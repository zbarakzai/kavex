//! The Markdown files a terminal's text names, so they can look like links
//! without anyone holding a key. Text is read only when a row changes, past a
//! cheap check for `.m`. The disk is asked off the main thread, as a slow mount
//! must not stall a frame, and asked again as files come and go with no row
//! changing.

use crate::links;
use crate::vt::{Cell, Spans};
use std::collections::HashMap;
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

pub const RECHECK: Duration = Duration::from_secs(3);

struct Reference {
    word: String,
    spans: Spans,
}

#[derive(Default)]
pub struct MarkdownRefs {
    /// This disk says nothing about another machine's files.
    remote: bool,
    cwd: Option<PathBuf>,
    rows: Vec<Rc<Vec<Cell>>>,
    wraps: Vec<bool>,
    refs: Vec<Reference>,
    known: HashMap<String, bool>,
    asking: bool,
    rechecking: bool,
}

/// The names to look up, and whether that starts the rechecks.
pub struct Lookup {
    pub words: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub start_rechecking: bool,
}

/// Which names are on disk. Slow: not for the main thread.
pub fn on_disk(words: Vec<String>, cwd: Option<PathBuf>) -> HashMap<String, bool> {
    words
        .into_iter()
        .map(|word| {
            let found = links::on_disk(&word, cwd.as_deref());
            (word, found)
        })
        .collect()
}

impl MarkdownRefs {
    pub fn set_place(&mut self, cwd: Option<&Path>, remote: bool) {
        if self.cwd.as_deref() != cwd || self.remote != remote {
            (self.cwd, self.remote) = (cwd.map(PathBuf::from), remote);
            self.known.clear();
            self.rows.clear();
        }
    }

    /// The lookup to run now, unless one is running or nothing shows.
    pub fn start_lookup(&mut self) -> Option<Lookup> {
        let words = self.words();
        if self.asking || words.is_empty() {
            return None;
        }
        self.asking = true;
        let start_rechecking = !std::mem::replace(&mut self.rechecking, true);
        Some(Lookup { words, cwd: self.cwd.clone(), start_rechecking })
    }

    /// Takes a lookup's answers. Returns whether what's underlined changed and
    /// whether new names came in the meantime.
    pub fn finish_lookup(&mut self, answers: HashMap<String, bool>) -> (bool, bool) {
        self.asking = false;
        (self.learn(answers), self.has_unknown())
    }

    /// Whether rechecks go on, for a terminal that is or isn't on screen.
    pub fn keep_rechecking(&mut self, shown: bool) -> bool {
        self.rechecking = shown && !self.refs.is_empty();
        self.rechecking
    }

    /// Finds the names on screen, if its text changed. `wraps` says which rows
    /// carry on in the next, so a long path counts as one name.
    pub fn read(&mut self, rows: &[Rc<Vec<Cell>>], wraps: &[bool]) {
        let same = rows.len() == self.rows.len() && rows.iter().zip(&self.rows).all(|(a, b)| Rc::ptr_eq(a, b)) && wraps == self.wraps;
        if same {
            return;
        }
        (self.rows, self.wraps) = (rows.to_vec(), wraps.to_vec());
        self.refs.clear();
        if self.remote {
            return;
        }
        let mut first = 0;
        while first < rows.len() {
            let mut last = first;
            while last + 1 < rows.len() && wraps.get(last).copied().unwrap_or(false) {
                last += 1;
            }
            self.read_line(rows, first..=last);
            first = last + 1;
        }
    }

    fn read_line(&mut self, rows: &[Rc<Vec<Cell>>], line: RangeInclusive<usize>) {
        let mut text = String::new();
        // The row and column of each byte of `text`.
        let mut spots = Vec::new();
        let (mut dot, mut mentioned, mut after_wide) = (false, false, false);
        for y in line {
            for (x, cell) in rows[y].iter().enumerate() {
                // A wide character's second cell is part of it, not a gap.
                if std::mem::replace(&mut after_wide, cell.wide) && cell.text.is_empty() {
                    continue;
                }
                mentioned |= dot && matches!(cell.text.as_str(), "m" | "M");
                dot = cell.text == ".";
                let shown = if cell.text.is_empty() { " " } else { cell.text.as_str() };
                text.push_str(shown);
                spots.resize(spots.len() + shown.len(), (y as u16, x as u16));
            }
        }
        if !mentioned {
            return;
        }
        for word in links::markdown_words(links::PathStyle::of(self.remote), &text) {
            let mut spans = Spans::new();
            for &(y, x) in &spots[word.clone()] {
                match spans.last_mut() {
                    Some(span) if span.0 == y => span.2 = x,
                    _ => spans.push((y, x, x)),
                }
            }
            self.refs.push(Reference { word: text[word].to_owned(), spans });
        }
    }

