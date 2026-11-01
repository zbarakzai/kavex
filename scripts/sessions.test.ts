import { test, expect, mock, beforeEach, afterAll, setSystemTime, spyOn } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The real agents mod with recording fakes of the app. Session files are real files in a
// scratch home and `sh` really runs on them: what a machine gives the mod, and what a person sees.
type El = { calls: [string, any[]][]; kids: any[] };
function make(): any {
  const el: El = { calls: [], kids: [] };
  const self: any = new Proxy({}, {
    get: (_t, k: string) => {
      if (k === "el") return el;
      if (k === "when") return (on: unknown, f: (s: any) => any) => (on ? f(self) : self);
      if (k === "child") return (kid: any) => (el.kids.push(kid), self);
      if (k === "children") return (kids: any[]) => (el.kids.push(...kids), self);
      if (k === "hover") return () => self;
      return (...args: any[]) => (el.calls.push([k, args]), self);
    },
  });
  return self;
}
const mine = (n: any): El | null => (n && typeof n === "object" && n.el ? n.el : null);
const all = (e: El): El[] => [e, ...e.kids.flatMap((k) => (mine(k) ? all(mine(k)!) : []))];
const arg = (e: El, name: string) => e.calls.findLast(([k]) => k === name)?.[1][0];
const byId = (root: El, id: string) => all(root).find((e) => arg(e, "id") === id);
const words = (root: El) => all(root).flatMap((e) => e.kids.filter((k) => typeof k === "string"));

