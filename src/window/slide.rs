//! A fixed-size node opening and closing: it keeps its size inside and slides
//! out of the space it leaves, so a mod in it never redraws for the motion. A
//! closing node stays on screen until it has gone, though `hidden` is already true.

use super::*;

/// Codex's panel spring, 0.5 s with 0.1 bounce, as a period (s) and a damping ratio.
const PERIOD: f32 = 0.37;
const DAMPING: f32 = 0.9;
const SETTLED: f32 = 0.65;

pub struct Slide {
    from: f32,
    to: f32,
    start: Instant,
}

/// Where a spring from 0 to 1 is after `t` seconds.
fn spring(t: f32) -> f32 {
    let frequency = std::f32::consts::TAU / PERIOD;
    let decay = DAMPING * frequency;
    let ring = frequency * (1.0 - DAMPING * DAMPING).sqrt();
    1.0 - (-decay * t).exp() * ((ring * t).cos() + decay / ring * (ring * t).sin())
}

impl Slide {
    /// How open it is: 0 shut, 1 open.
    pub fn now(&self) -> f32 {
        self.from + (self.to - self.from) * spring(self.start.elapsed().as_secs_f32())
    }

    fn running(&self) -> bool {
        self.start.elapsed().as_secs_f32() < SETTLED
    }
}

impl AppWindow {
    /// A slide already under way turns round from where it is.
    pub(super) fn start_slide(&mut self, id: &str, open: bool) {
        let from = self.slides.get(id).map_or(if open { 0.0 } else { 1.0 }, Slide::now);
        self.slides.insert(id.to_owned(), Slide { from, to: if open { 1.0 } else { 0.0 }, start: Instant::now() });
    }

    pub(super) fn tick_slides(&mut self, window: &mut Window) {
        self.slides.retain(|_, slide| slide.running());
        if !self.slides.is_empty() {
            window.request_animation_frame();
        }
    }
}

/// `slot` cut down to how open it is, around `content` at full size. `seam` is the
/// gap beside it, which closes with it. The first child goes out by its start edge.
pub(super) fn slid(slot: Div, n: &Node, axis: Axis, open: f32, seam: f32, first: bool, content: AnyElement) -> Div {
    let Some(Span::Px { px: full }) = n.size else { return slot.child(content) };
    let full = full.max(n.min.unwrap_or(0.0));
    let (row, shown, pull) = (axis == Axis::Row, settings::z(full * open.max(0.0)), px(seam * (open - 1.0)));
    let inner = div().relative().flex().flex_none();
    let inner = if row { inner.w(settings::z(full)).h_full() } else { inner.h(settings::z(full)).w_full() };
    let slot = slot.overflow_hidden().opacity(open.clamp(0.0, 1.0)).when(first, |d| d.justify_end());
    let slot = match (row, first) {
        (true, true) => slot.w(shown).min_w(px(0.0)).mr(pull),
        (true, false) => slot.w(shown).min_w(px(0.0)).ml(pull),
        (false, true) => slot.h(shown).min_h(px(0.0)).mb(pull),
        (false, false) => slot.h(shown).min_h(px(0.0)).mt(pull),
    };
    slot.child(inner.child(content))
}

#[cfg(test)]
mod tests {
    use super::{Duration, Instant, SETTLED, Slide, spring};

    #[test]
    fn the_spring_starts_still_and_rests_at_its_end() {
        assert!(spring(0.0).abs() < 1e-5);
        assert!(spring(0.05) < 0.3);
        assert!((spring(SETTLED) - 1.0).abs() < 0.002);
    }

    #[test]
    fn the_spring_barely_overshoots() {
        let most = (0..200).map(|i| spring(i as f32 * 0.005)).fold(0.0, f32::max);
        assert!(most > 1.0 && most < 1.005, "{most}");
    }

    #[test]
    fn a_shut_slide_ends_where_it_was_going() {
        let slide = Slide { from: 0.4, to: 0.0, start: Instant::now() - Duration::from_secs(2) };
        assert!(slide.now().abs() < 0.001);
        assert!(!slide.running());
    }
}
