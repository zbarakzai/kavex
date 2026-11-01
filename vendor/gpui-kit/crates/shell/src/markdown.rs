//! HERDR: a Markdown document a script keeps while someone reads it. The text
//! stays on this side, so a render costs the script nothing however long the
//! document is; parsing runs off the main thread and only what's on screen draws.

use std::{
    cell::RefCell,
    collections::HashMap,
    hash::{DefaultHasher, Hash, Hasher},
    ops::Range,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, LazyLock},
    time::Duration,
};

use gpui::{
    AnyElement, App, AppContext as _, ClipboardItem, Entity, FontWeight, HighlightStyle, Hsla,
    InteractiveElement as _, IntoElement as _, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, StyleRefinement, Styled as _, Window, div, px, rems, svg,
};
use gpui_base::text::{
    CodeBlock, MarkdownExtensions, RangeHighlight, TextView, TextViewState, TextViewStyle,
};

use crate::{syntax::SyntaxStyles, value::Bridged};

/// More marks than this tell a reader nothing, and each one costs a repaint.
const MAX_FOUND: usize = 5000;
const COPIED_FOR: Duration = Duration::from_millis(1200);

type Highlighter =
    Arc<dyn Fn(&CodeBlock) -> Vec<(Range<usize>, HighlightStyle)> + Send + Sync + 'static>;

static EXTENSIONS: LazyLock<MarkdownExtensions> =
    LazyLock::new(|| MarkdownExtensions::default().frontmatter());

#[derive(serde::Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct MarkdownOptions {
    pub value: String,
    /// Where a document's relative images are. Without it they don't load.
    pub folder: Option<String>,
}

/// A document's look, as the script gives it: colors from its theme.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LookSpec {
    foreground: String,
    heading: String,
    muted: String,
    link: String,
    code: String,
    inline_code: String,
    border: String,
    hover: String,
    selection: String,
    alerts: [String; 5],
    mark: String,
    mark_active: String,
    syntax: HashMap<String, String>,
    copy_icon: String,
    copied_icon: String,
}

#[derive(Clone)]
struct Controls {
    muted: Hsla,
    foreground: Hsla,
    hover: Hsla,
    copy_icon: SharedString,
    copied_icon: SharedString,
}

pub(crate) struct MarkdownLook {
    style: TextViewStyle,
    highlighter: Highlighter,
    controls: Controls,
    mark: Hsla,
    mark_active: Hsla,
}

fn color(value: &str) -> crate::error::Result<Hsla> {
    Bridged::Str(value.to_owned()).as_color()
}

impl MarkdownLook {
    pub(crate) fn new(spec: LookSpec) -> crate::error::Result<Self> {
        let (foreground, heading) = (color(&spec.foreground)?, color(&spec.heading)?);
        let (muted, border) = (color(&spec.muted)?, color(&spec.border)?);
        let mut alerts = [Hsla::default(); 5];
        for (slot, value) in alerts.iter_mut().zip(&spec.alerts) {
            *slot = color(value)?;
        }
        let mut syntax = HashMap::new();
        for (name, value) in &spec.syntax {
            syntax.insert(name.clone(), color(value)?);
        }
        let syntax = SyntaxStyles(syntax);
        let mut table = StyleRefinement::default().rounded(px(10.));
        table.overflow.x = Some(gpui::Overflow::Scroll);
        let style = TextViewStyle::default()
            .with_foreground(foreground)
            .with_muted_foreground(muted)
            .with_link(color(&spec.link)?)
            .with_selection(color(&spec.selection)?)
            .with_code_background(color(&spec.code)?)
            .with_border(border)
            .with_paragraph_gap(rems(0.85))
            .with_alerts(alerts)
            .with_dark(gpui::Rgba::from(foreground).r > 0.5)
            .with_inline_code(HighlightStyle {
                background_color: Some(color(&spec.inline_code)?),
                ..Default::default()
            })
            .with_heading(move |level| {
                let refinement = StyleRefinement::default().text_color(heading);
                match level {
                    1 | 2 => refinement.font_weight(FontWeight::SEMIBOLD),
                    _ => refinement.font_weight(FontWeight::MEDIUM),
                }
            })
            .with_code_block(StyleRefinement::default().rounded(px(10.)))
            .with_table(table);
        Ok(Self {
            style,
            highlighter: Arc::new(move |block: &CodeBlock| {
                let language = block.lang().unwrap_or_default();
                crate::syntax::highlight_block(&language, &block.code(), &syntax)
            }),
            controls: Controls {
                muted,
                foreground,
                hover: color(&spec.hover)?,
                copy_icon: spec.copy_icon.into(),
                copied_icon: spec.copied_icon.into(),
            },
            mark: color(&spec.mark)?,
            mark_active: color(&spec.mark_active)?,
        })
    }
}

#[derive(Default)]
struct Found {
    ranges: Vec<Range<usize>>,
    active: usize,
}