const home = mkdtempSync(join(tmpdir(), "zaki-sessions-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const theme = JSON.parse(readFileSync(new URL("../defaults/themes/zaki.json", import.meta.url), "utf8"));
const colors = { background: theme.background, ...theme.colors, ...Object.fromEntries(theme.ansi.map((c: string, i: number) => [`ansi${i}`, c])) };

(globalThis as any).localStorage = { getItem: () => null, setItem() {} };
const EXEC_OUTPUT = 8 * 1024 * 1024;
let state: any;

mock.module("gpui-kit", () => ({ View: class {}, div: make, svg: make, image: make }));
mock.module("gpui-base", () => ({ h_flex: make, v_flex: make }));
mock.module("herdr", () => ({
  agents: () => state.agents,
  terminals: () => state.terminals,
  focused: () => null,
  spaces: () => [],
  run: (name: string, args: any) => void state.ran.push([name, args]),
  theme: () => colors,
  shared: (key: string) => state.shared[key],
  setShared: (key: string, value: any) => { state.shared[key] = value; },
  setAgentOrder: () => {},
  openOverlay: (o: any) => (state.opened.push(o), "overlay"),
  closeOverlay: (id: string) => void state.closed.push(id),
  props: () => state.props,
  window: () => ({ platform: "macos" }),
  layout: () => state.layout,
  home: () => home,
  readTextFile: async (path: string) => {
    state.reads.push(path);
    if (state.brokenFiles) throw new Error("no such thing");
    try { return readFileSync(path, "utf8"); } catch { return null; }
  },
  watchFolder: (folder: string) => {
    if (state.brokenWatch) throw new Error("can't watch");
    state.watched.push(folder);
    state.parked++;
    return new Promise((resolve) => state.watchers.push((paths: string[]) => { state.parked--; resolve(paths); }));
  },
  exec: async (cmd: string, args: string[]) => {
    state.execs.push([cmd, ...args]);
    if (cmd === "claude") return state.claude(args);
    if (state.brokenExec) throw new Error("cannot run");
    const r = Bun.spawnSync([cmd, ...args]);
    const stdout = r.stdout.toString();
    state.outputs.push(stdout.length);
    if (state.asleep) await state.asleep;
    return { code: r.exitCode, stdout: stdout.slice(0, EXEC_OUTPUT), stderr: r.stderr.toString() };
  },
}));
const Agents = (await import("../defaults/mods/agents/main.js")).default;
const { look } = await import("../defaults/mods/agents/look.js");

const cx: any = {
  notify() { state.notified++; },
  stop_propagation() { state.stopped++; },
  spawn(f: any) {
    state.running++;
    Promise.resolve(f(cx)).catch(() => {}).finally(() => { state.running--; });
    return { cancel() {} };
  },
  timer: {
    every(ms: number, f: any) { state.timers.push([ms, f]); },
    after(_ms: number, f: any) { f(cx); },
  },
};

// Everything started has come to rest, or waits for a change (a watch loop never ends).
async function settle() {
  do await Bun.sleep(1);
  while (state.running > state.parked);
}

// The clock the mod reads the session on: what its timer would do.
const ticks = async () => {
  for (const [ms, f] of state.timers) if (ms === 2000) f(cx);
  await settle();
};

const CLAUDE = { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, tile: null, color: null, agent: true, shell: false };
const OPENCODE = { key: "opencode", name: "OpenCode", icon: "icons/opencode.svg", tint: false, tile: null, color: null, agent: true, shell: false };

const running = (address: string, pid: number | null, program: any = CLAUDE, more: any = {}) => ({
  address, state: "live", pid: 1, labels: {}, status: "idle", program, foreground: pid === null ? null : { pid, name: "claude", argv: ["claude"], cwd: "/work/project" }, ...more,
});
const listed = (term: any) => ({ address: term.address, pane: `p-${term.address}`, space: "s", space_name: "one", tab: "tb", tab_index: 1, status: "idle", program: term.program, seq: 1, focused: false });

const folderOf = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
const recordOf = (pid: number, sessionId: string, cwd = "/work/project") => {
  const path = join(home, ".claude", "sessions", `${pid}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid, sessionId, cwd, startedAt: 1, version: "2.1.316", kind: "interactive", entrypoint: "cli", status: "idle" }));
};
const fileOf = (sessionId: string, cwd = "/work/project") => join(home, ".claude", "projects", folderOf(cwd), `${sessionId}.jsonl`);

// One assistant line as Claude writes it, with made-up words.
type Said = { id: string; input?: number; read?: number; write?: number; output?: number; model?: string; side?: boolean; text?: string };
const said = ({ id, input = 0, read = 0, write = 0, output = 0, model = "claude-opus-5-5", side = false, text = "made up" }: Said) =>
  JSON.stringify({
    parentUuid: "p", isSidechain: side,
    message: {
      model, id, type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn",
      usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output, cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 } },
    },
    requestId: "r", requestedModel: model, type: "assistant", uuid: "u", timestamp: "2026-11-01T10:00:00.000Z", cwd: "/work/project", sessionId: "s", version: "2.1.316",
  });
const writes = (sessionId: string, lines: string[], cwd = "/work/project") => {
  mkdirSync(dirname(fileOf(sessionId, cwd)), { recursive: true });
  appendFileSync(fileOf(sessionId, cwd), lines.map((l) => `${l}\n`).join(""));
};

const contextReply = (tokens: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0, local_command: "context", result: `## Context Usage\n\n**Model:** claude-opus-5-5  \n**Tokens:** ${tokens}\n\n### Estimated usage by category\n` });

const open = async () => {
  state.props = {};
  const view: any = new Agents();
  view.init({}, cx);
  await settle();
  return { view, draw: () => view.render(cx).el as El };
};
const shows = (draw: () => El, address: string) => words(byId(draw(), `ag-${address}`)!);

beforeEach(() => {
  rmSync(join(home, ".claude"), { recursive: true, force: true });
  state = {
    agents: [], terminals: [], ran: [], shared: {}, opened: [], closed: [], props: {}, layout: null,
    reads: [], watched: [], watchers: [], execs: [], running: 0, parked: 0, timers: [], notified: 0, stopped: 0,
    outputs: [], brokenFiles: false, brokenExec: false, brokenWatch: false,
    claude: () => ({ code: 0, stdout: contextReply("13.7k / 1m (1%)"), stderr: "" }),
  };
});

test("a Claude row shows how full its session is", async () => {
  const term = running("t1", 101);
  state.terminals = [term];
  state.agents = [listed(term)];
  recordOf(101, "one");
  writes("one", [said({ id: "m1", input: 5, read: 60000, write: 10000, output: 900 })]);
  const { draw } = await open();
  await ticks();
  expect(shows(draw, "t1")).toContain("7%");
});

// A row with its session, ready to draw.
const one = async (lines: string[], pid = 101, id = "one") => {
  const term = running("t1", pid);
  state.terminals = [term];
  state.agents = [listed(term)];
  recordOf(pid, id);
  if (lines.length) writes(id, lines);
  const list = await open();
  await ticks();
  return list;
};
const clicks = (e: El) => e.calls.find(([k]) => k === "on_click")?.[1].at(-1)({}, cx);
const percents = (e: El) => words(e).filter((w) => w.endsWith("%"));
const rowPercents = (draw: () => El, address: string) => percents(byId(draw(), `ag-${address}`)!);

// The dropdown a logo's click opened, as its own copy of the mod.
const dropdown = async () => {
  const spec = state.opened.at(-1);
  const list = state.props;
  const asPopup = { ...spec.props, overlay: "ov" };
  state.props = asPopup;
  const view: any = new Agents();
  view.init({}, cx);
  await settle();
  state.props = list;
  const draw = () => {
    state.props = asPopup;
    const root = view.render(cx).el as El;
    state.props = list;
    return root;
  };
  return { spec, draw };
};

test("context is the newest main message's input and cache, with helpers and Claude's notices left out", async () => {
  const { draw } = await one([
    said({ id: "m1", input: 1000, read: 1000, write: 1000, output: 5000 }),
    said({ id: "m2", input: 10, read: 40000, write: 9990, output: 700 }),
    said({ id: "h1", input: 900000, read: 900000, side: true }),
    said({ id: "n1", model: "<synthetic>" }),
  ]);
  expect(rowPercents(draw, "t1")).toEqual(["5%"]);
});

test("repeated lines for one message count once, and the dropdown adds up the rest", async () => {
  const { draw } = await one([
    said({ id: "m1", input: 1000, read: 2000, write: 3000, output: 400 }),
    said({ id: "m1", input: 1000, read: 2000, write: 3000, output: 400 }),
    said({ id: "m1", input: 1000, read: 2000, write: 3000, output: 400 }),
    said({ id: "m2", input: 500, read: 60000, write: 4700, output: 8000 }),
  ]);
  clicks(byId(draw(), "logo-t1")!);
  const seen = words((await dropdown()).draw());
  expect(seen).toContain("Claude Opus 5.5");
  expect(seen).toContain("65.2k / 1M");
  expect(seen).toContain("7%");
  expect(seen).toContain("in 1.5k · out 8.4k · cached 69.7k");
});

test("two agents in one folder never show each other's numbers", async () => {
  const a = running("t1", 101), b = running("t2", 102);
  state.terminals = [a, b];
  state.agents = [listed(a), listed(b)];
  recordOf(101, "one");
  recordOf(102, "two");
  writes("one", [said({ id: "m1", read: 100000 })]);
  writes("two", [said({ id: "m2", read: 300000 })]);
  const { draw } = await open();
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["10%"]);
  expect(rowPercents(draw, "t2")).toEqual(["30%"]);
});

test("the logo opens the dropdown, without focusing the agent or folding its sub-agents", async () => {
  const parent = running("t1", 101), kid = running("t1b", 102, CLAUDE, { parent: "t1" });
  state.terminals = [parent, kid];
  state.agents = [listed(parent)];
  recordOf(101, "one");
  writes("one", [said({ id: "m1", read: 100000 })]);
  const { view, draw } = await open();
  await ticks();
  clicks(byId(draw(), "logo-t1")!);
  expect(state.stopped).toBe(1);
  expect(state.ran).toEqual([]);
  expect(view.folded.has("t1")).toBe(false);
  expect(state.opened).toHaveLength(1);
  expect(state.opened[0]).toMatchObject({ mod: "agents", kind: "popup", props: { session: "t1" } });

  clicks(byId(draw(), "fold-t1")!);
  expect(view.folded.has("t1")).toBe(true);
  expect(byId(draw(), "sub-t1b")).toBeUndefined();
});

test("clicking the row still focuses the agent", async () => {
  const { draw } = await one([said({ id: "m1", read: 100000 })]);
  clicks(byId(draw(), "ag-t1")!);
  expect(state.ran).toEqual([["pane.focus", { pane: "p-t1" }]]);
});

test("OpenCode shows no percent, reads nothing, and its logo acts like clicking the row", async () => {
  const term = running("t1", 101, OPENCODE);
  const kid = running("t1b", 102, OPENCODE, { parent: "t1" });
  state.terminals = [term, kid];
  state.agents = [listed(term)];
  recordOf(101, "one");
  writes("one", [said({ id: "m1", read: 100000 })]);
  const { view, draw } = await open();
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual([]);
  expect(state.reads).toEqual([]);
  expect(state.execs).toEqual([]);
  expect(clicks(byId(draw(), "logo-t1")!)).toBeUndefined();
  expect(state.stopped).toBe(0);
  expect(state.opened).toEqual([]);
  expect(view.folded.has("t1")).toBe(false);
  expect(byId(draw(), "sub-t1b")!.calls.some(([k]) => k === "on_click")).toBe(true);
  expect(byId(draw(), "logo-t1b")?.calls.some(([k]) => k === "on_click") ?? false).toBe(false);
});

test("a sub-agent's row shows its own percent, and its logo opens its own dropdown", async () => {
  const parent = running("t1", 101), kid = running("t1b", 102, CLAUDE, { parent: "t1" });
  state.terminals = [parent, kid];
  state.agents = [listed(parent)];
  recordOf(101, "one");
  recordOf(102, "two");
  writes("one", [said({ id: "m1", read: 100000 })]);
  writes("two", [said({ id: "m2", read: 250000, output: 7 })]);
  const { draw } = await open();
  await ticks();
  expect(percents(byId(draw(), "sub-t1b")!)).toEqual(["25%"]);

  clicks(byId(draw(), "logo-t1b")!);
  expect(state.stopped).toBe(1);
  expect(state.ran).toEqual([]);
  expect(state.opened.at(-1).props.session).toBe("t1b");
  expect(words((await dropdown()).draw())).toContain("250k / 1M");
});

const changes = async (id: string, lines: string[]) => {
  writes(id, lines);
  state.watchers.shift()([fileOf(id)]);
  await ticks();
};

test("the total comes from Claude's own /context, once per model, spending nothing, and is kept for a day", async () => {
  const start = Date.now();
  const asked: string[][] = [];
  state.claude = (args: string[]) => { asked.push(args); return { code: 0, stdout: contextReply("13.7k / 200k (7%)"), stderr: "" }; };
  const { draw } = await one([said({ id: "m1", read: 20000 })]);
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["10%"]);
  expect(asked).toEqual([["-p", "/context", "--output-format", "json", "--model", "claude-opus-5-5", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""]]);

  await changes("one", [said({ id: "m2", read: 30000 })]);
  expect(asked.length).toBe(1);

  setSystemTime(new Date(start + 25 * 3600000));
  await changes("one", [said({ id: "m3", read: 40000 })]);
  setSystemTime();
  expect(asked.length).toBe(2);
});

test("a new model gets its own total, and the context follows the model running now", async () => {
  state.claude = (args: string[]) => ({ code: 0, stdout: contextReply(args.includes("claude-sonnet-5-5") ? "1k / 200k (0%)" : "1k / 1m (0%)"), stderr: "" });
  const { draw } = await one([said({ id: "m1", read: 100000 })]);
  expect(rowPercents(draw, "t1")).toEqual(["10%"]);
  await changes("one", [said({ id: "m2", read: 100000, model: "claude-sonnet-5-5" })]);
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["50%"]);
  clicks(byId(draw(), "logo-t1")!);
  expect(words((await dropdown()).draw())).toContain("Claude Sonnet 5.5");
});

test("until the total is known the dropdown shows tokens and the row shows nothing", async () => {
  state.claude = () => ({ code: 1, stdout: "", stderr: "not installed" });
  const { draw } = await one([said({ id: "m1", input: 100, read: 2000, output: 30 })]);
  expect(rowPercents(draw, "t1")).toEqual([]);
  clicks(byId(draw(), "logo-t1")!);
  const seen = words((await dropdown()).draw());
  expect(seen).toContain("2.1k");
  expect(seen).toContain("in 100 · out 30 · cached 2k");
  expect(percents((await dropdown()).draw())).toEqual([]);
});

test("a check that failed waits before trying again", async () => {
  const start = Date.now();
  let tries = 0;
  state.claude = () => { tries++; throw new Error("not there"); };
  const { draw } = await one([said({ id: "m1", read: 2000 })]);
  await changes("one", [said({ id: "m2", read: 3000 })]);
  expect(tries).toBe(1);
  expect(rowPercents(draw, "t1")).toEqual([]);

  setSystemTime(new Date(start + 11 * 60000));
  await changes("one", [said({ id: "m3", read: 4000 })]);
  setSystemTime();
  expect(tries).toBe(2);
});

test("a total smaller than what's used is wrong, so no percent shows", async () => {
  state.claude = () => ({ code: 0, stdout: contextReply("1k / 200k (0%)"), stderr: "" });
  const { draw } = await one([said({ id: "m1", read: 300000 })]);
  expect(rowPercents(draw, "t1")).toEqual([]);
});

test("numbers follow the file, at most once per pass however often it changes", async () => {
  const { draw } = await one([said({ id: "m1", read: 100000 })]);
  expect(rowPercents(draw, "t1")).toEqual(["10%"]);
  const reads = () => state.execs.filter(([cmd]: string[]) => cmd === "sh").length;
  const before = reads();
  await ticks();
  expect(reads()).toBe(before);

  writes("one", [said({ id: "m2", read: 200000 })]);
  const notified = state.notified;
  state.watchers.shift()([fileOf("one")]);
  await settle();
  writes("one", [said({ id: "m3", read: 300000 })]);
  state.watchers.shift()([fileOf("one")]);
  await settle();
  expect(reads()).toBe(before);
  await ticks();
  expect(reads()).toBe(before + 1);
  expect(state.notified).toBeGreaterThan(notified);
  expect(rowPercents(draw, "t1")).toEqual(["30%"]);
});

test("the pass stays quiet when nothing changed: no redraw for the window to pay for", async () => {
  await one([said({ id: "m1", read: 100000 })]);
  const notified = state.notified;
  await ticks();
  await changes("one", [JSON.stringify({ type: "user", message: { role: "user", content: "made up" } })]);
  expect(state.notified).toBe(notified);
});

test("a session file that goes away keeps the last result", async () => {
  const { draw } = await one([said({ id: "m1", read: 100000 })]);
  rmSync(fileOf("one"));
  state.watchers.shift()([fileOf("one")]);
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["10%"]);
});

