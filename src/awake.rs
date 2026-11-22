//! Keep-awake policy and the lifetime of the operating system's power assertions.

#[cfg(target_os = "linux")]
#[path = "awake/linux.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "awake/macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "awake/windows.rs"]
mod platform;

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, TryRecvError},
    },
    time::{Duration, Instant},
};

pub const MODE_KEY: &str = "awake.mode";
const FRESH_FOR: Duration = Duration::from_secs(2 * 60 * 60);

/// Only live reports qualify. A restored snapshot can still show work in the UI.
#[derive(Default)]
pub struct LocalWork(HashMap<String, Instant>);

impl LocalWork {
    pub fn observe(&mut self, kind: &str, address: &str, working: bool, now: Instant) {
        if address.contains('/') || address.is_empty() {
            return;
        }
        match kind {
            "status" if working => {
                self.0.insert(address.to_owned(), now);
            }
            "status" | "finished" | "removed" | "lost" | "restarted" | "created" => {
                self.0.remove(address);
            }
            _ => {}
        }
    }

    pub fn clear(&mut self) {
        self.0.clear();
    }

    pub fn working(&mut self, now: Instant) -> bool {
        self.0
            .retain(|_, seen| now.saturating_duration_since(*seen) < FRESH_FOR);
        !self.0.is_empty()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    On,
    Auto,
    #[default]
    Off,
}

impl Mode {
    fn from_setting(value: Option<&str>) -> Self {
        match value {
            Some("on") => Self::On,
            Some("auto") => Self::Auto,
            _ => Self::Off,
        }
    }

    fn holds(self, working: bool) -> bool {
        self == Self::On || (self == Self::Auto && working)
    }
}

#[derive(Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct Status {
    mode: Mode,
    active: bool,
}

#[derive(Default)]
pub struct Service {
    mode: Mode,
    working: bool,
    last: Status,
    worker: Option<Worker>,
}

impl Service {
    pub fn set_mode(&mut self, value: Option<&str>) {
        let held = self.mode.holds(self.working);
        self.mode = Mode::from_setting(value);
        self.apply_change(held);
    }

    pub fn set_working(&mut self, working: bool) {
        let held = self.mode.holds(self.working);
        self.working = working;
        self.apply_change(held);
    }

    fn apply_change(&mut self, held: bool) {
        let want = self.mode.holds(self.working);
        if want == held {
            return;
        }
        if want && self.worker.is_none() {
            self.worker = Worker::start();
        }
        if let Some(worker) = &self.worker {
            let _ = worker.tx.send(want);
        }
    }

    /// The app already polls for desktop changes. Publish only when the displayed state changes.
    pub fn changed(&mut self) -> bool {
        let new = self.status();
        new != std::mem::replace(&mut self.last, new)
    }

    pub fn status(&self) -> Status {
        Status {
            mode: self.mode,
            active: self.mode.holds(self.working)
                && self
                    .worker
                    .as_ref()
                    .is_some_and(|w| w.active.load(Ordering::Acquire)),
        }
    }

    pub fn close(&mut self) {
        // Dropping the sender ends the worker even if it has yet to process a mode change.
        self.worker = None;
        self.mode = Mode::Off;
    }
}

struct Worker {
    tx: mpsc::Sender<bool>,
    active: Arc<AtomicBool>,
}

impl Worker {
    fn start() -> Option<Self> {
        let (tx, rx) = mpsc::channel();
        let active = Arc::new(AtomicBool::new(false));
        let report = active.clone();
        match std::thread::Builder::new()
            .name("kavex-awake".into())
            .spawn(move || hold(rx, report))
        {
            Ok(_) => Some(Self { tx, active }),
            Err(error) => {
                tracing::warn!("cannot start keep-awake service: {error}");
                None
            }
        }
    }
}

const RETRY: Duration = Duration::from_secs(30);
const MAX_RETRY: Duration = Duration::from_secs(8 * 60);

