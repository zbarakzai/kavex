// A lazy file browser for the focused pane's folder, with bounded read-only previews, Markdown
// rendered or raw. Right-click opens `file-menu`, whose rows come back here as commands. With props
// { file, on } it's a pane or tab showing that one file. `file.preview` asks through shared
// "files.open": a file a terminal or agent named.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, InputState, Input } from "gpui-base";
import { spaces, panes, focused, terminals, exec, readTextFile, watchFolder, theme, window, props, run, notify, openOverlay, nextCommand, shared, setShared } from "herdr";
import * as fs from "fs/promises";
import { look, MONO } from "./look.js";
import { typeTag } from "./filetypes.js";
import { panelHeader } from "./panel.js";
import { baseName, parentOf, native, quoted, badName, create, move, trash, reveal, cd, WASTE } from "./ops.js";
import { isMarkdown, isAbsolute, forwardSlashes, tidy, linkTarget } from "./markdown.js";
import { Reader, rememberedMode, codeState, iconButton } from "./reader.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const PER_FOLDER = 500, TOTAL = 5000;
// No watching another machine's folders: an open file there is read this often.
const RECHECK_REMOTE = 10000;

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
    this.trail = [];
    const { file, on } = props() ?? {};
    if (file) {
      this.pinned = true; this.root = parentOf(file); this.on = on ?? null; this.context = {};
      this.show(baseName(file), cx);
      if (this.on) cx.timer.every(RECHECK_REMOTE, cx => this.reload(cx));
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
    this.reload(cx);
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file, on: this.fileOn });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.edit = null; this.target = null; this.trail = [];
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx, { on: saved.on });
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

  closeFile() {
    this.code?.release(); this.reader?.release();
    this.code = null; this.reader = null;
  }

  // `file` runs from the folder shown, or is absolute when it's from anywhere else.
  get elsewhere() { return isAbsolute(this.file); }

  show(path, cx, { on = this.on, mode = rememberedMode(), anchor } = {}) {
    if (path && path === this.file && this.reader) {
      this.reader.show(mode);
      if (anchor) this.reader.jump(anchor, cx);
      return this.reload(cx);
    }
    this.closeFile(); this.file = path; this.fileOn = on; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, full = this.full(path);
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(full, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        if (!isMarkdown(path)) { this.code = codeState(path, text); return; }
        this.reader = new Reader({ path, text, mode, folder: on ? undefined : parentOf(full), onLink: (url, cx) => this.follow(url, cx) });
        if (anchor) this.reader.jump(anchor, cx);
        if (!on && (this.pinned || this.elsewhere)) this.watchFile(parentOf(full), cx);
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  watchFile(folder, cx) {
    const reader = this.reader;
    cx.spawn(async cx => {
      try { while (this.reader === reader) { await watchFolder(folder); this.reload(cx); } }
      catch {}
    });
  }

  // A document someone is reading follows its file, and they keep their place in it. A change
  // that lands mid-read is read again: nothing else would ever pick it up.
  reload(cx) {
    const reader = this.reader;
    if (!reader) return;
    if (this.reloading) { this.reloadAgain = true; return; }
    this.reloading = true;
    const path = this.file;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(this.full(path), { on: this.fileOn });
        if (reader === this.reader && text !== null && !text.includes("\0")) reader.update(text);
      } catch {}
      finally {
        this.reloading = false;
        if (this.reloadAgain) { this.reloadAgain = false; this.reload(cx); }
      }
    });
  }

  inside(path) {
    const root = forwardSlashes(this.root), file = forwardSlashes(path);
    return root && file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
  }

  // What `file.preview` asked for: a file named from outside, maybe outside the folder shown.
  openAsked(ask, cx) {
    setShared("files.open", null);
    this.trail = [];
    this.show(this.inside(ask.file), cx, { on: ask.on ?? this.on, mode: "preview" });
  }

  back(cx) {
    const last = this.trail.pop();
    if (last) this.show(last.file, cx, { on: last.on });
    else this.show(null);
    cx.notify();
  }

  follow(url, cx) {
    const here = tidy(this.full(this.file)), to = linkTarget(url, parentOf(here));
    if (to.web) return cx.open_url(to.web);
    if (to.other) return notify({ title: "Files", body: `Can't open ${to.other} from here`, level: "error" });
    if (to.file && to.file !== here) {
      this.trail.push({ file: this.file, on: this.fileOn });
      this.show(this.inside(to.file), cx, { on: this.fileOn, anchor: to.anchor });
    } else if (to.anchor) this.reader?.jump(to.anchor, cx);
  }

  full(path) { return path ? (isAbsolute(path) ? path : `${this.root}/${path}`) : this.root; }

  menu(path, dir, cx) {
    this.target = { path, dir, context: this.context, at: Date.now() };
    openOverlay({ mod: "file-menu", kind: "popup", width: 236, height: 440, props: { from: "files", dir, root: !path, local: !this.on } });
    cx.notify();
  }

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
        .on_click((_e, cx) => { if (entry.dir) return this.toggle(path, cx); this.trail = []; this.show(path, cx); })
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

  title(t) {
    const file = this.file ?? "", folder = this.elsewhere ? "" : parentOf(file);
    return h_flex().flex_1().min_w(0).overflow_hidden().items_center()
      .when(Boolean(folder), el => el.child(div().min_w(0).truncate().text_color(t.muted).child(`${folder}/`)))
      .child(div().flex_none().child(baseName(file)));
  }

  viewer(t) {
    if (this.reader) return this.reader.body(t);
    if (this.code) return Editor.new(this.code).flex_1().min_h(0);
    return div().p(12).text_color(t.label).child(this.fileError || "Loading file…");
  }

  render(cx) {
    if (!this.pinned && key() !== this.context?.key) this.refresh(cx);
    const ask = this.pinned ? null : shared("files.open");
    if (ask?.file) this.openAsked(ask, cx);
    const t = look(theme());
    const card = v_flex().id("files-card").flex_1().min_w(0).min_h(0).h_full().rounded(18).overflow_hidden().bg(t.card).border_1().border_color(t.card_border)
      .when(Boolean(this.reader), el => el.on_key_down((e, cx) => this.reader?.key(e, cx)))
      .when(Boolean(this.file), el => el.child(h_flex().h(46).flex_none().pl(this.pinned && !this.trail.length ? 16 : 10).pr(10).gap(8).items_center()
        .when(!this.pinned || this.trail.length > 0, el => el.child(iconButton("files-back", "chevron-left", t, { size: 28, radius: 7 }).on_click((_e, cx) => this.back(cx))))
        .child(typeTag(this.file ?? "", t.accent))
        .child(this.title(t))
        .when(Boolean(this.reader), el => el.child(this.reader.tools(t)))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().px(8).py(8)
        .when(Boolean(this.root), el => el.on_mouse_down("right", (_e, cx) => this.menu("", true, cx)))
        .children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.label).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.label).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.viewer(t)));
    if (this.pinned) return card.size_full().text_color(t.foreground).text_size(13);
    return v_flex().id("files").size_full().min_h(0).rounded(20).overflow_hidden().bg(t.panel).border_1().border_color(t.panel_border).text_color(t.foreground).text_size(13)
      .child(panelHeader(t, "files"))
      .child(h_flex().flex_1().min_h(0).px(8).pb(8).child(card));
  }
}
