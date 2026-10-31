// The Changes panel: one repo's diff by scope, a filterable file tree, and git
// actions on the whole diff, a file or a hunk. diff.js, tokens.js, tree.js and
// git.js hold the logic; this file runs git and draws.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle, Popover, HoverCard } from "gpui-base";
import { spaces, panes, focused, agents, exec, hc, appHome, readTextFile, watchFolder, theme, settings, run, openOverlay, notify, nextCommand, layout, window, props } from "herdr";
import * as fs from "fs/promises";
import { MOST_ROWS, buttonAt, fileRows, hunkPatch, lineCount, newFile, parseDiff, signature, splitRows, stackedRows, stepped, wrapSpans } from "./diff.js";
import { languageOf, painter } from "./tokens.js";
import { buildTree, filtered, iconOf, inTreeOrder, jumpList, middle, treeRows } from "./tree.js";
import { DIFF, READ, SNAPSHOT, chooseBase, parseCounts, parseLog, parseNumstat, parseRefs, planAction, reviewMessage, untrackedPaths } from "./git.js";

const SCOPES = [["unstaged", "Unstaged"], ["staged", "Staged"], ["commit", "Commit"], ["branch", "Branch"], ["turn", "Last turn"]];
const NOTHING = { unstaged: "No unstaged changes", staged: "Nothing staged", commit: "This commit changes no files", branch: "No changes on this branch", turn: "That turn changed nothing" };
const COLORS = { keyword: "ansi5", string: "ansi2", comment: "dim", function: "ansi4", type: "ansi3", number: "ansi1", literal: "ansi6", key: "ansi4" };

const LINE = 21, BAR = 4, GUTTER = 46, SEAM = 2, CODE_AT = BAR + GUTTER + SEAM, CODE_LEFT = 7, CODE_RIGHT = 12, CHAR = 7.2;
// A tile of stripes: its repeat divides LINE, so the lines run on from row to row.
const STRIPES = 140;
const FILE_ROW = 42, FILE_BUTTON = 26, FILE_GAP = 2, GAP_ROW = 34, NOTE_ROW = 40, COMMENT_TOP = 46, COMMENT_LINE = 18, TREE_ROW = 29, TREE_WIDTH = 300;
// The hunk buttons stay clear of the scrollbar, which takes presses along that edge.
const WIDE = 640, SPLITS_AT = 460, TREE_MIN = 140, TREE_STATS_AT = 190, HUNK_BUTTONS = 138, HUNK_MARGIN = 16, FULL_PANEL = 900;
// Codex's tree moves on a spring of 0.5 s and 0.1 bounce: this is that spring as a period and a damping.
const TREE_SPRING = { response: 370, damping: 0.9 }, TREE_SNAP = { response: 0 }, TREE_SETTLE = 650, TIP_DELAY = 300;
const JUMP_WIDTH = 360, JUMP_ROW = 29, JUMP_ROWS = 10, UI_CHAR = 7;
// Past either, one file shows at a time. Codex allows 9,000 lines; a long list is slower to lay out here.
const MOST_LINES = 6000, MOST_FILES = 128, MOST_LISTED = 2000, MOST_UNTRACKED = 300, EXEC_LIMIT = 8 << 20, STUCK = 45000;

