//! Kavex was called Zaki until 0.5.0. What a Zaki install left behind keeps
//! working here: its home, its machines' layout documents, its theme's name
//! and the labels on terminals it started. Remove once Zaki installs are gone.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// The core's layout document Zaki wrote, read when Kavex has none yet.
pub const OLD_DOCUMENT: &str = "zaki";

/// A first start copies `~/.config/zaki` to `~/.config/kavex`. A copy, not a
/// move: a Zaki still open keeps its own home.
pub fn copy_home() {
    if std::env::var_os("HERDR_APP_HOME").is_some_and(|v| !v.is_empty()) {
        return;
    }
    let new = crate::mods::app_dir();
    let Some(old) = new.parent().map(|p| p.join("zaki")) else { return };
    if new.exists() || !old.is_dir() {
        return;
    }
    let staged = new.with_file_name(format!(".kavex-from-zaki-{}", std::process::id()));
    let copied = copy_dir(&old, &staged).and_then(|()| std::fs::rename(&staged, &new));
    if let Err(e) = copied {
        tracing::warn!("copying {} to {}: {e}", old.display(), new.display());
        let _ = std::fs::remove_dir_all(&staged);
    }
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target: PathBuf = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_file() && entry.file_name() != "zaki.sock" {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Settings and layouts that name Zaki's theme get the same theme by its new name.
pub fn theme(name: &str) -> &str {
    if name == "zaki" { "kavex" } else { name }
}

/// Moves a terminal record's `zaki.*` labels to `kavex.*` (a `kavex.*` one
/// already there wins) and returns the labels to write back to the core,
/// with the old ones cleared, or None when there were none.
pub fn labels(record: &mut Map<String, Value>) -> Option<Map<String, Value>> {
    let labels = record.get_mut("labels")?.as_object_mut()?;
    let old: Vec<String> = labels.keys().filter(|k| k.starts_with("zaki.")).cloned().collect();
    if old.is_empty() {
        return None;
    }
    let mut write = Map::new();
    for key in old {
        let value = labels.remove(&key).unwrap_or(Value::Null);
        if value.as_str().is_some_and(|s| s.is_empty()) {
            continue;
        }
        let new = format!("kavex.{}", &key["zaki.".len()..]);
        if !labels.contains_key(&new) {
            labels.insert(new.clone(), value.clone());
            write.insert(new, value);
        }
        write.insert(key, Value::String(String::new()));
    }
    (!write.is_empty()).then_some(write)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn old_labels_move_to_the_new_name() {
        let mut record = json!({"labels": {"zaki.space": "sp1", "zaki.tab": "", "kavex.group": "a", "zaki.group": "b", "other": "x"}});
        let write = labels(record.as_object_mut().unwrap()).unwrap();
        assert_eq!(record["labels"], json!({"kavex.space": "sp1", "kavex.group": "a", "other": "x"}));
        assert_eq!(Value::Object(write), json!({"kavex.space": "sp1", "zaki.space": "", "zaki.group": ""}));
    }

    #[test]
    fn records_without_old_labels_are_left_alone() {
        let mut record = json!({"labels": {"kavex.space": "sp1"}});
        assert!(labels(record.as_object_mut().unwrap()).is_none());
        let mut cleared = json!({"labels": {"zaki.space": ""}});
        assert!(labels(cleared.as_object_mut().unwrap()).is_none());
        assert_eq!(cleared["labels"], json!({}));
    }

    #[test]
    fn the_old_theme_name_is_the_new_theme() {
        assert_eq!((theme("zaki"), theme("ink")), ("kavex", "ink"));
    }
}