    pub fn spans(&self) -> Spans {
        self.refs.iter().filter(|r| self.known.get(&r.word).copied().unwrap_or(false)).flat_map(|r| r.spans.iter().copied()).collect()
    }

    fn words(&self) -> Vec<String> {
        let mut words: Vec<String> = self.refs.iter().map(|r| r.word.clone()).collect();
        words.sort();
        words.dedup();
        words
    }

    fn has_unknown(&self) -> bool {
        self.refs.iter().any(|r| !self.known.contains_key(&r.word))
    }

    pub fn wants_asking(&self) -> bool {
        !self.refs.is_empty() && (!self.rechecking || (!self.asking && self.has_unknown()))
    }

    fn learn(&mut self, answers: HashMap<String, bool>) -> bool {
        let changed = answers.iter().any(|(word, found)| self.known.get(word).copied().unwrap_or(false) != *found);
        self.known.extend(answers);
        let refs = &self.refs;
        self.known.retain(|word, _| refs.iter().any(|r| r.word == *word));
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(text: &str) -> Rc<Vec<Cell>> {
        Rc::new(text.chars().map(|c| Cell { text: c.to_string(), ..Default::default() }).collect())
    }

    fn cwd_with(files: &[&str]) -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("zaki-refs-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        for file in files {
            std::fs::write(dir.join(file), "").unwrap();
        }
        dir
    }

    fn refs_in(dir: &Path) -> MarkdownRefs {
        let mut refs = MarkdownRefs::default();
        refs.set_place(Some(dir), false);
        refs
    }

    fn checked(refs: &mut MarkdownRefs) -> bool {
        let lookup = refs.start_lookup().expect("names to look up");
        refs.finish_lookup(on_disk(lookup.words, lookup.cwd)).0
    }

