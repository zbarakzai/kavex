//! Counts for `scripts/bench.py`: how often the window and terminals are drawn.
//! With HERDR_APP_BENCH=<file>, one JSON line per second goes there.
//!
//! `scripts/perf/` asks for more with HERDR_APP_BENCH_EVENTS=<file>: a
//! timestamped line per mark, span, core call and drawn frame. Without that
//! variable every call below is one relaxed load of `EVENTS`, and nothing is
//! recorded, started or attached. HERDR_APP_PROFILE=<file> adds a sampling
//! profiler (Windows, needs the events file too).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::{Mutex, OnceLock};

#[cfg(all(windows, target_arch = "x86_64"))]
mod sampler;
#[cfg(windows)]
mod wndproc;

pub static WINDOW: AtomicU64 = AtomicU64::new(0);
pub static TERMINAL: AtomicU64 = AtomicU64::new(0);
pub static GRID: AtomicU64 = AtomicU64::new(0);
/// Terminal rows whose drawing was built again (the rest were kept).
pub static ROWS: AtomicU64 = AtomicU64::new(0);
/// Microseconds spent in the window's own render.
pub static WINDOW_US: AtomicU64 = AtomicU64::new(0);

/// Microseconds from the window's render to the end of its paint: the
/// main thread's work for a frame, before the GPU.
pub static FRAME_US: AtomicU64 = AtomicU64::new(0);
static FRAME_START: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

pub fn frame_start() {
    *FRAME_START.lock().unwrap() = Some(std::time::Instant::now());
}

/// Put last in the window: painted last, it ends the frame's clock.
pub fn frame_end() -> impl gpui::IntoElement {
    gpui::canvas(|_, _, _| {}, |_, _, _, _| {
        if let Some(t) = FRAME_START.lock().unwrap().take() {
            FRAME_US.fetch_add(t.elapsed().as_micros() as u64, Relaxed);
        }
        static FIRST: AtomicBool = AtomicBool::new(true);
        if events_on() && FIRST.swap(false, Relaxed) {
            mark("first_paint");
        }
    })
}

/// The mods runtime's totals so far (scripts run, native rebuilds), copied
/// in by the window.
pub static SCRIPT_RENDERS: AtomicU64 = AtomicU64::new(0);
pub static SCRIPT_US: AtomicU64 = AtomicU64::new(0);
pub static MATERIALIZE: AtomicU64 = AtomicU64::new(0);
pub static MATERIALIZE_US: AtomicU64 = AtomicU64::new(0);

pub fn note_mods(m: &gpui_shell::metrics::RuntimeMetrics) {
    SCRIPT_RENDERS.store(m.script_renders(), Relaxed);
    SCRIPT_US.store(m.script_render_time().as_micros() as u64, Relaxed);
    MATERIALIZE.store(m.materializations(), Relaxed);
    MATERIALIZE_US.store(m.materialize_time().as_micros() as u64, Relaxed);
}

/// Adds the time until it's dropped to a counter.
pub struct Timed(&'static AtomicU64, std::time::Instant);

pub fn timed(c: &'static AtomicU64) -> Timed {
    Timed(c, std::time::Instant::now())
}

impl Drop for Timed {
    fn drop(&mut self) {
        self.0.fetch_add(self.1.elapsed().as_micros() as u64, Relaxed);
    }
}

pub fn count(c: &AtomicU64) {
    c.fetch_add(1, Relaxed);
}

static EVENTS: AtomicBool = AtomicBool::new(false);
static PENDING: Mutex<Vec<Event>> = Mutex::new(Vec::new());
static NAMES: OnceLock<Mutex<HashMap<String, &'static str>>> = OnceLock::new();
static MAIN: OnceLock<std::thread::ThreadId> = OnceLock::new();
/// Terminal bytes received, and the time spent feeding them to the VT.
pub static OUTPUT_BYTES: AtomicU64 = AtomicU64::new(0);
pub static OUTPUT_US: AtomicU64 = AtomicU64::new(0);

struct Event {
    at: u64,
    name: &'static str,
    values: Vec<u64>,
}

#[inline]
pub fn events_on() -> bool {
    EVENTS.load(Relaxed)
}

/// Microseconds since the Unix epoch: comparable between processes, so the
/// harness's clock and these marks line up.
fn now_us() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

fn push(name: &'static str, at: u64, values: Vec<u64>) {
    if let Ok(mut p) = PENDING.lock() {
        p.push(Event { at, name, values });
    }
}

/// Something happened now.
#[inline]
pub fn mark(name: &'static str) {
    if events_on() {
        push(name, now_us(), Vec::new());
    }
}

#[inline]
pub fn mark_with(name: &'static str, values: &[u64]) {
    if events_on() {
        push(name, now_us(), values.to_vec());
    }
}

/// A name known only at run time, kept once.
fn intern(name: &str) -> &'static str {
    let names = NAMES.get_or_init(Default::default);
    let Ok(mut names) = names.lock() else { return "?" };
    if let Some(known) = names.get(name) {
        return known;
    }
    let kept: &'static str = Box::leak(name.to_owned().into_boxed_str());
    names.insert(name.to_owned(), kept);
    kept
}