test("a change to another agent's session reads nothing here", async () => {
  await one([said({ id: "m1", read: 100000 })]);
  const reads = state.execs.length;
  state.watchers.shift()([fileOf("another")]);
  await ticks();
  expect(state.execs.length).toBe(reads);
});

test("a folder that can't be watched is read every pass instead", async () => {
  state.brokenWatch = true;
  const { draw } = await one([said({ id: "m1", read: 100000 })]);
  writes("one", [said({ id: "m2", read: 200000 })]);
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["20%"]);
});

test("a failed read keeps the last result, and the next pass tries again", async () => {
  const { draw } = await one([said({ id: "m1", read: 100000 })]);
  state.brokenExec = true;
  await changes("one", [said({ id: "m2", read: 200000 })]);
  expect(rowPercents(draw, "t1")).toEqual(["10%"]);
  state.brokenExec = false;
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["20%"]);
});

test("a broken line is skipped, and a process with no record keeps the last result", async () => {
  const { draw } = await one([said({ id: "m1", read: 100000 }), '{"type":"assistant","message":{"usa', said({ id: "m2", read: 150000 })]);
  expect(rowPercents(draw, "t1")).toEqual(["15%"]);
  state.terminals = [running("t1", 999)];
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["15%"]);
});

test("an unreadable session shows no percent and no error", async () => {
  state.brokenFiles = true;
  const { draw } = await one([]);
  expect(rowPercents(draw, "t1")).toEqual([]);
  state.brokenFiles = false;
  state.brokenExec = true;
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual([]);
  clicks(byId(draw(), "logo-t1")!);
  expect(words((await dropdown()).draw())).toEqual(["No usage yet"]);
});

