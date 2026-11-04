//! Atomic replacement for app-owned files.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Follow file symlinks, including relative links and links to missing files.
pub(crate) fn resolve_target(path: &Path) -> std::io::Result<PathBuf> {
    let mut target = path.to_path_buf();
    for _ in 0..40 {
        match std::fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_symlink() => {
                let link = std::fs::read_link(&target)?;
                target = target.parent().unwrap_or(Path::new("")).join(link);
            }
            Ok(_) => return Ok(target),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(target),
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other("Too many symlinks"))
}

pub fn write_atomic(path: &Path, body: impl AsRef<[u8]>) -> std::io::Result<()> {
    let target = resolve_target(path)?;
    let path = target.as_path();
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".tmp.{}.{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let tmp = std::path::PathBuf::from(name);
    let result = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(body.as_ref())?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// One app-owned file written on a thread of its own, so the window never
/// waits on the disk (on Windows each create and rename is slow). The newest
/// text wins, an older one never lands last, and `finish` waits for the last.
pub struct Later {
    path: PathBuf,
    writer: Option<(std::sync::mpsc::Sender<String>, std::thread::JoinHandle<()>)>,
    failed: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Later {
    pub fn new(path: PathBuf) -> Self {
        Self { path, writer: None, failed: Default::default() }
    }

    /// Writes `text` soon (now, if no thread can start).
    pub fn write(&mut self, text: String) {
        if self.writer.is_none() {
            let (tx, rx) = std::sync::mpsc::channel::<String>();
            let (path, failed) = (self.path.clone(), self.failed.clone());
            let worker = std::thread::Builder::new().name("write-later".into()).spawn(move || {
                while let Ok(mut text) = rx.recv() {
                    for newer in rx.try_iter() {
                        text = newer;
                    }
                    Self::put(&path, &failed, &text);
                }
            });
            match worker {
                Ok(worker) => self.writer = Some((tx, worker)),
                Err(_) => return Self::put(&self.path, &self.failed, &text),
            }
        }
        if let Some((tx, _)) = &self.writer
            && let Err(e) = tx.send(text)
        {
            Self::put(&self.path, &self.failed, &e.0);
        }
    }

    fn put(path: &Path, failed: &std::sync::atomic::AtomicBool, text: &str) {
        let result = write_atomic(path, text);
        if let Err(error) = &result {
            tracing::warn!("cannot write {}: {error}", path.display());
        }
        failed.store(result.is_err(), Ordering::SeqCst);
    }

    /// The last write didn't reach the disk: write it again next time.
    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::SeqCst)
    }

    /// Waits until everything written so far is on disk.
    pub fn finish(&mut self) {
        if let Some((tx, worker)) = self.writer.take() {
            drop(tx);
            if worker.join().is_err() {
                tracing::warn!("{} writer stopped before saving finished", self.path.display());
            }
        }
    }
}

impl Drop for Later {
    fn drop(&mut self) {
        self.finish();
    }
}

#[cfg(test)]
mod later_tests {
    use super::*;

    #[test]
    fn the_newest_text_is_on_disk_after_finish_and_a_failure_is_known() {
        let dir = std::env::temp_dir().join(format!("herdr-later-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut file = Later::new(dir.join("view.json"));
        for i in 0..50 {
            file.write(format!("v{i}"));
        }
        file.finish();
        assert_eq!(std::fs::read_to_string(dir.join("view.json")).unwrap(), "v49");
        assert!(!file.failed());
        // Written again after finish: a new writer, same file.
        file.write("again".into());
        file.finish();
        assert_eq!(std::fs::read_to_string(dir.join("view.json")).unwrap(), "again");

        let mut nowhere = Later::new(dir.join("missing-folder").join("view.json"));
        nowhere.write("x".into());
        nowhere.finish();
        assert!(nowhere.failed());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn atomic_write_preserves_symlink_chains_and_dangling_targets() {
        let root = std::env::temp_dir().join(format!(
            "herdr-persist-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let links = root.join("links");
        std::fs::create_dir_all(&links).unwrap();
        let target = root.join("settings.json");
        let intermediate = links.join("intermediate");
        let link = root.join("settings-link.json");
        symlink("../settings.json", &intermediate).unwrap();
        symlink(&intermediate, &link).unwrap();

        for body in ["created", "updated"] {
            write_atomic(&link, body).unwrap();
            assert_eq!(std::fs::read_to_string(&target).unwrap(), body);
            assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
            assert!(std::fs::symlink_metadata(&intermediate).unwrap().is_symlink());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomic_write_rejects_symlink_cycles() {
        let link = std::env::temp_dir().join(format!("herdr-persist-cycle-{}", std::process::id()));
        symlink(&link, &link).unwrap();
        assert!(write_atomic(&link, "ignored").is_err());
        assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
        std::fs::remove_file(link).unwrap();
    }
}