/// Reports how long it lived, and whether that was on the main thread.
pub struct Span(Option<(&'static str, u64)>);

/// A named stretch of work; `span` lines say which thread it blocked.
#[inline]
pub fn span(name: &'static str) -> Span {
    Span(events_on().then(|| (name, now_us())))
}

/// A core call, by method: a call on the main thread stalls the window.
#[inline]
pub fn rpc(method: &str) -> Span {
    named_span("rpc", method)
}

/// A span whose name is only known at run time (a command, a process).
#[inline]
pub fn named_span(kind: &str, name: &str) -> Span {
    Span(events_on().then(|| (intern(&format!("{kind}:{}", name.replace(['"', '\\'], ""))), now_us())))
}

impl Drop for Span {
    fn drop(&mut self) {
        if let Some((name, at)) = self.0 {
            let main = MAIN.get().is_some_and(|m| *m == std::thread::current().id());
            push(name, at, vec![now_us().saturating_sub(at), main as u64]);
        }
    }
}

/// Called first thing in `main`, on the main thread.
pub fn init() {
    let Some(path) = std::env::var_os("HERDR_APP_BENCH_EVENTS") else { return };
    let Ok(file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else { return };
    let _ = MAIN.set(std::thread::current().id());
    EVENTS.store(true, Relaxed);
    mark("main");
    let _ = std::thread::Builder::new().name("kavex-bench".into()).spawn(move || write_events(file));
    #[cfg(all(windows, target_arch = "x86_64"))]
    if let Some(path) = std::env::var_os("HERDR_APP_PROFILE") {
        sampler::start(path.into());
    }
}

fn write_events(file: std::fs::File) {
    use std::io::Write;
    let mut out = std::io::BufWriter::new(file);
    let mut ticks = 0u32;
    loop {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let events = PENDING.lock().map(|mut p| std::mem::take(&mut *p)).unwrap_or_default();
        for e in &events {
            let values = e.values.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
            let _ = writeln!(out, r#"{{"t":{},"e":"{}","v":[{values}]}}"#, e.at, e.name);
        }
        ticks += 1;
        if ticks % 10 == 0 {
            #[cfg(windows)]
            let (idle, idle_us) = wndproc::idle_paints();
            #[cfg(not(windows))]
            let (idle, idle_us) = (0, 0);
            let _ = writeln!(
                out,
                r#"{{"t":{},"e":"tick","v":[{},{},{idle},{idle_us}]}}"#,
                now_us(),
                OUTPUT_BYTES.load(Relaxed),
                OUTPUT_US.load(Relaxed)
            );
        }
        let _ = out.flush();
    }
}

/// Terminal output on its way into the VT: counted, and timed until dropped.
#[inline]
pub fn output(channel: Option<u32>, len: usize) -> Option<OutputTimer> {
    if !events_on() {
        return None;
    }
    OUTPUT_BYTES.fetch_add(len as u64, Relaxed);
    mark_with("output", &[channel.unwrap_or(0) as u64, len as u64]);
    Some(OutputTimer(std::time::Instant::now()))
}

pub struct OutputTimer(std::time::Instant);

impl Drop for OutputTimer {
    fn drop(&mut self) {
        OUTPUT_US.fetch_add(self.0.elapsed().as_micros() as u64, Relaxed);
    }
}

/// How many rows of a terminal have something on them, when that changes:
/// the first such paint is the prompt becoming visible.
pub fn ink(channel: Option<u32>, rows: usize) {
    use std::cell::RefCell;
    thread_local!(static LAST: RefCell<HashMap<u32, usize>> = RefCell::default());
    let channel = channel.unwrap_or(0);
    let changed = LAST.with(|l| l.borrow_mut().insert(channel, rows) != Some(rows));
    if changed {
        mark_with("ink", &[channel as u64, rows as u64]);
    }
}

/// Every window render: the first one notes itself and starts timing the window.
#[inline]
pub fn rendering(window: &gpui::Window) {
    static SEEN: AtomicBool = AtomicBool::new(false);
    if events_on() && !SEEN.swap(true, Relaxed) {
        mark("first_render");
        #[cfg(windows)]
        wndproc::attach(window);
        #[cfg(not(windows))]
        let _ = window;
    }
}

/// All the frame counters, for one frame's share of them.
#[cfg_attr(not(windows), allow(dead_code))]
fn frame_counters() -> [u64; 9] {
    [
        WINDOW.load(Relaxed),
        TERMINAL.load(Relaxed),
        GRID.load(Relaxed),
        ROWS.load(Relaxed),
        WINDOW_US.load(Relaxed),
        FRAME_US.load(Relaxed),
        SCRIPT_US.load(Relaxed),
        MATERIALIZE_US.load(Relaxed),
        SCRIPT_RENDERS.load(Relaxed),
    ]
}

pub fn start() {
    let Some(path) = std::env::var_os("HERDR_APP_BENCH") else { return };
    std::thread::spawn(move || {
        use std::io::Write;
        let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else { return };
        let mut last = [0u64; 4];
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let now = [SCRIPT_RENDERS.load(Relaxed), SCRIPT_US.load(Relaxed), MATERIALIZE.load(Relaxed), MATERIALIZE_US.load(Relaxed)];
            let d: Vec<u64> = now.iter().zip(last).map(|(n, l)| n.saturating_sub(l)).collect();
            last = now;
            let _ = writeln!(
                f,
                r#"{{"t":{t},"scripts":{},"script_ms":{},"materialize":{},"materialize_ms":{},"window":{},"terminal":{},"grid":{},"rows":{},"window_ms":{},"frame_ms":{}}}"#,
                d[0],
                d[1] as f64 / 1000.0,
                d[2],
                d[3] as f64 / 1000.0,
                WINDOW.swap(0, Relaxed),
                TERMINAL.swap(0, Relaxed),
                GRID.swap(0, Relaxed),
                ROWS.swap(0, Relaxed),
                WINDOW_US.swap(0, Relaxed) as f64 / 1000.0,
                FRAME_US.swap(0, Relaxed) as f64 / 1000.0
            );
        }
    });
}