    #[test]
    fn only_names_that_exist_get_underlined() {
        let dir = cwd_with(&["README.md", "docs/plan.md"]);
        let mut refs = refs_in(&dir);
        refs.read(&[row("see README.md, docs/plan.md and gone.md")], &[false]);
        assert_eq!(refs.spans(), [], "nothing shows before the disk answers");
        assert!(refs.wants_asking());
        assert!(checked(&mut refs));
        assert_eq!(refs.spans(), [(0, 4, 12), (0, 15, 26)]);
        assert!(!refs.has_unknown());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn answers_follow_the_disk_with_no_row_changing() {
        let dir = cwd_with(&[]);
        let mut refs = refs_in(&dir);
        let screen = [row("I'll write plan.md")];
        refs.read(&screen, &[false]);
        assert!(!checked(&mut refs));
        assert_eq!(refs.spans(), []);
        std::fs::write(dir.join("plan.md"), "").unwrap();
        refs.read(&screen, &[false]);
        assert!(checked(&mut refs), "the file came");
        assert_eq!(refs.spans(), [(0, 11, 17)]);
        std::fs::remove_file(dir.join("plan.md")).unwrap();
        assert!(checked(&mut refs), "the file went");
        assert_eq!(refs.spans(), []);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_wrapped_path_counts_as_one_name_on_each_row() {
        let dir = cwd_with(&["docs/plan.md"]);
        let mut refs = refs_in(&dir);
        refs.read(&[row("open docs/"), row("plan.md now")], &[true, false]);
        checked(&mut refs);
        assert_eq!(refs.spans(), [(0, 5, 9), (1, 0, 6)]);
        let dot_on_the_edge = [row("see docs/plan."), row("md")];
        refs.read(&dot_on_the_edge, &[true, false]);
        checked(&mut refs);
        assert_eq!(refs.spans(), [(0, 4, 13), (1, 0, 1)]);
        refs.read(&[row("docs/plan."), row("md")], &[false, false]);
        assert_eq!(refs.spans(), [], "rows that don't wrap are separate lines");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_wide_character_is_one_letter_of_a_name() {
        let dir = cwd_with(&["文档.md"]);
        let mut refs = refs_in(&dir);
        let mut cells = Vec::new();
        for c in ['文', '档'] {
            cells.push(Cell { text: c.to_string(), wide: true, ..Default::default() });
            cells.push(Cell::default());
        }
        cells.extend(row(".md").iter().cloned());
        refs.read(&[Rc::new(cells)], &[false]);
        checked(&mut refs);
        assert_eq!(refs.spans(), [(0, 0, 6)]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_blank_cell_after_narrow_text_still_ends_a_word() {
        let dir = cwd_with(&["a.md", "b.md"]);
        let mut refs = refs_in(&dir);
        let mut cells: Vec<Cell> = row("a.md").iter().cloned().collect();
        cells.push(Cell::default());
        cells.extend(row("b.md").iter().cloned());
        refs.read(&[Rc::new(cells)], &[false]);
        assert_eq!(refs.words(), ["a.md", "b.md"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn another_machine_shows_nothing_and_asks_nothing() {
        let dir = cwd_with(&["README.md"]);
        let mut refs = MarkdownRefs::default();
        refs.set_place(Some(&dir), true);
        refs.read(&[row("README.md")], &[false]);
        assert!(!refs.wants_asking() && refs.start_lookup().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn one_lookup_runs_at_a_time_and_rechecks_end_with_the_names() {
        let dir = cwd_with(&["a.md"]);
        let mut refs = refs_in(&dir);
        refs.read(&[row("a.md")], &[false]);
        assert!(refs.start_lookup().is_some_and(|lookup| lookup.start_rechecking));
        assert!(refs.start_lookup().is_none());
        refs.finish_lookup(HashMap::new());
        assert!(refs.start_lookup().is_some_and(|lookup| !lookup.start_rechecking));
        refs.finish_lookup(HashMap::new());
        assert!(refs.keep_rechecking(true));
        assert!(!refs.keep_rechecking(false), "off screen");
        refs.read(&[row("nothing here")], &[false]);
        assert!(!refs.keep_rechecking(true), "no names");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_get_underlined() {
        let dir = cwd_with(&["README.md", "docs/plan.md"]);
        let mut refs = refs_in(&dir);
        refs.read(&[row(r"see docs\plan.md and .\README.md, gone\no.md")], &[false]);
        checked(&mut refs);
        assert_eq!(refs.spans(), [(0, 4, 15), (0, 21, 31)]);
        let whole = dir.join(r"docs\plan.md").display().to_string();
        refs.read(&[row(&format!("({whole})"))], &[false]);
        checked(&mut refs);
        assert_eq!(refs.spans(), [(0, 1, whole.len() as u16)]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_wrapped_windows_path_counts_as_one_name_on_each_row() {
        let dir = cwd_with(&["docs/plan.md"]);
        let mut refs = refs_in(&dir);
        refs.read(&[row(r"open docs\"), row("plan.md now")], &[true, false]);
        checked(&mut refs);
        assert_eq!(refs.spans(), [(0, 5, 9), (1, 0, 6)]);
        let whole = dir.join(r"docs\plan.md").display().to_string();
        let (head, tail) = whole.split_at(2);
        refs.read(&[row(head), row(tail)], &[true, false]);
        checked(&mut refs);
        assert_eq!(refs.spans(), [(0, 0, 1), (1, 0, tail.len() as u16 - 1)], "the wrap falls after its drive");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_path_with_spaces_gets_underlined_whole() {
        let dir = cwd_with(&[]);
        std::fs::create_dir_all(dir.join("Digital Twin")).unwrap();
        std::fs::write(dir.join("Digital Twin/plan.md"), "").unwrap();
        let whole = dir.join(r"Digital Twin\plan.md").display().to_string();
        let mut refs = refs_in(&dir);
        refs.read(&[row(&format!("wrote {whole} just now"))], &[false]);
        checked(&mut refs);
        assert_eq!(refs.spans(), [(0, 6, 5 + whole.len() as u16)]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn a_file_link_is_underlined_whole_when_its_file_exists() {
        let dir = cwd_with(&["a.md"]);
        let mut refs = refs_in(&dir);
        let link = format!("file://{}", dir.join("a.md").display());
        refs.read(&[row(&link), row("file:///nowhere/gone.md")], &[false, false]);
        checked(&mut refs);
        assert_eq!(refs.spans(), [(0, 0, link.len() as u16 - 1)]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_new_folder_asks_again() {
        let dir = cwd_with(&["README.md"]);
        let elsewhere = cwd_with(&[]);
        let mut refs = refs_in(&dir);
        let screen = [row("README.md")];
        refs.read(&screen, &[false]);
        checked(&mut refs);
        assert_eq!(refs.spans(), [(0, 0, 8)]);
        refs.set_place(Some(&elsewhere), false);
        refs.read(&screen, &[false]);
        assert_eq!(refs.spans(), []);
        assert!(refs.has_unknown());
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(elsewhere).unwrap();
    }

    #[test]
    fn answers_for_names_no_longer_shown_are_dropped() {
        let dir = cwd_with(&["a.md"]);
        let mut refs = refs_in(&dir);
        refs.read(&[row("a.md")], &[false]);
        checked(&mut refs);
        refs.read(&[row("other text")], &[false]);
        refs.learn(HashMap::new());
        assert!(refs.known.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
