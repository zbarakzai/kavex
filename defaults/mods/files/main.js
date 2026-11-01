// A lazy file browser for the focused pane's folder, with bounded read-only previews, Markdown
// rendered or raw. Right-click opens `file-menu`, whose rows come back here as commands. With props
// { file, on } it's a pane or tab showing that one file. `file.preview` asks through shared
// "files.open": a file a terminal or agent named.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input, MarkdownState, TextView, Popover, HoverCard } from "gpui-base";
import { spaces, panes, focused, terminals, exec, readTextFile, watchFolder, theme, window, props, run, notify, openOverlay, nextCommand, shared, setShared } from "herdr";
import * as fs from "fs/promises";
import { look, MONO } from "./look.js";
import { typeTag } from "./filetypes.js";
import { panelHeader } from "./panel.js";
import { baseName, parentOf, native, quoted, badName, create, move, trash, reveal, cd, WASTE } from "./ops.js";
import { READER_FONT, isMarkdown, isAbsolute, forward, tidy, linkTarget, headingFor, syntaxColors, readerLook } from "./markdown.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
// A file the folder watch can't see is read this often while it's open; on a machine, gently.
const RECHECK = 2000, RECHECK_REMOTE = 10000;
const OUTLINE_ROWS = 500, TIP_DELAY = 500;

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
    this.mode = localStorage.getItem("markdown") === "raw" ? "raw" : "preview";
    this.trail = [];
    const { file, on } = props() ?? {};
    if (file) {
      this.pinned = true; this.root = parentOf(file); this.on = on ?? null; this.context = {};
      this.show(baseName(file), cx);
      cx.timer.every(this.on ? RECHECK_REMOTE : RECHECK, cx => this.reload(cx));
      return;
    }
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    cx.timer.every(RECHECK, cx => { if (!this.fileOn && isAbsolute(this.file)) this.reload(cx); });
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
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.edit = null; this.target = null; this.trail = [];
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

  closeFile() {
    this.code?.release(); this.doc?.release();
    this.code = null; this.doc = null; this.text = null; this.dressed = null;
    this.finding = false; this.found = 0; this.findInput = null; this.popup = null;
  }

  show(path, cx, on = this.on) {
    if (path && path === this.file && this.doc) return this.reload(cx);
    this.closeFile(); this.file = path; this.fileOn = on; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, full = this.full(path);
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(full, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        this.text = text;
        if (!isMarkdown(path)) { this.code = this.editor(path, text); return; }
        this.doc = MarkdownState.new({ value: text, folder: on ? undefined : parentOf(full) });
        if (this.mode === "raw") this.code = this.editor(path, text);
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  editor(path, text) {
    const ext = path.includes(".") ? path.split(".").pop() : "txt";
    return EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
      value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
      font_family: MONO, font_size: 11.5, syntax: syntaxColors(theme()) });
  }

  // A document someone is reading follows its file, and they keep their place in it.
  reload(cx) {
    if (!this.doc || this.reloading) return;
    const doc = this.doc, path = this.file;
    this.reloading = true;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(this.full(path), { on: this.fileOn });
        if (doc !== this.doc || text === null || text === this.text || text.includes("\0")) return;
        this.text = text;
        doc.set_value(text);
        this.code?.set_value(text);
      } catch {}
      finally { this.reloading = false; cx.notify(); }
    });
  }

  setMode(mode, cx) {
    this.mode = mode; this.popup = null; this.finding = false;
    localStorage.setItem("markdown", mode);
    if (mode === "raw" && !this.code) this.code = this.editor(this.file, this.text);
    cx.notify();
  }

  // A file's path from the folder shown, if it's in there.
  inside(path) {
    const root = forward(this.root), file = forward(path);
    return root && file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
  }

  // What `file.preview` asked for: a file named from outside, maybe outside the folder shown.
  take(ask, cx) {
    setShared("files.open", null);
    this.mode = "preview"; this.trail = [];
    this.show(this.inside(ask.file), cx, ask.on ?? this.on);
  }

  back(cx) {
    const last = this.trail.pop();
    if (last) this.show(last, cx);
    else this.show(null);
    cx.notify();
  }

  follow(url, cx) {
    const here = tidy(this.full(this.file)), to = linkTarget(url, parentOf(here));
    if (to.web) return cx.open_url(to.web);
    if (to.other) return notify({ title: "Files", body: `Can't open ${to.other} from here`, level: "error" });
    if (to.file && to.file !== here) {
      this.trail.push(this.file);
      this.show(this.inside(to.file), cx, this.fileOn);
    }
    if (to.anchor) this.jump(to.anchor, this.file, cx);
  }

  // A document's headings exist once its parse lands, which a large one does a little later.
  jump(anchor, file, cx, tries = 12) {
    const heading = this.doc && headingFor(this.doc.outline(), anchor);
    if (heading) return this.doc.scroll_to(heading.block);
    if (tries > 0 && file === this.file) cx.timer.after(120, cx => this.jump(anchor, file, cx, tries - 1));
  }

  openFind(cx) {
    if (this.finding) return this.findInput?.focus();
    this.finding = true; this.found = 0; this.foundAt = 0;
    this.findInput = InputState.new({ placeholder: "Find in this file" });
    this.findInput.on("change", (_e, cx) => { this.found = this.doc?.find(this.findInput.value()) ?? 0; this.foundAt = this.found ? 1 : 0; cx.notify(); });
    this.findInput.on("submit", (_e, cx) => this.step(1, cx));
    this.findInput.focus();
    cx.notify();
  }

  step(by, cx) {
    this.foundAt = this.doc?.find_step(by) ?? 0;
    cx.notify();
  }

  closeFind(cx) {
    this.finding = false; this.found = 0; this.findInput = null;
    this.doc?.find("");
    cx.notify();
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

  // A deep path gives way before the file's own name does.
  title(t) {
    const file = this.file ?? "", folder = isAbsolute(file) ? "" : parentOf(file);
    return h_flex().flex_1().min_w(0).overflow_hidden().items_center()
      .when(Boolean(folder), el => el.child(div().min_w(0).truncate().text_color(t.muted).child(`${folder}/`)))
      .child(div().flex_none().child(baseName(file)));
  }

  tool(id, name, tip, on, t) {
    const button = h_flex().id(id).size(26).flex_none().items_center().justify_center().rounded(13).cursor_pointer().text_color(on ? t.foreground : t.muted).when(on, el => el.bg(t.pill_selected))
      .when(!on, el => el.hover(s => s.bg(t.hover_strong).text_color(t.foreground))).child(svg(`mods/workspace-chrome/icons/${name}.svg`).size(16));
    return { button, tipped: (trigger) => HoverCard.new(`tip-${id}`).open_delay(TIP_DELAY).close_delay(0).trigger(trigger)
      .when(!this.popup, el => el.content(div().mt(6).px(9).py(5).rounded(8).bg(t.raised).border_1().border_color(t.border).shadow_md().text_size(12).text_color(t.foreground).whitespace_nowrap().child(tip))) };
  }

  outline(t) {
    const open = this.popup === "outline", { button, tipped } = this.tool("files-outline", "file-tree", "Outline", open, t);
    return tipped(Popover.new("files-outline-menu").anchor("top_right").open(open)
      .on_open_change((next, cx) => { this.popup = next ? "outline" : null; cx.notify(); })
      .trigger(button).when(open, el => el.content(this.headings(t))));
  }

  headings(t) {
    const rows = this.doc?.outline().slice(0, OUTLINE_ROWS) ?? [], top = Math.min(...rows.map(row => row.level));
    return v_flex().id("files-headings").w(280).max_h(420).overflow_y_scrollbar().p(6).gap(1).rounded(14).bg(t.raised).border_1().border_color(t.border).shadow_lg().text_size(13)
      .when(!rows.length, el => el.child(div().px(10).py(6).text_color(t.dim).child("No headings")))
      .children(rows.map((row, i) => h_flex().id(`files-heading-${i}`).h(30).flex_none().pl(10 + (row.level - top) * 14).pr(10).items_center().rounded(8).cursor_pointer().hover(s => s.bg(t.hover))
        .text_color(row.level === top ? t.foreground : t.muted)
        .on_click((_e, cx) => { this.popup = null; this.doc?.scroll_to(row.block); cx.notify(); })
        .child(div().flex_1().min_w(0).truncate().child(row.text))));
  }

  modes(t) {
    const tab = (mode, label) => {
      const on = this.mode === mode;
      return h_flex().id(`files-${mode}`).h(24).px(10).flex_none().items_center().rounded(12).cursor_pointer().text_size(12).text_color(on ? t.foreground : t.muted)
        .when(on, el => el.bg(t.pill_selected)).when(!on, el => el.hover(s => s.text_color(t.foreground)))
        .on_click((_e, cx) => this.setMode(mode, cx)).child(label);
    };
    return h_flex().flex_none().gap(2).p(2).items_center().rounded(999).bg(t.pill).border_1().border_color(t.pill_ring).child(tab("preview", "Preview")).child(tab("raw", "Raw"));
  }

  tools(t) {
    const { button, tipped } = this.tool("files-find", "search", "Find", this.finding, t);
    return h_flex().flex_none().gap(4).items_center()
      .when(this.mode === "preview", el => el.child(this.outline(t)).child(tipped(button.on_click((_e, cx) => (this.finding ? this.closeFind(cx) : this.openFind(cx))))))
      .child(this.modes(t));
  }

  findBar(t) {
    const asked = Boolean(this.findInput?.value());
    const step = (id, name, by) => h_flex().id(id).size(24).flex_none().items_center().justify_center().rounded(7).cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover_strong).text_color(t.foreground))
      .on_click((_e, cx) => this.step(by, cx)).child(svg(`mods/workspace-chrome/icons/${name}.svg`).size(16));
    return h_flex().h(34).flex_none().mx(10).mb(4).pl(10).pr(4).gap(6).items_center().rounded(10).bg(t.well).border_1().border_color(t.card_border)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.closeFind(cx); } })
      .child(svg("mods/workspace-chrome/icons/search.svg").size(16).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).child(Input.new(this.findInput).h_full().text_size(12.5).text_color(t.foreground)))
      .when(asked, el => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(this.found ? `${this.foundAt} of ${this.found}` : "No matches")))
      .when(this.found > 1, el => el.child(step("files-find-back", "chevron-left", -1)).child(step("files-find-next", "chevron-right", 1)))
      .child(step("files-find-close", "close", 0).on_click((_e, cx) => this.closeFind(cx)));
  }

  // The look follows the theme; handing it over only when it changes keeps a render free.
  reader(t) {
    const dress = readerLook(t), worn = JSON.stringify(dress);
    if (worn !== this.dressed) { this.dressed = worn; this.doc.set_look(dress); }
    return v_flex().flex_1().min_h(0)
      .when(this.finding, el => el.child(this.findBar(t)))
      .child(div().flex_1().min_h(0).pl(20).pr(10).pb(10).child(TextView.state(this.doc).scrollable(true).selectable(true).size_full().font_family(READER_FONT).text_size(13.5)
        .on_link_click((url, cx) => this.follow(url, cx))));
  }

  viewer(t) {
    if (this.doc && this.mode === "preview") return this.reader(t);
    if (this.code) return Editor.new(this.code).flex_1().min_h(0);
    return div().p(12).text_color(t.label).child(this.fileError || "Loading file…");
  }

  render(cx) {
    if (!this.pinned && key() !== this.context?.key) this.refresh(cx);
    const ask = this.pinned ? null : shared("files.open");
    if (ask?.file) this.take(ask, cx);
    const t = look(theme());
    const card = v_flex().id("files-card").flex_1().min_w(0).min_h(0).h_full().rounded(18).overflow_hidden().bg(t.card).border_1().border_color(t.card_border)
      .when(Boolean(this.doc), el => el.on_key_down((e, cx) => {
        if (e.key === "f" && this.mode === "preview" && (e.modifiers.platform || e.modifiers.control)) { cx.stop_propagation(); this.openFind(cx); }
      }))
      .when(Boolean(this.file), el => el.child(h_flex().h(46).flex_none().pl(this.pinned && !this.trail.length ? 16 : 10).pr(10).gap(8).items_center()
        .when(!this.pinned || this.trail.length > 0, el => el.child(h_flex().id("files-back").size(28).flex_none().items_center().justify_center().rounded(7).text_color(t.muted).hover(s => s.bg(t.hover_strong).text_color(t.foreground))
          .on_click((_e, cx) => this.back(cx)).child(svg("mods/workspace-chrome/icons/chevron-left.svg").size(16))))
        .child(typeTag(this.file ?? "", t.accent))
        .child(this.title(t))
        .when(Boolean(this.doc), el => el.child(this.tools(t)))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().px(8).py(8)
        .when(Boolean(this.root), el => el.on_mouse_down("right", (_e, cx) => this.menu("", true, cx)))
        .children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.label).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.label).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.viewer(t)));
    if (this.pinned) return card.text_color(t.foreground).text_size(13);
    return v_flex().id("files").size_full().min_h(0).rounded(20).overflow_hidden().bg(t.panel).border_1().border_color(t.panel_border).text_color(t.foreground).text_size(13)
      .child(panelHeader(t, "files"))
      .child(h_flex().flex_1().min_h(0).px(8).pb(8).child(card));
  }
}
