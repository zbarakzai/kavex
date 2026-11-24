//! Ordinary drags select output; Alt keeps a tracked program's drag controls.
use gpui::{Modifiers, MouseDownEvent, Pixels, Point};

pub(super) fn selects_text(tracking: bool, modifiers: Modifiers) -> bool {
    !tracking || modifiers.shift || !modifiers.alt
}

/// A tracked program's plain click waits until we know it wasn't a text selection.
pub(super) struct ProgramClick {
    press: MouseDownEvent,
    dragged: bool,
}

impl ProgramClick {
    pub(super) fn new(press: MouseDownEvent) -> Self {
        Self { press, dragged: false }
    }

    pub(super) fn move_to(&mut self, at: Point<Pixels>) {
        let delta = at - self.press.position;
        self.dragged |= f32::from(delta.x).abs() > 4.0 || f32::from(delta.y).abs() > 4.0;
    }

    pub(super) fn release(mut self, at: Point<Pixels>, selected: bool) -> Option<MouseDownEvent> {
        self.move_to(at);
        (!selected && !self.dragged).then_some(self.press)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{point, px, MouseButton};

    fn press() -> MouseDownEvent {
        MouseDownEvent { button: MouseButton::Left, position: point(px(100.0), px(100.0)), ..Default::default() }
    }

    #[test]
    fn ordinary_drags_select_even_when_the_program_tracks_the_mouse() {
        for tracking in [false, true] {
            assert!(selects_text(tracking, Modifiers::default()));
            assert!(selects_text(tracking, Modifiers { shift: true, ..Default::default() }));
        }
        assert!(!selects_text(true, Modifiers { alt: true, ..Default::default() }));
        assert!(selects_text(false, Modifiers { alt: true, ..Default::default() }));
        assert!(selects_text(true, Modifiers { alt: true, shift: true, ..Default::default() }));
    }

    #[test]
    fn a_plain_click_is_forwarded_at_its_original_position() {
        let click = ProgramClick::new(press()).release(point(px(102.0), px(101.0)), false).unwrap();
        assert_eq!(click.position, press().position);
        assert_eq!(click.button, MouseButton::Left);
    }

    #[test]
    fn a_drag_back_to_its_start_is_never_forwarded_as_a_click() {
        let mut click = ProgramClick::new(press());
        click.move_to(point(px(120.0), px(100.0)));
        assert!(click.release(press().position, false).is_none());
    }

    #[test]
    fn word_selection_does_not_also_click_the_program() {
        assert!(ProgramClick::new(press()).release(press().position, true).is_none());
    }
}
