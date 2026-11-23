import { div, svg } from "gpui-kit";
import * as ui from "gpui-base";
import { closeOverlay, focused, notify, openOverlay, revealTerminalNote, terminals, theme, window } from "herdr";
import { MONO } from "./look.js";
import { noteScope, terminalScope } from "./notes-scope.js";
import { listNotes, saveNote } from "./notes-store.js";

const ROW_GAP = 5;
const LIST_HEIGHT = 313;
const COPY_COLUMN = 0.10;
const noteHeight = (note) => note.comment ? 62 : 41;
const firstLine = (text) => text.trimStart().split("\n", 1)[0];

const icon = (name) => svg(`mods/workspace-chrome/icons/${name}.svg`).size(16).flex_none();

function button(t, id, label, click, { primary = false, disabled = false, glyph, iconOnly = false } = {}) {
  const active = primary && !disabled;
  return ui.h_flex().id(id).h(32).px(iconOnly ? 8 : 10).gap(6).flex_none().items_center().justify_center().rounded(7)
    .accessibility_label(label)
    .when(active, (el) => el.bg(t.accent))
    .text_color(active ? t.accent_foreground : disabled ? t.dim : t.foreground)
    .text_size(12).font_medium()
    .when(!disabled, (el) => el.cursor_pointer().hover((el) => active ? el.opacity(0.9) : el.bg(t.hover)).on_click(click))
    .when(Boolean(glyph), (el) => el.child(icon(glyph)))
    .when(!iconOnly, (el) => el.child(label));
}

function keyHint(t, keys, text) {
  return ui.h_flex().gap(5).items_center().flex_none().text_size(11).text_color(t.muted)
    .children(keys.map((key) => div().min_w(16).h(19).px(4).rounded(4).border_1().border_color(t.input).bg(t.raised)
      .font_family(MONO).text_size(10.5).text_center().line_height("17px").child(key)))
    .child(text);
}

function terminalSource(p) {
  if (p.source) return p.source;
  const focus = focused();
  const address = p.terminal ?? focus?.shown ?? focus?.terminal;
  const term = terminals().find((t) => t.address === address);
  if (!term) return null;
  return {
    address, created_ms: term.created_ms, pid: term.pid,
    foreground: { pid: term.foreground?.pid },
    program: { key: term.program?.key },
    labels: { "kavex.session": term.labels?.["kavex.session"] },
  };
}