test("a record that isn't JSON shows no percent and no error", async () => {
  const { draw } = await one([]);
  writeFileSync(join(home, ".claude", "sessions", "101.json"), "half a rec");
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual([]);
});

test("a new Claude shows no percent before its first message, and says so in its dropdown", async () => {
  const { draw } = await one([]);
  expect(rowPercents(draw, "t1")).toEqual([]);
  clicks(byId(draw(), "logo-t1")!);
  const { draw: card } = await dropdown();
  expect(words(card())).toEqual(["No usage yet"]);

  writes("one", [said({ id: "m1", read: 100000 })]);
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["10%"]);
  expect(words(card())).toContain("100k / 1M");
});

test("the dropdown stays live while it's open", async () => {
  const { draw } = await one([said({ id: "m1", read: 100000, output: 10 })]);
  clicks(byId(draw(), "logo-t1")!);
  const { draw: card } = await dropdown();
  expect(words(card())).toContain("100k / 1M");
  writes("one", [said({ id: "m2", read: 200000, output: 20 })]);
  for (const changed of state.watchers.splice(0)) changed([fileOf("one")]);
  await ticks();
  expect(words(card())).toContain("200k / 1M");
  expect(words(card())).toContain("in 0 · out 30 · cached 300k");
});

test("the dropdown draws at once from what the row knew, before its own first read", async () => {
  const { draw } = await one([said({ id: "m1", read: 100000 })]);
  clicks(byId(draw(), "logo-t1")!);
  state.props = { ...state.opened.at(-1).props, overlay: "ov" };
  const view: any = new Agents();
  view.init({}, { ...cx, spawn: () => ({ cancel() {} }) });
  expect(words(view.render(cx).el as El)).toContain("100k / 1M");
});

