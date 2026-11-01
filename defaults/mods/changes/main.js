// The Changes panel: one repo's diff by scope, a filterable file tree, and git
// actions on the whole diff, a file or a hunk. diff.js, tokens.js, tree.js and
// git.js hold the logic; this file runs git and draws.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle, Popover, HoverCard } from "gpui-base";
import { spaces, panes, focused, agents, exec, hc, appHome, readTextFile, watchFolder, theme, run, openOverlay, notify, nextCommand, layout, window, props } from "herdr";
import * as fs from "fs/promises";
import { MOST_ROWS, buttonAt, fileRows, hunkPatch, lineCount, newFile, parseDiff, signature, splitRows, stackedRows, stepped, wrapSpans } from "./diff.js";
import { languageOf, painter } from "./tokens.js";
import { look, spaced, MONO } from "./look.js";
import { typeTag } from "./filetypes.js";
import { panelHeader } from "./panel.js";
import { buildTree, filtered, inTreeOrder, jumpList, middle, treeRows } from "./tree.js";
import { DIFF, READ, SNAPSHOT, chooseBase, parseCounts, parseLog, parseNumstat, parseRefs, planAction, reviewMessage, untrackedPaths } from "./git.js";

const SCOPES = [["unstaged", "Unstaged"], ["staged", "Staged"], ["commit", "Commit"], ["branch", "Branch"], ["turn", "Last turn"]];
const NOTHING = { unstaged: "No unstaged changes", staged: "Nothing staged", commit: "This commit changes no files", branch: "No changes on this branch", turn: "That turn changed nothing" };
const COLORS = { keyword: "ansi5", string: "ansi2", comment: "dim", function: "ansi4", type: "ansi3", number: "ansi1", literal: "ansi6", key: "ansi4" };

const LINE = 23, GUTTER = 48, MARKER = 18, CODE_RIGHT = 16, CHAR = 6.9;
// A tile of stripes: its repeat divides LINE, so the lines run on from row to row.
const STRIPES = 140;
const FILE_ROW = 40, FILE_BUTTON = 28, FILE_GAP = 2, FILE_END = 8, GAP_ROW = 38, NOTE_ROW = 40, COMMENT_TOP = 46, COMMENT_LINE = 18, TREE_ROW = 28, TREE_WIDTH = 240;
// The hunk buttons stay clear of the scrollbar, which takes presses along that edge.
const SPLITS_AT = 400, TREE_MIN = 140, TREE_STATS_AT = 190, HUNK_BUTTONS = 138, HUNK_MARGIN = 16, PANEL_MIN = 680;
// Codex's tree moves on a spring of 0.5 s and 0.1 bounce: this is that spring as a period and a damping.
const TREE_SPRING = { response: 370, damping: 0.9 }, TREE_SNAP = { response: 0 }, TREE_SETTLE = 650, TIP_DELAY = 300;
const JUMP_WIDTH = 360, JUMP_ROW = 28, JUMP_ROWS = 10, UI_CHAR = 7;
const MENU_EASE = { duration: 160, easing: "ease-out" }, MENU_RISE = 6, MENU_REVEAL = 30; // how a dropdown arrives, as the app's own menus do
// Past either, one file shows at a time. Codex allows 9,000 lines; a long list is slower to lay out here.
const MOST_LINES = 6000, MOST_FILES = 128, MOST_LISTED = 2000, MOST_UNTRACKED = 300, EXEC_LIMIT = 8 << 20, STUCK = 45000;

const commas = (n) => String(n).replace(/\B(?=(\d{3})+$)/g, ",");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const minus = "\u2212";
const icon = (name, size = 16) => svg(`mods/workspace-chrome/icons/${name}.svg`).size(size).flex_none();
const store = (name, fallback) => { try { return JSON.parse(localStorage.getItem(name) ?? "null") ?? fallback; } catch { return fallback; } };
const keep = (name, value) => localStorage.setItem(name, JSON.stringify(value));
const findNode = (node, id) => { if (!node || typeof node !== "object") return null; if (node.id === id) return node; for (const child of node.children ?? []) { const hit = findNode(child, id); if (hit) return hit; } return null; };

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

async function snapshot(root, on) {
  const r = await exec("sh", ["-c", SNAPSHOT], { cwd: root, on });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot save a snapshot of this repo");
  return r.stdout.trim();
}

