// A lazy file browser for the focused pane's folder, with bounded read-only previews. Right-click
// opens `file-menu`, whose rows come back here as commands. With props { file, on } it's a pane or
// tab showing that one file.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input } from "gpui-base";
import { spaces, panes, focused, terminals, exec, readTextFile, watchFolder, theme, window, props, run, notify, openOverlay, nextCommand, shared } from "herdr";
import * as fs from "fs/promises";
import { look, panelHeader, typeTag, MONO } from "./look.js";
import { baseName, parentOf, native, quoted, badName, create, move, trash, reveal, cd, WASTE } from "./ops.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    // PowerShell costs a new process per folder. The app's own reader costs none, but stops at the home folder.
    try {
      const found = await fs.readdir(path, { withFileTypes: true });
      return found.filter(e => e.name !== ".git").slice(0, 501).map(e => ({ name: e.name, dir: e.isDirectory() }));
    } catch {}
    const r = await exec("powershell", ["-NoProfile", "-Command", "& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    const { file, on } = props() ?? {};
    if (file) {
      this.pinned = true; this.root = parentOf(file); this.on = on ?? null; this.context = {};
      this.show(baseName(file), cx);
      return;
    }
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    cx.spawn(async cx => {
      for (;;) {
        const name = await nextCommand();
        try { await this.command(name, cx); }
        catch (e) { notify({ title: "Files", body: e.message ?? String(e), level: "error" }); }
        cx.notify();
      }
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && (this.pinned || key() === context.key);
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path && (!p || this.folders.has(p))).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.edit = null; this.target = null;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  // Opens a folder and, as the tree joins a folder holding only one folder, any such below it.
  async open(path, context) {
    await this.loadFolder(path, context);
    const inside = this.entries.get(path);
    if (inside?.length !== 1 || !inside[0].dir || !this.folders.has(path)) return;
    const next = `${path}/${inside[0].name}`;
    this.folders.add(next);
    await this.open(next, context);
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) this.folders.delete(folder);
    } else {
      this.folders.add(path);
      if (!this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.open(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: MONO, font_size: 11.5,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  full(path) { return path ? `${this.root}/${path}` : this.root; }

  menu(path, dir, cx) {
    this.target = { path, dir, context: this.context, at: Date.now() };
    openOverlay({ mod: "file-menu", kind: "popup", width: 236, height: 440, props: { from: "files", dir, root: !path, local: !this.on } });
    cx.notify();
  }

  // The row whose menu is open: it stays marked with the pointer on the menu.
  menuOpen(path) {
    if (this.target?.path !== path) return false;
    const shut = shared("popup.closed");
    return !(shut?.from === "files" && shut.at >= this.target.at);
  }

  async command(name, cx) {
    const target = this.target;
    if (!target || target.context !== this.context) return;
    const { path, dir } = target, full = this.full(path), on = this.on, space = location().space;
    const terminal = terminals().find(t => t.address === focused()?.terminal);
    const file = { file: full, on };
    switch (name) {
      case "new": return this.begin({ kind: "new", folder: path }, "", cx);
      case "rename": return this.begin({ kind: "rename", path, dir }, baseName(path), cx);
      case "delete": return this.ask(target);
      case "remove": return this.remove(target, cx);
      case "cd": return terminal && cd(terminal.address, full, on);
      case "tab": return dir ? run("tab.new", { space, folder: full }) : run("tab.new", { space, name: baseName(path), mod: "files", props: file });
      case "pane": return run("pane.split", { direction: "right", mod: "files", props: file });
      case "reveal": return reveal(full);
      case "attach": return terminal && this.attach(terminal, target, cx);
      case "copy": return cx.write_to_clipboard(native(full, on));
      case "relative": return cx.write_to_clipboard(native(path, on));
    }
  }

  // Mods can only put text in a terminal, unsubmitted, by pasting. What was copied comes back
  // after, unless it wasn't text: the clipboard can't be read as anything else.
  attach(terminal, { path, dir }, cx) {
    const text = terminal.program?.agent ? `@${path || "."}${dir && path ? "/" : ""} ` : `${quoted(this.full(path), this.on)} `;
    const kept = cx.read_from_clipboard();
    cx.write_to_clipboard(text);
    run("terminal.paste");
    this.focusTerminal();
    if (kept !== undefined) cx.timer.after(300, cx => cx.write_to_clipboard(kept));
  }

  focusTerminal() {
    const f = focused();
    if (f?.pane) run("pane.focus", { pane: f.pane });
    else if (f?.terminal) run("pane.focus", { terminal: f.terminal });
  }

  ask({ path, dir }) {
    const inside = dir ? " and everything in it" : "";
    const detail = this.on ? `Deletes ${baseName(path)}${inside} from ${this.on} for good. This can't be undone.` : `Moves ${baseName(path)}${inside} to the ${WASTE()}.`;
    openOverlay({ mod: "confirm", kind: "dialog", width: 420, height: 200, props: { title: `Delete ${baseName(path)}?`, detail, command: { name: "files.remove" } } });
  }

  async remove({ path, context }, cx) {
    if (!path) return;
    await trash(this.full(path), this.on);
    for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) this.folders.delete(folder);
    await this.settle(parentOf(path), context, cx);
  }

  async settle(folder, context, cx) {
    await this.loadFolder(folder, context);
    if (this.current(context)) this.refresh(cx);
  }

  // A name typed into the tree: a new file's, or a new one for what's there.
  begin(edit, value, cx) {
    this.edit = edit; this.editError = null;
    if (edit.folder && !this.folders.has(edit.folder)) this.toggle(edit.folder, cx);
    this.input = InputState.new({ value, placeholder: edit.kind === "new" ? "Name this file" : "" });
    const stem = edit.dir ? -1 : value.lastIndexOf(".");
    if (value) this.input.set_selected_range({ start: 0, end: stem > 0 ? stem : value.length });
    this.input.on("change", (_e, cx) => { this.editError = null; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.focus();
    cx.timer.after(250, () => { if (this.edit === edit) this.input.focus(); });
  }

  finish(cx, back = true) {
    this.edit = null; this.input = null; this.editError = null;
    if (back) this.focusTerminal();
    cx.notify();
  }

  commit(cx) {
    const edit = this.edit, name = this.input.value().trim(), adding = edit.kind === "new";
    if (edit.busy) return;
    if (!adding && name === baseName(edit.path)) return this.finish(cx);
    this.editError = badName(name, adding);
    if (this.editError) return cx.notify();
    const folder = adding ? edit.folder : parentOf(edit.path), to = folder ? `${folder}/${name}` : name;
    const context = this.context;
    edit.busy = true;
    cx.spawn(async cx => {
      try {
        if (adding) await create(this.full(to), this.on);
        else { await move(this.full(edit.path), this.full(to), this.on); this.moved(edit.path, to); }
        if (this.edit === edit) this.finish(cx);
        await this.settle(folder, context, cx);
      } catch (e) {
        if (this.edit === edit) this.editError = e.message ?? String(e);
      } finally { edit.busy = false; cx.notify(); }
    });
  }

  // Open folders follow a rename.
  moved(from, to) {
    const swap = p => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
    this.folders = new Set([...this.folders].map(swap));
    this.entries = new Map([...this.entries].map(([p, list]) => [swap(p), list]));
  }

  draft(depth, icon, out, t) {
    out.push(h_flex().id("files-edit").h(28).flex_none().pl(8 + depth * 14).pr(2).gap(8).items_center()
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.finish(cx); } })
      .on_mouse_down_out((_e, cx) => this.finish(cx, false))
      .child(icon)
      .child(Input.new(this.input).flex_1().min_w(0).h(24).px(6).rounded(6).border_1().border_color(this.editError ? (t.failed ?? t.blocked) : t.input).bg(t.well).text_size(12.5).text_color(t.foreground)));
    if (this.editError) out.push(div().flex_none().pl(34 + depth * 14).pr(8).py(2).text_size(11).text_color(t.failed ?? t.blocked).child(this.editError));
  }

  // The Changes tree without its counts: 28 px rows, a type tag, a folder holding only one
  // folder on one line.
  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    if (!prefix && this.edit?.folder === "") this.newFile(depth, out, t);
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      let last = path, label = entry.name;
      const chain = [path];
      for (;;) {
        const inside = this.folders.has(last) ? this.entries.get(last) : null;
        if (inside?.length !== 1 || !inside[0].dir) break;
        last = `${last}/${inside[0].name}`; label += ` / ${inside[0].name}`;
        chain.push(last);
      }
      const shown = entry.dir ? last : path, chevron = () => svg(`mods/workspace-chrome/icons/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.label);
      if (this.edit?.path === shown) {
        this.draft(depth, entry.dir ? chevron() : typeTag(entry.name, t.label), out, t);
        if (entry.dir && open) this.rows(last, depth + 1, out, t);
        continue;
      }
      const mark = this.marks[`${this.root}/${path}`];
      const row = h_flex().id(`file-${path}`).h(28).flex_none().pr(8).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover)).text_size(12.5)
        .when(this.menuOpen(shown), el => el.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(shown, entry.dir, cx); })
        .when(!this.on, el => el.drag_paths(`${this.root}/${path}`));
      out.push(entry.dir
        ? row.pl(4 + depth * 14).gap(6).text_color(t.tile_text).child(chevron()).child(div().flex_1().min_w(0).truncate().child(label))
        : row.pl(8 + depth * 14).gap(8).text_color(t.text_secondary).child(typeTag(entry.name, t.label)).child(div().flex_1().min_w(0).truncate().child(entry.name))
          .when(Boolean(mark), el => el.child(div().font_family(MONO).text_size(11).text_color(mark === "A" ? t.added : mark === "D" || mark === "U" ? t.removed : t.muted).child(mark))));
      if (entry.dir && open) {
        if (chain.includes(this.edit?.folder)) this.newFile(depth + 1, out, t);
        this.rows(last, depth + 1, out, t);
      }
    }
    return out;
  }

  newFile(depth, out, t) {
    this.draft(depth, h_flex().w(18).flex_none().child(svg("mods/workspace-chrome/icons/file-new.svg").size(16).text_color(t.label)), out, t);
  }

  render(cx) {
    if (!this.pinned && key() !== this.context?.key) this.refresh(cx);
    const t = look(theme());
    const card = v_flex().flex_1().min_w(0).min_h(0).h_full().rounded(18).overflow_hidden().bg(t.card).border_1().border_color(t.card_border)
      .when(Boolean(this.file), el => el.child(h_flex().h(40).flex_none().pl(this.pinned ? 16 : 10).pr(14).gap(8).items_center()
        .when(!this.pinned, el => el.child(h_flex().id("files-back").size(28).flex_none().items_center().justify_center().rounded(7).text_color(t.muted).hover(s => s.bg(t.hover_strong).text_color(t.foreground))
          .on_click((_e, cx) => { this.show(null); cx.notify(); }).child(svg("mods/workspace-chrome/icons/chevron-left.svg").size(16))))
        .child(typeTag(this.file ?? "", t.accent))
        .child(div().flex_1().min_w(0).truncate().child(this.file ?? ""))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().px(8).py(8)
        .when(Boolean(this.root), el => el.on_mouse_down("right", (_e, cx) => this.menu("", true, cx)))
        .children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.label).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.label).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.label).child(this.fileError || "Loading file…")));
    if (this.pinned) return card.text_color(t.foreground).text_size(13);
    return v_flex().id("files").size_full().min_h(0).rounded(20).overflow_hidden().bg(t.panel).border_1().border_color(t.panel_border).text_color(t.foreground).text_size(13)
      .child(panelHeader(t, "files"))
      .child(h_flex().flex_1().min_h(0).px(8).pb(8).child(card));
  }
}
