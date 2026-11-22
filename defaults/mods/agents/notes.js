import { div, svg } from "gpui-kit";
import * as ui from "gpui-base";
import { closeOverlay, focused, notify, openOverlay, revealTerminalNote, terminals, theme } from "herdr";
import { noteScope, terminalScope } from "./notes-scope.js";
import { listNotes, saveNote } from "./notes-store.js";

const NOTE_LINE = 18;
const NOTE_GAP = 4;
const NOTE_PADDING = 7;
const noteHeight = (note) => NOTE_PADDING * 2 + NOTE_LINE + (note.comment ? NOTE_LINE + NOTE_GAP : 0);

const icon = (name) => svg(`mods/workspace-chrome/icons/${name}.svg`).size(16).flex_none();

function button(t, id, label, click, { primary = false, disabled = false, glyph } = {}) {
  return ui.h_flex().id(id).h(32).px(10).gap(6).flex_none().items_center().rounded(7)
    .bg(primary && !disabled ? t.solid : t.raised)
    .text_color(primary && !disabled ? t.solid_foreground : disabled ? t.dim : t.foreground)
    .text_size(12.5)
    .when(!disabled, (el) => el.cursor_pointer().hover((el) => el.opacity(0.85)).on_click(click))
    .when(Boolean(glyph), (el) => el.child(icon(glyph)))
    .child(label);
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
    if (p.notes === "edit") {
      this.comment = ui.TextareaState.new({ placeholder: "Add a comment (optional)", rows: 3 });
      this.comment.focus();
    } else {
      this.search = ui.InputState.new({ placeholder: "Find a note…" });
      this.search.on("change", (_e, cx) => { this.at = 0; cx.notify(); });
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

  edit() {
    const { text, anchor } = this.p;
    this.close();
    openOverlay({ mod: "agents", kind: "dialog", width: 460, props: { notes: "edit", source: this.source, text, anchor } });
  }

  save(cx) {
    if (this.busy || !this.scope) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await saveNote(this.scope, { text: this.p.text, comment: this.comment.value(), anchor: this.p.anchor });
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
    if (!note || this.revealing) return;
    this.revealing = true;
    cx.spawn(async (cx) => {
      const terminal = this.source.address;
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

  keys(e, cx) {
    if (e.key === "escape") {
      if (this.detail) {
        this.detail = null;
        this.search.focus();
        cx.notify();
      } else {
        this.close();
      }
      cx.stop_propagation();
    }
    if (this.search && !this.detail && (e.key === "up" || e.key === "down")) {
      const last = Math.max(0, this.matches().length - 1);
      this.at = Math.max(0, Math.min(last, this.at + (e.key === "up" ? -1 : 1)));
      cx.notify();
      cx.stop_propagation();
    }
  }

  excerpt(t, text) {
    return div().id("notes-excerpt").w_full().max_h(120).overflow_y_scrollbar().p(10)
      .rounded(7).bg(t.background).border_1().border_color(t.border).text_size(12.5).text_color(t.muted)
      .child(text);
  }

  editor(t) {
    return [
      this.excerpt(t, this.p.text),
      ui.Textarea.new(this.comment).w_full().h(90).p(10).rounded(7)
        .bg(t.background).border_1().border_color(t.input).text_size(13).text_color(t.foreground),
      ui.h_flex().w_full().gap(8).justify_end()
        .child(button(t, "cancel-note", "Cancel", () => this.close()))
        .child(button(t, "save-note", "Save note", (_e, cx) => this.save(cx), { primary: true, disabled: this.busy || !this.scope })),
    ];
  }

  library(t) {
    if (this.detail) {
      return [
        this.excerpt(t, this.detail.text),
        ...(this.detail.comment ? [div().text_size(13).child(this.detail.comment)] : []),
        ui.h_flex().gap(8).justify_end()
          .child(button(t, "notes-back", "Back", (_e, cx) => { this.detail = null; this.search.focus(); cx.notify(); }))
          .child(button(t, "copy-note", "Copy excerpt", (_e, cx) => this.copy(this.detail.text, cx))),
      ];
    }
    const matches = this.matches();
    const listHeight = matches.reduce((height, note) => height + noteHeight(note) + NOTE_GAP, -NOTE_GAP);
    let empty = this.scope?.session && !this.showTerminal ? "No notes for this session yet." : "No notes for this terminal yet.";
    if (this.currentItems().length) empty = "No matching notes.";
    if (!this.scope) empty = "Focus a terminal to see its notes.";
    if (this.busy) empty = "Loading notes…";
    return [
      ui.Input.new(this.search).w_full().h(34).px(10).rounded(7)
        .bg(t.background).border_1().border_color(t.input).text_size(13).text_color(t.foreground),
      matches.length
        ? ui.v_flex().id("notes-list").w_full().h(Math.min(290, listHeight)).min_h(0).flex_shrink(1)
          .overflow_y_scrollbar().gap(NOTE_GAP)
          .children(matches.map((note, i) => ui.v_flex().id(note.id).h(noteHeight(note)).px(10).py(NOTE_PADDING)
            .gap(NOTE_GAP).flex_none().rounded(7)
            .cursor_pointer().when(i === this.at, (el) => el.bg(t.selected))
            .hover((el) => el.bg(t.hover)).on_click((_e, cx) => this.choose(note, cx))
            .child(div().truncate().text_size(13).line_height(`${NOTE_LINE}px`).child(note.comment || note.text))
            .when(Boolean(note.comment), (el) => el.child(div().truncate().text_size(12)
              .line_height(`${NOTE_LINE}px`).text_color(t.muted).child(note.text)))))
        : div().py(12).text_size(13).text_color(t.muted).child(empty),
    ];
  }

  render() {
    const t = theme();
    if (this.p.notes === "selection") {
      return ui.h_flex().w_full().p(4).gap(4)
        .child(button(t, "add-note", "Add note", () => this.edit(), { glyph: "plus" }))
        .child(button(t, "copy-selection", "Copy", (_e, cx) => { this.copy(this.p.text, cx); this.close(); }));
    }
    const edit = this.p.notes === "edit";
    let title = this.scope?.terminalRun || this.showTerminal ? "Terminal notes" : "Session notes";
    if (this.detail) title = "Saved excerpt";
    if (edit) title = "Add note";
    return ui.v_flex().id("terminal-notes").track_focus(this.focus).on_key_down((e, cx) => this.keys(e, cx))
      .w_full().min_h(0).p(14).gap(10).text_color(t.foreground)
      .child(ui.h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(15).font_semibold().child(title))
        .when(!this.detail && Boolean(this.runItems?.length), (el) => el.child(button(t, "notes-switch",
          this.showTerminal ? "Session notes" : "Terminal notes", (_e, cx) => {
            this.showTerminal = !this.showTerminal;
            this.at = 0;
            cx.notify();
          }, { disabled: this.revealing })))
        .child(button(t, "notes-close", "Close", () => this.close())))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .children(edit ? this.editor(t) : this.library(t));
  }
}