export default class Changes extends View {
  init(_props, cx) {
    const view = store("view", {});
    this.scope = view.scope ?? "unstaged"; this.wrap = Boolean(view.wrap); this.tight = Boolean(view.tight);
    this.split = Boolean(view.split); this.showTree = view.tree !== false; this.unfold = Boolean(view.unfold);
    this.width = PANEL_MIN; this.scrollX = 0; this.gen = 0; this.treeTurn = 0;
    this.files = []; this.rows = []; this.sizes = []; this.byId = new Map(); this.lines = [];
    this.gaps = new Map(); this.shutDirs = new Set(); this.shut = new Set(); this.comments = []; this.viewed = {};
    this.statuses = {}; this.turns = store("turns", {}); this.refs = []; this.commits = []; this.branches = []; this.staged = 0;
    this.job = null; this.spans = new Map();
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new(); this.treeScroll = VirtualListScrollHandle.new(); this.jumpScroll = VirtualListScrollHandle.new();

    this.message = "";
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.input.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });

    this.filter = "";
    this.filterInput = InputState.new({ placeholder: "Filter files" });
    this.filterInput.on("change", (_e, cx) => { this.filter = this.filterInput.value(); this.buildTree(); cx.notify(); });
    this.baseFilter = "";
    this.baseInput = InputState.new({ placeholder: "Find a branch…" });
    this.baseInput.on("change", (_e, cx) => { this.baseFilter = this.baseInput.value(); cx.notify(); });
    this.commentInput = InputState.new({ placeholder: "Leave a comment" });
    this.commentInput.on("submit", (_e, cx) => this.saveComment(cx));
    this.jumpWanted = ""; this.jumpAt = 0;
    this.jumpInput = InputState.new({ placeholder: "Jump to file" });
    this.jumpInput.on("change", (_e, cx) => {
      const wanted = this.jumpInput.value();
      if (wanted === this.jumpWanted) return;
      this.jumpWanted = wanted; this.jumpAt = 0;
      this.jumpScroll.scroll_to_item(0);
      cx.notify();
    });
    this.jumpInput.on("submit", (_e, cx) => this.jumpTo(jumpList(this.files, this.jumpWanted)[this.jumpAt], cx));

    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    cx.timer.every(1500, (cx) => this.watchTurns(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "revert" && this.pending) {
          const { target, context } = this.pending;
          this.pending = null;
          if (context === this.context) this.apply("revert", target, cx);
        }
        cx.notify();
      }
    });
  }

  saveView() {
    keep("view", { scope: this.scope, wrap: this.wrap, tight: this.tight, split: this.split, tree: this.showTree, unfold: this.unfold });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  reset(context) {
    this.context = context; this.root = null; this.spec = null; this.raw = null; this.files = []; this.open = null;
    this.gaps = new Map(); this.shutDirs = new Set(); this.shut = new Set(); this.tooLong = false; this.error = null; this.note = null; this.empty = null;
    this.watched = null; this.large = false; this.limited = false; this.message = ""; this.input.set_value("");
    this.draft = null; this.comments = []; this.viewed = {}; this.loadedRoot = null; this.branch = null;
    this.compose();
  }

  clear(message) {
    this.files = []; this.raw = null; this.large = false; this.open = null; this.empty = message; this.compose();
  }

  // The panel may sit behind Files or be closed: then it only notes that it's behind.
  shown() {
    if (props()?.overlay || panes().some((p) => p.mod === "changes")) return true;
    const root = layout(), panel = findNode(root, "panel"), body = findNode(root, "panel-body");
    return !panel || (!panel.hidden && body?.active === "changes");
  }

  refresh(cx) {
    if (this.busy) return;
    // The runtime stops a step that runs too long and its `finally` never comes, so
    // a load can't be trusted to end. Past exec's own limit, this one has died.
    if (this.loading && Date.now() - this.loadStarted < STUCK) { this.again = true; return; }
    if (this.loading) this.note = "Reading this diff took too long";
    const { cwd, on } = location(), context = key();
    if (context !== this.context) this.reset(context);
    if (!cwd) return;
    if (!this.shown()) { this.behind = true; return; }
    this.behind = false;
    this.loading = true; this.loadStarted = Date.now();
    const gen = this.gen, current = () => key() === context && gen === this.gen;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (!current()) return;
        if (top.code !== 0) { this.root = null; this.spec = null; this.error = "Not a git repository"; this.clear(null); return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        this.root = root; this.on = on; this.error = null;
        this.remember(root);
        this.watch(root, cx);
        const head = await git(["rev-parse", "--verify", "-q", "HEAD"]);
        const branch = await git(["branch", "--show-current"]);
        this.hasHead = head.code === 0; this.head = head.stdout.trim();
        this.branch = branch.stdout.trim() || this.head.slice(0, 7) || "HEAD";
        this.staged = (await git(["diff", "--cached", "--name-only", "-z"])).stdout.split("\0").filter(Boolean).length;
        const spec = await this.resolve(git, root, on);
        if (!current()) return;
        if (spec.empty) { this.spec = null; this.clear(spec.empty); return; }
        this.spec = spec; this.empty = null;
        await this.load(git, spec, current);
      } catch (e) { if (current()) { this.error = String(e?.message ?? e); this.clear(null); } }
      finally {
        this.loading = false;
        if (gen !== this.gen) { this.again = false; this.refresh(cx); }
        else if (this.again) { this.again = false; cx.timer.after(300, (cx) => this.refresh(cx)); }
        cx.notify();
      }
    });
  }

  remember(root) {
    if (this.loadedRoot === root) return;
    this.loadedRoot = root;
    this.comments = store(`comments:${root}`, []); this.viewed = store(`viewed:${root}`, {});
  }

  // Which two sides this scope compares. `right` names the newer side: "index",
  // a revision, or nothing for the working files.
  async resolve(git, root, on) {
    switch (this.scope) {
      case "staged": return { args: ["--cached"], right: "index" };
      case "commit": {
        if (!this.hasHead) return { empty: "No commits yet" };
        const log = await git(["log", "-n", "100", "--format=%H%x00%h%x00%s%x00%cr"]);
        this.commits = parseLog(log.stdout);
        const sha = this.commits.some((c) => c.sha === this.picked) ? this.picked : this.commits[0]?.sha;
        if (!sha) return { empty: "No commits yet" };
        this.shownCommit = sha;
        const parent = await git(["rev-parse", "--verify", "-q", `${sha}^`]);
        const left = parent.code === 0 ? parent.stdout.trim() : (await git(["hash-object", "-t", "tree", "--stdin"])).stdout.trim();
        return { args: [left, sha], right: sha };
      }
      case "branch": {
        if (!this.hasHead) return { empty: "No commits yet" };
        const refs = await git(["for-each-ref", "--sort=-committerdate", "--count=300", "--format=%(refname)", "refs/heads", "refs/remotes"]);
        const origin = await git(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
        this.refs = parseRefs(refs.stdout);
        const bases = store("bases", {});
        this.base = chooseBase(this.branch, this.refs, origin.stdout.trim(), bases[root]);
        if (!this.base) return { empty: "No other branch to compare with" };
        const merge = await git(["merge-base", "HEAD", this.base]);
        if (merge.code !== 0) return { empty: `${this.branch} and ${this.base} share no history` };
        return { args: [merge.stdout.trim()], untracked: true };
      }
      case "turn": {
        const turn = this.turns[`${on ?? ""}:${root}`];
        if (!turn) return { empty: "No agent turn seen yet. Turns count once this panel has been opened." };
        if ((await git(["cat-file", "-e", turn.start])).code !== 0) return { empty: "That turn's snapshot is gone" };
        const end = turn.end ?? await snapshot(root, on);
        return { args: [turn.start, end], right: end };
      }
      default: return { args: [], untracked: true };
    }
  }

  async untracked(git, root, on) {
    const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
    if (status.code !== 0) throw new Error(status.stderr.trim());
    const paths = untrackedPaths(status.stdout), files = [];
    this.limited = paths.length > MOST_UNTRACKED;
    for (const path of paths.slice(0, MOST_UNTRACKED)) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) files.push({ ...newFile(path, ""), add: 0, del: 0, binary: true, note: "Too large to preview" });
      else if (text.includes("\0")) files.push({ ...newFile(path, ""), add: 0, del: 0, binary: true, note: "Binary file" });
      else { const file = newFile(path, text); files.push({ ...file, add: file.hunks[0]?.newCount ?? 0, del: 0 }); }
    }
    return files;
  }

  // The list of files comes from the totals; only the chosen file's diff is read.
  async load(git, spec, current) {
    const flags = this.tight ? ["-w"] : [];
    const numstat = await git(["diff", ...DIFF, ...flags, "--numstat", "-z", ...spec.args]);
    if (numstat.code !== 0) throw new Error(numstat.stderr.trim());
    const fresh = spec.untracked ? await this.untracked(git, this.root, this.on) : [];
    if (!spec.untracked) this.limited = false;
    if (!current()) return;
    const stats = parseNumstat(numstat.stdout);
    const lines = stats.reduce((n, f) => n + f.add + f.del, 0) + fresh.reduce((n, f) => n + f.add, 0);
    let large = stats.length + fresh.length > MOST_FILES || lines > MOST_LINES;
    if (stats.length > MOST_LISTED) { stats.length = MOST_LISTED; this.limited = true; }
    const before = new Map(this.files.map((file) => [file.path, file]));
    const files = inTreeOrder([
      ...stats.filter((stat) => !this.tight || stat.add + stat.del || stat.binary).map((stat) => {
        const old = before.get(stat.path), same = old?.add === stat.add && old?.del === stat.del;
        return { head: [], hunks: [], ...stat, sig: same ? old.sig : null };
      }),
      ...fresh.map((file) => ({ ...file, sig: signature(file) })),
    ]);
    const open = files.some((f) => f.path === this.open) ? this.open : files[0]?.path ?? null;
    const file = files.find((f) => f.path === open);
    let text = "";
    if (!large) { text = await this.fileDiff(git, spec, null); large = text.length >= EXEC_LIMIT; }
    if (large) text = file && !file.fresh ? await this.fileDiff(git, spec, open) : "";
    if (!current()) return;
    const seen = [large, large ? open : "", numstat.stdout, text, ...fresh.map((f) => f.path + f.sig)].join("\0");
    if (seen === this.raw) return;
    if (large && this.open !== null && this.open !== open && files.some((f) => f.path === this.open)) { this.again = true; return; }
    if (!large) await this.fillAll(files, text, git, spec);
    else if (file && !file.fresh) await this.fillFile(file, text, git, spec);
    if (!current()) return;
    this.raw = seen; this.large = large; this.tooLong = false; this.files = files; this.open = open;
    for (const [path, state] of this.gaps) {
      const now = files.find((f) => f.path === path);
      if (!now || ((!large || path === open) && now.sig !== state.sig)) this.gaps.delete(path);
    }
    for (const path of this.spans.keys()) if (!files.some((f) => f.path === path)) this.spans.delete(path);
    for (const shown of this.shownFiles()) await this.readForUnfold(shown);
    this.compose();
  }

  async readForUnfold(file) {
    if (!file || !this.unfold || !file.hunks.length || file.isNew || file.isDeleted) return;
    const state = this.gapState(file.path, file.sig);
    if (state.text === null) state.text = await this.rightText(file);
  }

  async fileDiff(git, spec, path) {
    const r = await git(["diff", ...DIFF, ...(this.tight ? ["-w"] : []), ...spec.args, ...(path ? ["--", path] : [])]);
    if (r.code !== 0) throw new Error(r.stderr.trim());
    return r.stdout;
  }

  async fillFile(file, text, git, spec) {
    if (text.length >= EXEC_LIMIT) { Object.assign(file, { hunks: [], head: [], note: "This file's diff is too large to show" }); return; }
    const [parsed] = parseDiff(text);
    if (parsed) Object.assign(file, parsed);
    file.sig = signature(file);
    await this.fillTotals([file], git, spec);
  }

  async fillAll(files, text, git, spec) {
    const parsed = new Map(parseDiff(text).map((file) => [file.path, file]));
    for (const file of files) {
      if (file.fresh) continue;
      if (parsed.has(file.path)) Object.assign(file, parsed.get(file.path));
      file.sig = signature(file);
    }
    await this.fillTotals(files, git, spec);
  }

  // How long each file is, which sizes the gap after its last hunk.
  async fillTotals(files, git, spec) {
    const known = files.filter((file) => !file.isNew && !file.isDeleted && !file.binary && !file.fresh).map((file) => file.path);
    if (!known.length) return;
    const where = spec.right === "index" ? ["--cached"] : spec.right ? [spec.right] : [];
    const r = await git(["grep", "-I", "-c", "--null", "-e", "", ...where, "--", ...known]);
    const counts = r.code === 0 ? parseCounts(r.stdout, spec.right === "index" ? null : spec.right) : {};
    for (const file of files) file.total = counts[file.path] ?? null;
  }

  async rightText(file) {
    const right = this.spec?.right;
    if (!right) return readTextFile(`${this.root}/${file.path}`, { on: this.on }).catch(() => null);
    const r = await this.git(["show", `${right === "index" ? "" : right}:${file.path}`]);
    return r.code === 0 ? r.stdout : null;
  }

  git(args) {
    return exec("git", [...READ, ...args], { cwd: this.root, on: this.on });
  }

  gapState(path, sig) {
    if (!this.gaps.has(path)) this.gaps.set(path, { sig, open: new Set(), all: false, text: null });
    return this.gaps.get(path);
  }

  isViewed(file) { return this.viewed[file.path] === file.sig; }

  oneFile() { return this.large || this.tooLong; }
  shownFiles() {
    if (!this.oneFile()) return this.files;
    const file = this.currentFile();
    return file ? [file] : [];
  }

  treeShown() { return this.showTree && this.files.length > 0; }
  treeWidth() { return Math.max(TREE_MIN, Math.min(TREE_WIDTH, Math.round(this.width * 0.36))); }
  // The panel less its 8 px margins and the card's border, and the tree and the gap beside it.
  diffWidth() { return Math.max(120, this.width - 18 - (this.treeShown() ? this.treeWidth() + 8 : 0)); }
  canSplit() { return this.diffWidth() >= SPLITS_AT; }
  splitting() { return this.split && this.canSplit(); }
  codeWidth() { return (this.splitting() ? this.diffWidth() / 2 : this.diffWidth()) - GUTTER - MARKER; }
  columns() {
    return Math.max(10, Math.floor((this.codeWidth() - CODE_RIGHT) / CHAR));
  }

  heightOf(row, columns) {
    switch (row.kind) {
      case "file": return FILE_ROW;
      case "gap": return GAP_ROW;
      case "note": return NOTE_ROW;
      case "comment": return COMMENT_TOP + COMMENT_LINE * lineCount(row.comment.text, columns);
      case "pair": return this.wrap ? LINE * Math.max(lineCount(row.left?.text ?? "", columns), lineCount(row.right?.text ?? "", columns)) : LINE;
      default: return this.wrap ? LINE * lineCount(row.text, columns) : LINE;
    }
  }

  // Lays what's shown out as rows; the visible ones are drawn each frame.
  compose() {
    const files = this.shownFiles(), optionsOf = (file) => {
      const state = this.gaps.get(file.path);
      return { text: state?.text ?? null, total: file.total ?? null, open: state?.open, all: state?.all || this.unfold, comments: this.comments.filter((c) => c.path === file.path) };
    };
    const list = this.oneFile() ? files.flatMap((file) => fileRows(file, optionsOf(file))) : stackedRows(files, this.shut, optionsOf);
    // Shown lines can outgrow what the runtime lays out in a step, as every line of every file does.
    if (!this.oneFile() && list.length > MOST_ROWS) { this.tooLong = true; return this.compose(); }
    const rows = this.splitting() ? splitRows(list) : list, columns = this.columns();
    this.lines = list.filter((row) => row.text !== undefined && row.kind !== "note");
    this.longest = this.lines.reduce((most, row) => Math.max(most, row.text.length), 0);
    this.rows = rows;
    this.queuePaint(files);
    this.sizes = rows.map((row) => this.heightOf(row, columns));
    this.byId = new Map(rows.map((row) => [row.id, row]));
    this.maxScroll = 0;
    this.clampScroll();
    this.buildTree();
  }

  // A draw has 50 ms and a big file takes longer, so rows draw plain and color in
  // slices from here. Colors already worked out carry over until a file changes.
  queuePaint(files) {
    this.job = null;
    const parts = new Map();
    for (const file of files) {
      const kept = this.spans.get(file.path), known = kept?.sig === file.sig ? kept.known : new Map();
      this.spans.set(file.path, { sig: file.sig, known });
      parts.set(file.path, { next: painter(languageOf(file.path)), lines: [], at: 0, known, unpainted: false });
    }
    for (const row of this.lines) {
      const part = parts.get(row.path);
      row.spans = part.known.get(row.id) ?? null;
      part.lines.push(row);
      if (!row.spans) part.unpainted = true;
    }
    const waiting = [...parts.values()].filter((part) => part.unpainted);
    if (waiting.length) this.job = { parts: waiting, part: 0 };
  }

  paintSome(ms) {
    const stop = Date.now() + ms;
    while (this.job && Date.now() < stop) {
      const part = this.job.parts[this.job.part];
      if (!part) { this.job = null; break; }
      for (const end = Math.min(part.at + 40, part.lines.length); part.at < end; part.at++) {
        const row = part.lines[part.at];
        row.spans = part.next(row.text);
        part.known.set(row.id, row.spans);
      }
      if (part.at >= part.lines.length) this.job.part++;
    }
  }

  paintRest(cx) {
    if (this.painting) return;
    this.painting = true;
    cx.spawn(async (cx) => {
      try {
        while (this.job) {
          await cx.sleep(1);
          this.paintSome(12);
          cx.notify();
        }
      } finally { this.painting = false; }
    });
  }

  clampScroll() {
    this.maxScroll = Math.max(0, this.longest * CHAR + CODE_RIGHT - this.codeWidth());
    this.scrollX = Math.min(this.scrollX, this.maxScroll);
  }

  buildTree() {
    const list = filtered(this.files, this.filter);
    this.treeList = treeRows(buildTree(list), this.filter.trim() ? new Set() : this.shutDirs);
  }

  currentFile() { return this.files.find((f) => f.path === this.open) ?? null; }

  // The old file stays up until the new one's diff is in, so nothing flashes empty.
  pickFile(path, cx) {
    if (!this.oneFile()) {
      this.open = path;
      if (this.shut.delete(path)) this.compose();
      this.scrollToFile(path);
      return cx.notify();
    }
    if (path === this.open) return;
    this.open = path;
    const file = this.currentFile(), spec = this.spec, git = (args) => this.git(args);
    cx.spawn(async (cx) => {
      try {
        if (!file.fresh) await this.fillFile(file, await this.fileDiff(git, spec, path), git, spec);
        if (this.open !== path) return;
        await this.readForUnfold(file);
        if (this.open !== path) return;
        this.scrollX = 0; this.raw = null;
        this.compose();
        this.scroll.scroll_to_item(0, "top");
      } catch (e) { this.note = String(e?.message ?? e); }
      cx.notify();
    });
    cx.notify();
  }

  scrollToFile(path) {
    const at = this.rows.findIndex((row) => row.kind === "file" && row.path === path);
    if (at >= 0) this.scroll.scroll_to_item(at, "top");
  }

  toggleFile(path, cx) {
    if (!this.shut.delete(path)) this.shut.add(path);
    this.compose();
    this.scrollToFile(path);
    cx.notify();
  }

  toggleAllFiles(cx) {
    this.shut = this.shut.size < this.files.length ? new Set(this.files.map((file) => file.path)) : new Set();
    this.compose();
    this.scroll.scroll_to_item(0, "top");
    cx.notify();
  }

  stepFile(step, cx) {
    const at = this.files.findIndex((f) => f.path === this.open);
    const next = this.files[stepped(at, step, this.files.length)];
    if (next) this.pickFile(next.path, cx);
  }

  setScope(scope, cx) {
    this.scope = scope; this.gen++; this.raw = null; this.files = []; this.empty = null; this.note = null; this.draft = null;
    this.scrollX = 0; this.saveView(); this.compose(); this.refresh(cx);
    this.scroll.scroll_to_item(0, "top");
  }
  reload(cx) {
    this.gen++; this.raw = null; this.saveView(); this.compose(); this.refresh(cx); cx.notify();
  }
  setBase(base, cx) {
    keep("bases", { ...store("bases", {}), [this.root]: base });
    this.reload(cx);
  }

  openGap(row, cx) {
    const file = this.files.find((f) => f.path === row.path);
    if (!file) return;
    const state = this.gapState(file.path, file.sig);
    state.open.add(row.from);
    this.fillGaps(file, state, cx);
  }
  toggleWhole(file, cx) {
    const state = this.gapState(file.path, file.sig);
    state.all = !state.all;
    this.fillGaps(file, state, cx);
  }
  fillGaps(file, state, cx) {
    if (state.text !== null) { this.compose(); cx.notify(); return; }
    cx.spawn(async (cx) => {
      state.text = await this.rightText(file);
      if (state.text === null) this.note = "Cannot read this file to show the rest of it";
      this.compose();
      cx.notify();
    });
  }

  toggleUnfold(cx) {
    this.unfold = !this.unfold; this.tooLong = false;
    this.saveView();
    const files = this.shownFiles();
    cx.spawn(async (cx) => {
      for (const file of files) await this.readForUnfold(file);
      this.compose();
      cx.notify();
    });
    cx.notify();
  }

  // The spring runs only for this toggle: a resize of the panel moves the tree at once.
  toggleTree(cx) {
    const turn = ++this.treeTurn;
    this.showTree = !this.showTree; this.treeMoving = true;
    cx.timer.after(TREE_SETTLE, (cx) => { if (turn === this.treeTurn) { this.treeMoving = false; cx.notify(); } });
    this.saveView(); this.compose(); cx.notify();
  }

  // A reload is quicker than the eye, so the button turns long enough to be seen.
  refreshNow(cx) {
    this.spinning = true;
    cx.timer.after(650, (cx) => { this.spinning = false; cx.notify(); });
    this.reload(cx);
  }

  toggleViewed(file, cx) {
    if (this.isViewed(file)) delete this.viewed[file.path];
    else this.viewed[file.path] = file.sig;
    keep(`viewed:${this.root}`, this.viewed);
    this.compose();
    cx.notify();
  }

  ask(target) {
    const { file = null, hunk = null } = target;
    this.pending = { target, context: this.context };
    const what = hunk !== null ? "this hunk" : file ? file.path : "all of these changes";
    const lost = this.scope === "unstaged" && !file ? " Untracked files are deleted too." : file?.fresh ? " This file isn't in git, so it's deleted for good." : "";
    openOverlay({ mod: "confirm", kind: "dialog", width: 420, height: 200, props: { title: "Revert?", detail: `Undoes ${what} in your working files.${lost} This can't be undone.`, command: { name: "changes.revert" } } });
  }

  act(action, target, cx) {
    if (action === "revert") this.ask(target);
    else this.apply(action, target, cx);
  }

  // Fixed to the repo it began on: with no root, git would run in the home folder.
  apply(action, { file = null, hunk = null } = {}, cx) {
    const { root, on, spec, scope, hasHead } = this;
    if (!root || !spec || this.busy) return;
    const plan = planAction(action, scope, { file, hunk, hasHead });
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        if (plan.patch) {
          const text = plan.patch === "hunk" ? hunkPatch(file, hunk) : await this.patchText(plan.patch === "file" ? file : null, root, on, spec);
          await this.applyPatch(text, plan.flags, root, on);
        }
        for (const args of plan.commands ?? []) {
          const r = await exec("git", ["--literal-pathspecs", ...args], { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
      } catch (e) { this.note = `${action[0].toUpperCase()}${action.slice(1)} failed: ${e?.message ?? e}`; }
      finally { this.busy = false; this.raw = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  async patchText(file, root, on, spec) {
    const r = await exec("git", [...READ, "diff", "--binary", ...DIFF, ...spec.args, ...(file ? ["--", file.path] : [])], { cwd: root, on });
    if (r.code !== 0) throw new Error(r.stderr.trim());
    if (r.stdout.length >= EXEC_LIMIT) throw new Error("This diff is too large to undo at once");
    return r.stdout;
  }

  // exec has no stdin: a patch goes through a file here, an argument on another machine.
  async applyPatch(text, flags, root, on) {
    let r;
    if (on) r = await exec("sh", ["-c", 'p=$1; shift; printf %s "$p" | git apply "$@" -', "apply", text, ...flags], { cwd: root, on });
    else {
      const folder = `${appHome()}/data`, path = `${folder}/changes-${Date.now()}.patch`;
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path, text);
      try { r = await exec("git", ["apply", ...flags, path], { cwd: root }); }
      finally { await fs.unlink(path).catch(() => {}); }
    }
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  }

  canCommit() {
    return Boolean(this.message.trim() && this.root && !this.busy && !this.loading && (this.scope !== "staged" || this.files.length));
  }

  // What's staged is committed as it stands; with nothing staged, everything is.
  commit(cx) {
    if (!this.canCommit() || this.context !== key()) return;
    const { root, on, context } = this, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const staged = await exec("git", ["diff", "--cached", "--quiet"], { cwd: root, on });
        for (const args of [...(staged.code === 0 ? [["add", "-A"]] : []), ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e?.message ?? e}`; }
      finally { this.busy = false; this.raw = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  openInEditor(path, line, cx) {
    const full = `${this.root}/${path}`, at = `${full}:${line ?? 1}`, platform = window()?.platform;
    const system = platform === "macos" ? ["open", [full]] : platform === "windows" ? ["cmd", ["/c", "start", "", full]] : ["xdg-open", [full]];
    cx.spawn(async () => {
      for (const [command, args] of [["cursor", ["-g", at]], ["code", ["-g", at]], ["zed", [at]], system]) {
        const r = await exec(command, args).catch(() => null);
        if (r?.code === 0) return;
      }
      notify({ title: "No editor found to open this file", level: "warning" });
    });
  }

  // Last turn: a turn starts when an agent begins working and ends when it stops.
  // A permission prompt in between is the same turn.
  watchTurns(cx) {
    const active = (status) => status === "working" || status === "blocked";
    for (const agent of agents()) {
      const was = this.statuses[agent.address];
      this.statuses[agent.address] = agent.status;
      if (agent.status === "working" && !active(was)) this.markTurn(agent, "start", was === undefined, cx);
      else if (active(was) && !active(agent.status)) this.markTurn(agent, "end", false, cx);
    }
  }

  markTurn(agent, edge, justSeen, cx) {
    const space = spaces().find((s) => s.id === agent.space), on = space?.machine ?? null;
    const cwd = panes().find((p) => p.pane === agent.pane)?.cwd ?? space?.folder;
    if (!cwd) return;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (top.code !== 0) return;
        const root = top.stdout.trim(), id = `${on ?? ""}:${root}`, turn = this.turns[id];
        if (edge === "start" && justSeen && turn?.agent === agent.address && !turn.end) return;
        if (edge === "end" && turn?.agent !== agent.address) return;
        const tree = await snapshot(root, on);
        if (edge === "start") this.turns[id] = { start: tree, end: null, agent: agent.address, at: Date.now() };
        else this.turns[id].end = tree;
        keep("turns", this.turns);
        if (this.scope === "turn" && root === this.root) { this.raw = null; this.refresh(cx); }
      } catch {}
    });
  }

  startComment(row, cx) {
    const side = row.kind === "del" ? "old" : "new", line = side === "old" ? row.old : row.new;
    this.draft = { id: null, path: row.path, line, side, code: row.text };
    this.commentInput.set_value("");
    this.commentInput.focus();
    cx.notify();
  }
  editComment(comment, cx) {
    this.draft = { ...comment };
    this.commentInput.set_value(comment.text);
    this.commentInput.focus();
    cx.notify();
  }
  saveComment(cx) {
    const text = this.commentInput.value().trim();
    if (!this.draft || !text) return;
    const { draft } = this;
    this.comments = draft.id
      ? this.comments.map((c) => (c.id === draft.id ? { ...c, text } : c))
      : [...this.comments, { ...draft, id: `${Date.now().toString(36)}${this.comments.length}`, text }];
    this.closeDraft(cx);
  }
  dropComment(cx) {
    this.comments = this.comments.filter((c) => c.id !== this.draft?.id);
    this.closeDraft(cx);
  }
  closeDraft(cx) {
    this.draft = null;
    keep(`comments:${this.root}`, this.comments);
    this.compose();
    this.handle.focus();
    cx.notify();
  }
  clearComments(cx) {
    this.comments = [];
    keep(`comments:${this.root}`, this.comments);
    this.compose();
    cx.notify();
  }

  targets() {
    const space = spaces().find((s) => s.active);
    return agents().filter((a) => a.space === space?.id).sort((a, b) => Number(b.focused) - Number(a.focused));
  }

  sendComments(agent, cx) {
    if (this.sending) return;
    const message = reviewMessage(this.comments), count = this.comments.length;
    this.sending = true; this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(["send", agent.address, message]).catch((e) => ({ code: 1, stderr: String(e) }));
      this.sending = false;
      if (r.code !== 0) this.note = `Could not send: ${(r.stderr || "").trim() || "the agent didn't take it"}`;
      else { this.clearComments(cx); notify({ title: `Sent ${plural(count, "comment")} to ${agent.program?.name ?? "the agent"}`, level: "success" }); }
      cx.notify();
    });
  }

  openJump() {
    const at = jumpList(this.files, "").findIndex((row) => row.path === this.open);
    this.jumpWanted = ""; this.jumpAt = Math.max(0, at);
    this.jumpInput.set_value("");
    this.jumpScroll.scroll_to_item(this.jumpAt);
    this.jumpInput.focus();
  }

  jumpTo(row, cx) {
    if (!row) return;
    this.menu = null;
    const parts = row.path.split("/");
    for (let end = 1; end < parts.length; end++) this.shutDirs.delete(parts.slice(0, end).join("/"));
    this.buildTree();
    const at = this.treeList.findIndex((item) => item.file?.path === row.path);
    if (at >= 0) this.treeScroll.scroll_to_item(at);
    this.handle.focus();
    this.pickFile(row.path, cx);
    cx.notify();
  }

  // A list row has one click handler: where the press landed says what it was for.
  pressed(event) {
    this.press = { x: event.local_position?.x ?? 0, y: event.local_position?.y ?? 0, width: event.bounds?.width ?? this.diffWidth(), meta: event.modifiers.platform || event.modifiers.control };
  }

  canHunk(row) {
    return (row.kind === "add" || row.kind === "del") && !this.tight;
  }
  stageWord() {
    return this.scope === "unstaged" ? "Stage" : this.scope === "staged" ? "Unstage" : null;
  }

  clickRow(id, cx) {
    const row = this.byId.get(id), press = this.press ?? { x: 0, y: 0, width: 0, meta: false };
    if (!row) return;
    if (row.kind === "file") return this.clickFileRow(row.file, press, cx);
    if (row.kind === "gap") return this.openGap(row, cx);
    if (row.kind === "comment") return this.editComment(row.comment, cx);
    const end = press.width - HUNK_MARGIN, sides = row.kind === "pair" ? [row.right, row.left] : [row];
    const changed = sides.find((side) => side && this.canHunk(side));
    if (changed && press.x >= end - HUNK_BUTTONS && press.x <= end) {
      const file = this.files.find((f) => f.path === changed.path), word = this.stageWord();
      if (word && press.x >= end - HUNK_BUTTONS / 2) return this.act(word.toLowerCase(), { file, hunk: changed.hunk }, cx);
      return this.act("revert", { file, hunk: changed.hunk }, cx);
    }
    const half = press.width / 2, right = row.kind === "pair" && press.x >= half;
    const target = row.kind === "pair" ? (right ? row.right : row.left) : row;
    if (!target) return;
    if (press.meta && !this.on) return this.openInEditor(target.path, target.new ?? target.old, cx);
    if ((right ? press.x - half : press.x) <= GUTTER) this.startComment(target, cx);
  }

  // Its buttons, right to left: the row can't hold handlers, so a press is matched by place.
  fileButtons(file) {
    return [
      { name: "chevron-right", action: (cx) => this.stepFile(1, cx) },
      { name: "chevron-left", action: (cx) => this.stepFile(-1, cx) },
      { name: "more", action: (cx, press, end) => { this.rowMenu = { path: file.path, x: end, y: press.y + 10 }; this.menu = "row"; this.reveal(cx); cx.notify(); } },
    ];
  }

  clickFileRow(file, press, cx) {
    const buttons = this.fileButtons(file), end = press.width - FILE_END;
    const at = buttonAt(press.x, end, buttons.length, FILE_BUTTON, FILE_GAP);
    if (at < 0) this.toggleFile(file.path, cx);
    else buttons[at].action(cx, press, end - at * (FILE_BUTTON + FILE_GAP));
  }

  wheel(event, cx) {
    const { x, y } = event.delta;
    const sideways = event.modifiers.shift ? y : Math.abs(x) > Math.abs(y) ? x : 0;
    if (!sideways || this.wrap || !this.maxScroll) return;
    this.scrollX = Math.max(0, Math.min(this.maxScroll, this.scrollX - sideways));
    cx.notify();
  }

  resized(size, cx) {
    const splitting = this.splitting(), columns = this.columns();
    this.width = size.width; this.height = size.height;
    if (splitting !== this.splitting() || (this.wrap && columns !== this.columns())) this.compose();
    else this.clampScroll();
    cx.notify();
  }

  // Changes needs its width; Files is happy with less, so it's asked for here.
  keepWide() {
    const root = layout(), panel = findNode(root, "panel");
    if (panel && !panel.hidden && findNode(root, "panel-body")?.active === "changes" && (panel.size?.px ?? 0) < PANEL_MIN) run("layout.resize", { id: "panel", px: PANEL_MIN });
  }

  pieces(spans, t) {
    return spans.map(([text, kind]) => {
      const piece = div().flex_none().whitespace_nowrap();
      return kind ? piece.text_color(t[COLORS[kind]]).child(text) : piece.child(text);
    });
  }

  code(row, columns, t) {
    const tone = this.tones[row.kind];
    const cell = div().flex_1().min_w(0).h_full().overflow_hidden().pr(CODE_RIGHT).font_family(MONO).text_size(11.5).text_color(tone ? t.foreground : t.diff_text);
    const spans = row.spans ?? [[row.text, null]];
    const body = this.wrap ? cell.child(v_flex().children(wrapSpans(spans, columns).map((line) => h_flex().h(LINE).items_center().children(this.pieces(line, t)))))
      : cell.child(h_flex().h(LINE).items_center().ml(-this.scrollX).children(this.pieces(spans, t)));
    if (!tone) return body;
    return h_flex().flex_1().min_w(0).h_full().items_start()
      .child(h_flex().w(MARKER).h(LINE).flex_none().items_center().justify_center().font_family(MONO).text_size(11.5).text_color(tone.text).child(row.kind === "add" ? "+" : minus))
      .child(body);
  }

  gutter(row, t) {
    const tone = this.tones[row?.kind], number = row ? row.new ?? row.old : "";
    return div().w(GUTTER).h_full().flex_none().when(Boolean(tone), (el) => el.bg(tone.gutter))
      .child(h_flex().h(LINE).pr(14).items_center().justify_end().font_family(MONO).text_size(11.5).text_color(tone?.text ?? t.line_number).child(String(number)));
  }

  // The side of a change with nothing on it.
  stripes(lines) {
    const tile = () => svg("mods/changes/icons/stripes.svg").w(STRIPES).h(LINE).flex_none().text_color(this.tones.stripe);
    const tiles = Math.ceil(this.codeWidth() / STRIPES), row = () => h_flex().h(LINE).flex_none().children(Array.from({ length: tiles }, tile));
    return div().flex_1().min_w(0).h_full().overflow_hidden().child(v_flex().children(Array.from({ length: lines }, row)));
  }

  // The row's hover layer: a clear sheet, shown whole when the pointer is on it.
  hoverLayer(row, t) {
    const badge = (at) => h_flex().absolute().left(at).top(0).size(LINE).ml(GUTTER - LINE - 6).items_center().justify_center().rounded(6).bg(t.solid).text_color(t.solid_foreground).child(icon("plus", 16));
    const layer = div().id("hover").absolute().inset_0().opacity(0).hover((s) => s.opacity(1)).child(badge(0)).when(row.kind === "pair", (el) => el.child(badge(Math.round(this.diffWidth() / 2))));
    const changed = row.kind === "pair" ? (row.left?.kind === "del" || row.right?.kind === "add") : this.canHunk(row);
    if (!changed || this.tight) return layer;
    const word = this.stageWord();
    const button = (label) => div().w(HUNK_BUTTONS / 2 - 4).h(LINE - 3).flex().items_center().justify_center().rounded(5).bg(t.popover).border_1().border_color(t.border).text_color(t.foreground).text_size(11).child(label);
    return layer.child(h_flex().absolute().right(HUNK_MARGIN).top(0).w(HUNK_BUTTONS).h(LINE).gap(4).items_center().justify_end().child(button("Revert")).when(Boolean(word), (el) => el.child(button(word))));
  }

  toned(t) {
    return {
      add: { row: t.diff_added_row, gutter: t.diff_added_gutter, text: t.added },
      del: { row: t.diff_removed_row, gutter: t.diff_removed_gutter, text: t.removed },
      stripe: t.hover,
    };
  }

  lineRow(row, columns, t) {
    const tone = this.tones[row.kind];
    return h_flex().relative().w_full().h_full().items_start().when(Boolean(tone), (el) => el.bg(tone.row)).child(this.gutter(row, t)).child(this.code(row, columns, t)).child(this.hoverLayer(row, t));
  }

  pairRow(row, columns, t) {
    const lines = Math.round(this.heightOf(row, columns) / LINE);
    const cell = (side) => h_flex().flex_1().min_w(0).h_full().items_start().when(Boolean(this.tones[side?.kind]), (el) => el.bg(this.tones[side.kind].row))
      .child(this.gutter(side, t)).child(side ? this.code(side, columns, t) : this.stripes(lines));
    return h_flex().relative().w_full().h_full().items_start().child(cell(row.left)).child(cell(row.right)).child(this.hoverLayer(row, t));
  }

  gapRow(row, t) {
    return div().w_full().h_full().py(4).child(h_flex().id("gap").size_full().bg(t.diff_collapsed_row).items_center().text_size(11.5).text_color(t.text_faint).hover((s) => s.bg(t.hover))
      .child(h_flex().w(GUTTER).h_full().flex_none().items_center().justify_center().bg(t.diff_collapsed_gutter).child(icon("unfold", 16)))
      .child(div().pl(14).child(`${commas(row.count)} unmodified ${row.count === 1 ? "line" : "lines"}`)));
  }

  fileLabel(file, t, on = true) {
    const parts = file.path.split("/"), name = parts.pop();
    return h_flex().flex_1().min_w(0).gap(8).items_center().text_size(13)
      .child(typeTag(file.path, on ? t.accent : t.label))
      .child(h_flex().flex_1().min_w(0).gap(4).items_center()
        .when(parts.length > 0, (el) => el.child(div().min_w(0).truncate().text_color(t.label).child(`${parts.join(" / ")} /`)))
        .child(div().flex_none().max_w_full().truncate().when(file.isDeleted, (el) => el.line_through()).child(name)));
  }

  stats(file, t, both = true, size = 11.5) {
    const add = both || file.add > 0, del = both || file.del > 0;
    return h_flex().flex_none().gap(6).font_family(MONO).text_size(size)
      .when(add, (el) => el.child(div().text_color(t.added).child(`+${commas(file.add)}`)))
      .when(del, (el) => el.child(div().text_color(t.removed).child(`${minus}${commas(file.del)}`)));
  }

  counter(file, t) {
    return div().flex_none().ml(8).font_family(MONO).text_size(10.5).text_color(t.label).child(`${this.files.indexOf(file) + 1} / ${this.files.length}`);
  }

  commentRow(row, t) {
    return div().w_full().h_full().px(14).py(5).child(
      v_flex().id("note").size_full().px(12).py(7).gap(2).rounded(9).bg(t.raised).border_1().border_color(t.border).hover((s) => s.border_color(t.input))
        .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim).child(icon("comment", 16)).child(`Line ${row.comment.line}`))
        .child(v_flex().text_size(12).text_color(t.foreground).child(row.comment.text)));
  }

  // What a file's header holds, in a list row or above a single file. A row can't take
  // handlers, so its buttons are matched by place (`fileButtons`).
  fileRow(row, t) {
    const file = row.file, shut = this.shut.has(file.path), [next, back, more] = this.fileButtons(file);
    const button = (name) => h_flex().size(FILE_BUTTON).flex_none().items_center().justify_center().rounded(7).text_color(t.muted).child(icon(name, 16));
    const options = h_flex().absolute().right(FILE_END + 2 * (FILE_BUTTON + FILE_GAP)).top(6).size(FILE_BUTTON).items_center().justify_center().rounded(7).bg(t.card).text_color(t.muted).child(icon(more.name, 16));
    return h_flex().id("file").relative().w_full().h_full().pl(18).pr(FILE_END).gap(8).items_center().when(!row.first, (el) => el.border_t(1).border_color(t.card_border).hover((s) => s.bg(t.hover)))
      .child(this.fileLabel(file, t, file.path === this.open))
      .child(this.stats(file, t))
      .child(this.counter(file, t))
      .child(h_flex().flex_none().gap(FILE_GAP).child(button(back.name)).child(button(next.name)))
      .child(div().id("options").absolute().inset_0().opacity(0).hover((s) => s.opacity(1)).when(!shut, (el) => el.child(options)));
  }

  drawRow(row, columns, t) {
    switch (row.kind) {
      case "file": return this.fileRow(row, t);
      case "gap": return this.gapRow(row, t);
      case "comment": return this.commentRow(row, t);
      case "note": return div().w_full().h_full().px(14).py(10).text_color(t.dim).text_size(12).child(row.text);
      case "pair": return this.pairRow(row, columns, t);
      default: return this.lineRow(row, columns, t);
    }
  }

  tool(id, name, tip, action, t, { on = false } = {}) {
    return this.tip(id, tip, this.toolButton(id, name, t, on).on_click((_e, cx) => action(cx)), t);
  }

  toolButton(id, name, t, on = false) {
    return h_flex().id(id).size(26).flex_none().items_center().justify_center().rounded(13).cursor_pointer().text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.pill_selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover_strong).text_color(t.foreground))).child(icon(name, 16));
  }

  // `.tooltip()` shows nothing here: its layer is looked up on the window's first
  // view, and that is the app's, not a mod's. A hover card gives the same label.
  tip(id, text, trigger, t) {
    return HoverCard.new(`tip-${id}`).open_delay(TIP_DELAY).close_delay(0).trigger(trigger)
      .when(!this.menu, (el) => el.content(div().mt(6).px(9).py(5).rounded(8).bg(t.raised).border_1().border_color(t.border).shadow_md().text_size(12).text_color(t.foreground).whitespace_nowrap().child(text)));
  }

  popover(id, anchor, trigger, content) {
    const open = this.menu === id;
    return Popover.new(`changes-${id}`).anchor(anchor).open(open)
      .on_open_change((next, cx) => {
        this.menu = next ? id : null;
        if (next) this.reveal(cx);
        if (next && id === "base") { this.baseInput.set_value(""); this.baseFilter = ""; this.baseInput.focus(); }
        if (next && id === "jump") this.openJump();
        if (next && id === "switch") this.openSwitch(cx);
        cx.notify();
      })
      .trigger(trigger).when(open, (el) => el.content(content()));
  }

  // A dropdown starts hidden, then eases in, as the app's own menus do: a transition needs a
  // frame to start from.
  reveal(cx) {
    this.menuIn = false;
    cx.timer.after(MENU_REVEAL, (cx) => { this.menuIn = true; cx.notify(); });
  }

  arrive(box) {
    return box.relative().top(this.menuIn ? 0 : -MENU_RISE).opacity(this.menuIn ? 1 : 0).transition("opacity", MENU_EASE).transition("top", MENU_EASE);
  }

  menuBox(width, t, rows) {
    return this.arrive(v_flex()).id("changes-menu-box").w(width).max_h(380).overflow_y_scrollbar().p(6).gap(1).rounded(14).bg(t.raised).border_1().border_color(t.border).shadow_lg().text_size(13).text_color(t.foreground).children(rows);
  }

  item(id, label, action, t, { hint = null, on = false, danger = false, enabled = true } = {}) {
    return h_flex().id(`changes-item-${id}`).h(32).flex_none().px(10).gap(10).items_center().rounded(9).when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.menu = null; action(cx); cx.notify(); })).text_color(!enabled ? t.dim : danger ? (t.failed ?? t.blocked) : t.foreground)
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(hint)))
      .when(on, (el) => el.child(icon("check", 16).text_color(t.accent)));
  }

  pillBox(t) {
    return h_flex().items_center().rounded(999).bg(t.pill).border_1().border_color(t.pill_ring);
  }

  pill(id, t) {
    return this.pillBox(t).id(id).h(34).min_w(0).px(13).gap(7).text_size(13.5).cursor_pointer().hover((s) => s.bg(t.hover));
  }

  scopeControl(t) {
    const label = SCOPES.find(([id]) => id === this.scope)?.[1];
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const trigger = this.pill("changes-scope", t).flex_none().gap(9)
      .child(h_flex().gap(4).items_center().child(label).child(icon("chevron-down", 12).text_color(t.label)))
      .child(div().font_family(MONO).text_size(12.5).text_color(t.added).child(`+${commas(add)}`))
      .child(div().font_family(MONO).text_size(12.5).text_color(t.removed).child(`${minus}${commas(del)}`));
    return this.tip("changes-scope", "Choose which changes to show", this.popover("scope", "top_left", trigger, () => this.menuBox(180, t, SCOPES.map(([id, name]) => this.item(id, name, (cx) => this.setScope(id, cx), t, { on: id === this.scope })))), t);
  }

  compareControl(t) {
    if (this.scope === "branch" && this.base) {
      const trigger = this.pill("changes-base", t)
        .child(icon("branch", 16).text_color(t.accent))
        .child(div().min_w(0).truncate().child(this.branch ?? "")).child(icon("arrow-right", 16).text_color(t.label))
        .child(div().min_w(0).truncate().child(this.base)).child(icon("chevron-down", 12).text_color(t.label));
      return this.popover("base", "top_left", trigger, () => {
        const wanted = this.baseFilter.toLowerCase(), refs = this.refs.filter((ref) => ref !== this.branch && ref.toLowerCase().includes(wanted)).slice(0, 80);
        return this.menuBox(300, t, [
          h_flex().h(32).flex_none().px(9).mb(4).items_center().rounded(7).border_1().border_color(t.border).child(Input.new(this.baseInput).h_full().text_size(12)),
          ...refs.map((ref) => this.item(`base-${ref}`, ref, (cx) => this.setBase(ref, cx), t, { on: ref === this.base })),
        ]);
      });
    }
    if (this.scope === "commit" && this.commits.length) {
      const shown = this.commits.find((c) => c.sha === this.shownCommit) ?? this.commits[0];
      const trigger = this.pill("changes-commit", t)
        .child(div().flex_none().font_family(MONO).text_size(13).text_color(t.label).child(shown.short)).child(div().min_w(0).truncate().child(shown.subject)).child(icon("chevron-down", 12).text_color(t.label));
      return this.popover("commit", "top_left", trigger, () => this.menuBox(380, t, this.commits.map((c) => this.item(`commit-${c.sha}`, `${c.short}  ${c.subject}`, (cx) => { this.picked = c.sha; this.reload(cx); }, t, { hint: c.when, on: c.sha === shown.sha }))));
    }
    if (this.scope === "turn" && this.turnLabel()) return div().min_w(0).px(4).truncate().text_color(t.muted).child(this.turnLabel());
    return this.branch ? this.branchControl(t) : div();
  }

  branchControl(t) {
    const trigger = this.pill("changes-branch", t).pr(11)
      .child(icon("branch", 16).text_color(t.accent))
      .child(div().min_w(0).truncate().child(this.branch))
      .child(icon("chevron-down", 12).text_color(t.label));
    return this.tip("changes-branch", "Switch branch", this.popover("switch", "top_left", trigger, () => {
      const wanted = this.baseFilter.toLowerCase(), list = this.branches.filter((name) => name.toLowerCase().includes(wanted)).slice(0, 80);
      return this.menuBox(300, t, [
        h_flex().h(32).flex_none().px(9).mb(4).items_center().rounded(7).border_1().border_color(t.border).child(Input.new(this.baseInput).h_full().text_size(12)),
        ...list.map((name) => this.item(`switch-${name}`, name, (cx) => this.switchTo(name, cx), t, { on: name === this.branch })),
      ]);
    }), t);
  }

  openSwitch(cx) {
    this.baseInput.set_value(""); this.baseFilter = ""; this.baseInput.focus();
    if (!this.root) return;
    cx.spawn(async (cx) => {
      const r = await this.git(["for-each-ref", "--sort=-committerdate", "--count=300", "--format=%(refname:short)", "refs/heads"]);
      if (r.code === 0) this.branches = r.stdout.split("\n").filter(Boolean);
      cx.notify();
    });
  }

  // Git refuses a switch that would overwrite uncommitted work, and says so.
  switchTo(name, cx) {
    const { root, on } = this;
    if (!root || this.busy || name === this.branch) return;
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["switch", name], { cwd: root, on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
      } catch (e) { this.note = `Switch failed: ${e?.message ?? e}`; }
      finally { this.busy = false; this.raw = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  turnLabel() {
    const turn = this.root ? this.turns[`${this.on ?? ""}:${this.root}`] : null;
    if (!turn) return null;
    const minutes = Math.round((Date.now() - turn.at) / 60000);
    const when = minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
    return turn.end ? `Turn from ${when}` : `Turn started ${when}`;
  }

  jumpControl(t) {
    return this.tip("changes-jump", "Jump to file", this.popover("jump", "top_right", this.toolButton("changes-jump", "find-in-diff", t, this.menu === "jump"), () => this.jumpBox(t)), t);
  }

  jumpRow(row, active, t) {
    const room = Math.floor((JUMP_WIDTH - 32 - row.name.length * UI_CHAR) / UI_CHAR), folder = room >= 6 ? middle(row.folder, room) : "";
    return h_flex().id("row").w_full().h(JUMP_ROW).px(8).gap(8).items_center().rounded(10).when(active, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
      .child(div().flex_none().max_w(JUMP_WIDTH - 32).truncate().text_color(t.foreground).child(row.name))
      .when(Boolean(folder), (el) => el.child(div().min_w(0).truncate().text_color(t.dim).child(folder)));
  }

  jumpBox(t) {
    const rows = jumpList(this.files, this.jumpWanted), at = Math.min(this.jumpAt, rows.length - 1);
    const list = v_virtual_list("changes-jump", rows.length, JUMP_ROW, (i) => rows[i].path, (range) => rows.slice(range.start, range.end).map((row) => this.jumpRow(row, rows[at] === row, t)))
      .track_scroll(this.jumpScroll).size_full().on_item_click((path, cx) => this.jumpTo(rows.find((row) => row.path === path), cx));
    return this.arrive(v_flex()).id("changes-jump-box").w(JUMP_WIDTH).mt(4).p(4).rounded(14).bg(t.raised).border_1().border_color(t.border).shadow_lg().text_size(13)
      .on_key_down((e, cx) => {
        if ((e.key !== "down" && e.key !== "up") || !rows.length) return;
        this.jumpAt = stepped(at, e.key === "down" ? 1 : -1, rows.length);
        this.jumpScroll.scroll_to_item(this.jumpAt);
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().h(38).flex_none().px(8).gap(8).items_center().child(icon("search", 16).text_color(t.dim)).child(div().flex_1().min_w(0).child(Input.new(this.jumpInput).h_full().text_size(13))))
      .child(rows.length ? div().relative().w_full().flex_none().h(Math.min(rows.length, JUMP_ROWS) * JUMP_ROW).child(list).child(Scrollbar.vertical("changes-jump").viewport_from_layout().absolute().inset_0())
        : div().px(8).py(6).text_color(t.dim).child("No matching files"));
  }

  moreControl(t) {
    return this.tip("changes-more", "Changes options", this.popover("more", "top_right", this.toolButton("changes-more", "more", t), () => {
      const word = this.stageWord(), some = this.files.length > 0;
      return this.menuBox(220, t, [
        this.item("refresh", "Refresh", (cx) => this.reload(cx), t),
        this.item("wrap", "Wrap lines", (cx) => { this.wrap = !this.wrap; this.scrollX = 0; this.saveView(); this.compose(); cx.notify(); }, t, { on: this.wrap }),
        this.item("fold", "Hide unchanged lines", (cx) => this.toggleUnfold(cx), t, { on: !this.unfold }),
        this.item("space", "Hide whitespace", (cx) => { this.tight = !this.tight; this.reload(cx); }, t, { on: this.tight }),
        ...(this.oneFile() ? [] : [this.item("all-files", this.shut.size < this.files.length ? "Collapse all diffs" : "Expand all diffs", (cx) => this.toggleAllFiles(cx), t, { enabled: some })]),
        ...(word ? [this.item("stage-all", `${word} all`, (cx) => this.act(word.toLowerCase(), {}, cx), t, { enabled: some })] : []),
        this.item("revert-all", "Revert all", (cx) => this.act("revert", {}, cx), t, { danger: some, enabled: some }),
      ]);
    }), t);
  }

  toolbar(t) {
    const tools = this.pillBox(t).flex_none().gap(2).p(3)
      .child(this.jumpControl(t))
      .when(this.canSplit(), (el) => el.child(this.tool("changes-split", "split-view", this.split ? "Switch to unified diff" : "Switch to split diff", (cx) => { this.split = !this.split; this.saveView(); this.compose(); cx.notify(); }, t, { on: this.split })))
      .child(this.tool("changes-tree", "file-tree", this.showTree ? "Hide file tree" : "Show file tree", (cx) => this.toggleTree(cx), t, { on: this.showTree }))
      .child(this.moreControl(t));
    return h_flex().flex_none().px(8).pb(8).gap(6).items_center()
      .child(this.scopeControl(t))
      .child(h_flex().flex_1().min_w(0).child(this.compareControl(t)))
      .child(tools);
  }

  fileHeader(file, t) {
    const step = (id, name, by, tip) => this.tip(id, tip, h_flex().id(id).size(FILE_BUTTON).flex_none().items_center().justify_center().rounded(7).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover_strong).text_color(t.foreground)).on_click((_e, cx) => this.stepFile(by, cx)).child(icon(name, 16)), t);
    const trigger = h_flex().id("changes-file-more").size(FILE_BUTTON).flex_none().items_center().justify_center().rounded(7).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover_strong).text_color(t.foreground)).child(icon("more", 16));
    return h_flex().h(FILE_ROW).flex_none().pl(18).pr(FILE_END).gap(8).items_center()
      .child(this.fileLabel(file, t))
      .child(this.stats(file, t))
      .child(this.counter(file, t))
      .child(this.tip("changes-file-more", "File options", this.popover("file", "top_right", trigger, () => this.fileMenu(file, t)), t))
      .child(h_flex().flex_none().gap(FILE_GAP).child(step("changes-prev", "chevron-left", -1, "Previous file")).child(step("changes-next", "chevron-right", 1, "Next file")));
  }

  fileMenu(file, t) {
    const state = this.gaps.get(file.path), viewed = this.isViewed(file), word = this.stageWord();
    return this.menuBox(210, t, [
      ...(word ? [this.item("file-stage", `${word} file`, (cx) => this.act(word.toLowerCase(), { file }, cx), t)] : []),
      this.item("file-revert", "Revert file", (cx) => this.act("revert", { file }, cx), t, { danger: true }),
      this.item("file-viewed", viewed ? "Mark as unviewed" : "Mark as viewed", (cx) => this.toggleViewed(file, cx), t),
      ...(file.hunks.length ? [this.item("file-whole", state?.all ? "Show only the changes" : "Show the whole file", (cx) => this.toggleWhole(file, cx), t)] : []),
      ...(this.on ? [] : [this.item("file-open", "Open in editor", (cx) => this.openInEditor(file.path, null, cx), t)]),
      this.item("file-copy", "Copy path", (cx) => cx.write_to_clipboard(file.path), t),
    ]);
  }

  emptyState(t) {
    const words = this.error ?? this.empty ?? (this.loading ? "Loading changes…" : this.root ? NOTHING[this.scope] : "No folder");
    return div().flex_1().min_h(0).flex().items_center().justify_center().p(24).text_color(t.dim).child(words);
  }

  diffList(t) {
    const rows = this.rows, columns = this.columns(), menuFile = this.menu === "row" ? this.files.find((f) => f.path === this.rowMenu?.path) : null;
    // GPUI clips to a box, not a curve: the rows stop short of the card's rounded bottom.
    return div().flex_1().min_h(0).relative().pb(12)
      .id("changes-diff-wrap")
      .on_mouse_down("left", (e) => this.pressed(e))
      .on_scroll_wheel((e, cx) => this.wheel(e, cx))
      .child(v_virtual_list("changes-diff", rows.length, this.sizes, (i) => rows[i].id, (range) => rows.slice(range.start, range.end).map((row) => this.drawRow(row, columns, t)))
        .track_scroll(this.scroll).on_item_click((id, cx) => this.clickRow(id, cx)).size_full())
      .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
      .when(this.maxScroll > 0 && !this.wrap, (el) => el.child(this.sideways(t)))
      .when(Boolean(menuFile), (el) => el.child(div().absolute().left(this.rowMenu.x).top(this.rowMenu.y).child(this.popover("row", "top_right", div().size(1), () => this.fileMenu(menuFile, t)))));
  }

  sideways(t) {
    const room = this.diffWidth() - GUTTER - MARKER, width = Math.max(40, room * room / (room + this.maxScroll));
    return div().absolute().bottom(2).left(GUTTER + (room - width) * (this.scrollX / this.maxScroll)).w(width).h(6).rounded(3).bg(t.pill_selected);
  }

  composer(t) {
    const { draft } = this, name = draft.path.split("/").pop();
    const button = (id, label, action, solid = false) => div().id(id).h(28).px(12).flex().items_center().rounded(7).cursor_pointer().when(solid, (el) => el.bg(t.solid).text_color(t.solid_foreground)).when(!solid, (el) => el.bg(t.raised)).text_size(12).on_click((_e, cx) => action(cx)).child(label);
    return v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).truncate().child(`${draft.id ? "Edit comment on" : "Comment on"} ${name}:${draft.line}`))
      .child(h_flex().h(32).px(10).items_center().rounded(8).border_1().border_color(t.accent).child(Input.new(this.commentInput).h_full().text_size(12)))
      .child(h_flex().gap(6).justify_end()
        .when(Boolean(draft.id), (el) => el.child(button("changes-comment-drop", "Delete", (cx) => this.dropComment(cx))))
        .child(button("changes-comment-cancel", "Cancel", (cx) => { this.draft = null; this.handle.focus(); cx.notify(); }))
        .child(button("changes-comment-save", "Comment", (cx) => this.saveComment(cx), true)));
  }

  commentBar(t) {
    const count = this.comments.length, targets = this.targets();
    const send = div().id("changes-send").h(28).px(12).flex().items_center().rounded(7).bg(t.solid).text_color(t.solid_foreground).text_size(12).cursor_pointer();
    const control = this.sending ? div().text_size(12).text_color(t.dim).child("Sending…")
      : !targets.length ? div().text_size(11).text_color(t.dim).child("No agent in this space")
      : targets.length === 1 ? send.on_click((_e, cx) => this.sendComments(targets[0], cx)).child(`Send to ${targets[0].program?.name ?? "agent"}`)
        : this.popover("send", "bottom_right", send.child("Send to agent"), () => this.menuBox(260, t, targets.map((a) => this.item(`send-${a.address}`, a.program?.name ?? a.address, (cx) => this.sendComments(a, cx), t, { hint: a.tab_name }))));
    return h_flex().flex_none().h(44).px(10).gap(8).items_center().border_t(1).border_color(t.border)
      .child(icon("comment", 16).text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(plural(count, "comment")))
      .child(div().id("changes-comments-clear").h(28).px(10).flex().items_center().rounded(7).cursor_pointer().text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.clearComments(cx)).child("Clear"))
      .child(control);
  }

  commitBar(t) {
    const enabled = this.canCommit(), files = plural(this.files.length, "file").toUpperCase();
    const staged = this.staged ? `${this.staged} STAGED` : "NOTHING STAGED";
    return h_flex().flex_none().pl(14).pr(8).py(8).gap(8).items_center()
      .child(spaced(`${staged} · ${files}`, 10.5, 0.1).text_color(t.label))
      .child(h_flex().id("commit-message").flex_1().min_w(0).h(34).px(11).gap(6).items_center().rounded(11).bg(this.typing ? t.selected : t.pill).border_1().border_color(t.pill_ring).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_key_down((e, cx) => { if (e.key === "enter" && (e.modifiers.platform || e.modifiers.control)) { cx.stop_propagation(); this.commit(cx); } })
        .child(div().flex_1().min_w(0).child(Input.new(this.input).h_full().text_size(13).text_color(t.foreground)))
        .child(div().flex_none().font_family(MONO).text_size(10.5).text_color(t.label).child(window()?.platform === "macos" ? "\u2318\u21b5" : "Ctrl \u21b5")))
      .child(h_flex().id("commit").h(34).px(15).gap(6).flex_none().items_center().rounded(11).bg(t.accent).text_color(t.accent_foreground).text_size(13.5).font_medium()
        .when(!enabled, (e) => e.opacity(0.55)).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx))
        .child(icon("commit", 16)).child(this.busy ? "Committing…" : "Commit"));
  }

  treeRow(row, t) {
    const shell = h_flex().id("row").w_full().h(TREE_ROW).flex_none().pr(8).items_center().rounded(7);
    if (row.kind === "dir") return shell.pl(4 + row.depth * 14).gap(6).text_color(t.tile_text).hover((s) => s.bg(t.hover)).child(icon(row.open ? "chevron-down" : "chevron-right", 12).text_color(t.label)).child(div().flex_1().min_w(0).truncate().child(row.name));
    const file = row.file, active = file.path === this.open, tight = this.treeWidth() < TREE_STATS_AT;
    return shell.pl(8 + row.depth * 14).gap(8).when(active, (el) => el.bg(t.hover_strong)).hover((s) => s.bg(active ? t.hover_strong : t.hover))
      .child(typeTag(file.path, active ? t.accent : t.label))
      .child(div().flex_1().min_w(0).truncate().text_color(active ? t.foreground : t.text_secondary).when(this.isViewed(file), (el) => el.text_color(t.label)).when(file.isDeleted, (el) => el.line_through()).child(row.name))
      .when(!tight, (el) => el.child(this.stats(file, t, false, 11)));
  }

  fileTree(t) {
    const rows = this.treeList ?? [];
    return v_flex().size_full().min_h(0).pt(10).px(8).pb(8).gap(8).bg(t.card).border_1().border_color(t.card_border).rounded(18).overflow_hidden().text_size(12.5)
      .child(h_flex().h(34).flex_none().px(10).gap(8).items_center().rounded(10).bg(t.well).text_color(t.label)
        .child(icon("search", 16)).child(div().flex_1().min_w(0).child(Input.new(this.filterInput).h_full().text_size(12.5).text_color(t.foreground))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("changes-tree", rows.length, TREE_ROW, (i) => rows[i].id, (range) => rows.slice(range.start, range.end).map((row) => this.treeRow(row, t)))
          .track_scroll(this.treeScroll).size_full()
          .on_item_click((id, cx) => {
            const row = rows.find((r) => r.id === id);
            if (!row) return;
            if (row.kind === "file") return this.pickFile(row.file.path, cx);
            if (this.shutDirs.has(row.path)) this.shutDirs.delete(row.path); else this.shutDirs.add(row.path);
            this.buildTree(); cx.notify();
          }))
        .child(Scrollbar.vertical("changes-tree").viewport_from_layout().absolute().inset_0()));
  }

  // Stays in the layout when shut, because a spring only runs on an element that's there.
  // The tree keeps its width inside, so it slides out rather than squeezing up.
  treePane(t) {
    const shown = this.treeShown(), width = this.treeWidth(), motion = this.treeMoving ? TREE_SPRING : TREE_SNAP;
    return div().id("changes-tree-pane").flex_none().h_full().overflow_hidden().w(shown ? width + 8 : 0).opacity(shown ? 1 : 0).spring("width", motion).spring("opacity", motion)
      .when(shown || Boolean(this.treeMoving), (el) => el.child(div().ml(8).w(width).h_full().child(this.fileTree(t))));
  }

  render(cx) {
    if (key() !== this.context || (this.behind && this.shown())) this.refresh(cx);
    this.keepWide();
    const t = look(theme()), file = this.currentFile(), hasRows = this.rows.length > 0;
    this.tones = this.toned(t);
    this.paintSome(12);
    if (this.job) this.paintRest(cx);
    const canCommit = this.scope === "unstaged" || this.scope === "staged";
    const diff = v_flex().flex_1().min_w(0).min_h(0).h_full().rounded(18).overflow_hidden().bg(t.card).border_1().border_color(t.card_border)
      .when(Boolean(file) && this.oneFile(), (el) => el.child(this.fileHeader(file, t)))
      .child(hasRows ? this.diffList(t) : this.emptyState(t))
      .when(this.limited, (el) => el.child(div().px(12).py(4).text_size(11).text_color(t.label).child("Too many files to list them all")))
      .when(Boolean(this.note), (el) => el.child(div().px(12).py(6).text_size(11).text_color(t.failed_text).child(this.note)))
      .when(Boolean(this.draft), (el) => el.child(this.composer(t)))
      .when(this.comments.length > 0 && !this.draft, (el) => el.child(this.commentBar(t)));
    return v_flex().id("changes").size_full().min_h(0).rounded(20).overflow_hidden().bg(t.panel).border_1().border_color(t.panel_border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size, cx) => this.resized(size, cx))
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.draft) { this.draft = null; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
        else if (this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(panelHeader(t, "changes"))
      .child(this.toolbar(t))
      .child(h_flex().flex_1().min_h(0).px(8).child(diff).child(this.treePane(t)))
      .child(canCommit ? this.commitBar(t) : div().h(8).flex_none());
  }
}
