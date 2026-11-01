import { test, expect, mock, beforeEach, afterAll, setSystemTime, spyOn } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  home: () => state.home ?? home,
  readTextFile: async (path: string) => {
    state.reads.push(path);
    if (state.brokenFiles) throw new Error("no such thing");
    try { return readFileSync(path, "utf8"); } catch { return null; }
  },
  // Refuses a changed file as the real one does, and anything outside the scratch home.
  writeTextFile: async (path: string, text: string, expected: string | null) => {
    if (!path.startsWith(`${home}/`)) throw new Error(`outside the scratch home: ${path}`);
    if (state.brokenWrites) throw new Error("can't write");
    if ((existsSync(path) ? readFileSync(path, "utf8") : null) !== expected) throw new Error("The file changed while saving.");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    state.written.push(path);
    return null;
  },
  hc: async (args: string[]) => {
    state.hc.push(args);
    if (state.brokenHc) throw new Error("no hc");
    return { code: 0, stdout: "", stderr: "" };
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
    const r = Bun.spawnSync([cmd, ...args], { env: { ...process.env, HOME: home } });
    const stdout = r.stdout.toString();
    state.outputs.push(stdout.length);
    if (state.asleep) await state.asleep;
    if (args.at(-1)?.endsWith("/subagents")) await state.listing;
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
type Said = { id: string; input?: number; read?: number; write?: number; write5m?: number; output?: number; model?: string; side?: boolean; text?: string; speed?: string; geo?: string };
const said = ({ id, input = 0, read = 0, write = 0, write5m = 0, output = 0, model = "claude-opus-5-5", side = false, text = "made up", speed = "standard", geo = "global" }: Said) =>
  JSON.stringify({
    parentUuid: "p", isSidechain: side,
    message: {
      model, id, type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn",
      usage: { input_tokens: input, cache_creation_input_tokens: write + write5m, cache_read_input_tokens: read, output_tokens: output, cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: write5m }, service_tier: "standard", inference_geo: geo, speed },
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
  for (const folder of [".claude", ".codex", ".zaki"]) rmSync(join(home, folder), { recursive: true, force: true });
  state = {
    agents: [], terminals: [], ran: [], shared: {}, opened: [], closed: [], props: {}, layout: null,
    reads: [], watched: [], watchers: [], execs: [], running: 0, parked: 0, timers: [], notified: 0, stopped: 0,
    outputs: [], brokenFiles: false, brokenExec: false, brokenWatch: false, brokenWrites: false, brokenHc: false,
    written: [], hc: [], totals: {}, ordinal: 0,
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

const realReads = () => state.execs.filter(([cmd, , script]: string[]) => cmd === "sh" && script.includes("dd if=")).length;
const changed = (path: string) => { for (const wake of state.watchers.splice(0)) wake([path]); };
const changes = async (id: string, lines: string[]) => {
  writes(id, lines);
  changed(fileOf(id));
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
  const before = realReads();
  await ticks();
  expect(realReads()).toBe(before);

  writes("one", [said({ id: "m2", read: 200000 })]);
  const notified = state.notified;
  state.watchers.shift()([fileOf("one")]);
  await settle();
  writes("one", [said({ id: "m3", read: 300000 })]);
  state.watchers.shift()([fileOf("one")]);
  await settle();
  expect(realReads()).toBe(before);
  await ticks();
  expect(realReads()).toBe(before + 1);
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
  for (const file of ["main.js", "sessions.js", "claude.js", "codex.js", "sizes.js", "dropdown.js", "prices.js"]) {
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
  // One for the list and one for the dropdown it left open.
  expect(realReads()).toBe(2);
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

// What the list has worked out as it went, drawn by a dropdown that never reads for itself.
const known = (draw: () => El) => {
  clicks(byId(draw(), "logo-t1")!);
  const list = state.props;
  state.props = { ...state.opened.at(-1).props, overlay: "ov" };
  const view: any = new Agents();
  view.init({}, { ...cx, spawn: () => ({ cancel() {} }), timer: { every() {} } });
  const seen = words(view.render(cx).el as El);
  state.props = list;
  return seen;
};

// A dropdown reads the session from its start and the list follows it: both must come to the same.
const card = async (draw: () => El) => {
  const followed = known(draw);
  clicks(byId(draw(), "logo-t1")!);
  const seen = words((await dropdown()).draw());
  expect(seen).toEqual(followed);
  return seen;
};

test("the dropdown shows the API cost, per token class, and says it is not what was paid", async () => {
  const seen = await card((await one([said({ id: "m1", input: 1000000, write5m: 1000000, write: 1000000, read: 1000000, output: 1000000 })])).draw);
  // Opus 5.5 on the pricing page: $4 in, $5 5m write, $8 1h write, $0.20 read, $20 out.
  expect(seen).toContain("API cost");
  expect(seen).toContain("$37.20");
  expect(seen).toContain("What this would cost on the API, not what you paid.");
});

test("a session on several models names the one running now and counts them all", async () => {
  const seen = await card((await one([
    said({ id: "m1", input: 1000000 }),
    said({ id: "m2", input: 1000000, model: "claude-fable-5-1" }),
    said({ id: "m3", output: 1000000, model: "claude-sonnet-5-5" }),
  ])).draw);
  expect(seen).toContain("Claude Sonnet 5.5");
  expect(seen).toContain("$24.00");
});

test("one model with no exact price reads no price, and the rest of the dropdown stays", async () => {
  for (const model of ["claude-opus-9", "claude-opus-5-5-20270101", "anthropic.claude-opus-5-5"]) {
    const { draw } = await one([said({ id: "m1", input: 1000000 }), said({ id: `m-${model}`, read: 100000, output: 50, model })]);
    const seen = await card(draw);
    expect(seen).toContain("no price");
    expect(seen.join(" ")).not.toContain("$");
    expect(seen).toContain("in 1M · out 50 · cached 100k");
    expect(seen).toContain("100k / 1M");
    expect(rowPercents(draw, "t1")).toEqual(["10%"]);
    rmSync(fileOf("one"));
  }
});

test("repeated lines for one message cost once", async () => {
  const line = said({ id: "m1", input: 1000000 });
  expect(await card((await one([line, line, line])).draw)).toContain("$4.00");
});

test("Claude's own notices cost nothing, and don't make a session no price", async () => {
  expect(await card((await one([said({ id: "m1", input: 1000000 }), said({ id: "n1", input: 5, model: "<synthetic>" })])).draw)).toContain("$4.00");
});

test("a sum under a cent doesn't read as free, and an empty one does", async () => {
  expect(await card((await one([said({ id: "m1", input: 100 })])).draw)).toContain("<$0.01");
  rmSync(fileOf("one"));
  expect(await card((await one([said({ id: "m1" })])).draw)).toContain("$0.00");
});

test("a Haiku 5.5 message over 100,000 prompt tokens pays the higher prices, by itself", async () => {
  const haiku = "claude-haiku-5-5";
  expect(await card((await one([said({ id: "m1", input: 100000, output: 2000000, model: haiku })])).draw)).toContain("$1.01");
  rmSync(fileOf("one"));
  expect(await card((await one([said({ id: "m1", input: 1, read: 100000, output: 2000000, model: haiku })])).draw)).toContain("$5.01");
  rmSync(fileOf("one"));
  expect(await card((await one([
    said({ id: "m1", output: 2000000, model: haiku }),
    said({ id: "m2", write: 200000, output: 2000000, model: haiku }),
  ])).draw)).toContain("$6.20");
});

test("fast mode has its own prices, and a model without them reads no price", async () => {
  const lots = { input: 1000000, write5m: 1000000, write: 1000000, read: 1000000, output: 1000000, speed: "fast" };
  expect(await card((await one([said({ id: "m1", ...lots })])).draw)).toContain("$74.40");
  rmSync(fileOf("one"));
  expect(await card((await one([said({ id: "m1", ...lots, model: "claude-opus-4-7" })])).draw)).toContain("no price");
  rmSync(fileOf("one"));
  expect(await card((await one([said({ id: "m1", ...lots, speed: "turbo" })])).draw)).toContain("no price");
});

test("US-only inference is 1.1 times the price, and any other place reads no price", async () => {
  const lots = { input: 1000000, output: 1000000 };
  expect(await card((await one([said({ id: "m1", ...lots, geo: "us" })])).draw)).toContain("$26.40");
  rmSync(fileOf("one"));
  expect(await card((await one([said({ id: "m1", ...lots, geo: "not_available" })])).draw)).toContain("$24.00");
  rmSync(fileOf("one"));
  expect(await card((await one([said({ id: "m1", ...lots, geo: "moon" })])).draw)).toContain("no price");
});

test("a line that doesn't split its cache writes counts them as 5-minute ones", async () => {
  const line = JSON.parse(said({ id: "m1", write: 1000000 }));
  delete line.message.usage.cache_creation;
  expect(await card((await one([JSON.stringify(line)])).draw)).toContain("$5.00");
});

test("/clear starts the cost over", async () => {
  const { draw } = await one([said({ id: "m1", input: 1000000 })]);
  recordOf(101, "two");
  writes("two", [said({ id: "m2", input: 500000 })]);
  await ticks();
  expect(await card(draw)).toContain("$2.00");
});

test("/compact keeps the cost going", async () => {
  const boundary = JSON.stringify({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual", preTokens: 500000, postTokens: 25000 }, isSidechain: false });
  const { draw } = await one([said({ id: "m1", input: 1000000 }), boundary]);
  await changes("one", [said({ id: "m2", input: 500000 })]);
  expect(await card(draw)).toContain("$6.00");
});

test("a resumed session keeps its cost, in a new process and after Zaki restarts", async () => {
  const { draw } = await one([said({ id: "m1", input: 1000000 })]);
  recordOf(202, "one");
  state.terminals = [running("t1", 202)];
  await changes("one", [said({ id: "m2", input: 500000 })]);
  expect(await card(draw)).toContain("$6.00");

  const restarted = await open();
  await ticks();
  expect(await card(restarted.draw)).toContain("$6.00");
});

const helperOf = (sessionId: string, name: string) => join(dirname(fileOf(sessionId)), sessionId, "subagents", `agent-${name}.jsonl`);
const helps = (sessionId: string, name: string, lines: string[]) => {
  mkdirSync(dirname(helperOf(sessionId, name)), { recursive: true });
  appendFileSync(helperOf(sessionId, name), lines.map((l) => `${l}\n`).join(""));
  writeFileSync(helperOf(sessionId, name).replace(/\.jsonl$/, ".meta.json"), '{"agentType":"made-up"}');
};
const helperChanges = async (sessionId: string, name: string, lines: string[]) => {
  helps(sessionId, name, lines);
  changed(helperOf(sessionId, name));
  await ticks();
};

test("helpers add to their parent's cost and tokens, and never to its context", async () => {
  helps("one", "a1", [said({ id: "h1", input: 1000000, output: 10, side: true }), said({ id: "h2", read: 900000, side: true })]);
  helps("one", "a2", [said({ id: "h3", output: 1000000, model: "claude-sonnet-5-5", side: true })]);
  const { draw } = await one([said({ id: "m1", input: 100000, read: 10000 })]);
  expect(rowPercents(draw, "t1")).toEqual(["11%"]);
  const seen = await card(draw);
  expect(seen).toContain("110k / 1M");
  // Opus 5.5: $0.40 + $0.002 + $4 + $0.0002 + $0.18. Sonnet 5.5: $10.
  expect(seen).toContain("$14.58");
  expect(seen).toContain("in 1.1M · out 1M · cached 910k");
});

test("a helper file saying nothing of being a helper still stays out of context", async () => {
  helps("one", "a1", [said({ id: "h1", read: 900000, model: "claude-sonnet-5-5" })]);
  const { draw } = await one([said({ id: "m1", read: 100000 })]);
  expect(rowPercents(draw, "t1")).toEqual(["10%"]);
  expect(await card(draw)).toContain("Claude Opus 5.5");
});

test("a helper's message counts at its final output, not the part-way one on its first line", async () => {
  const first = said({ id: "h1", input: 1000000, read: 1000000, output: 1000000, side: true });
  const last = said({ id: "h1", input: 1000000, read: 1000000, output: 2000000, side: true });
  helps("one", "a1", [first, last, first]);
  const seen = await card((await one([said({ id: "m1" })])).draw);
  // $4 in, $0.20 read and $40 out, once.
  expect(seen).toContain("$44.20");
  expect(seen).toContain("in 1M · out 2M · cached 1M");
});

test("a helper on a model with no price makes the whole session no price", async () => {
  helps("one", "a1", [said({ id: "h1", input: 5, model: "claude-opus-9", side: true })]);
  const { draw } = await one([said({ id: "m1", input: 1000000 })]);
  const seen = await card(draw);
  expect(seen).toContain("no price");
  expect(seen).toContain("in 1M · out 0 · cached 0");
});

test("a helper that starts or grows later is followed, and only it is read again", async () => {
  helps("one", "a1", [said({ id: "h1", input: 1000000, side: true })]);
  const { draw } = await one([said({ id: "m1", input: 1000000 })]);
  expect(realReads()).toBe(2);
  await helperChanges("one", "a2", [said({ id: "h2", input: 1000000, side: true })]);
  expect(realReads()).toBe(4);
  await helperChanges("one", "a2", [said({ id: "h3", input: 1000000, side: true })]);
  expect(realReads()).toBe(6);
  expect(await card(draw)).toContain("$16.00");
});

test("the dropdown stays live on a helper's work too", async () => {
  const { draw } = await one([said({ id: "m1", input: 1000000 })]);
  clicks(byId(draw(), "logo-t1")!);
  const { draw: open } = await dropdown();
  expect(words(open())).toContain("$4.00");
  helps("one", "a1", [said({ id: "h1", input: 1000000, side: true })]);
  changed(helperOf("one", "a1"));
  await ticks();
  expect(words(open())).toContain("$8.00");
});

test("a rewritten, shorter helper starts its session over, and counts nothing twice", async () => {
  helps("one", "a1", [said({ id: "h1", input: 1000000, side: true, text: "x".repeat(3000000) }), said({ id: "h2", input: 1000000, side: true, text: "y".repeat(3000000) })]);
  const { draw } = await one([said({ id: "m1", input: 1000000 })]);
  expect(await card(draw)).toContain("$12.00");
  await changes("one", [said({ id: "m2", input: 1000000 })]);
  writeFileSync(helperOf("one", "a1"), `${said({ id: "h9", input: 500000, side: true })}\n`);
  changed(helperOf("one", "a1"));
  await ticks();
  expect(await card(draw)).toContain("$10.00");
});

test("a helper file that goes away during a read costs nothing and breaks nothing", async () => {
  helps("one", "a1", [said({ id: "h1", input: 1000000, side: true })]);
  const { draw } = await one([said({ id: "m1", input: 1000000 })]);
  rmSync(helperOf("one", "a1"));
  await changes("one", [said({ id: "m2", input: 1000000 })]);
  expect(known(draw)).toContain("$12.00");
});

test("a read replaced while it listed helpers reads nothing more", async () => {
  const start = Date.now();
  helps("one", "a1", [said({ id: "h1", input: 1000000, side: true })]);
  await one([said({ id: "m1", input: 1000000 })]);
  let wake = () => {};
  state.listing = new Promise<void>((resolve) => { wake = resolve; });
  helps("one", "a1", [said({ id: "h2", input: 1000000, side: true })]);
  changed(helperOf("one", "a1"));
  await Bun.sleep(5);
  for (const [ms, f] of state.timers) if (ms === 2000) f(cx);
  await Bun.sleep(30);

  state.listing = null;
  helps("one", "a1", [said({ id: "h3", input: 1000000, side: true })]);
  changed(helperOf("one", "a1"));
  setSystemTime(new Date(start + 15 * 60000));
  await Bun.sleep(5);
  for (const [ms, f] of state.timers) if (ms === 2000) f(cx);
  await Bun.sleep(30);
  const before = realReads();
  wake();
  await settle();
  setSystemTime();
  expect(realReads()).toBe(before);
});

test("a home folder with a space in its name still finds helpers", async () => {
  const spaced = join(home, "first last");
  state.home = spaced;
  const file = join(spaced, ".claude", "projects", folderOf("/work/project"), "one", "subagents", "agent-a1.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${said({ id: "h1", input: 1000000, side: true })}\n`);
  mkdirSync(join(spaced, ".claude", "sessions"), { recursive: true });
  writeFileSync(join(spaced, ".claude", "sessions", "101.json"), JSON.stringify({ pid: 101, sessionId: "one", cwd: "/work/project" }));
  writeFileSync(join(spaced, ".claude", "projects", folderOf("/work/project"), "one.jsonl"), `${said({ id: "m1", input: 1000000 })}\n`);
  const term = running("t1", 101);
  state.terminals = [term];
  state.agents = [listed(term)];
  const { draw } = await open();
  await ticks();
  expect(await card(draw)).toContain("$8.00");
  rmSync(spaced, { recursive: true, force: true });
});

test("a very big session with many helpers on several models adds up, a window at a time", async () => {
  const talk = JSON.stringify({ type: "user", message: { role: "user", content: `she said "type":"assistant" ${"x".repeat(77000)}` } });
  const chunks: string[] = [];
  for (let i = 1; i <= 1300; i++) {
    const line = said({ id: `m${i}`, input: 100, read: 1000, write5m: 10, write: 10, output: 50, model: i % 2 ? "claude-opus-5-5" : "claude-sonnet-5-5", text: "z".repeat(300) });
    chunks.push(line, line, line, talk);
  }
  writes("one", chunks);
  expect(statSync(fileOf("one")).size).toBeGreaterThan(100000000);
  for (let h = 1; h <= 40; h++) {
    const lines: string[] = [];
    for (let i = 1; i <= 2000; i++) {
      const id = `h${h}-${i}`;
      lines.push(said({ id, input: 100, read: 1000, output: 5, side: true, model: "claude-haiku-5-5", text: "y".repeat(300) }));
      lines.push(said({ id, input: 100, read: 1000, output: 50, side: true, model: "claude-haiku-5-5" }));
    }
    helps("one", `a${h}`, lines);
  }

  const { draw } = await one([]);
  const seen = await card(draw);
  // Each of 650 Opus: 100×$4 + 1000×$0.20 + 10×$5 + 10×$8 + 50×$20 = $1730 a million.
  // Each of 650 Sonnet: half that, $865. Each of 80,000 Haiku: 100×$0.10 + 1000×$0.01 + 50×$0.50 = $45.
  expect(seen).toContain("$5.29");
  expect(seen).toContain("in 8.1M · out 4.1M · cached 81.3M");
  expect(Math.max(...state.outputs)).toBeLessThanOrEqual(EXEC_OUTPUT);

  state.execs = [];
  state.outputs = [];
  await helperChanges("one", "a7", [said({ id: "h-new", input: 1000000, side: true, model: "claude-haiku-5-5" })]);
  // The session and that one helper, for the list and for the dropdown it left open.
  expect(realReads()).toBe(4);
  expect(await card(draw)).toContain("$5.79");
  rmSync(join(dirname(fileOf("one")), "one"), { recursive: true, force: true });
  rmSync(fileOf("one"));
}, 60000);

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
  for (const file of ["main.js", "sessions.js", "claude.js", "codex.js", "sizes.js", "dropdown.js", "prices.js"]) {
    expect(readFileSync(new URL(`../defaults/mods/agents/${file}`, import.meta.url), "utf8")).not.toMatch(/\bfetch\(|WebSocket|https?:/);
  }
});

// Codex, from here on. Lines have the keys real session files have, with made-up words.
const CODEX = { key: "codex", name: "Codex", icon: "icons/codex.svg", tint: false, tile: null, color: null, agent: true, shell: false };
const SHELL = { key: "shell", name: "Shell", icon: null, tint: false, tile: null, color: null, agent: false, shell: true };
const sessionsRoot = () => join(home, ".codex", "sessions");
const uuid = (n: number) => `01a19000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const rollout = (id: string, day = "01") => join(sessionsRoot(), "2026", "11", day, `rollout-2026-11-${day}T10-00-00-${id}.jsonl`);
const labelled = (id: string, day?: string) => ({ "zaki.session": rollout(id, day) });
const aCodex = (address: string, more: any = {}) => running(address, 201, CODEX, { foreground: { pid: 201, name: "codex", argv: ["codex"], cwd: "/work/project" }, ...more });

const envelope = (type: string, payload: any) => JSON.stringify({ timestamp: "2026-11-01T10:00:00.000Z", ordinal: state.ordinal++, type, payload });
const metaOf = (id: string, more: any = {}) => envelope("session_meta", { id, session_id: id, timestamp: "2026-11-01T10:00:00.000Z", cwd: "/work/project", originator: "codex-tui", cli_version: "0.166.0", source: "cli", model_provider: "openai", base_instructions: { text: "made up" }, history_mode: "full", ...more });
const turn = (model = "gpt-6.1-sol") => envelope("turn_context", { turn_id: "t", cwd: "/work/project", approval_policy: "on-request", model, effort: "high", summary: "auto" });
const tier = (service_tier: string) => envelope("event_msg", { type: "thread_settings_applied", thread_settings: { model: "gpt-6.1-sol", service_tier, cwd: "/work/project" } });
const noise = (text = "made up") => envelope("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const started = (kid: string, kind = "started") => envelope("event_msg", { type: "item_completed", item: { type: "SubAgentActivity", id: "i", kind, agent_thread_id: kid, agent_path: "/root/made_up" } });

// One response: `input` holds `cached`, as Codex writes it, and the file keeps a running total.
type Used = { input?: number; cached?: number; write?: number; output?: number; reasoning?: number; window?: number | null };
const usageOf = ({ input = 0, cached = 0, write = 0, output = 0, reasoning = 0 }: Used) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });
const tokenCount = (total: any, last: any, window: number | null) => envelope("event_msg", { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: window }, rate_limits: { limit_id: "codex", primary: { used_percent: 1, window_minutes: 300, resets_at: 1 }, plan_type: "made-up" } });
const spent = (id: string, used: Used) => {
  const last = usageOf(used);
  const total: any = (state.totals[id] ??= usageOf({}));
  for (const key of Object.keys(last) as (keyof typeof last)[]) total[key] += last[key];
  return tokenCount({ ...total }, last, used.window === undefined ? 258400 : used.window);
};

const codexWrites = (id: string, lines: string[], day?: string) => {
  mkdirSync(dirname(rollout(id, day)), { recursive: true });
  appendFileSync(rollout(id, day), lines.map((l) => `${l}\n`).join(""));
};
const codexRow = async (id: string, lines: string[], address = "t1") => {
  const term = aCodex(address, { labels: labelled(id) });
  state.terminals = [term];
  state.agents = [listed(term)];
  if (lines.length) codexWrites(id, lines);
  const list = await open();
  await ticks();
  return list;
};

test("a Codex row shows its session from the terminal's label, with Codex's own sum", async () => {
  // Codex leaves a 12,000 token base out of both sides: 61,600 of 246,400 is 25% used.
  const { draw } = await codexRow(uuid(1), [metaOf(uuid(1)), turn(), spent(uuid(1), { input: 73600 })]);
  expect(rowPercents(draw, "t1")).toEqual(["25%"]);
});

const HOOKS_MESSAGE = "Run `/hooks` in Codex, trust Zaki's hook, then restart this Codex.";
const quietCodex = async (more: any = {}) => {
  const term = aCodex("t1", more);
  state.terminals = [term];
  state.agents = [listed(term)];
  const list = await open();
  await ticks();
  return list;
};
const works = async (more: any = {}) => {
  state.terminals = [aCodex("t1", { status: "working", ...more })];
  await ticks();
};

test("a Codex that has worked and reported no session shows a dash, and its dropdown says what to do", async () => {
  const { draw } = await quietCodex();
  await works();
  state.terminals = [aCodex("t1", { status: "idle" })];
  await ticks();
  expect(shows(draw, "t1")).toContain("–");
  expect(rowPercents(draw, "t1")).toEqual([]);
  clicks(byId(draw(), "logo-t1")!);
  expect(words((await dropdown()).draw())).toEqual([HOOKS_MESSAGE]);
});

test("a new Codex shows no percent before its first message, and No usage yet, because its hook hasn't had a turn to run in", async () => {
  const { draw } = await quietCodex();
  expect(shows(draw, "t1")).not.toContain("–");
  expect(rowPercents(draw, "t1")).toEqual([]);
  clicks(byId(draw(), "logo-t1")!);
  expect(words((await dropdown()).draw())).toEqual(["No usage yet"]);
});

test("the dash is in the time's small text and stays on hover", async () => {
  const { view, draw } = await quietCodex();
  await works();
  view.changed.t1 = { s: "idle", at: Date.now() - 300000 };
  const row = byId(draw(), "ag-t1")!;
  const dash = all(row).find((e) => e.kids.includes("–"))!;
  const time = all(row).find((e) => e.kids.includes("5m"))!;
  expect([arg(dash, "font_family"), arg(dash, "text_size"), arg(dash, "text_color")]).toEqual([arg(time, "font_family"), arg(time, "text_size"), arg(time, "text_color")]);
  row.calls.find(([k]) => k === "on_hover")![1][0](true, cx);
  expect(words(byId(draw(), "ag-t1")!)).toContain("–");
});

test("after approving and restarting, the same agent shows its numbers, and an open dropdown follows", async () => {
  const { draw } = await quietCodex();
  await works();
  clicks(byId(draw(), "logo-t1")!);
  const { draw: card } = await dropdown();
  expect(words(card())).toEqual([HOOKS_MESSAGE]);

  codexWrites(uuid(1), [metaOf(uuid(1)), turn(), spent(uuid(1), { input: 73600, output: 10 })]);
  await works({ labels: labelled(uuid(1)) });
  expect(rowPercents(draw, "t1")).toEqual(["25%"]);
  expect(words(card())).toContain("73.6k / 258k");
});

test("a dropdown opened on a waiting Codex says so from the start, though it hasn't seen it work", async () => {
  const { draw } = await quietCodex();
  await works();
  state.terminals = [aCodex("t1", { status: "idle" })];
  await ticks();
  clicks(byId(draw(), "logo-t1")!);
  expect(words((await dropdown()).draw())).toEqual([HOOKS_MESSAGE]);
});

test("only a real session file in the label counts", async () => {
  for (const label of ["hello", "/etc/passwd", join(sessionsRoot(), "notes.jsonl"), join(home, "2026", "11", "01", `rollout-x-${uuid(1)}.jsonl`), `${rollout(uuid(1))}.bak`, join(sessionsRoot(), "2026", "11", "01", "rollout-made-up.jsonl")]) {
    const { draw } = await quietCodex({ labels: { "zaki.session": label } });
    await works({ labels: { "zaki.session": label } });
    expect(shows(draw, "t1")).toContain("–");
    expect(state.execs).toEqual([]);
  }
});

test("a label pointing at a file that isn't there yet reads as no usage", async () => {
  const { draw } = await codexRow(uuid(1), []);
  expect(shows(draw, "t1")).not.toContain("–");
  clicks(byId(draw(), "logo-t1")!);
  expect(words((await dropdown()).draw())).toEqual(["No usage yet"]);
  codexWrites(uuid(1), [metaOf(uuid(1)), turn(), spent(uuid(1), { input: 73600 })]);
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["25%"]);
});

test("a session with no token record yet reads as no usage", async () => {
  const { draw } = await codexRow(uuid(1), [metaOf(uuid(1)), turn(), noise()]);
  expect(rowPercents(draw, "t1")).toEqual([]);
  clicks(byId(draw(), "logo-t1")!);
  expect(words((await dropdown()).draw())).toEqual(["No usage yet"]);
});

test("two Codex agents in one folder each show their own numbers", async () => {
  const a = aCodex("t1", { labels: labelled(uuid(1)) }), b = aCodex("t2", { labels: labelled(uuid(2)) });
  state.terminals = [a, b];
  state.agents = [listed(a), listed(b)];
  codexWrites(uuid(1), [metaOf(uuid(1)), turn(), spent(uuid(1), { input: 73600 })]);
  codexWrites(uuid(2), [metaOf(uuid(2)), turn(), spent(uuid(2), { input: 135200 })]);
  const { draw } = await open();
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["25%"]);
  expect(rowPercents(draw, "t2")).toEqual(["50%"]);
});

test("a record with no context window shows tokens and no percent, and a real zero window isn't divided by", async () => {
  for (const window of [null, 0]) {
    const { draw } = await codexRow(uuid(1), [metaOf(uuid(1)), turn(), spent(uuid(1), { input: 5000, output: 100, window })]);
    expect(rowPercents(draw, "t1")).toEqual([]);
    clicks(byId(draw(), "logo-t1")!);
    const seen = words((await dropdown()).draw());
    expect(seen).toContain("5.1k");
    expect(percents((await dropdown()).draw())).toEqual([]);
    rmSync(rollout(uuid(1)));
  }
});

test("more used than the window means the window is wrong, so no percent shows", async () => {
  const { draw } = await codexRow(uuid(1), [turn(), spent(uuid(1), { input: 300000, window: 258400 })]);
  expect(rowPercents(draw, "t1")).toEqual([]);
});

test("a Codex percent turns the blocked color from 90%", async () => {
  const { draw } = await codexRow(uuid(1), [turn(), spent(uuid(1), { input: 231000 })]);
  const color = (text: string) => arg(all(byId(draw(), "ag-t1")!).find((e) => e.kids.includes(text))!, "text_color");
  expect(color("89%")).not.toBe(colors.blocked);
  codexWrites(uuid(1), [spent(uuid(1), { input: 236000 })]);
  changed(rollout(uuid(1)));
  await ticks();
  expect(color("91%")).toBe(colors.blocked);
});

test("the dropdown names the newest turn's model and the newest record's context", async () => {
  const id = uuid(1);
  const { draw } = await codexRow(id, [metaOf(id), turn("gpt-5.6-sol"), spent(id, { input: 100000, cached: 90000, output: 2000 }), turn("gpt-6.1-sol"), spent(id, { input: 120000, cached: 100000, output: 3000 })]);
  const seen = await card(draw);
  expect(seen).toContain("GPT-6.1 Sol");
  expect(seen).toContain("123k / 258k");
  expect(seen).toContain("45%");
  expect(seen).toContain("in 30k · out 5k · cached 190k");
  expect(seen).toContain("What this would cost on the API, not what you paid.");
});

test("a model name Zaki can't tidy stays as Codex wrote it", async () => {
  const id = uuid(1);
  expect(await card((await codexRow(id, [turn("o3-made-up"), spent(id, { input: 100000 })])).draw)).toContain("o3-made-up");
});

test("API cost treats cached input apart, and reasoning is only part of output", async () => {
  const id = uuid(1);
  const seen = await card((await codexRow(id, [turn("gpt-6.1-sol"), spent(id, { input: 1000000, cached: 400000, output: 1000000, reasoning: 500000, window: 2000000 })])).draw);
  // GPT-6.1 Sol over 272K in: $4 in, $0.20 cached, $15 out. 600k × $4 + 400k × $0.20 + 1M × $15.
  expect(seen).toContain("$17.48");
  expect(seen).toContain("in 600k · out 1M · cached 400k");
});

test("each model's prices are the page's, short and long", async () => {
  const short = { input: 240000, cached: 200000, output: 120000 };
  const long = { input: 400000, cached: 100000, output: 100000, window: 2000000 };
  const rows: [string, string, string][] = [
    ["gpt-6-astra", "$6.60", "$13.70"],
    ["gpt-6.1-sol", "$1.30", "$2.72"],
    ["gpt-6.1-terra", "$0.65", "$1.36"],
    ["gpt-6-luna", "$0.07", "$0.14"],
    ["gpt-6-sol", "$1.32", "$2.74"],
    ["gpt-5.6-sol", "$2.64", "$5.48"],
    ["gpt-5.6-terra", "$1.56", "$3.04"],
    ["gpt-5.6-luna", "$0.16", "$0.30"],
    ["gpt-5.5", "$3.90", "$7.60"],
    ["gpt-5.4", "$1.95", "$3.80"],
  ];
  for (const [model, small, big] of rows) {
    const id = uuid(1);
    state.totals = {};
    const { draw } = await codexRow(id, [turn(model), spent(id, short)]);
    expect([model, ...(await card(draw))]).toContain(small);
    rmSync(rollout(id));
    state.totals = {};
    const { draw: larger } = await codexRow(id, [turn(model), spent(id, long)]);
    expect([model, ...(await card(larger))]).toContain(big);
    rmSync(rollout(id));
  }
});

test("exactly 272K in is still the short price, by the response and not by the session", async () => {
  const id = uuid(1);
  const seen = await card((await codexRow(id, [turn("gpt-6.1-sol"), spent(id, { input: 272000 }), spent(id, { input: 272000 }), spent(id, { input: 272001, window: 2000000 })])).draw);
  // $0.544 + $0.544 + 272,001 × $4 a million = $2.176.
  expect(seen).toContain("$2.18");
});

test("a session on several models counts each at its own price, and one with no price makes it all no price", async () => {
  const id = uuid(1);
  const seen = await card((await codexRow(id, [turn("gpt-6.1-sol"), spent(id, { input: 100000 }), turn("gpt-5.6-sol"), spent(id, { input: 100000 })])).draw);
  expect(seen).toContain("$0.60");
  expect(seen).toContain("GPT-5.6 Sol");
  rmSync(rollout(id));
  state.totals = {};
  const { draw } = await codexRow(id, [turn("gpt-6.1-sol"), spent(id, { input: 100000 }), turn("gpt-6.1-sol-2027-01-01"), spent(id, { input: 100, output: 7 })]);
  const none = await card(draw);
  expect(none).toContain("no price");
  expect(none.join(" ")).not.toContain("$");
  expect(none).toContain("in 100k · out 7 · cached 0");
});

test("Fast has its own prices, default doesn't change them, and any other tier reads no price", async () => {
  const id = uuid(1);
  const used = { input: 100000, output: 10000 };
  const cost = async (lines: string[]) => {
    state.totals = {};
    const seen = await card((await codexRow(id, [...lines, spent(id, used)])).draw);
    rmSync(rollout(id));
    return seen;
  };
  expect(await cost([turn(), tier("default")])).toContain("$0.30");
  expect(await cost([turn(), tier("fast")])).toContain("$0.60");
  expect(await cost([turn(), tier("priority")])).toContain("$0.60");
  expect(await cost([turn(), tier("flex")])).toContain("no price");
  expect(await cost([turn("gpt-5.5"), tier("fast")])).toContain("$2.00");
  state.totals = {};
  const big = await card((await codexRow(id, [turn("gpt-5.5"), tier("fast"), spent(id, { input: 300000, window: 2000000 })])).draw);
  expect(big).toContain("no price");
});

test("Fast counts from when it was turned on", async () => {
  const id = uuid(1);
  const seen = await card((await codexRow(id, [turn(), spent(id, { input: 100000 }), tier("fast"), spent(id, { input: 100000 }), tier("default"), spent(id, { input: 100000 })])).draw);
  // $0.20 + $0.40 + $0.20.
  expect(seen).toContain("$0.80");
});

test("cache writes read no price: Codex gives one figure and the page prices two kinds", async () => {
  const id = uuid(1);
  const seen = await card((await codexRow(id, [turn(), spent(id, { input: 100000, write: 5000 })])).draw);
  expect(seen).toContain("no price");
});

test("a repeated token record counts once", async () => {
  const id = uuid(1);
  const last = usageOf({ input: 1000000 });
  const line = tokenCount(last, last, 2000000);
  expect(await card((await codexRow(id, [turn(), line, line, tokenCount(last, last, 2000000)])).draw)).toContain("$4.00");
});

test("a token record with nothing in it changes nothing", async () => {
  const id = uuid(1);
  const empty = envelope("event_msg", { type: "token_count", info: null, rate_limits: {} });
  const { draw } = await codexRow(id, [turn(), spent(id, { input: 73600 }), empty]);
  expect(rowPercents(draw, "t1")).toEqual(["25%"]);
  expect(await card(draw)).toContain("$0.15");
});

test("a running total that falls back to zero mid-session loses no cost, as happens on real files", async () => {
  const id = uuid(1);
  const a = usageOf({ input: 1000000 }), b = usageOf({ input: 73600 });
  const seen = await card((await codexRow(id, [turn(), tokenCount(a, a, 2000000), tokenCount(b, b, 258400)])).draw);
  // $4 for the first at the long price, $0.1472 for the second.
  expect(seen).toContain("$4.15");
  expect(seen).toContain("25%");
});

test("what a tool printed about tokens is never read as a record", async () => {
  const id = uuid(1);
  const talk = noise(`said "type":"token_count" and "type":"turn_context" ${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 900000 } } } })}`);
  const { draw } = await codexRow(id, [turn(), spent(id, { input: 73600 }), talk]);
  expect(rowPercents(draw, "t1")).toEqual(["25%"]);
});

test("a new session in the terminal starts over, for /clear, /new and /fork alike", async () => {
  const one = uuid(1), two = uuid(2);
  const { draw } = await codexRow(one, [turn(), spent(one, { input: 135200, output: 100 })]);
  expect(rowPercents(draw, "t1")).toEqual(["50%"]);
  codexWrites(two, [metaOf(two), turn(), spent(two, { input: 73600, output: 5 })]);
  state.terminals = [aCodex("t1", { labels: labelled(two) })];
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["25%"]);
  expect(await card(draw)).toContain("in 73.6k · out 5 · cached 0");
});

test("the new session's file may not be there yet when its label lands", async () => {
  const one = uuid(1), two = uuid(2);
  const { draw } = await codexRow(one, [turn(), spent(one, { input: 135200 })]);
  state.terminals = [aCodex("t1", { labels: labelled(two) })];
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual([]);
  clicks(byId(draw(), "logo-t1")!);
  expect(words((await dropdown()).draw())).toEqual(["No usage yet"]);
});

test("/compact lowers context with Codex's next record, and tokens and cost carry on", async () => {
  const id = uuid(1);
  const { draw } = await codexRow(id, [metaOf(id), turn(), spent(id, { input: 135200, output: 50 }), envelope("compacted", { message: "made up", replacement_history: [] })]);
  expect(rowPercents(draw, "t1")).toEqual(["50%"]);
  codexWrites(id, [turn(), spent(id, { input: 20000, output: 25 })]);
  changed(rollout(id));
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["3%"]);
  expect(await card(draw)).toContain("in 155k · out 75 · cached 0");
});

test("compacting drops context at once: Codex writes the new size with no new usage, and it costs nothing", async () => {
  const id = uuid(1);
  const { draw } = await codexRow(id, [metaOf(id), turn(), spent(id, { input: 135200, output: 50 })]);
  const total = { ...state.totals[id] };
  codexWrites(id, [envelope("compacted", { message: "made up", replacement_history: [] }), tokenCount(total, { ...usageOf({}), total_tokens: 73600 }, 258400)]);
  changed(rollout(id));
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["25%"]);
  const seen = await card(draw);
  expect(seen).toContain("in 135k · out 50 · cached 0");
  expect(seen).toContain("$0.27");
});

test("a resumed session keeps its numbers in the same file, also after Zaki restarts", async () => {
  const id = uuid(1);
  const { draw } = await codexRow(id, [metaOf(id), turn(), spent(id, { input: 1000000, window: 2000000 })]);
  codexWrites(id, [turn(), spent(id, { input: 500000, window: 2000000 })]);
  changed(rollout(id));
  await ticks();
  expect(await card(draw)).toContain("$6.00");
  const restarted = await open();
  await ticks();
  expect(await card(restarted.draw)).toContain("$6.00");
});

const helperFirst = (id: string, parent: string, more: any = {}) => metaOf(id, { forked_from_id: parent, parent_thread_id: parent, source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: "/root/made_up" } } }, ...more });

test("a helper is found through its parent, on any day, and counts in cost and tokens but not context", async () => {
  const one = uuid(1), kid = uuid(2);
  codexWrites(kid, [helperFirst(kid, one), metaOf(one), turn("gpt-5.6-luna"), spent(kid, { input: 200000, output: 1000 })], "02");
  const { draw } = await codexRow(one, [metaOf(one), turn(), started(kid), spent(one, { input: 73600, output: 10 })]);
  expect(rowPercents(draw, "t1")).toEqual(["25%"]);
  const seen = await card(draw);
  expect(seen).toContain("73.6k / 258k");
  expect(seen).toContain("GPT-6.1 Sol");
  expect(seen).toContain("in 274k · out 1k · cached 0");
  // $0.1472 + $0.0001 for the agent, $0.04 + $0.0012 at Luna's prices for its helper.
  expect(seen).toContain("$0.19");
});

test("a helper's helpers count too, however deep, and in one read", async () => {
  const one = uuid(1), kid = uuid(2), grandkid = uuid(3);
  codexWrites(grandkid, [helperFirst(grandkid, kid), turn(), spent(grandkid, { input: 1000000, window: 2000000 })]);
  codexWrites(kid, [helperFirst(kid, one), turn(), started(grandkid), spent(kid, { input: 1000000, window: 2000000 })]);
  const { draw } = await codexRow(one, [turn(), started(kid), spent(one, { input: 1000000, window: 2000000 })]);
  expect(known(draw)).toContain("$12.00");
});

test("activity that names the agent itself, or names a helper many times, counts nothing twice", async () => {
  const one = uuid(1), kid = uuid(2);
  codexWrites(kid, [helperFirst(kid, one), turn(), started(one, "interacted"), spent(kid, { input: 1000000, window: 2000000 })]);
  const { draw } = await codexRow(one, [turn(), started(kid), started(kid, "interacted"), started(kid, "completed"), spent(one, { input: 1000000, window: 2000000 })]);
  expect(await card(draw)).toContain("$8.00");
});

test("a helper's tier and model are its own, and don't leak into its parent's next record", async () => {
  const one = uuid(1), kid = uuid(2);
  codexWrites(kid, [helperFirst(kid, one), turn("gpt-5.6-sol"), tier("fast"), spent(kid, { input: 100000 })]);
  const { draw } = await codexRow(one, [turn(), started(kid), spent(one, { input: 100000 })]);
  expect(known(draw)).toContain("$1.00");
  codexWrites(one, [spent(one, { input: 100000 })]);
  changed(rollout(one));
  await ticks();
  // $0.20 + $0.80 and a further $0.20 at GPT-6.1 Sol, not Fast GPT-5.6 Sol's $0.80.
  expect(known(draw)).toContain("$1.20");
  expect(known(draw)).toContain("GPT-6.1 Sol");
});

test("a helper with no price makes the session no price", async () => {
  const one = uuid(1), kid = uuid(2);
  codexWrites(kid, [helperFirst(kid, one), turn("gpt-9"), spent(kid, { input: 5 })]);
  const seen = await card((await codexRow(one, [turn(), started(kid), spent(one, { input: 100000 })])).draw);
  expect(seen).toContain("no price");
  expect(seen).toContain("in 100k · out 0 · cached 0");
});

test("a helper that starts later and grows wakes its parent's row, and only what changed is read", async () => {
  const one = uuid(1), kid = uuid(2), still = uuid(3);
  codexWrites(still, [helperFirst(still, one), turn(), spent(still, { input: 1000000, window: 2000000 })]);
  const { draw } = await codexRow(one, [turn(), started(still), spent(one, { input: 1000000, window: 2000000 })]);
  expect(known(draw)).toContain("$8.00");

  codexWrites(kid, [helperFirst(kid, one), turn(), spent(kid, { input: 1000000, window: 2000000 })]);
  codexWrites(one, [started(kid)]);
  changed(rollout(one));
  await ticks();
  expect(known(draw)).toContain("$12.00");

  const before = realReads();
  codexWrites(kid, [spent(kid, { input: 500000, window: 2000000 })]);
  changed(rollout(kid));
  await ticks();
  expect(known(draw)).toContain("$14.00");
  // The session itself and that one helper.
  expect(realReads()).toBe(before + 2);
});

test("a helper whose file can't be found yet is looked for again", async () => {
  const one = uuid(1), kid = uuid(2);
  const { draw } = await codexRow(one, [turn(), started(kid), spent(one, { input: 1000000, window: 2000000 })]);
  expect(known(draw)).toContain("$4.00");
  codexWrites(kid, [helperFirst(kid, one), turn(), spent(kid, { input: 1000000, window: 2000000 })]);
  codexWrites(one, [noise()]);
  changed(rollout(one));
  await ticks();
  expect(known(draw)).toContain("$8.00");
});

test("a session with no helpers looks for none", async () => {
  const id = uuid(1);
  await codexRow(id, [turn(), spent(id, { input: 100000 })]);
  expect(state.execs.filter(([cmd, , script]: string[]) => cmd !== "sh" || !script.includes("dd if="))).toEqual([]);
});

// Setting up. All of it stays in the scratch home: the fake writer refuses anything else.
const hooksPath = () => join(home, ".codex", "hooks.json");
const scriptPath = () => join(home, ".zaki", "codex-session.sh");
const hookCommand = () => `sh '${scriptPath()}'`;
const hooksFile = (text: string) => {
  mkdirSync(dirname(hooksPath()), { recursive: true });
  writeFileSync(hooksPath(), text);
};
const sessionStart = () => JSON.parse(readFileSync(hooksPath(), "utf8")).hooks.SessionStart;
const ours = (group: any) => group.hooks.some((h: any) => h.command === hookCommand());
const seesCodex = async () => {
  await quietCodex();
  await settle();
};
const oldHook = { hooks: [{ command: "bash '/made/up/other-hook.sh' session", timeout: 10, type: "command" }] };

test("the hook goes in when Zaki first sees Codex, as a group of its own, with its script", async () => {
  await seesCodex();
  const groups = sessionStart();
  expect(groups).toHaveLength(1);
  expect(groups[0].matcher).toBeUndefined();
  expect(groups[0].hooks).toHaveLength(1);
  expect(groups[0].hooks[0]).toMatchObject({ type: "command", command: hookCommand(), timeout: 10 });
  expect(groups[0].hooks[0].commandWindows).toContain(".zaki/codex-session.ps1");
  expect(existsSync(scriptPath())).toBe(true);
  expect(state.shared["agents.setup"]).toEqual({ codex: 1 });
});

test("with no Codex in sight nothing is set up", async () => {
  await one([said({ id: "m1", read: 100000 })]);
  expect(existsSync(hooksPath())).toBe(false);
  expect(state.written).toEqual([]);
  expect(state.shared["agents.setup"]).toBeUndefined();
});

test("a Codex on another machine sets up nothing here", async () => {
  const term = aCodex("vps/t1");
  state.terminals = [term];
  state.agents = [listed(term)];
  await open();
  await ticks();
  expect(state.written).toEqual([]);
});

test("an empty hook file, or one that's only an empty object, takes the hook", async () => {
  for (const text of ["", "  \n", "{}", '{"hooks":{}}', '{"hooks":{"SessionStart":[]}}']) {
    hooksFile(text);
    state.shared = {};
    await seesCodex();
    expect(sessionStart().filter(ours)).toHaveLength(1);
    expect(sessionStart()).toHaveLength(1);
  }
});

test("other hooks stay exactly as they were, in their places", async () => {
  const file = {
    version: 3,
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }],
      SessionStart: [oldHook, { matcher: "resume", hooks: [{ type: "command", command: "second", statusMessage: "made up" }] }],
      Stop: [{ hooks: [{ type: "command", command: "bye" }] }],
    },
    custom: { kept: true },
  };
  hooksFile(JSON.stringify(file));
  await seesCodex();
  const after = JSON.parse(readFileSync(hooksPath(), "utf8"));
  expect(after.hooks.SessionStart.slice(0, 2)).toEqual(file.hooks.SessionStart);
  expect(ours(after.hooks.SessionStart[2])).toBe(true);
  expect(after.hooks.SessionStart).toHaveLength(3);
  expect({ ...after, hooks: { ...after.hooks, SessionStart: null } }).toEqual({ ...file, hooks: { ...file.hooks, SessionStart: null } });
  expect(Object.keys(after.hooks)).toEqual(["PreToolUse", "SessionStart", "Stop"]);
});

test("a second run changes nothing", async () => {
  hooksFile(JSON.stringify({ hooks: { SessionStart: [oldHook] } }));
  await seesCodex();
  const before = readFileSync(hooksPath(), "utf8");
  const script = readFileSync(scriptPath(), "utf8");
  state.written = [];
  state.shared = {};
  await seesCodex();
  expect(state.written).toEqual([]);
  expect(readFileSync(hooksPath(), "utf8")).toBe(before);
  expect(readFileSync(scriptPath(), "utf8")).toBe(script);
  expect(state.shared["agents.setup"]).toEqual({ codex: 1 });
});

test("once set up, nothing is even read again, so a hook the person removed stays removed", async () => {
  await seesCodex();
  hooksFile("{}");
  state.reads = [];
  state.written = [];
  await seesCodex();
  expect(state.reads).toEqual([]);
  expect(readFileSync(hooksPath(), "utf8")).toBe("{}");
});

test("a new version of the setup runs again, and a changed script leaves the hook alone, so nothing asks for approval", async () => {
  hooksFile(JSON.stringify({ hooks: { SessionStart: [oldHook] } }));
  await seesCodex();
  const hooks = readFileSync(hooksPath(), "utf8");
  const script = readFileSync(scriptPath(), "utf8");
  writeFileSync(scriptPath(), "# an older script\n");
  state.written = [];
  state.shared = { "agents.setup": { codex: 0 } };
  await seesCodex();
  expect(readFileSync(scriptPath(), "utf8")).toBe(script);
  expect(readFileSync(hooksPath(), "utf8")).toBe(hooks);
  expect(state.written).toEqual([scriptPath()]);
});

test("a hook file that isn't valid is left alone, setup waits, and the row stays a dash", async () => {
  for (const text of ["{ not json", "[]", "3", "null", '{"hooks":[]}', '{"hooks":{"SessionStart":{}}}']) {
    hooksFile(text);
    state.shared = {};
    state.written = [];
    const { draw } = await quietCodex();
    await works();
    expect(readFileSync(hooksPath(), "utf8")).toBe(text);
    expect(state.written.filter((path: string) => path === hooksPath())).toEqual([]);
    expect(state.shared["agents.setup"]).toBeUndefined();
    expect(shows(draw, "t1")).toContain("–");
  }
});

test("a hook file put right is picked up on a later try, without a restart", async () => {
  const start = Date.now();
  hooksFile("{ not json");
  await seesCodex();
  await ticks();
  hooksFile("{}");
  await ticks();
  expect(readFileSync(hooksPath(), "utf8")).toBe("{}");
  setSystemTime(new Date(start + 11 * 60000));
  await ticks();
  await settle();
  setSystemTime();
  expect(sessionStart().filter(ours)).toHaveLength(1);
});

test("a write that fails isn't taken for done", async () => {
  state.brokenWrites = true;
  await seesCodex();
  expect(state.shared["agents.setup"]).toBeUndefined();
  expect(existsSync(hooksPath())).toBe(false);
});

test("a dropdown never sets anything up", async () => {
  const { draw } = await quietCodex();
  await settle();
  clicks(byId(draw(), "logo-t1")!);
  state.written = [];
  state.shared = {};
  await dropdown();
  expect(state.written).toEqual([]);
  expect(state.shared).toEqual({});
});

test("Zaki never writes Codex's approval record, and doesn't even read it", async () => {
  const config = `[hooks.state."${hooksPath()}:session_start:0:0"]\ntrusted_hash = "made-up"\n`;
  hooksFile(JSON.stringify({ hooks: { SessionStart: [oldHook] } }));
  writeFileSync(join(home, ".codex", "config.toml"), config);
  await seesCodex();
  expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(config);
  expect(state.written.sort()).toEqual([hooksPath(), scriptPath(), scriptPath().replace(/\.sh$/, ".ps1")].sort());
  expect(state.reads.filter((path: string) => path.endsWith("config.toml"))).toEqual([]);
  for (const file of ["main.js", "sessions.js", "codex.js", "dropdown.js"]) {
    expect(readFileSync(new URL(`../defaults/mods/agents/${file}`, import.meta.url), "utf8")).not.toMatch(/trusted_hash|hooks\.state|config\.toml|hook-trust/);
  }
});

test("a home with a quote in its name still gets a command the shell can run", async () => {
  const odd = join(home, "o'neil");
  state.home = odd;
  mkdirSync(odd, { recursive: true });
  await seesCodex();
  state.home = undefined;
  const command = JSON.parse(readFileSync(join(odd, ".codex", "hooks.json"), "utf8")).hooks.SessionStart[0].hooks[0].command;
  expect(Bun.spawnSync(["sh", "-c", command], { env: { PATH: "/usr/bin:/bin" } }).exitCode).toBe(0);
  rmSync(odd, { recursive: true, force: true });
});

// The script itself, as Codex runs it: real `sh`, a fake `hc` that writes down what it was told.
const fakeHc = (folder: string, code = 0) => {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "hc");
  // Real hc answers on stdout, and whatever a hook prints goes to Codex's model.
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${join(home, "hc-said")}"\necho '{"address":"t7","labels":{}}'\nexit ${code}\n`);
  chmodSync(path, 0o755);
};
const hcSaid = () => (existsSync(join(home, "hc-said")) ? readFileSync(join(home, "hc-said"), "utf8").trim().split("\n") : null);
const payload = (more: any = {}) => JSON.stringify({ session_id: uuid(1), transcript_path: rollout(uuid(1)), cwd: "/work/project", hook_event_name: "SessionStart", model: "gpt-6.1-sol", permission_mode: "default", source: "startup", ...more });
const hook = (stdin: string, env: Record<string, string>) => Bun.spawnSync(["sh", "-lc", hookCommand()], { stdin: Buffer.from(stdin), env: { HOME: home, PATH: "/usr/bin:/bin", ...env } });
const bare = { HC_TERMINAL_ID: "t7" };
const onPath = (folder: string) => ({ ...bare, PATH: `${folder}:/usr/bin:/bin` });

const resetHc = () => {
  for (const path of [join(home, "hc-said"), join(home, "bin"), join(home, ".local")]) rmSync(path, { recursive: true, force: true });
};

test("the hook does nothing outside a Zaki terminal", async () => {
  await seesCodex();
  resetHc();
  fakeHc(join(home, "bin"));
  const r = hook(payload(), { PATH: `${join(home, "bin")}:/usr/bin:/bin` });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toBe("");
  expect(hcSaid()).toBeNull();
});

test("every way a session starts labels the terminal with its session file, and the hook says nothing to Codex", async () => {
  await seesCodex();
  for (const source of ["startup", "resume", "clear", "compact", "fork"]) {
    resetHc();
    fakeHc(join(home, "bin"));
    const r = hook(payload({ source }), onPath(join(home, "bin")));
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("");
    expect(r.stderr.toString()).toBe("");
    expect(hcSaid()).toEqual(["label", "t7", `zaki.session=${rollout(uuid(1))}`]);
  }
});

test("the label the hook sets is one the mod takes", async () => {
  await seesCodex();
  resetHc();
  fakeHc(join(home, "bin"));
  hook(payload(), onPath(join(home, "bin")));
  const label = hcSaid()![2].slice("zaki.session=".length);
  rmSync(join(home, "hc-said"));
  const id = uuid(1);
  const { draw } = await quietCodex();
  codexWrites(id, [turn(), spent(id, { input: 73600 })]);
  await works({ labels: { "zaki.session": label } });
  expect(rowPercents(draw, "t1")).toEqual(["25%"]);
});

test("a home with spaces stays whole in the label", async () => {
  await seesCodex();
  resetHc();
  fakeHc(join(home, "bin"));
  const path = join(home, "first last", ".codex", "sessions", "2026", "11", "01", `rollout-x-${uuid(1)}.jsonl`);
  hook(payload({ transcript_path: path }), onPath(join(home, "bin")));
  expect(hcSaid()).toEqual(["label", "t7", `zaki.session=${path}`]);
});

test("no transcript, or a payload the hook can't read, labels nothing and fails nothing", async () => {
  await seesCodex();
  resetHc();
  fakeHc(join(home, "bin"));
  for (const stdin of [payload({ transcript_path: null }), "", "not json at all"]) {
    const r = hook(stdin, onPath(join(home, "bin")));
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("");
    expect(hcSaid()).toBeNull();
  }
});

// The script's usual folders include fixed ones. A machine with a real hc in one could reach a real
// core from these, so they don't run there.
const systemHc = ["/opt/homebrew/bin/hc", "/usr/local/bin/hc", "/run/current-system/sw/bin/hc"].some((path) => existsSync(path));

test.skipIf(systemHc)("the hook finds hc where the app does when PATH doesn't have it, as after a Dock launch", async () => {
  await seesCodex();
  for (const folder of [".local/bin", ".local/share/mise/shims", ".nix-profile/bin", ".cargo/bin"]) {
    resetHc();
    rmSync(join(home, ".cargo"), { recursive: true, force: true });
    rmSync(join(home, ".nix-profile"), { recursive: true, force: true });
    fakeHc(join(home, folder));
    const r = hook(payload(), bare);
    expect(r.exitCode).toBe(0);
    expect(hcSaid()).toEqual(["label", "t7", `zaki.session=${rollout(uuid(1))}`]);
  }
  rmSync(join(home, ".cargo"), { recursive: true, force: true });
  rmSync(join(home, ".nix-profile"), { recursive: true, force: true });
});

test("PATH wins over the usual folders", async () => {
  await seesCodex();
  resetHc();
  const decoy = join(home, ".local", "bin", "hc");
  fakeHc(join(home, ".local", "bin"));
  writeFileSync(decoy, "#!/bin/sh\nexit 9\n");
  fakeHc(join(home, "bin"));
  expect(hook(payload(), onPath(join(home, "bin"))).exitCode).toBe(0);
  expect(hcSaid()).not.toBeNull();
});

test.skipIf(systemHc)("with hc nowhere, or failing, the hook still gets out of Codex's way", async () => {
  await seesCodex();
  resetHc();
  const gone = hook(payload(), bare);
  expect(gone.exitCode).toBe(0);
  expect(gone.stdout.toString()).toBe("");
  expect(gone.stderr.toString()).toBe("");
  fakeHc(join(home, "bin"), 1);
  const failed = hook(payload(), onPath(join(home, "bin")));
  expect(failed.exitCode).toBe(0);
  expect(failed.stdout.toString()).toBe("");
});

test("a terminal back at its shell loses its label, so the next Codex there can't show the last one's numbers", async () => {
  const id = uuid(1);
  const { draw } = await codexRow(id, [turn(), spent(id, { input: 73600 })]);
  expect(state.hc).toEqual([]);
  state.terminals = [aCodex("t1", { program: SHELL, labels: labelled(id) })];
  await ticks();
  expect(state.hc).toEqual([["label", "t1", "zaki.session="]]);

  state.hc = [];
  state.terminals = [aCodex("t1")];
  await ticks();
  expect(state.hc).toEqual([]);
  expect(rowPercents(draw, "t1")).toEqual([]);
  expect(shows(draw, "t1")).not.toContain("–");
});

test("hc failing to clear a label breaks nothing, and it's tried again", async () => {
  const id = uuid(1);
  state.brokenHc = true;
  await codexRow(id, [turn(), spent(id, { input: 73600 })]);
  state.terminals = [aCodex("t1", { program: SHELL, labels: labelled(id) }), aCodex("t2", { labels: labelled(uuid(2)) })];
  await ticks();
  await ticks();
  expect(state.hc.length).toBeGreaterThanOrEqual(2);
});

test("a new Codex in a terminal that held a working one starts as new, not waiting", async () => {
  const { draw } = await quietCodex();
  await works();
  expect(shows(draw, "t1")).toContain("–");
  state.terminals = [aCodex("t1", { program: SHELL })];
  await ticks();
  state.terminals = [aCodex("t1", { status: "idle" })];
  await ticks();
  expect(shows(draw, "t1")).not.toContain("–");
});

test("a 100 MB Codex session is read whole, past lines bigger than a window, and after that only what's new", async () => {
  const id = uuid(1), kid = uuid(2);
  const talk = noise(`she said "type":"token_count" ${"x".repeat(77000)}`);
  const compacted = envelope("compacted", { message: "y".repeat(17 * 1024 * 1024), replacement_history: [] });
  const chunks = [metaOf(id), turn("gpt-5.6-sol"), started(kid)];
  for (let i = 1; i <= 1100; i++) {
    chunks.push(spent(id, { input: i === 1100 ? 73600 : 1000, cached: 100, output: 5 }), talk);
    if (i === 550) chunks.push(compacted, turn("gpt-6.1-sol"));
  }
  codexWrites(id, chunks);
  codexWrites(kid, [helperFirst(kid, id), turn(), spent(kid, { input: 1000000, window: 2000000 })]);
  expect(statSync(rollout(id)).size).toBeGreaterThan(100000000);

  const { draw } = await codexRow(id, []);
  expect(rowPercents(draw, "t1")).toEqual(["25%"]);
  const seen = await card(draw);
  expect(seen).toContain("in 2.1M · out 5.5k · cached 110k");
  // 550 at GPT-5.6 Sol: 900 in, 100 cached, 5 out, $0.00374 each. 549 at GPT-6.1 Sol: $0.00186
  // each. The last at $0.14706, and the helper's 1M at the long $4: $7.2252.
  expect(seen).toContain("$7.23");
  expect(Math.max(...state.outputs)).toBeLessThanOrEqual(EXEC_OUTPUT);

  state.execs = [];
  state.outputs = [];
  codexWrites(id, [spent(id, { input: 135200, output: 5 })]);
  changed(rollout(id));
  await ticks();
  expect(rowPercents(draw, "t1")).toEqual(["50%"]);
  expect(Math.max(...state.outputs)).toBeLessThan(200000);
  rmSync(rollout(id));
}, 60000);

test("no network, no login, and Codex's own files only read: all a pass touches is the session", async () => {
  const net = spyOn(globalThis, "fetch");
  const id = uuid(1), kid = uuid(2);
  await seesCodex();
  codexWrites(kid, [helperFirst(kid, id), turn(), spent(kid, { input: 5 })]);
  const { draw } = await codexRow(id, [turn(), started(kid), spent(id, { input: 73600 })]);
  clicks(byId(draw(), "logo-t1")!);
  await dropdown();
  await ticks();
  expect(net).not.toHaveBeenCalled();
  net.mockRestore();
  expect([...new Set(state.execs.map(([cmd]: string[]) => cmd))].sort()).toEqual(["find", "sh"]);
  const touched = [...state.reads, ...state.execs.flat(), ...state.written].join("\n");
  expect(touched).not.toMatch(/auth\.json|credential|keychain|oauth|\.netrc|security|login/i);
});
