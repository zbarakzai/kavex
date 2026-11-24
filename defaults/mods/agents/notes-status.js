// The notes owner tells the footer about the visible session; notes stay in their own files.
import { setShared, shared } from "herdr";
import { noteScope, noteSource, noteSourceKey } from "./notes-scope.js";
import { listNotes } from "./notes-store.js";

export class NotesStatus {
  start(cx) {
    cx.timer.after(0, (cx) => this.refresh(cx));
    // Claude can start a new conversation without changing its process or terminal label.
    cx.timer.every(2000, (cx) => this.refresh(cx));
  }

  follow(cx) {
    const key = noteSourceKey(noteSource()), changed = shared("terminal.notes.changed");
    if (key === this.following && changed === this.changed) return;
    this.following = key;
    this.changed = changed;
    cx.timer.after(0, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    const source = noteSource(), key = noteSourceKey(source), changed = shared("terminal.notes.changed");
    if (this.loading?.key === key && this.loading.changed === changed) return;
    const reading = { key, changed };
    this.loading = reading;
    if (!source) {
      if (shared("terminal.notes") != null) setShared("terminal.notes", null);
      this.loading = null;
      return;
    }
    cx.spawn(async (cx) => {
      try {
        const scope = await noteScope(source);
        const count = scope ? (await listNotes(scope)).length : 0;
        if (this.loading !== reading || noteSourceKey(noteSource()) !== key) return;
        const status = { key, source, scope, count };
        if (JSON.stringify(shared("terminal.notes")) !== JSON.stringify(status)) setShared("terminal.notes", status);
      } catch {
        // A failed read must not retain a previous conversation's availability.
        if (this.loading === reading && noteSourceKey(noteSource()) === key && shared("terminal.notes") != null) {
          setShared("terminal.notes", null);
        }
      } finally {
        if (this.loading === reading) this.loading = null;
      }
    });
  }
}