test("the dropdown goes when its agent does", async () => {
  const { draw } = await one([said({ id: "m1", read: 100000 })]);
  clicks(byId(draw(), "logo-t1")!);
  await dropdown();
  state.terminals = [];
  state.agents = [];
  await ticks();
  expect(state.closed).toEqual(["ov"]);
});

test("/clear shows the new session's numbers", async () => {
  const { draw } = await one([said({ id: "m1", read: 300000, output: 50 })]);
  expect(rowPercents(draw, "t1")).toEqual(["30%"]);
  recordOf(101, "two");
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual([]);
  writes("two", [said({ id: "m2", read: 50000, output: 5 })]);
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["5%"]);
  clicks(byId(draw(), "logo-t1")!);
  expect(words((await dropdown()).draw())).toContain("in 0 · out 5 · cached 50k");
});

test("/compact lowers context with Claude's next message, and token counts carry on", async () => {
  const boundary = JSON.stringify({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual", preTokens: 500000, postTokens: 25000 }, isSidechain: false });
  const { draw } = await one([said({ id: "m1", read: 500000, output: 100 }), boundary]);
  expect(rowPercents(draw, "t1")).toEqual(["50%"]);
  await changes("one", [said({ id: "m2", read: 80000, output: 200 })]);
  expect(rowPercents(draw, "t1")).toEqual(["8%"]);
  clicks(byId(draw(), "logo-t1")!);
  expect(words((await dropdown()).draw())).toContain("in 0 · out 300 · cached 580k");
});

test("a new Claude in the same terminal starts over", async () => {
  const { draw } = await one([said({ id: "m1", read: 300000 })]);
  recordOf(202, "two");
  writes("two", [said({ id: "m2", read: 40000 })]);
  state.terminals = [running("t1", 202)];
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["4%"]);
});

test("the percent sits between the name and the time, and stays when hovering swaps the time for the pin", async () => {
  const { view, draw } = await one([said({ id: "m1", read: 100000 })]);
  view.changed.t1 = { s: "idle", at: Date.now() - 300000 };
  expect(shows(draw, "t1").slice(0, 4)).toEqual(["one", "· 1", "10%", "5m"]);
  const row = byId(draw(), "ag-t1")!;
  const percent = all(row).find((e) => e.kids.includes("10%"))!;
  const time = all(row).find((e) => e.kids.includes("5m"))!;
  expect([arg(percent, "font_family"), arg(percent, "text_size"), arg(percent, "text_color")]).toEqual([arg(time, "font_family"), arg(time, "text_size"), arg(time, "text_color")]);

  row.calls.find(([k]) => k === "on_hover")![1][0](true, cx);
  const hovered = byId(draw(), "ag-t1")!;
  expect(byId(hovered, "pin-t1")).toBeDefined();
  expect(words(hovered)).toContain("10%");
  expect(words(hovered)).not.toContain("5m");
});

test("from 90% the percent turns the theme's blocked color", async () => {
  const { draw } = await one([said({ id: "m1", read: 894000 })]);
  const color = (text: string) => arg(all(byId(draw(), "ag-t1")!).find((e) => e.kids.includes(text))!, "text_color");
  expect(color("89%")).not.toBe(colors.blocked);
  await changes("one", [said({ id: "m2", read: 900000 })]);
  expect(color("90%")).toBe(colors.blocked);
});

test("the name shortens before the percent goes", async () => {
  const { draw } = await one([said({ id: "m1", read: 100000 })]);
  const row = byId(draw(), "ag-t1")!;
  const name = all(row).find((e) => e.kids.includes("one"))!;
  const percent = all(row).find((e) => e.kids.includes("10%"))!;
  expect(name.calls.some(([k]) => k === "truncate")).toBe(true);
  expect(percent.calls.some(([k]) => k === "flex_none")).toBe(true);
});

test("the collapsed rail shows no percent", async () => {
  const { draw } = await one([said({ id: "m1", read: 100000 })]);
  state.layout = { id: "sidebar", size: { px: 76 } };
  expect(percents(draw())).toEqual([]);
});

test("a machine's agents read nothing here, and their logos are part of the row", async () => {
  const term = running("vps/t1", 101);
  state.terminals = [term];
  state.agents = [listed(term)];
  recordOf(101, "one");
  writes("one", [said({ id: "m1", read: 100000 })]);
  const { draw } = await open();
  await ticks();
  expect(state.reads).toEqual([]);
  expect(byId(draw(), "logo-vps/t1")?.calls.some(([k]) => k === "on_click") ?? false).toBe(false);
});

test("every color the row and the dropdown use comes from the theme", async () => {
  const { draw } = await one([said({ id: "m1", read: 950000 })]);
  clicks(byId(draw(), "logo-t1")!);
  const root = (await dropdown()).draw();
  const named = new Set(Object.values(look(colors)).filter((c) => typeof c === "string"));
  for (const e of [...all(root), ...all(byId(draw(), "ag-t1")!)]) {
    for (const [k, a] of e.calls) if (["text_color", "bg", "border_color"].includes(k) && a[0] !== undefined) expect(named.has(a[0])).toBe(true);
  }
  for (const file of ["main.js", "sessions.js", "claude.js", "dropdown.js"]) {
    expect(readFileSync(new URL(`../defaults/mods/agents/${file}`, import.meta.url), "utf8")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  }
});

test("a helper's message nested in another kind of line counts for nothing", async () => {
  const nested = JSON.stringify({ type: "progress", message: { type: "assistant", model: "claude-opus-5-5", id: "h1", usage: { input_tokens: 900000 } } });
  const { draw } = await one([said({ id: "m1", read: 100000 }), nested]);
  expect(rowPercents(draw, "t1")).toEqual(["10%"]);
  clicks(byId(draw(), "logo-t1")!);
  expect(words((await dropdown()).draw())).toContain("in 0 · out 0 · cached 100k");
});

test("a rewritten, shorter file is read from the start", async () => {
  const { draw } = await one([said({ id: "m1", read: 100000, text: "x".repeat(2000000) })]);
  writeFileSync(fileOf("one"), `${said({ id: "m2", read: 40000 })}\n`);
  state.watchers.shift()([fileOf("one")]);
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["4%"]);
  clicks(byId(draw(), "logo-t1")!);
  expect(words((await dropdown()).draw())).toContain("in 0 · out 0 · cached 40k");
});

test("a 100 MB session is read whole, however its lines fall, and after that only what's new", async () => {
  const chunks: string[] = [];
  const talk = JSON.stringify({ type: "user", message: { role: "user", content: `she said "type":"assistant" ${"x".repeat(77000)}` } });
  const huge = JSON.stringify({ type: "user", toolUseResult: { usage: { input_tokens: 900000 } }, message: { role: "user", content: "y".repeat(1300000) } });
  for (let i = 1; i <= 1300; i++) {
    const read = i === 1300 ? 500000 : 1000;
    const line = said({ id: `m${i}`, input: 10, read, output: 5, text: "z".repeat(300) });
    chunks.push(line, line, line, talk);
    if (i % 200 === 0) chunks.push(huge);
  }
  writes("one", chunks);
  expect(statSync(fileOf("one")).size).toBeGreaterThan(100000000);

  const { draw } = await one([]);
  expect(rowPercents(draw, "t1")).toEqual(["50%"]);
  clicks(byId(draw(), "logo-t1")!);
  expect(words((await dropdown()).draw())).toContain("in 13k · out 6.5k · cached 1.8M");
  expect(Math.max(...state.outputs)).toBeLessThanOrEqual(EXEC_OUTPUT);

  state.execs = [];
  state.outputs = [];
  await changes("one", [said({ id: "m1301", input: 10, read: 600000 })]);
  expect(rowPercents(draw, "t1")).toEqual(["60%"]);
  expect(state.execs.filter(([cmd]: string[]) => cmd === "sh").length).toBe(1);
  expect(state.outputs[0]).toBeLessThan(200000);
  rmSync(fileOf("one"));
}, 30000);

test("a read the machine slept through can't put old numbers back over a newer read", async () => {
  const start = Date.now();
  const { draw } = await one([said({ id: "m1", read: 100000 })]);
  let wake = () => {};
  state.asleep = new Promise<void>((resolve) => { wake = resolve; });
  writes("one", [said({ id: "m2", read: 200000 })]);
  state.watchers.shift()([fileOf("one")]);
  await Bun.sleep(5);
  for (const [ms, f] of state.timers) if (ms === 2000) f(cx);
  await Bun.sleep(30);

  state.asleep = null;
  writes("one", [said({ id: "m3", read: 300000 })]);
  state.watchers.shift()([fileOf("one")]);
  setSystemTime(new Date(start + 15 * 60000));
  await Bun.sleep(5);
  for (const [ms, f] of state.timers) if (ms === 2000) f(cx);
  await Bun.sleep(30);
  wake();
  await settle();
  setSystemTime();
  expect(rowPercents(draw, "t1")).toEqual(["30%"]);
});

test("a read left unfinished by sleep is finished by the next pass", async () => {
  const start = Date.now();
  const { draw } = await one([said({ id: "m1", read: 100000 })]);
  state.asleep = new Promise<void>(() => {});
  writes("one", [said({ id: "m2", read: 200000 })]);
  state.watchers.shift()([fileOf("one")]);
  await Bun.sleep(5);
  for (const [ms, f] of state.timers) if (ms === 2000) f(cx);
  await Bun.sleep(30);

  state.asleep = null;
  state.running = state.parked;
  setSystemTime(new Date(start + 15 * 60000));
  await ticks();
  setSystemTime();
  expect(rowPercents(draw, "t1")).toEqual(["20%"]);
});

test("a change that lands during a read isn't lost", async () => {
  const { draw } = await one([said({ id: "m1", read: 100000 })]);
  let wake = () => {};
  state.asleep = new Promise<void>((resolve) => { wake = resolve; });
  writes("one", [said({ id: "m2", read: 200000 })]);
  state.watchers.shift()([fileOf("one")]);
  await Bun.sleep(5);
  for (const [ms, f] of state.timers) if (ms === 2000) f(cx);
  await Bun.sleep(30);

  writes("one", [said({ id: "m3", read: 300000 })]);
  state.watchers.shift()([fileOf("one")]);
  await Bun.sleep(5);
  state.asleep = null;
  wake();
  await settle();
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["30%"]);
});