#[allow(dead_code)] // The operating systems differ in which checks they need.
enum Poll {
    Never,
    Check,
    Retry,
}

fn next_check(poll: Poll, retry: &mut Duration) -> Option<Duration> {
    match poll {
        Poll::Never => {
            *retry = RETRY;
            None
        }
        Poll::Check => {
            *retry = RETRY;
            Some(RETRY)
        }
        Poll::Retry => {
            let delay = *retry;
            *retry = (delay * 2).min(MAX_RETRY);
            Some(delay)
        }
    }
}

fn hold(rx: mpsc::Receiver<bool>, active: Arc<AtomicBool>) {
    let mut assertion: Option<platform::Assertion> = None;
    let mut retry = RETRY;
    let mut wait = None;
    'policy: loop {
        let next = match wait {
            None => rx.recv().ok(),
            Some(duration) => match rx.recv_timeout(duration) {
                Ok(want) => Some(want),
                Err(RecvTimeoutError::Timeout) => Some(true),
                Err(RecvTimeoutError::Disconnected) => None,
            },
        };
        let Some(mut want) = next else { break };
        // Mode changes can queue behind an OS call. Apply the newest decision only.
        loop {
            match rx.try_recv() {
                Ok(value) => want = value,
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break 'policy,
            }
        }
        match want {
            false => {
                assertion = None;
                active.store(false, Ordering::Release);
                retry = RETRY;
                wait = None;
            }
            true => {
                if !assertion.as_mut().is_some_and(platform::Assertion::held) {
                    drop(assertion.take());
                    assertion = match platform::Assertion::take() {
                        Ok(assertion) => Some(assertion),
                        Err(error) => {
                            tracing::warn!("cannot keep computer awake: {error}");
                            None
                        }
                    };
                }
                active.store(assertion.is_some(), Ordering::Release);
                let poll = assertion
                    .as_ref()
                    .map_or(Poll::Retry, platform::Assertion::poll);
                wait = next_check(poll, &mut retry);
            }
        }
    }
    drop(assertion);
    active.store(false, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_assertion_backs_off_until_it_is_healthy() {
        let mut retry = RETRY;
        for seconds in [30, 60, 120, 240, 480, 480] {
            assert_eq!(
                next_check(Poll::Retry, &mut retry),
                Some(Duration::from_secs(seconds))
            );
        }
        assert_eq!(next_check(Poll::Check, &mut retry), Some(RETRY));
        assert_eq!(next_check(Poll::Retry, &mut retry), Some(RETRY));
        assert_eq!(next_check(Poll::Never, &mut retry), None);
        assert_eq!(retry, RETRY);
    }

    #[test]
    fn three_modes_follow_orcas_power_policy() {
        for (saved, idle, busy) in [
            (None, false, false),
            (Some("unknown"), false, false),
            (Some("off"), false, false),
            (Some("on"), true, true),
            (Some("auto"), false, true),
        ] {
            let mode = Mode::from_setting(saved);
            assert_eq!(mode.holds(false), idle);
            assert_eq!(mode.holds(true), busy);
        }
    }

    #[test]
    fn live_local_work_expires_and_only_the_last_agent_releases_it() {
        let now = Instant::now();
        let mut work = LocalWork::default();
        work.observe("created", "t1", true, now);
        work.observe("status", "elsewhere/t2", true, now);
        assert!(!work.working(now));
        work.observe("status", "t1", true, now);
        work.observe("status", "t2", true, now);
        work.observe("status", "t1", false, now);
        assert!(work.working(now));
        let renewed = now + Duration::from_secs(60);
        work.observe("status", "t2", true, renewed);
        assert!(work.working(now + FRESH_FOR));
        assert!(!work.working(renewed + FRESH_FOR));
        work.observe("status", "t2", true, renewed + FRESH_FOR);
        work.observe("lost", "t2", false, renewed + FRESH_FOR);
        assert!(!work.working(renewed + FRESH_FOR));
    }
}
