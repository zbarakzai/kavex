// Reading a Markdown file: rendered or raw, with its outline and find. The panel decides which file
// is open and when it changed; this decides how it reads.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input, MarkdownState, TextView, Popover, HoverCard } from "gpui-base";
import { theme } from "herdr";
import { MONO, soft } from "./look.js";
import { READER_FONT, headingFor } from "./markdown.js";

const OUTLINE_ROWS = 500, TIP_DELAY = 500, PARSE_TRIES = 12, PARSE_WAIT = 120;

const syntaxColors = (t) => ({ keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 });

export const readerLook = (t) => ({
  foreground: t.text_secondary,
  heading: t.foreground,
  muted: t.muted,
  // Blue, as links are: orange means "you" here. Task boxes take this color too.
  link: t.ansi4,
  code: t.well,
  inline_code: t.hover,
  border: t.card_border,
  hover: t.hover_strong,
  // Selections paint over the glyphs, so a solid color hides what's selected.
  selection: soft(t.foreground, "26"),
  alerts: { note: t.ansi4, tip: t.ansi2, important: t.ansi5, warning: t.ansi3, caution: t.failed },
  mark: soft(t.ansi3, "40"),
  mark_active: soft(t.ansi4, "80"),
  syntax: syntaxColors(t),
  copy_icon: "mods/workspace-chrome/icons/copy.svg",
  copied_icon: "mods/workspace-chrome/icons/check.svg",
});

export const rememberedMode = () => (localStorage.getItem("markdown") === "raw" ? "raw" : "preview");

export function codeState(path, text) {
  return EditorState.new({ language: path.includes(".") ? path.split(".").pop() : "txt", readonly: true,
    value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
    font_family: MONO, font_size: 11.5, syntax: syntaxColors(theme()) });
}

export function iconButton(id, name, t, { size = 26, radius = 13, active = false } = {}) {
  return h_flex().id(id).size(size).flex_none().items_center().justify_center().rounded(radius).cursor_pointer().text_color(active ? t.foreground : t.muted).when(active, el => el.bg(t.pill_selected))
    .when(!active, el => el.hover(s => s.bg(t.hover_strong).text_color(t.foreground))).child(svg(`mods/workspace-chrome/icons/${name}.svg`).size(16));
}

export class Reader {
  constructor({ path, text, folder, mode, onLink }) {
    Object.assign(this, { path, text, mode, onLink });
    this.doc = MarkdownState.new({ value: text, folder });
    this.raw = mode === "raw" ? codeState(path, text) : null;
    this.outlineOpen = false; this.finding = false; this.findInput = null; this.found = 0; this.foundAt = 0;
  }

  release() {
    this.released = true;
    this.doc.release(); this.raw?.release();
  }

  // Both views take new text themselves, so the panel doesn't redraw for it.
  update(text, cx) {
    if (text === this.text) return;
    this.text = text;
    this.doc.set_value(text);
    this.raw?.set_value(text);
    if (this.finding) this.findAgain(cx);
  }

  // Matches are places in the text that was there; the new ones exist once its parse lands.
  findAgain(cx, tries = PARSE_TRIES) {
    if (this.released || !this.finding) return;
    const again = this.doc.find_again();
    if (again) { this.found = again.found; this.foundAt = again.at; return cx.notify(); }
    if (tries > 0) cx.timer.after(PARSE_WAIT, cx => this.findAgain(cx, tries - 1));
  }

  setMode(mode) {
    this.mode = mode; this.outlineOpen = false;
    if (this.finding) this.endFind();
    if (mode === "raw" && !this.raw) this.raw = codeState(this.path, this.text);
  }

  choose(mode, cx) {
    localStorage.setItem("markdown", mode);
    this.setMode(mode);
    cx.notify();
  }

  // A document's headings exist once its parse lands, which a large one does a little later.
  jump(anchor, cx, tries = PARSE_TRIES) {
    if (this.released) return;
    const heading = headingFor(this.doc.outline(), anchor);
    if (heading) return this.doc.scroll_to(heading.block);
    if (tries > 0) cx.timer.after(PARSE_WAIT, cx => this.jump(anchor, cx, tries - 1));
  }

  key(e, cx) {
    if (e.key !== "f" || this.mode !== "preview" || !(e.modifiers.platform || e.modifiers.control)) return;
    cx.stop_propagation();
    this.openFind(cx);
  }

  openFind(cx) {
    if (this.finding) return this.findInput.focus();
    this.finding = true; this.found = 0; this.foundAt = 0;
    this.findInput = InputState.new({ placeholder: "Find in this file" });
    this.findInput.on("change", (_e, cx) => { this.found = this.doc.find(this.findInput.value()); this.foundAt = this.found ? 1 : 0; cx.notify(); });
    this.findInput.on("submit", (_e, cx) => this.step(1, cx));
    this.findInput.focus();
    cx.notify();
  }

  step(by, cx) {
    this.foundAt = this.doc.find_step(by);
    cx.notify();
  }

