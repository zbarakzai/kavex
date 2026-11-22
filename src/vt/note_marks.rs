// The terminal owns tracked ranges. Only the opaque mark ID is written into a note.
use super::*;
use std::collections::VecDeque;
use std::hash::{BuildHasher, Hasher};

const MAX_MARKS: usize = 64;

#[derive(Default)]
pub(super) struct Marks(VecDeque<(String, Range)>);

impl Marks {
    pub(super) fn keep(&mut self, term: GhosttyTerminal) -> Option<String> {
        let mut selection = selection();
        if unsafe { ghostty_terminal_get(term, GHOSTTY_TERMINAL_DATA_SELECTION, (&mut selection as *mut GhosttySelection).cast()) } != GHOSTTY_SUCCESS {
            return None;
        }
        let range = Range::track(term, &selection)?;
        let id = format!("{:016x}", std::collections::hash_map::RandomState::new().build_hasher().finish());
        self.0.push_back((id.clone(), range));
        if self.0.len() > MAX_MARKS {
            self.0.pop_front();
        }
        Some(id)
    }

    pub(super) fn reveal(&self, term: GhosttyTerminal, anchor: Option<&str>, text: &str) -> bool {
        if let Some((_, range)) = anchor.and_then(|id| self.0.iter().find(|(key, _)| key == id)) {
            return range.reveal(term, text);
        }
        // A restarted view can still find a retained quote if it identifies one place.
        find_unique(term, text).is_some_and(|range| range.reveal(term, text))
    }
}

fn selection() -> GhosttySelection {
    GhosttySelection { size: std::mem::size_of::<GhosttySelection>(), ..Default::default() }
}

struct Tracked(GhosttyTrackedGridRef);
impl Tracked {
    fn new(term: GhosttyTerminal, coordinate: GhosttyPointCoordinate) -> Option<Self> {
        let mut point = GhosttyPoint { tag: GHOSTTY_POINT_TAG_SCREEN, ..Default::default() };
        point.value.coordinate = coordinate;
        let mut tracked = std::ptr::null_mut();
        (unsafe { ghostty_terminal_grid_ref_track(term, point, &mut tracked) } == GHOSTTY_SUCCESS).then_some(Self(tracked))
    }

    fn snapshot(&self) -> Option<GhosttyGridRef> {
        let mut snapshot = GhosttyGridRef { size: std::mem::size_of::<GhosttyGridRef>(), ..Default::default() };
        (unsafe { ghostty_tracked_grid_ref_snapshot(self.0, &mut snapshot) } == GHOSTTY_SUCCESS).then_some(snapshot)
    }
}

impl Drop for Tracked {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { ghostty_tracked_grid_ref_free(self.0) };
        }
    }
}

struct Range {
    start: Tracked,
    end: Tracked,
    rectangle: bool,
    screen: GhosttyTerminalScreen,
}

impl Range {
    fn track(term: GhosttyTerminal, saved: &GhosttySelection) -> Option<Self> {
        let start = point(term, &saved.start)?;
        let end = point(term, &saved.end)?;
        Some(Self {
            start: Tracked::new(term, start)?,
            end: Tracked::new(term, end)?,
            rectangle: saved.rectangle,
            screen: screen(term),
        })
    }

    fn snapshot(&self) -> Option<GhosttySelection> {
        Some(GhosttySelection {
            start: self.start.snapshot()?,
            end: self.end.snapshot()?,
            rectangle: self.rectangle,
            ..selection()
        })
    }

    fn reveal(&self, term: GhosttyTerminal, text: &str) -> bool {
        if screen(term) != self.screen {
            return false;
        }
        let Some(bounds) = self.snapshot() else { return false };
        if selection_text(term, Some(&bounds)).as_deref() != Some(text) {
            return false;
        }
        let Some((start, end)) = point(term, &bounds.start).zip(point(term, &bounds.end)) else { return false };
        let mut scroll = GhosttyTerminalScrollViewport { tag: GHOSTTY_SCROLL_VIEWPORT_ROW, ..Default::default() };
        scroll.value.row = start.y.min(end.y) as usize;
        unsafe { ghostty_terminal_scroll_viewport(term, scroll) };
        // Moving the viewport can invalidate a snapshot. Resolve its tracked ends again.
        let Some(bounds) = self.snapshot() else { return false };
        unsafe { ghostty_terminal_set(term, GHOSTTY_TERMINAL_OPT_SELECTION, (&bounds as *const GhosttySelection).cast()) == GHOSTTY_SUCCESS }
    }
}

fn point(term: GhosttyTerminal, cell: &GhosttyGridRef) -> Option<GhosttyPointCoordinate> {
    let mut p = GhosttyPointCoordinate::default();
    (unsafe { ghostty_terminal_point_from_grid_ref(term, cell, GHOSTTY_POINT_TAG_SCREEN, &mut p) } == GHOSTTY_SUCCESS).then_some(p)
}

fn screen(term: GhosttyTerminal) -> GhosttyTerminalScreen {
    let mut screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
    unsafe { ghostty_terminal_get(term, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, (&mut screen as *mut GhosttyTerminalScreen).cast()) };
    screen
}

struct Search(GhosttySearch);
impl Drop for Search {
    fn drop(&mut self) {
        unsafe { ghostty_search_free(self.0) };
    }
}

fn find_unique(term: GhosttyTerminal, text: &str) -> Option<Range> {
    if text.trim().is_empty() {
        return None;
    }
    let mut search = std::ptr::null_mut();
    unsafe {
        if ghostty_search_new(std::ptr::null(), &mut search, term) != GHOSTTY_SUCCESS {
            return None;
        }
        let search = Search(search);
        let needle = GhosttyString { ptr: text.as_ptr(), len: text.len() };
        if ghostty_search_set(search.0, GHOSTTY_SEARCH_OPT_NEEDLE, (&needle as *const GhosttyString).cast()) != GHOSTTY_SUCCESS
            || ghostty_search_run(search.0) != GHOSTTY_SUCCESS
        {
            return None;
        }
        let mut count = 0usize;
        if ghostty_search_get(search.0, GHOSTTY_SEARCH_DATA_TOTAL_MATCHES, (&mut count as *mut usize).cast()) != GHOSTTY_SUCCESS || count != 1 {
            return None;
        }
        let mut selection = selection();
        let mut matches = GhosttySelectionBuffer { ptr: &mut selection, cap: 1, len: 0 };
        if ghostty_search_get(search.0, GHOSTTY_SEARCH_DATA_MATCHES, (&mut matches as *mut GhosttySelectionBuffer).cast()) != GHOSTTY_SUCCESS || matches.len != 1 {
            return None;
        }
        Range::track(term, &selection)
    }
}
