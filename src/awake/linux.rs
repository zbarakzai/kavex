use std::time::Duration;
use zbus::{
    blocking::{Connection, connection::Builder},
    zvariant::OwnedFd,
};

const APP: &str = "Kavex";
const REASON: &str = "Keep computer awake";
const TIMEOUT: Duration = Duration::from_secs(2);
const IDLE: u32 = 8;

pub struct Assertion {
    system: Option<OwnedFd>,
    desktop: Option<Desktop>,
}

impl Assertion {
    pub fn take() -> Result<Self, String> {
        match (inhibit_system(), inhibit_desktop()) {
            (Err(system), Err(desktop)) => {
                Err(format!("system sleep: {system}; desktop idle: {desktop}"))
            }
            (system, desktop) => Ok(Self {
                system: system.ok(),
                desktop: desktop.ok(),
            }),
        }
    }

    pub fn held(&mut self) -> bool {
        // Keep whichever assertion succeeded while the other service comes up.
        if self.system.is_none() {
            self.system = inhibit_system().ok();
        }
        if self.desktop.is_none() {
            self.desktop = inhibit_desktop().ok();
        }
        self.system.is_some() || self.desktop.is_some()
    }

    pub fn poll(&self) -> super::Poll {
        if self.system.is_some() && self.desktop.is_some() {
            super::Poll::Never
        } else {
            super::Poll::Retry
        }
    }
}

fn inhibit_system() -> zbus::Result<OwnedFd> {
    let bus = Builder::system()?.method_timeout(TIMEOUT).build()?;
    inhibit_login(&bus)
}

fn inhibit_login(bus: &Connection) -> zbus::Result<OwnedFd> {
    // A sleep lock alone can be ignored on lid-close. Take the low-level lid lock too.
    let reply = bus.call_method(
        Some("org.freedesktop.login1"),
        "/org/freedesktop/login1",
        Some("org.freedesktop.login1.Manager"),
        "Inhibit",
        &("sleep:handle-lid-switch", APP, REASON, "block"),
    )?;
    reply.body().deserialize()
}

const GNOME: &str = "org.gnome.SessionManager";
const SCREENSAVER: &str = "org.freedesktop.ScreenSaver";

enum Release {
    Gnome(u32),
    Screensaver(u32),
}

struct Desktop {
    bus: Connection,
    release: Release,
}

fn inhibit_desktop() -> zbus::Result<Desktop> {
    // Use a connection of our own. A process crash also disconnects this client.
    let bus = Builder::session()?.method_timeout(TIMEOUT).build()?;
    inhibit_session(bus)
}

fn inhibit_session(bus: Connection) -> zbus::Result<Desktop> {
    let gnome = || {
        let reply = bus.call_method(
            Some(GNOME),
            "/org/gnome/SessionManager",
            Some(GNOME),
            "Inhibit",
            &(APP, 0u32, REASON, IDLE),
        )?;
        reply.body().deserialize().map(Release::Gnome)
    };
    let screensaver = || {
        let reply = bus.call_method(
            Some(SCREENSAVER),
            "/org/freedesktop/ScreenSaver",
            Some(SCREENSAVER),
            "Inhibit",
            &(APP, REASON),
        )?;
        reply.body().deserialize().map(Release::Screensaver)
    };
    let release = gnome().or_else(|_| screensaver())?;
    Ok(Desktop { bus, release })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Read},
        os::unix::net::UnixStream,
        process::{Child, Command, Stdio},
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
    };

    struct Daemon(Child);

    impl Drop for Daemon {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    struct Logind(Arc<Mutex<Option<UnixStream>>>);

    #[zbus::interface(name = "org.freedesktop.login1.Manager")]
    impl Logind {
        fn inhibit(&self, what: &str, who: &str, why: &str, mode: &str) -> OwnedFd {
            assert_eq!(
                (what, who, why, mode),
                ("sleep:handle-lid-switch", APP, REASON, "block")
            );
            let (client, peer) = UnixStream::pair().unwrap();
            peer.set_nonblocking(true).unwrap();
            *self.0.lock().unwrap() = Some(peer);
            let fd: std::os::fd::OwnedFd = client.into();
            fd.into()
        }
    }

    struct ScreenSaver(Arc<AtomicBool>);

    #[zbus::interface(name = "org.freedesktop.ScreenSaver")]
    impl ScreenSaver {
        fn inhibit(&self, who: &str, why: &str) -> u32 {
            assert_eq!((who, why), (APP, REASON));
            self.0.store(true, Ordering::SeqCst);
            1
        }

        #[zbus(name = "UnInhibit")]
        fn uninhibit(&self, cookie: u32) {
            assert_eq!(cookie, 1);
            self.0.store(false, Ordering::SeqCst);
        }
    }

    #[test]
    fn owns_and_releases_linux_sleep_lid_and_desktop_inhibitors() {
        let mut daemon = Daemon(
            Command::new("dbus-daemon")
                .args(["--session", "--nofork", "--print-address=1", "--nopidfile"])
                .stdout(Stdio::piped())
                .spawn()
                .expect("dbus-daemon is required for the Linux power test"),
        );
        let mut address = String::new();
        BufReader::new(daemon.0.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        let builder = || {
            Builder::address(address.trim())
                .unwrap()
                .method_timeout(TIMEOUT)
        };
        let peer = Arc::new(Mutex::new(None));
        let screen = Arc::new(AtomicBool::new(false));
        let _services = builder()
            .name("org.freedesktop.login1")
            .unwrap()
            .name(SCREENSAVER)
            .unwrap()
            .serve_at("/org/freedesktop/login1", Logind(peer.clone()))
            .unwrap()
            .serve_at("/org/freedesktop/ScreenSaver", ScreenSaver(screen.clone()))
            .unwrap()
            .build()
            .unwrap();
        let hold = inhibit_login(&builder().build().unwrap()).unwrap();
        let mut peer = peer.lock().unwrap().take().unwrap();
        assert_eq!(
            peer.read(&mut [0]).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let desktop = inhibit_session(builder().build().unwrap()).unwrap();
        assert!(screen.load(Ordering::SeqCst));
        drop(desktop);
        assert!(!screen.load(Ordering::SeqCst));
        drop(hold);
        assert_eq!(peer.read(&mut [0]).unwrap(), 0);
    }
}

impl Drop for Desktop {
    fn drop(&mut self) {
        let _ = match &self.release {
            Release::Gnome(cookie) => self.bus.call_method(
                Some(GNOME),
                "/org/gnome/SessionManager",
                Some(GNOME),
                "Uninhibit",
                &(*cookie,),
            ),
            Release::Screensaver(cookie) => self.bus.call_method(
                Some(SCREENSAVER),
                "/org/freedesktop/ScreenSaver",
                Some(SCREENSAVER),
                "UnInhibit",
                &(*cookie,),
            ),
        };
    }
}