pub(crate) struct MarkdownDocument {
    pub(crate) state: Entity<TextViewState>,
    pub(crate) folder: Option<PathBuf>,
    look: RefCell<Option<Rc<MarkdownLook>>>,
    found: RefCell<Found>,
}

impl MarkdownDocument {
    pub(crate) fn new(options: MarkdownOptions, cx: &mut App) -> Self {
        // Its first load takes tens of milliseconds, not to be spent inside a frame.
        std::thread::spawn(crate::syntax::preload);
        let extensions = Arc::new(EXTENSIONS.clone());
        let state = cx.new(|cx| {
            let mut state = TextViewState::markdown("", cx);
            state.set_markdown_extensions(extensions, cx);
            state.set_keep_place(true);
            state.set_text(&options.value, cx);
            state
        });
        Self {
            state,
            folder: options.folder.map(PathBuf::from),
            look: RefCell::default(),
            found: RefCell::default(),
        }
    }

    pub(crate) fn set_look(&self, look: MarkdownLook) {
        *self.look.borrow_mut() = Some(Rc::new(look));
    }

    pub(crate) fn view(&self) -> TextView {
        let view = TextView::new(&self.state).markdown_extensions(EXTENSIONS.clone());
        let Some(look) = self.look.borrow().clone() else {
            return view;
        };
        let controls = look.controls.clone();
        view.style(look.style.clone())
            .shared_code_block_highlighter(look.highlighter.clone())
            .code_block_actions(move |block, window, cx| code_controls(&controls, block, window, cx))
    }

    /// Marks every match, ignoring ASCII case, and shows the first. Returns how many.
    pub(crate) fn find(&self, query: &str, cx: &mut App) -> usize {
        let text = self.state.read(cx).rendered_text();
        let ranges = if query.is_empty() {
            Vec::new()
        } else {
            // Lowercasing ASCII moves no byte, so offsets hold for the original.
            let (text, query) = (text.as_str().to_ascii_lowercase(), query.to_ascii_lowercase());
            text.match_indices(&query)
                .take(MAX_FOUND)
                .map(|(at, _)| at..at + query.len())
                .collect()
        };
        let count = ranges.len();
        *self.found.borrow_mut() = Found { ranges, active: 0 };
        self.show_found(cx);
        count
    }

    /// Moves to another match, wrapping around. Returns its number from 1, or 0.
    pub(crate) fn find_step(&self, by: i32, cx: &mut App) -> usize {
        {
            let mut found = self.found.borrow_mut();
            let count = found.ranges.len();
            if count == 0 {
                return 0;
            }
            found.active = (found.active as i64 + by as i64).rem_euclid(count as i64) as usize;
        }
        self.show_found(cx);
        self.found.borrow().active + 1
    }

    fn show_found(&self, cx: &mut App) {
        let found = self.found.borrow();
        let Some(look) = self.look.borrow().clone() else {
            return;
        };
        self.state.update(cx, |state, cx| {
            if found.ranges.is_empty() {
                state.clear_range_highlights(cx);
                return;
            }
            let marks = found.ranges.iter().enumerate().map(|(index, range)| {
                let active = index == found.active;
                RangeHighlight::new(range.clone(), if active { look.mark_active } else { look.mark })
            });
            let _ = state.set_range_highlights(marks.collect::<Vec<_>>(), cx);
            if let Some(range) = found.ranges.get(found.active) {
                let _ = state.reveal_range(range.clone(), cx);
            }
        });
    }
}

/// The corner of a code block: its language and a copy button.
fn code_controls(
    controls: &Controls,
    block: &CodeBlock,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let code = block.code();
    let mut hasher = DefaultHasher::new();
    code.hash(&mut hasher);
    let id = SharedString::from(format!("markdown-copy-{:x}", hasher.finish()));
    let copied = window.use_keyed_state(id.clone(), cx, |_, _| false);
    let shown = *copied.read(cx);
    let hover = controls.hover;
    div()
        .flex()
        .items_center()
        .gap(px(4.))
        .text_color(controls.muted)
        .text_size(px(11.))
        .children(block.lang().filter(|lang| !lang.is_empty()))
        .child(
            div()
                .id(id)
                .size(px(22.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .cursor_pointer()
                .hover(move |style| style.bg(hover))
                .on_click(move |_, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(code.to_string()));
                    copied.update(cx, |copied, cx| {
                        *copied = true;
                        cx.notify();
                    });
                    let copied = copied.downgrade();
                    cx.spawn(async move |cx| {
                        cx.background_executor().timer(COPIED_FOR).await;
                        let _ = copied.update(cx, |copied, cx| {
                            *copied = false;
                            cx.notify();
                        });
                    })
                    .detach();
                })
                .child(
                    svg()
                        .path(if shown {
                            controls.copied_icon.clone()
                        } else {
                            controls.copy_icon.clone()
                        })
                        .size(px(16.))
                        .text_color(if shown {
                            controls.foreground
                        } else {
                            controls.muted
                        }),
                ),
        )
        .into_any_element()
}