export class TerminalNotes {
  constructor(p, cx) {
    this.p = p;
    this.source = terminalSource(p);
    this.items = [];
    this.at = 0;
    this.busy = p.notes !== "selection";
    if (!this.busy) return;
    this.focus = cx.focus_handle();
    this.mac = window()?.platform === "macos";
    if (p.notes === "edit") {
      this.comment = ui.TextareaState.new({ placeholder: "What should you remember about this?", rows: 3 });
      this.comment.on("submit", (e, cx) => { if (e.secondary) this.save(cx); });
      this.comment.focus();
    } else {
      this.scroll = ui.VirtualListScrollHandle.new();
      this.search = ui.InputState.new({ placeholder: "Search text or comments…" });
      this.search.on("change", (_e, cx) => this.moveTo(0, cx));
      this.search.on("submit", (_e, cx) => this.choose(this.matches()[this.at], cx));
      this.search.focus();
    }
    // Let the overlay mount before starting host calls that need its view context.
    cx.timer.after(0, (cx) => this.load(cx));
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        this.scope = await noteScope(this.source);
        if (this.p.notes === "browse" && this.scope) {
          this.items = await listNotes(this.scope);
          if (this.scope.session) {
            this.runScope = terminalScope(this.source);
            if (this.runScope) this.runItems = await listNotes(this.runScope);
          }
        }
      } catch (error) {
        this.error = String(error?.message ?? error);
      }
      this.busy = false;
      cx.notify();
    });
  }

  close() { closeOverlay(this.p.overlay); }

  copy(text, cx) {
    cx.write_to_clipboard(text);
  }

  copyNote(note, cx) {
    this.copy(note.text, cx);
    const confirmation = { id: note.id };
    this.copied = confirmation;
    cx.notify();
    cx.timer.after(1300, (cx) => {
      if (this.copied !== confirmation) return;
      this.copied = null;
      cx.notify();
    });
  }

  edit() {
    const { text, anchor } = this.p;
    this.close();
    openOverlay({ mod: "agents", kind: "dialog", width: 520, props: { notes: "edit", source: this.source, text, anchor } });
  }

  save(cx) {
    if (this.busy || !this.scope) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await saveNote(this.scope, { text: this.p.text, comment: this.comment.value().trimEnd(), anchor: this.p.anchor });
        this.close();
        notify({ title: "Note saved", level: "success" });
      } catch (error) {
        this.error = String(error?.message ?? error);
      }
      this.busy = false;
      cx.notify();
    });
  }

  currentItems() {
    return this.showTerminal ? this.runItems : this.items;
  }

  matches() {
    const q = this.search.value().trim().toLowerCase();
    return this.currentItems().filter((note) => !q || note.text.toLowerCase().includes(q) || note.comment.toLowerCase().includes(q));
  }

  choose(note, cx) {
    const terminal = this.source?.address;
    if (!note || !terminal || this.busy || this.revealing) return;
    const at = this.matches().indexOf(note);
    if (at < 0) return;
    this.at = at;
    this.revealing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const source = terminalSource({ terminal });
        const current = this.showTerminal ? terminalScope(source) : await noteScope(source);
        const scope = this.showTerminal ? this.runScope : this.scope;
        if (JSON.stringify(current) === JSON.stringify(scope) && await revealTerminalNote(terminal, note.anchor ?? null, note.text)) {
          this.close();
          return;
        }
      } catch {}
      this.revealing = false;
      this.detail = note;
      this.focus.focus();
      cx.notify();
    });
  }

  moveTo(index, cx) {
    const last = this.matches().length - 1;
    this.at = Math.max(0, Math.min(last, index));
    if (last >= 0) this.scroll.scroll_to_item(this.at, "center");
    cx.notify();
  }

  keys(e, cx) {
    if (e.key === "escape") {
      if (this.detail) this.back(cx);
      else this.close();
      cx.stop_propagation();
      return;
    }
    if (this.comment && e.key === "enter" && (this.mac ? e.modifiers?.platform : e.modifiers?.control)) {
      cx.stop_propagation();
      this.save(cx);
    }
    if (this.search && !this.detail && !this.revealing && (e.key === "up" || e.key === "down")) {
      this.moveTo(this.at + (e.key === "up" ? -1 : 1), cx);
      cx.stop_propagation();
    }
  }

  excerpt(t, text, label) {
    const lines = text.split("\n");
    const height = Math.min(160, lines.reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / 62)), 0) * 19 + 16);
    return ui.v_flex().w_full().min_h(0).rounded(9).bg(t.well ?? t.background).border_1().border_color(t.card_border ?? t.border)
      .child(ui.h_flex().h(32).px(10).gap(7).flex_none().items_center().border_b(1).border_color(t.card_border ?? t.border)
        .child(icon("terminal").text_color(t.accent))
        .child(div().flex_1().text_size(11.5).font_medium().text_color(t.muted).child(label))
        .child(div().font_family(MONO).text_color(t.muted).text_size(10.5)
          .child(`${lines.length} ${lines.length === 1 ? "line" : "lines"}`)))
      .child(div().id("notes-excerpt").w_full().h(height).min_h(0).flex_shrink(1).overflow_y_scrollbar()
        .px(12).py(8).font_family(MONO).text_size(12).line_height("19px").text_color(t.text_secondary ?? t.foreground)
        .child(text));
  }

  editor(t) {
    return [
      this.excerpt(t, this.p.text, "Selected output"),
      ui.h_flex().items_center().gap(7).text_size(12).font_medium()
        .child("Comment").child(div().text_size(11).text_color(t.muted).child("Optional")),
      ui.Textarea.new(this.comment).w_full().h(90).p(10).rounded(7)
        .accessibility_label("Optional comment").bg(t.well ?? t.background).border_1().border_color(t.input)
        .text_size(13).text_color(t.foreground),
      ui.h_flex().w_full().pt(8).gap(6).items_center()
        .child(keyHint(t, [this.mac ? "⌘" : "Ctrl", "↵"], "Save"))
        .child(div().flex_1())
        .child(button(t, "cancel-note", "Cancel", () => this.close()))
        .child(button(t, "save-note", "Save note", (_e, cx) => this.save(cx), { primary: true, disabled: this.busy || !this.scope, glyph: "check" })),
    ];
  }

  row(t, note, active) {
    const accent = t.accent_text ?? t.accent;
    const copied = this.copied?.id === note.id;
    return ui.h_flex().id(note.id).h(noteHeight(note)).w_full().gap(9).items_center().rounded(8)
      .bg(active ? t.row_selected_strong ?? t.selected : t.card ?? t.background)
      .border_1().border_color(active ? t.row_ring ?? t.input : t.card_border ?? t.border)
      .cursor_pointer().hover((el) => el.bg(t.row_active_hover ?? t.hover))
      .child(ui.h_flex().w(22).h_full().flex_none().items_center().gap(5)
        .child(div().w(2).h(note.comment ? 26 : 17).rounded(1).when(active, (el) => el.bg(t.accent)))
        .child(div().font_family(MONO).text_size(16).text_color(active ? accent : t.muted).child("›")))
      .child(ui.v_flex().flex_1().min_w(0).gap(3)
        .when(Boolean(note.comment), (el) => el.child(div().truncate().text_size(13).font_medium()
          .line_height("18px").child(firstLine(note.comment))))
        .child(div().truncate().font_family(MONO).text_size(11.5).line_height("18px")
          .text_color(note.comment ? t.muted : t.foreground).child(firstLine(note.text))))
      .child(ui.h_flex().w(`${COPY_COLUMN * 100}%`).h_full().flex_none().items_center().justify_center()
        .accessibility_label(copied ? "Copied" : "Copy saved text")
        .hover((el) => el.bg(t.row_active_hover ?? t.hover))
        .child(ui.h_flex().size(28).items_center().justify_center().rounded(6)
          .text_color(copied ? t.done : t.muted).hover((el) => el.bg(t.raised).text_color(t.foreground))
          .child(icon(copied ? "check" : "copy"))));
  }

  list(t, matches) {
    // Give the viewport its height so the dialog's fit-to-content pass leaves room for the rows.
    const sizes = matches.map((note) => noteHeight(note) + ROW_GAP);
    const height = sizes.reduce((a, b) => a + b, 0);
    return div().id("notes-list").w_full().relative().h(Math.min(LIST_HEIGHT, height)).min_h(0).flex_shrink(1)
      // Virtual rows share one click handler. The press location identifies the copy column.
      .on_mouse_down("left", (e) => {
        this.copyPressed = Boolean(e.bounds && e.local_position?.x >= e.bounds.width * (1 - COPY_COLUMN));
      })
      .child(ui.v_virtual_list("notes-items", matches.length, sizes, (i) => matches[i].id, (range) =>
        matches.slice(range.start, range.end).map((note, i) =>
          div().h(sizes[range.start + i]).pb(ROW_GAP).child(this.row(t, note, range.start + i === this.at))))
        .size_full().track_scroll(this.scroll)
        .on_item_click((id, cx) => {
          const note = matches.find((note) => note.id === id);
          const copy = this.copyPressed;
          this.copyPressed = false;
          if (!note) return;
          if (copy) this.copyNote(note, cx);
          else this.choose(note, cx);
        }))
      .when(height > LIST_HEIGHT, (el) => el.child(ui.Scrollbar.vertical("notes-items").viewport_from_layout().absolute().inset_0()));
  }

  library(t) {
    if (this.detail) {
      return [
        div().text_size(12).text_color(t.muted).child("The original output is unavailable in this terminal."),
        ...(this.detail.comment ? [div().text_size(14).font_medium().child(this.detail.comment)] : []),
        this.excerpt(t, this.detail.text, "Saved output"),
        ui.h_flex().pt(6).gap(8).justify_between()
          .child(button(t, "notes-back", "Back", (_e, cx) => this.back(cx), { glyph: "chevron-left" }))
          .child(button(t, "copy-note", "Copy excerpt", (_e, cx) => this.copy(this.detail.text, cx), { primary: true, glyph: "copy" })),
      ];
    }
    const matches = this.matches();
    let empty = "Select terminal output and choose Add note.";
    if (this.currentItems().length) empty = "No notes match your search.";
    if (!this.scope) empty = "Focus a terminal, then open %note again.";
    if (this.busy) empty = "Loading notes…";
    return [
      ui.h_flex().h(38).px(10).gap(8).flex_none().items_center().rounded(8)
        .bg(t.well ?? t.background).border_1().border_color(t.input)
        .child(icon("search").text_color(t.muted))
        .child(ui.Input.new(this.search).accessibility_label("Search notes").flex_1().min_w(0).h_full()
          .text_size(13).text_color(t.foreground)),
      matches.length ? this.list(t, matches) : div().px(10).py(18).text_size(12.5).text_color(t.muted).child(empty),
      ...(matches.length ? [ui.h_flex().pt(10).gap(15).items_center().flex_wrap().border_t(1).border_color(t.card_border ?? t.border)
        .child(keyHint(t, ["↑", "↓"], "Select"))
        .child(keyHint(t, ["↵"], this.revealing ? "Finding output…" : "Jump to output"))
        .child(div().flex_1())
        .child(keyHint(t, ["Esc"], "Close"))] : []),
    ];
  }

  back(cx) {
    this.detail = null;
    this.search.focus();
    this.moveTo(this.at, cx);
  }

  render() {
    const t = theme();
    if (this.p.notes === "selection") {
      const action = (id, glyph, label, click) => ui.h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none()
        .accessibility_label(label).cursor_pointer().text_color(t.foreground).hover((el) => el.bg(t.hover)).on_click(click)
        .child(icon(`heroicons/${glyph}`).text_color(t.muted))
        .child(label);
      return ui.v_flex().id("selection-actions").w_full().p(5).gap(2).text_size(12.8)
        .child(action("add-note", "pencil-square", "Add note", () => this.edit()))
        .child(action("copy-selection", "clipboard-document", "Copy", (_e, cx) => { this.copy(this.p.text, cx); this.close(); }));
    }
    const edit = this.p.notes === "edit";
    let title = this.scope?.terminalRun || this.showTerminal ? "Terminal notes" : "Session notes";
    if (this.detail) title = "Saved excerpt";
    if (edit) title = "Add note";
    return ui.v_flex().id("terminal-notes").track_focus(this.focus).on_key_down((e, cx) => this.keys(e, cx))
      .w_full().min_h(0).p(16).gap(11).bg(t.surface).text_color(t.foreground)
      .child(ui.h_flex().gap(9).flex_none().items_center()
        .child(ui.h_flex().size(31).flex_none().items_center().justify_center().rounded(8)
          .bg(t.tile ?? t.raised).child(icon("pin").text_color(t.accent_text ?? t.accent)))
        .child(div().min_w(0).flex_1().truncate().text_size(16).font_semibold().child(title))
        .when(!edit && !this.detail && !this.busy && Boolean(this.currentItems().length), (el) =>
          el.child(div().flex_none().font_family(MONO).text_size(10.5).text_color(t.muted)
            .child(`${this.currentItems().length} saved`)))
        .when(!this.detail && Boolean(this.runItems?.length), (el) => el.child(button(t, "notes-switch",
          this.showTerminal ? "Session notes" : "Terminal notes", (_e, cx) => {
            this.showTerminal = !this.showTerminal;
            this.moveTo(0, cx);
          }, { disabled: this.revealing })))
        .child(button(t, "notes-close", "Close", () => this.close(), { glyph: "close", iconOnly: true })))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .children(edit ? this.editor(t) : this.library(t));
  }
}