const commas = (n) => String(n).replace(/\B(?=(\d{3})+$)/g, ",");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const icon = (name, size = 16) => svg(`mods/changes/icons/${name}.svg`).size(size).flex_none();
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
    this.width = 368; this.scrollX = 0; this.gen = 0; this.treeTurn = 0;
    this.files = []; this.rows = []; this.sizes = []; this.byId = new Map(); this.lines = [];
    this.gaps = new Map(); this.shutDirs = new Set(); this.shut = new Set(); this.comments = []; this.viewed = {};
    this.statuses = {}; this.turns = store("turns", {}); this.refs = []; this.commits = [];
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
    this.filterInput = InputState.new({ placeholder: "Filter files…" });
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
  diffWidth() { return Math.max(120, this.width - (this.treeShown() ? this.treeWidth() : 0) - 2); }
  canSplit() { return this.diffWidth() >= SPLITS_AT; }
  splitting() { return this.split && this.canSplit(); }
  codeWidth() { return (this.splitting() ? (this.diffWidth() - SEAM) / 2 : this.diffWidth()) - CODE_AT; }
  columns() {
    return Math.max(10, Math.floor((this.codeWidth() - CODE_LEFT - CODE_RIGHT) / CHAR));
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
    this.maxScroll = Math.max(0, this.longest * CHAR + CODE_LEFT + CODE_RIGHT - this.codeWidth());
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
    if ((right ? press.x - half : press.x) <= BAR + GUTTER) this.startComment(target, cx);
  }

  // Its buttons, right to left: the row can't hold handlers, so a press is matched by place.
  fileButtons(file) {
    const state = this.gaps.get(file.path), viewed = this.isViewed(file), wide = this.diffWidth() >= SPLITS_AT;
    return [
      { id: "more", name: "more", tip: "File options", action: (cx, press, end) => { this.rowMenu = { path: file.path, x: end, y: press.y + 10 }; this.menu = "row"; cx.notify(); } },
      ...(wide && file.hunks.length ? [{ id: "whole", name: "code", tip: state?.all ? "Show only the changes" : "Show the whole file", on: Boolean(state?.all), action: (cx) => this.toggleWhole(file, cx) }] : []),
      ...(wide && !this.on ? [{ id: "open", name: "external", tip: "Open in editor", action: (cx) => this.openInEditor(file.path, null, cx) }] : []),
      ...(wide ? [{ id: "viewed", name: viewed ? "eye-off" : "eye", tip: viewed ? "Mark as unviewed" : "Mark as viewed", on: viewed, action: (cx) => this.toggleViewed(file, cx) }] : []),
    ];
  }

  clickFileRow(file, press, cx) {
    const buttons = this.fileButtons(file), end = press.width - HUNK_MARGIN;
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

  togglePanel() {
    if (this.width >= FULL_PANEL - 40) run("layout.resize", { id: "panel", px: this.smaller ?? 368 });
    else { this.smaller = this.width; run("layout.resize", { id: "panel", px: FULL_PANEL }); }
  }

  pieces(spans, t) {
    return spans.map(([text, kind]) => {
      const piece = div().flex_none().whitespace_nowrap();
      return kind ? piece.text_color(t[COLORS[kind]]).child(text) : piece.child(text);
    });
  }

  code(row, columns, t) {
    const tone = this.tones[row.kind];
    const cell = div().flex_1().min_w(0).h_full().overflow_hidden().pl(CODE_LEFT).pr(CODE_RIGHT).font_family(this.mono).text_size(12)
      .when(Boolean(tone), (el) => el.bg(tone.code));
    const spans = row.spans ?? [[row.text, null]];
    if (this.wrap) return cell.child(v_flex().children(wrapSpans(spans, columns).map((line) => h_flex().h(LINE).items_center().children(this.pieces(line, t)))));
    return cell.child(h_flex().h(LINE).items_center().ml(-this.scrollX).children(this.pieces(spans, t)));
  }

  gutter(row, t) {
    const tone = this.tones[row?.kind], number = row ? row.new ?? row.old : "";
    return h_flex().flex_none().h_full().items_start()
      .child(div().w(BAR).h_full().flex_none().when(Boolean(tone), (el) => el.bg(tone.bar)))
      .child(div().w(GUTTER).h_full().flex_none().when(Boolean(tone), (el) => el.bg(tone.gutter))
        .child(h_flex().h(LINE).pr(8).items_center().justify_end().font_family(this.mono).text_size(12).text_color(tone?.bar ?? t.dim).child(String(number))))
      .child(div().w(SEAM).h_full().flex_none());
  }

  // The side of a change with nothing on it.
  stripes(lines) {
    const tile = () => svg("mods/changes/icons/stripes.svg").w(STRIPES).h(LINE).flex_none().text_color(this.tones.stripe);
    const tiles = Math.ceil(this.codeWidth() / STRIPES), row = () => h_flex().h(LINE).flex_none().children(Array.from({ length: tiles }, tile));
    return div().flex_1().min_w(0).h_full().overflow_hidden().child(v_flex().children(Array.from({ length: lines }, row)));
  }

  // The row's hover layer: a clear sheet, shown whole when the pointer is on it.
  hoverLayer(row, t) {
    const badge = (at) => h_flex().absolute().left(at).top(0).size(LINE).ml(BAR + GUTTER - LINE - 6).items_center().justify_center().rounded(6).bg(t.solid).text_color(t.solid_foreground).child(icon("plus", 13));
    const layer = div().id("hover").absolute().inset_0().opacity(0).hover((s) => s.opacity(1)).child(badge(0)).when(row.kind === "pair", (el) => el.child(badge(Math.round(this.diffWidth() / 2))));
    const changed = row.kind === "pair" ? (row.left?.kind === "del" || row.right?.kind === "add") : this.canHunk(row);
    if (!changed || this.tight) return layer;
    const word = this.stageWord();
    const button = (label) => div().w(HUNK_BUTTONS / 2 - 4).h(LINE - 3).flex().items_center().justify_center().rounded(5).bg(t.popover).border_1().border_color(t.border).text_color(t.foreground).text_size(11).child(label);
    return layer.child(h_flex().absolute().right(HUNK_MARGIN).top(0).w(HUNK_BUTTONS).h(LINE).gap(4).items_center().justify_end().child(button("Revert")).when(Boolean(word), (el) => el.child(button(word))));
  }

  // The theme names no diff colors: a change wears its green or red, thinned as mods thin `blocked`.
  toned(t) {
    const tone = (bar) => ({ bar, code: `${bar}24`, gutter: `${bar}0f` });
    return { add: tone(t.ansi2), del: tone(t.ansi1), stripe: t.hover };
  }

  lineRow(row, columns, t) {
    return h_flex().relative().w_full().h_full().items_start().child(this.gutter(row, t)).child(this.code(row, columns, t)).child(this.hoverLayer(row, t));
  }

  pairRow(row, columns, t) {
    const lines = Math.round(this.heightOf(row, columns) / LINE);
    const cell = (side) => h_flex().flex_1().min_w(0).h_full().items_start().child(this.gutter(side, t)).child(side ? this.code(side, columns, t) : this.stripes(lines));
    return h_flex().relative().w_full().h_full().items_start().child(cell(row.left)).child(div().w(SEAM).h_full().flex_none()).child(cell(row.right)).child(this.hoverLayer(row, t));
  }

  gapRow(row, t) {
    const split = this.splitting();
    const label = h_flex().id("gap").flex_1().min_w(0).h_full().bg(t.raised).items_center().text_color(t.muted).hover((s) => s.bg(t.hover))
      .when(split, (el) => el.rounded_tl(9).rounded_bl(9)).when(!split, (el) => el.rounded(9))
      .child(h_flex().w(CODE_AT - 8).h_full().flex_none().items_center().justify_center().border_r(1).border_color(t.background).child(icon(row.tail ? "chevron-down" : "chevron-up", 15)))
      .child(div().pl(CODE_LEFT + 1).text_size(12).child(`${commas(row.count)} unmodified ${row.count === 1 ? "line" : "lines"}`));
    return h_flex().w_full().h_full().pl(8).py(2).child(label).when(split, (el) => el.child(div().w(SEAM).h_full().flex_none()).child(div().flex_1().min_w(0).h_full().bg(t.raised)));
  }

  fileLabel(file, t) {
    const parts = file.path.split("/"), name = parts.pop(), [glyph, tint] = iconOf(file.path);
    return h_flex().flex_1().min_w(0).gap(8).items_center()
      .child(icon(`ft-${glyph}`, 16).text_color(tint ? t[tint] : t.muted))
      .child(h_flex().flex_1().min_w(0).items_center()
        .when(parts.length > 0, (el) => el.child(div().min_w(0).truncate().text_color(t.dim).child(`${parts.join("/")}/`)))
        .child(div().flex_none().max_w_full().truncate().when(file.isDeleted, (el) => el.line_through()).child(name)));
  }

  stats(file, t, both = true) {
    const add = both || file.add > 0, del = both || file.del > 0;
    return h_flex().flex_none().gap(6).text_size(12)
      .when(add, (el) => el.child(div().text_color(t.ansi2).child(`+${commas(file.add)}`)))
      .when(del, (el) => el.child(div().text_color(t.ansi1).child(`-${commas(file.del)}`)));
  }

  commentRow(row, t) {
    return div().w_full().h_full().px(14).py(5).child(
      v_flex().id("note").size_full().px(12).py(7).gap(2).rounded(9).bg(t.raised).border_1().border_color(t.border).hover((s) => s.border_color(t.input))
        .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim).child(icon("comment", 12)).child(`Line ${row.comment.line}`))
        .child(v_flex().text_size(12).text_color(t.foreground).child(row.comment.text)));
  }

  fileRow(row, t) {
    const file = row.file, shut = this.shut.has(file.path);
    const button = ({ id, name, tip, on = false }) => this.tip(`${id}-${file.path}`, tip, h_flex().id(id).size(FILE_BUTTON).flex_none().items_center().justify_center().rounded(6).text_color(on ? t.accent : t.muted).hover((s) => s.bg(t.hover)).child(icon(name, 15)), t);
    return h_flex().id("file").w_full().h_full().pl(10).pr(HUNK_MARGIN).gap(8).items_center().bg(t.background).border_b(1).border_color(t.border).when(!row.first, (el) => el.border_t(1)).hover((s) => s.bg(t.hover))
      .child(icon(shut ? "chevron-right" : "chevron-down", 13).text_color(t.dim))
      .child(this.fileLabel(file, t))
      .child(this.stats(file, t))
      .child(h_flex().flex_none().gap(FILE_GAP).items_center().children(this.fileButtons(file).reverse().map(button)));
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

  tool(id, name, tip, action, t, { on = false, spin = false, mark = null } = {}) {
    const size = this.width >= WIDE ? 32 : 30;
    const glyph = mark ?? icon(name, 18).when(spin, (el) => el.spin(800));
    const button = h_flex().id(id).size(size).flex_none().items_center().justify_center().rounded(size / 2).cursor_pointer().text_color(on ? t.accent : t.muted).when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(on ? t.selected : t.hover))
      .on_click((_e, cx) => action(cx)).child(glyph);
    return this.tip(id, tip, button, t);
  }

  // `.tooltip()` shows nothing here: its layer is looked up on the window's first
  // view, and that is the app's, not a mod's. A hover card gives the same label.
  tip(id, text, trigger, t) {
    return HoverCard.new(`tip-${id}`).open_delay(TIP_DELAY).close_delay(0).trigger(trigger)
      .when(!this.menu, (el) => el.content(div().mt(6).px(9).py(5).rounded(8).bg(t.raised).border_1().border_color(t.border).shadow_md().text_size(12).text_color(t.foreground).whitespace_nowrap().child(text)));
  }

  // Which view shows: a frame holding both sides, in the theme's removed and added colors.
  diffMark(t) {
    const state = this.split ? "split" : "unified";
    const part = (name, color) => svg(`mods/changes/icons/diff-${name}.svg`).absolute().top(0).left(0).size(18).text_color(color);
    return div().relative().size(18).flex_none().child(part(`${state}-old`, t.ansi1)).child(part(`${state}-new`, t.ansi2)).child(part("frame", t.muted));
  }

  popover(id, anchor, trigger, content) {
    const open = this.menu === id;
    return Popover.new(`changes-${id}`).anchor(anchor).open(open)
      .on_open_change((next, cx) => {
        this.menu = next ? id : null;
        if (next && id === "base") { this.baseInput.set_value(""); this.baseFilter = ""; this.baseInput.focus(); }
        if (next && id === "jump") this.openJump();
        cx.notify();
      })
      .trigger(trigger).when(open, (el) => el.content(content()));
  }

  menuBox(width, t, rows) {
    return v_flex().id("changes-menu-box").w(width).max_h(380).overflow_y_scrollbar().p(6).gap(1).rounded(14).bg(t.raised).border_1().border_color(t.border).shadow_lg().text_size(13).text_color(t.foreground).children(rows);
  }

  item(id, label, action, t, { hint = null, on = false, danger = false, enabled = true } = {}) {
    return h_flex().id(`changes-item-${id}`).h(32).flex_none().px(10).gap(10).items_center().rounded(9).when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.menu = null; action(cx); cx.notify(); })).text_color(!enabled ? t.dim : danger ? t.blocked : t.foreground)
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(hint)))
      .when(on, (el) => el.child(icon("check", 14).text_color(t.accent)));
  }

  // Scope, branch and toolbar share one shape: a filled pill on the panel.
  capsule(t) {
    return h_flex().h(36).items_center().rounded(18).bg(t.raised).border_1().border_color(t.border);
  }

  pill(id, t) {
    return this.capsule(t).id(id).min_w(0).px(14).gap(8).cursor_pointer().hover((s) => s.bg(t.hover));
  }

  scopeControl(t) {
    const label = SCOPES.find(([id]) => id === this.scope)?.[1];
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const trigger = this.pill("changes-scope", t).flex_none()
      .child(div().child(label)).child(icon("chevron-down", 13).text_color(t.muted))
      .child(div().text_color(t.ansi2).child(`+${commas(add)}`)).child(div().text_color(t.ansi1).child(`-${commas(del)}`));
    return this.tip("changes-scope", "Choose which changes to show", this.popover("scope", "top_left", trigger, () => this.menuBox(180, t, SCOPES.map(([id, name]) => this.item(id, name, (cx) => this.setScope(id, cx), t, { on: id === this.scope })))), t);
  }

  compareControl(t) {
    if (this.scope === "branch" && this.base) {
      const trigger = this.pill("changes-base", t)
        .child(div().min_w(0).truncate().child(this.branch ?? "")).child(icon("arrow-right", 14).text_color(t.dim))
        .child(div().min_w(0).truncate().child(this.base)).child(icon("chevron-down", 13).text_color(t.muted));
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
        .child(div().flex_none().text_color(t.dim).child(shown.short)).child(div().min_w(0).truncate().child(shown.subject)).child(icon("chevron-down", 13).text_color(t.muted));
      return this.popover("commit", "top_left", trigger, () => this.menuBox(380, t, this.commits.map((c) => this.item(`commit-${c.sha}`, `${c.short}  ${c.subject}`, (cx) => { this.picked = c.sha; this.reload(cx); }, t, { hint: c.when, on: c.sha === shown.sha }))));
    }
    if (this.scope === "turn") return div().min_w(0).px(4).truncate().text_color(t.muted).child(this.turnLabel() ?? "");
    return this.branch ? this.branchLabel(t) : div();
  }

  // Not a button, so no button's shape: drawn as the status bar draws a branch.
  branchLabel(t) {
    return h_flex().min_w(0).px(4).gap(6).items_center().text_color(t.muted)
      .child(svg("mods/workspace-chrome/branch.svg").size(14).flex_none())
      .child(div().min_w(0).truncate().child(this.branch));
  }

  turnLabel() {
    const turn = this.root ? this.turns[`${this.on ?? ""}:${this.root}`] : null;
    if (!turn) return null;
    const minutes = Math.round((Date.now() - turn.at) / 60000);
    const when = minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
    return turn.end ? `Turn from ${when}` : `Turn started ${when}`;
  }

  menuButton(id, name, t, on = false) {
    const size = this.width >= WIDE ? 32 : 30;
    return h_flex().id(id).size(size).flex_none().items_center().justify_center().rounded(size / 2).cursor_pointer().text_color(on ? t.accent : t.muted).when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(on ? t.selected : t.hover)).child(icon(name, 18));
  }

  jumpControl(t) {
    return this.tip("changes-jump", "Jump to file", this.popover("jump", "top_right", this.menuButton("changes-jump", "find", t, this.menu === "jump"), () => this.jumpBox(t)), t);
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
    return v_flex().id("changes-jump-box").w(JUMP_WIDTH).mt(4).p(4).rounded(14).bg(t.raised).border_1().border_color(t.border).shadow_lg().text_size(13)
      .on_key_down((e, cx) => {
        if ((e.key !== "down" && e.key !== "up") || !rows.length) return;
        this.jumpAt = stepped(at, e.key === "down" ? 1 : -1, rows.length);
        this.jumpScroll.scroll_to_item(this.jumpAt);
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().h(38).flex_none().px(8).gap(8).items_center().child(icon("search", 15).text_color(t.dim)).child(div().flex_1().min_w(0).child(Input.new(this.jumpInput).h_full().text_size(13))))
      .child(rows.length ? div().relative().w_full().flex_none().h(Math.min(rows.length, JUMP_ROWS) * JUMP_ROW).child(list).child(Scrollbar.vertical("changes-jump").viewport_from_layout().absolute().inset_0())
        : div().px(8).py(6).text_color(t.dim).child("No matching files"));
  }

  moreControl(t) {
    return this.tip("changes-more", "Changes options", this.popover("more", "top_left", this.menuButton("changes-more", "more", t), () => {
      const word = this.stageWord(), some = this.files.length > 0, tiny = this.width < 440;
      return this.menuBox(220, t, [
        ...(word ? [this.item("stage-all", `${word} all`, (cx) => this.act(word.toLowerCase(), {}, cx), t, { enabled: some })] : []),
        this.item("revert-all", "Revert all", (cx) => this.act("revert", {}, cx), t, { danger: some, enabled: some }),
        ...(this.oneFile() ? [] : [this.item("all-files", this.shut.size < this.files.length ? "Collapse all diffs" : "Expand all diffs", (cx) => this.toggleAllFiles(cx), t, { enabled: some })]),
        this.item("space", "Hide whitespace", (cx) => { this.tight = !this.tight; this.reload(cx); }, t, { on: this.tight }),
        ...(tiny ? [this.item("fold", "Show every line", (cx) => this.toggleUnfold(cx), t, { on: this.unfold })] : []),
      ]);
    }), t);
  }

  toolbar(t) {
    const wide = this.width >= WIDE, tiny = this.width < 440;
    const tools = this.capsule(t).flex_none().pl(wide ? 4 : 2).pr(2).gap(wide ? 3 : 1)
      .child(this.moreControl(t))
      .child(this.jumpControl(t))
      .child(this.tool("changes-refresh", "refresh", this.spinning ? "Refreshing changes" : "Refresh", (cx) => this.refreshNow(cx), t, { spin: Boolean(this.spinning) }))
      .child(this.tool("changes-wrap", "wrap", this.wrap ? "Disable word wrap" : "Enable word wrap", (cx) => { this.wrap = !this.wrap; this.scrollX = 0; this.saveView(); this.compose(); cx.notify(); }, t, { on: this.wrap }))
      .when(!tiny, (el) => el.child(this.tool("changes-fold", "fold", this.unfold ? "Fold unmodified lines" : "Show every line", (cx) => this.toggleUnfold(cx), t, { on: this.unfold })))
      .when(this.canSplit(), (el) => el.child(this.tool("changes-split", null, this.split ? "Switch to unified diff" : "Switch to split diff", (cx) => { this.split = !this.split; this.saveView(); this.compose(); cx.notify(); }, t, { mark: this.diffMark(t) })))
      .child(this.tool("changes-tree", "tree", this.showTree ? "Hide file tree" : "Show file tree", (cx) => this.toggleTree(cx), t, { on: this.showTree }));
    if (wide) return h_flex().flex_none().px(10).py(8).gap(8).items_center().child(this.scopeControl(t)).child(div().flex_1().min_w(0).child(h_flex().child(this.compareControl(t)))).child(tools);
    return v_flex().flex_none().px(10).py(8).gap(8)
      .child(h_flex().gap(8).items_center().justify_between().child(this.scopeControl(t)).child(tools))
      .child(h_flex().min_w(0).child(this.compareControl(t)));
  }

  strip(t) {
    const hasPanel = Boolean(findNode(layout(), "panel"));
    return h_flex().h(38).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .child(h_flex().h(28).px(10).gap(8).items_center().rounded(8).bg(t.raised)
        .child(svg("mods/changes/changes.svg").size(14).flex_none().text_color(t.muted))
        .child(div().font_semibold().child("Changes"))
        .when(hasPanel, (el) => el.child(this.tip("changes-close", "Close", h_flex().id("changes-close").size(18).items_center().justify_center().rounded(5).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover)).on_click(() => run("layout.hide", { id: "panel" })).child(icon("close", 12)), t))))
      .child(div().flex_1())
      .when(hasPanel, (el) => el.child(this.tool("changes-expand", this.width >= FULL_PANEL - 40 ? "shrink" : "expand", this.width >= FULL_PANEL - 40 ? "Shrink panel" : "Expand panel", () => this.togglePanel(), t)));
  }

  banner(t) {
    const arrow = (id, name, step, tip) => this.tip(id, tip, h_flex().id(id).size(28).flex_none().items_center().justify_center().rounded(14).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.stepFile(step, cx)).child(icon(name, 16)), t);
    return h_flex().flex_none().mx(10).mb(8).min_h(44).px(14).py(6).gap(10).items_center().rounded(14).border_1().border_color(t.border)
      .child(icon("info", 16).text_color(t.accent))
      .child(div().flex_1().min_w(0).child("This diff is large, showing one file at a time"))
      .child(arrow("changes-prev", "chevron-left", -1, "Previous file")).child(arrow("changes-next", "chevron-right", 1, "Next file"));
  }

  fileHeader(file, t) {
    const state = this.gaps.get(file.path), viewed = this.isViewed(file);
    const trigger = h_flex().id("changes-file-more").size(26).flex_none().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover)).child(icon("more", 15));
    const button = (id, name, tip, action, on = false) => this.tip(id, tip, h_flex().id(id).size(26).flex_none().items_center().justify_center().rounded(6).cursor_pointer().text_color(on ? t.accent : t.muted).hover((s) => s.bg(t.hover)).on_click((_e, cx) => action(cx)).child(icon(name, 15)), t);
    const narrow = this.diffWidth() < 460;
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(this.fileLabel(file, t))
      .child(this.stats(file, t))
      .when(!narrow, (el) => el.child(button("changes-viewed", viewed ? "eye-off" : "eye", viewed ? "Mark as unviewed" : "Mark as viewed", (cx) => this.toggleViewed(file, cx), viewed)))
      .when(!narrow && !this.on, (el) => el.child(button("changes-open", "external", "Open in editor", (cx) => this.openInEditor(file.path, null, cx))))
      .when(!narrow && file.hunks.length > 0, (el) => el.child(button("changes-whole", "code", state?.all ? "Show only the changes" : "Show the whole file", (cx) => this.toggleWhole(file, cx), Boolean(state?.all))))
      .child(this.tip("changes-file-more", "File options", this.popover("file", "top_right", trigger, () => this.fileMenu(file, t)), t));
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
    return div().flex_1().min_h(0).relative()
      .id("changes-diff-wrap")
      .on_mouse_down("left", (e) => this.pressed(e))
      .on_scroll_wheel((e, cx) => this.wheel(e, cx))
      .child(v_virtual_list("changes-diff", rows.length, this.sizes, (i) => rows[i].id, (range) => rows.slice(range.start, range.end).map((row) => this.drawRow(row, columns, t)))
        .track_scroll(this.scroll).on_item_click((id, cx) => this.clickRow(id, cx)).size_full())
      .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
      .when(Boolean(menuFile), (el) => el.child(div().absolute().left(this.rowMenu.x).top(this.rowMenu.y).child(this.popover("row", "top_right", div().size(1), () => this.fileMenu(menuFile, t)))));
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
      .child(icon("comment", 14).text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(plural(count, "comment")))
      .child(div().id("changes-comments-clear").h(28).px(10).flex().items_center().rounded(7).cursor_pointer().text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.clearComments(cx)).child("Clear"))
      .child(control);
  }

  commitBox(t) {
    const enabled = this.canCommit();
    return h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
      .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
      .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit"));
  }

  treeRow(row, t) {
    const tight = this.treeWidth() < TREE_STATS_AT, step = tight ? 10 : 16;
    const guides = Array.from({ length: row.depth }, (_, depth) => div().absolute().left(15 + depth * step).top(0).w(1).h(TREE_ROW).bg(t.border));
    const shell = h_flex().id("row").relative().w_full().h(TREE_ROW).flex_none().pl(8 + row.depth * step).pr(8).gap(7).items_center().rounded(8).children(guides);
    if (row.kind === "dir") return shell.hover((s) => s.bg(t.hover)).child(icon(row.open ? "chevron-down" : "chevron-right", 13).text_color(t.dim)).child(div().flex_1().min_w(0).truncate().child(row.name));
    const file = row.file, active = file.path === this.open, [glyph, tint] = iconOf(file.path);
    return shell.when(active, (el) => el.bg(t.selected)).hover((s) => s.bg(active ? t.selected : t.hover))
      .child(icon(`ft-${glyph}`, 15).text_color(tint ? t[tint] : t.muted))
      .child(div().flex_1().min_w(0).truncate().text_color(active ? t.foreground : t.muted).when(this.isViewed(file), (el) => el.text_color(t.dim)).when(file.isDeleted, (el) => el.line_through()).child(row.name))
      .when(!tight, (el) => el.child(this.stats(file, t, false)));
  }

  fileTree(t) {
    const rows = this.treeList ?? [];
    return v_flex().size_full().min_h(0).p(6).gap(6)
      .child(h_flex().h(32).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.border)
        .child(icon("search", 14).text_color(t.dim)).child(div().flex_1().min_w(0).child(Input.new(this.filterInput).h_full().text_size(13))))
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
    return div().id("changes-tree-pane").flex_none().h_full().overflow_hidden().w(shown ? width : 0).opacity(shown ? 1 : 0).spring("width", motion).spring("opacity", motion)
      .when(shown || Boolean(this.treeMoving), (el) => el.child(div().w(width).h_full().border_l(1).border_color(t.border).child(this.fileTree(t))));
  }

  render(cx) {
    if (key() !== this.context || (this.behind && this.shown())) this.refresh(cx);
    this.mono = settings().font_family ?? "JetBrains Mono";
    this.tones = this.toned(theme());
    this.paintSome(12);
    if (this.job) this.paintRest(cx);
    const t = theme(), file = this.currentFile(), hasRows = this.rows.length > 0;
    const canCommit = this.scope === "unstaged" || this.scope === "staged";
    const diff = v_flex().flex_1().min_w(0).min_h(0).h_full()
      .when(Boolean(file) && this.oneFile(), (el) => el.child(this.fileHeader(file, t)))
      .child(hasRows ? this.diffList(t) : this.emptyState(t))
      .when(this.limited, (el) => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Too many files to list them all")))
      .when(Boolean(this.note), (el) => el.child(div().px(12).py(6).text_size(11).text_color(t.blocked).child(this.note)))
      .when(Boolean(this.draft), (el) => el.child(this.composer(t)))
      .when(this.comments.length > 0 && !this.draft, (el) => el.child(this.commentBar(t)))
      .when(canCommit, (el) => el.child(this.commitBox(t)));
    const body = h_flex().flex_1().min_h(0).border_t(1).border_color(t.border).child(diff).child(this.treePane(t));
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size, cx) => this.resized(size, cx))
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.draft) { this.draft = null; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
        else if (this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(this.strip(t))
      .child(this.toolbar(t))
      .when(this.oneFile(), (el) => el.child(this.banner(t)))
      .child(body);
  }
}