test("a session of nothing but messages, far past what exec can carry in one go, still adds up", async () => {
  const lines: string[] = [];
  for (let i = 1; i <= 900; i++) lines.push(said({ id: `m${i}`, input: 1, read: 1, output: 1, text: "z".repeat(25000) }));
  writes("one", lines);
  const { draw } = await one([]);
  clicks(byId(draw(), "logo-t1")!);
  expect(words((await dropdown()).draw())).toContain("in 900 · out 900 · cached 900");
  expect(Math.max(...state.outputs)).toBeLessThanOrEqual(EXEC_OUTPUT + 32);
  rmSync(fileOf("one"));
}, 30000);

test("no network, no login: all a pass touches is the session and Claude's own /context", async () => {
  const net = spyOn(globalThis, "fetch");
  const { draw } = await one([said({ id: "m1", read: 100000 })]);
  clicks(byId(draw(), "logo-t1")!);
  await dropdown();
  await ticks();
  expect(net).not.toHaveBeenCalled();
  net.mockRestore();
  expect([...new Set(state.execs.map(([cmd]: string[]) => cmd))].sort()).toEqual(["claude", "sh"]);
  const touched = [...state.reads, ...state.execs.flat()].join("\n");
  expect(touched).not.toMatch(/credential|keychain|oauth|\.netrc|security/i);
  for (const file of ["main.js", "sessions.js", "claude.js", "dropdown.js"]) {
    expect(readFileSync(new URL(`../defaults/mods/agents/${file}`, import.meta.url), "utf8")).not.toMatch(/\bfetch\(|WebSocket|https?:/);
  }
});