  endFind() {
    this.finding = false; this.found = 0; this.findInput = null;
    this.doc.find("");
  }

  closeFind(cx) {
    this.endFind();
    cx.notify();
  }

  tipped(id, tip, trigger, t) {
    return HoverCard.new(`tip-${id}`).open_delay(TIP_DELAY).close_delay(0).trigger(trigger)
      .when(!this.outlineOpen, el => el.content(div().mt(6).px(9).py(5).rounded(8).bg(t.raised).border_1().border_color(t.border).shadow_md().text_size(12).text_color(t.foreground).whitespace_nowrap().child(tip)));
  }

  outline(t) {
    const open = this.outlineOpen;
    return this.tipped("files-outline", "Outline", Popover.new("files-outline-menu").anchor("top_right").open(open)
      .on_open_change((next, cx) => { this.outlineOpen = next; cx.notify(); })
      .trigger(iconButton("files-outline", "file-tree", t, { active: open })).when(open, el => el.content(this.headings(t))), t);
  }

  headings(t) {
    const rows = this.doc.outline().slice(0, OUTLINE_ROWS), top = Math.min(...rows.map(row => row.level));
    return v_flex().id("files-headings").w(280).max_h(420).overflow_y_scrollbar().p(6).gap(1).rounded(14).bg(t.raised).border_1().border_color(t.border).shadow_lg().text_size(13)
      .when(!rows.length, el => el.child(div().px(10).py(6).text_color(t.dim).child("No headings")))
      .children(rows.map((row, i) => h_flex().id(`files-heading-${i}`).h(30).flex_none().pl(10 + (row.level - top) * 14).pr(10).items_center().rounded(8).cursor_pointer().hover(s => s.bg(t.hover))
        .text_color(row.level === top ? t.foreground : t.muted)
        .on_click((_e, cx) => { this.outlineOpen = false; this.doc.scroll_to(row.block); cx.notify(); })
        .child(div().flex_1().min_w(0).truncate().child(row.text))));
  }

  modes(t) {
    const tab = (mode, label) => {
      const selected = this.mode === mode;
      return h_flex().id(`files-${mode}`).h(24).px(10).flex_none().items_center().rounded(12).cursor_pointer().text_size(12).text_color(selected ? t.foreground : t.muted)
        .when(selected, el => el.bg(t.pill_selected)).when(!selected, el => el.hover(s => s.text_color(t.foreground)))
        .on_click((_e, cx) => this.choose(mode, cx)).child(label);
    };
    return h_flex().flex_none().gap(2).p(2).items_center().rounded(999).bg(t.pill).border_1().border_color(t.pill_ring).child(tab("preview", "Preview")).child(tab("raw", "Raw"));
  }

  tools(t) {
    const find = iconButton("files-find", "search", t, { active: this.finding }).on_click((_e, cx) => (this.finding ? this.closeFind(cx) : this.openFind(cx)));
    return h_flex().flex_none().gap(4).items_center()
      .when(this.mode === "preview", el => el.child(this.outline(t)).child(this.tipped("files-find", "Find", find, t)))
      .child(this.modes(t));
  }

  findBar(t) {
    const small = { size: 24, radius: 7 }, asked = Boolean(this.findInput?.value());
    const step = (id, name, by) => iconButton(id, name, t, small).on_click((_e, cx) => this.step(by, cx));
    return h_flex().h(34).flex_none().mx(10).mb(4).pl(10).pr(4).gap(6).items_center().rounded(10).bg(t.well).border_1().border_color(t.card_border)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.closeFind(cx); } })
      .child(svg("mods/workspace-chrome/icons/search.svg").size(16).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).child(Input.new(this.findInput).h_full().text_size(12.5).text_color(t.foreground)))
      .when(asked, el => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(this.found ? `${this.foundAt} of ${this.found}` : "No matches")))
      .when(this.found > 1, el => el.child(step("files-find-back", "chevron-left", -1)).child(step("files-find-next", "chevron-right", 1)))
      .child(iconButton("files-find-close", "close", t, small).on_click((_e, cx) => this.closeFind(cx)));
  }

  // The look follows the theme; handing it over only when it changes keeps a render free.
  sendLook(t) {
    const look = readerLook(t), sent = JSON.stringify(look);
    if (sent === this.lookSent) return;
    this.lookSent = sent;
    this.doc.set_look(look);
  }

  body(t) {
    if (this.mode === "raw") return Editor.new(this.raw).flex_1().min_h(0);
    this.sendLook(t);
    return v_flex().flex_1().min_h(0)
      .when(this.finding, el => el.child(this.findBar(t)))
      .child(div().flex_1().min_h(0).pl(20).pr(10).pb(10).child(TextView.state(this.doc).scrollable(true).selectable(true).size_full().font_family(READER_FONT).text_size(13.5)
        .on_link_click((url, cx) => this.onLink(url, cx))));
  }
}
