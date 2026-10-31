//! `drag_paths(...paths)` — files dragged out of a script's element.
//!
//! The drag carries [`gpui::ExternalPaths`], the value a drop from outside the
//! app carries, so a listener for that drop receives this one too and needs no
//! way to tell them apart.

use gpui::{
    AppContext as _, Context, IntoElement, ParentElement as _, Pixels, Point, Render, SharedString,
    StatefulInteractiveElement, Styled as _, Window, div,
};
use gpui_base::Theme;

use crate::materialize::Behavior;

/// What follows the pointer. GPUI draws a drag's view from where the element
/// was pressed, so `offset` moves the label from there to the pointer.
struct DragLabel {
    text: SharedString,
    offset: Point<Pixels>,
}

impl Render for DragLabel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tokens = Theme::global(cx).tokens;
        let (colors, radius, spacing) = (tokens.colors, tokens.radius, tokens.spacing);

        div().pl(self.offset.x).pt(self.offset.y).child(
            div()
                .px(spacing.sm)
                .py(spacing.xxs)
                .bg(colors.surface)
                .text_color(colors.surface_foreground)
                .border_1()
                .border_color(colors.border)
                .rounded(radius.md)
                .text_sm()
                .whitespace_nowrap()
                .child(self.text.clone()),
        )
    }
}

/// Wires the drag, when the script asked for one.
pub(in crate::materialize) fn with_drag_paths<E>(element: E, behavior: &Behavior) -> E
where
    E: StatefulInteractiveElement,
{
    let Some(paths) = behavior.drag_paths.clone() else {
        return element;
    };
    element.on_drag(paths, |paths, offset, _, cx| {
        let text = match paths.paths() {
            [path] => path
                .file_name()
                .map_or_else(|| path.to_string_lossy(), |name| name.to_string_lossy())
                .into_owned()
                .into(),
            paths => format!("{} files", paths.len()).into(),
        };
        cx.new(|_| DragLabel { text, offset })
    })
}
