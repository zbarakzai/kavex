import { test, expect, mock, beforeEach, afterEach, setSystemTime } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The real footer button, popover, Settings row and checks, with only the outside world faked: what `exec`,
// `knownAgents` and `machines` answer, and what's in shared storage. All data here is made up.
//
// To teach it a new agent, add its commands to `state.says` (a piece of the command line, and what
// comes back) and its entry to `state.agents`, by machine ("" is this computer). `state.answers`
// is the same for `fetch`, by address: anything unlisted fails, so no test reaches the network.
// `state.files` is what `readTextFile` finds; `state.reads` lists every path it was asked for.
type El = { calls: [string, any[]][]; kids: any[]; hover?: El };
function make(): any {
  const el: El = { calls: [], kids: [] };
  const self: any = new Proxy({}, {
    get: (_t, k: string) => {
      if (k === "el") return el;
      if (k === "when") return (on: unknown, f: (s: any) => any) => (on ? f(self) : self);
      if (k === "child" || k === "trigger" || k === "content") return (kid: any) => (el.kids.push(kid), self);
      if (k === "children") return (kids: any[]) => (el.kids.push(...kids), self);
      if (k === "hover") return (f: (s: any) => any) => { const sheet = make(); f(sheet); el.hover = sheet.el; return self; };
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
const handler = (e: El, name: string) => e.calls.find(([k]) => k === name)?.[1].at(-1);
const paths = (root: El) => all(root).map((e) => arg(e, "path")).filter(Boolean);
const icon = (path: string) => { const s = make(); s.el.calls.push(["path", [path]]); return s; };

type Reply = string | Error | { code?: number; stdout?: string; stderr?: string } | (() => Reply | Promise<Reply>) | Promise<Reply>;
let state: {
  says: Record<string, Reply>;
  agents: Record<string, any[] | Error>;
  machines: { name: string | null; layout: string }[];
  runs: { line: string; on: string | null }[];
  answers: Record<string, (() => Response | Error | Promise<Response | Error>) | Error>;
  fetched: { url: string; init?: RequestInit }[];
  files: Record<string, string>;
  reads: string[];
  shared: Record<string, any>;
  props: any;
  sidebar: number;
  agentsShown: number;
  space: any;
  overlays: any[];
  ran: string[];
  commands: string[];
  waiting: ((command: string) => void) | null;
};

// `solid` and its text are made for every theme by src/settings.rs, not written in the file.
const colors = { ...JSON.parse(readFileSync(new URL("../defaults/themes/zaki.json", import.meta.url), "utf8")).colors, solid: "#abcdef", solid_foreground: "#123456" };

async function exec(command: string, args: string[] = [], options: { on?: string | null } = {}) {
  const line = [command, ...args].join(" ");
  state.runs.push({ line, on: options.on ?? null });
  const piece = Object.keys(state.says).find((said) => line.includes(said));
  if (piece === undefined) throw new Error(`nothing fakes: ${line}`);
  let reply: Reply = state.says[piece];
  while (typeof reply === "function" || reply instanceof Promise) reply = await (typeof reply === "function" ? reply() : reply);
  if (reply instanceof Error) throw reply;
  return typeof reply === "string" ? { code: 0, stdout: reply, stderr: "" } : { code: 0, stdout: "", stderr: "", ...reply };
}

globalThis.fetch = (async (url: string, init?: RequestInit) => {
  state.fetched.push({ url: String(url), init });
  const reply = state.answers[String(url)];
  if (!reply) throw new Error(`nothing fakes: ${url}`);
  const answer = typeof reply === "function" ? await reply() : reply;
  if (answer instanceof Error) throw answer;
  return answer;
}) as typeof fetch;

mock.module("gpui-kit", () => ({ View: class {}, div: make, image: icon, svg: icon }));
const input = { on: () => {}, value: () => "", focus: () => {}, set_value: () => {}, set_selected_range: () => {} };
mock.module("gpui-base", () => ({ h_flex: make, v_flex: make, HoverCard: { new: make }, InputState: { new: () => input }, Input: { new: make } }));
mock.module("herdr", () => ({
  exec,
  knownAgents: async ({ on }: { on?: string | null } = {}) => {
    const list = state.agents[on ?? ""] ?? [];
    if (list instanceof Error) throw list;
    return list;
  },
  machines: () => state.machines,
  shared: (k: string) => state.shared[k] ?? null,
  setShared: (k: string, v: any) => { state.shared[k] = v === undefined ? v : JSON.parse(JSON.stringify(v)); },
  props: () => state.props,
  theme: () => colors,
  settings: () => ({ zoom: 1, font_family: "Geist Mono", font_size: 13, ui_font_family: "Geist", theme_dark: "zaki", theme_light: "paper" }),
  window: () => ({ platform: "macos" }),
  home: () => "/home/person",
  appHome: () => "/home/person/.config/zaki",
  readTextFile: async (path: string) => { state.reads.push(path); return state.files[path] ?? null; },
  writeTextFile: async () => {},
  hc: async () => ({ code: 0, stdout: '{"machines":[]}', stderr: "" }),
  themes: () => [],
  fonts: () => ["Geist"],
  telemetry: () => null,
  layouts: () => ["main"],
  playSound: () => {},
  closeOverlay: () => {},
  layout: () => ({ id: "root", children: [{ id: "sidebar", size: { px: state.sidebar } }] }),
  updates: () => ({ app: { ready: false, version: "0.4.0", updates: true }, core: { version: "0.1.15" }, checks: true }),
  agents: () => Array.from({ length: state.agentsShown }, () => ({})),
  spaces: () => (state.space ? [state.space] : []),
  openOverlay: (spec: any) => (state.overlays.push(spec), `overlay-${state.overlays.length}`),
  run: (name: string) => {
    state.ran.push(name);
    if (!name.startsWith("workspace-chrome.")) return;
    const command = name.slice("workspace-chrome.".length);
    if (state.waiting) { const answer = state.waiting; state.waiting = null; answer(command); } else state.commands.push(command);
  },
  nextCommand: () => new Promise<string>((resolve) => {
    if (state.commands.length) resolve(state.commands.shift()!);
    else state.waiting = resolve;
  }),
}));
const { default: WorkspaceChrome } = await import("../defaults/mods/workspace-chrome/main.js");
const { default: Usage } = await import("../defaults/mods/usage/main.js");
const { default: Settings } = await import("../defaults/frame/settings/main.js");

// A mod copy's context. Its timers run as `wait` moves the clock, and stop when the copy closes.
type Copy = { closed: boolean; notified: number; every: number[] };
let timers: { at: number; every?: number; run: (cx: any) => void; cx: any; copy: Copy }[] = [];
function copyContext() {
  const copy: Copy = { closed: false, notified: 0, every: [] };
  const start = (ms: number, run: (cx: any) => void, every?: number) => void timers.push({ at: Date.now() + ms, every, run, cx: context, copy });
  const context: any = {
    notify: () => { copy.notified += 1; },
    stop_propagation: () => {},
    spawn: (f: (cx: any) => unknown) => void f(context),
    timer: { every: (ms: number, run: (cx: any) => void) => { copy.every.push(ms); start(ms, run, ms); }, after: (ms: number, run: (cx: any) => void) => start(ms, run) },
  };
  return { copy, context };
}
const cx = copyContext().context;
const settle = () => Bun.sleep(0);

async function wait(ms: number) {
  const end = Date.now() + ms;
  for (;;) {
    const due = timers.filter((timer) => !timer.copy.closed && timer.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    setSystemTime(due.at);
    due.run(due.cx);
    if (due.every) due.at += due.every;
    else timers.splice(timers.indexOf(due), 1);
    await settle();
  }
  setSystemTime(end);
  await settle();
}

const NOW = Date.UTC(2026, 10, 1, 12, 0);
const WEEK = "Current week (all models): 12% used · resets Nov 6 at 7:59pm (UTC)";
const SONNET = "Current week (Sonnet only): 4% used · resets Nov 3 at 12:30pm (UTC)";
const SESSION = "Current session: 33% used · resets 3:30pm (UTC)";

const CLAUDE = { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: true, tile: null, color: null, shell: false, agent: true, run: ["claude"], installed: true };
const ACCOUNT = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "someone@example.test", orgId: "org-made-up", orgName: "Made Up Ltd" };
const usageAnswer = (...lines: string[]) => JSON.stringify({ type: "result", is_error: false, result: lines.join("\n") });

// Claude Code signed in with a subscription on this computer, reporting these lines.
function claude(...lines: string[]) {
  state.agents[""] = [CLAUDE];
  state.says["printenv PATH"] = "/made/up/bin:/usr/bin\n";
  state.says["claude auth status"] = JSON.stringify(ACCOUNT);
  state.says["claude -p /usage"] = usageAnswer(...lines);
}

const limits = (root: El) => all(root).filter((e) => String(arg(e, "id")).startsWith("limit-"));
const barOf = (limit: El) => all(limit).find((e) => String(arg(e, "id")).startsWith("bar-"))!;
const trackOf = (limit: El) => all(limit).find((e) => e.kids.some((kid) => mine(kid) === barOf(limit)))!;
const filled = (limit: El) => Math.round((arg(barOf(limit), "w") / arg(trackOf(limit), "w")) * 100);

function footer() {
  const view: any = new WorkspaceChrome(), { copy, context } = copyContext();
  state.props = { footer: true };
  view.init?.({}, context);
  return { copy, draw: () => { state.props = { footer: true }; return view.render(context).el as El; }, close: () => { copy.closed = true; } };
}

// A press closes an open popup first (`between`), then the click lands on what's under it.
const BUTTON = { x: 170, y: 690, width: 22, height: 22 };
function press(f: ReturnType<typeof footer>, id: string, between?: () => void) {
  const button = byId(f.draw(), id)!;
  handler(button, "on_mouse_down")({ bounds: BUTTON, position: { x: BUTTON.x + 4, y: BUTTON.y + 4 } }, cx);
  between?.();
  handler(button, "on_click")({}, cx);
}

// What the app does when an overlay opens: a new copy of its mod, with the spec's props.
function openPopover() {
  const spec = state.overlays.at(-1), own = { ...spec.props, overlay: `overlay-${state.overlays.length}` };
  const view: any = new Usage(), { copy, context } = copyContext();
  state.props = own;
  view.init(own, context);
  return {
    view,
    copy,
    draw: () => { state.props = own; return view.render(cx).el as El; },
    close: () => view.close(cx),
  };
}

// The popover as it looks with nothing more asked of it: checks made so far, none started.
function openedAfter() {
  state.overlays.push({ props: { from: "usage" } });
  return openPopover();
}

// Opened the way a person opens it, with the footer running: `settled` waits for the check.
async function opened(settled = true) {
  const f = footer();
  press(f, "usage");
  const popover = openPopover();
  if (settled) await settle();
  return { f, popover };
}

beforeEach(() => {
  setSystemTime(NOW);
  timers = [];
  state = {
    says: {},
    agents: {},
    machines: [{ name: null, layout: "ready" }],
    runs: [],
    answers: {},
    fetched: [],
    files: {},
    reads: [],
    shared: {},
    props: null,
    sidebar: 230,
    agentsShown: 2,
    space: null,
    overlays: [],
    ran: [],
    commands: [],
    waiting: null,
  };
});
afterEach(() => { setSystemTime(); });

test("the gauge sits beside Add machine and Settings, at the size of its neighbours", () => {
  const root = footer().draw();
  const ids = all(root).map((e) => arg(e, "id")).filter((id) => ["usage", "machine", "settings"].includes(id));
  expect(ids).toEqual(["usage", "machine", "settings"]);
  expect(paths(byId(root, "usage")!)).toEqual(["mods/workspace-chrome/icons/gauge.svg"]);
  const glyph = all(byId(root, "usage")!).find((e) => arg(e, "path"))!;
  expect(arg(glyph, "size")).toBe(16);
  expect(arg(byId(root, "usage")!, "size")).toBe(arg(byId(root, "machine")!, "size"));
  expect(words(root)).toContain("Usage limits");
});

test("the collapsed rail stays Settings only", () => {
  state.sidebar = 76;
  const root = footer().draw();
  expect(byId(root, "settings")).toBeDefined();
  expect(byId(root, "usage")).toBeUndefined();
});

test("a press on the gauge opens the popover beside the footer's buttons, where it can't cover them", () => {
  const f = footer();
  press(f, "usage");
  expect(state.overlays).toEqual([{ mod: "usage", kind: "popup", width: 340, height: 480, at: { x: BUTTON.x + 72, y: BUTTON.y }, props: { from: "usage" } }]);
});

test("a second press on the gauge only closes the popover", () => {
  const f = footer();
  press(f, "usage");
  const popover = openPopover();
  press(f, "usage", () => popover.close());
  expect(state.overlays.length).toBe(1);

  setSystemTime(NOW + 5000);
  press(f, "usage");
  expect(state.overlays.length).toBe(2);
});

test("a Claude subscription shows its logo, name and tier, and each limit's percent, bar and time", async () => {
  claude(WEEK);
  const { popover } = await opened();
  const root = popover.draw();
  expect(paths(root)).toContain("icons/claude.svg");
  expect(words(root)).toEqual(expect.arrayContaining(["Claude Code", "Max"]));
  const [week] = limits(root);
  expect(words(week)).toEqual(["This week", "12%", "resets in 5d 7h"]);
  expect(filled(week)).toBe(12);
});

test("weekly limits come first, then model limits, then the 5-hour limit", async () => {
  claude(SESSION, SONNET, WEEK);
  const { popover } = await opened();
  expect(limits(popover.draw()).map((limit) => words(limit))).toEqual([
    ["This week", "12%", "resets in 5d 7h"],
    ["Sonnet", "4%", "resets in 2d 0h"],
    ["5 hours", "33%", "resets in 3h 30m"],
  ]);
});

const checks = () => state.runs.filter((run) => run.line.includes("claude -p /usage")).length;
const refresh = (popover: { draw: () => El }) => handler(byId(popover.draw(), "usage-refresh")!, "on_click")({}, cx);
function held() {
  let release!: (reply: Reply) => void;
  const answer = new Promise<Reply>((resolve) => { release = resolve; });
  return { answer, release };
}
const ANSWER = usageAnswer(WEEK);

test("opening again within a minute reuses the last result, and after that checks", async () => {
  claude(WEEK);
  const { f, popover } = await opened();
  expect(checks()).toBe(1);
  popover.close();

  setSystemTime(NOW + 59_000);
  press(f, "usage");
  openPopover();
  await settle();
  expect(checks()).toBe(1);

  setSystemTime(NOW + 60_000);
  press(f, "usage");
  openPopover();
  await settle();
  expect(checks()).toBe(2);
});

test("the refresh button checks at once, and shows the new numbers", async () => {
  claude(WEEK);
  const { popover } = await opened();
  claude("Current week (all models): 40% used · resets Nov 6 at 7:59pm (UTC)");
  refresh(popover);
  await settle();
  expect(checks()).toBe(2);
  expect(words(limits(popover.draw())[0])).toContain("40%");
});

test("a check under way isn't started twice, by refresh or by opening", async () => {
  const usage = held();
  claude(WEEK);
  state.says["claude -p /usage"] = usage.answer;
  const { f, popover } = await opened();
  refresh(popover);
  await settle();
  press(f, "usage");
  openPopover();
  await settle();
  expect(checks()).toBe(1);
  usage.release(ANSWER);
});

test("while a check runs the window stays free and the line says so, then says how old the numbers are", async () => {
  const usage = held();
  claude(WEEK);
  state.says["claude -p /usage"] = usage.answer;
  const { popover } = await opened();
  expect(words(popover.draw())).toContain("Checking…");

  usage.release(ANSWER);
  await settle();
  expect(words(popover.draw())).toContain("Updated just now");
  expect(words(popover.draw())).not.toContain("Checking…");

  setSystemTime(NOW + 3 * 60_000);
  expect(words(popover.draw())).toContain("Updated 3m ago");
});

test("closing the popover midway leaves the check to finish, so its numbers still arrive", async () => {
  const usage = held();
  claude(WEEK);
  state.says["claude -p /usage"] = usage.answer;
  const { f, popover } = await opened();
  popover.close();
  usage.release(ANSWER);
  await settle();

  press(f, "usage");
  expect(limits(openPopover().draw()).length).toBe(1);
  await settle();
  expect(checks()).toBe(1);
});

test("the popover only asks: its tasks stop when it closes, so the footer runs the check", async () => {
  claude(WEEK);
  state.overlays.push({ props: { from: "usage" } });
  openPopover();
  await settle();
  expect(state.ran).toEqual(["workspace-chrome.check-usage"]);
  expect(state.runs).toEqual([]);
});

test("a check cut off by quitting doesn't block the next one", async () => {
  claude(WEEK);
  state.shared.usage = { startedAt: NOW - 60_000 };
  await opened();
  expect(checks()).toBe(1);
});

test("a check started under a minute ago still counts as running", async () => {
  claude(WEEK);
  state.shared.usage = { startedAt: NOW - 59_000 };
  const { popover } = await opened();
  expect(checks()).toBe(0);
  expect(words(popover.draw())).toContain("Checking…");
});

test("while open, the time left is redrawn every 30 seconds", async () => {
  claude(SESSION);
  const { popover } = await opened();
  expect(popover.copy.every).toEqual([30_000]);
  expect(words(limits(popover.draw())[0])).toContain("resets in 3h 30m");
  setSystemTime(NOW + 31 * 60_000);
  expect(words(limits(popover.draw())[0])).toContain("resets in 2h 59m");
});

test("a limit past its reset time reads 0% and empties its bar before the next check", async () => {
  claude(SESSION);
  const { popover } = await opened();
  setSystemTime(NOW + 4 * 3600_000);
  const [limit] = limits(popover.draw());
  expect(words(limit)).toEqual(["5 hours", "0%"]);
  expect(filled(limit)).toBe(0);
});

test("bars slide to new numbers, and keep their place to do it", async () => {
  claude(WEEK);
  const { popover } = await opened();
  const bar = barOf(limits(popover.draw())[0]);
  expect(arg(bar, "transition")).toBe("width");
  claude("Current week (all models): 40% used · resets Nov 6 at 7:59pm (UTC)");
  refresh(popover);
  await settle();
  expect(arg(barOf(limits(popover.draw())[0]), "id")).toBe(arg(bar, "id"));
});

const NONE = "No subscriptions found";

for (const [why, answer] of [
  ["signed out", { code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }) }],
  ["using an API key", JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" })],
] as const) {
  test(`Claude ${why} gives no row, asks nothing more, and takes an older row with it`, async () => {
    claude(WEEK);
    const { popover } = await opened();
    expect(limits(popover.draw()).length).toBe(1);

    state.says["claude auth status"] = answer;
    state.runs.length = 0;
    refresh(popover);
    await settle();
    expect(checks()).toBe(0);
    expect(limits(popover.draw())).toEqual([]);
    expect(words(popover.draw())).not.toContain("Claude Code");
    expect(words(popover.draw())).toContain(NONE);
  });
}

test("Claude not installed gives no row and runs nothing of Claude's", async () => {
  claude(WEEK);
  state.agents[""] = [{ ...CLAUDE, installed: false }];
  const { popover } = await opened();
  expect(state.runs.some((run) => run.line.includes("claude"))).toBe(false);
  expect(words(popover.draw())).toContain(NONE);
});

test("with no agents at all the popover reads as a result, and the gauge stays", async () => {
  state.says["printenv PATH"] = "/made/up/bin\n";
  const { f, popover } = await opened();
  expect(words(popover.draw())).toContain(NONE);
  expect(words(popover.draw())).toContain("Updated just now");
  expect(byId(f.draw(), "usage")).toBeDefined();
});

test("before the first check ends, nothing claims there are no subscriptions", async () => {
  const auth = held();
  claude(WEEK);
  state.says["claude auth status"] = auth.answer;
  const { popover } = await opened();
  expect(words(popover.draw())).not.toContain(NONE);
  auth.release(JSON.stringify(ACCOUNT));
});

test("a failed check keeps the last numbers, saying how old they are, in the row and on the line", async () => {
  claude(WEEK);
  const { popover } = await opened();
  setSystemTime(NOW + 12 * 60_000);
  state.says["claude -p /usage"] = new Error("claude took longer than 30 s and was stopped");
  refresh(popover);
  await settle();
  const root = popover.draw();
  expect(words(limits(root)[0])).toContain("12%");
  expect(words(root)).toContain("Last checked 12m ago");
  expect(words(root)).toContain("Updated 12m ago");
  expect(words(root)).not.toContain("Could not check");
});

test("the next good check clears the note", async () => {
  claude(WEEK);
  const { popover } = await opened();
  state.says["claude -p /usage"] = new Error("no");
  setSystemTime(NOW + 2 * 60_000);
  refresh(popover);
  await settle();
  claude(WEEK);
  refresh(popover);
  await settle();
  expect(words(popover.draw()).filter((word) => word.startsWith("Last checked"))).toEqual([]);
});

for (const [why, usage] of [
  ["a failure", new Error("claude took longer than 30 s and was stopped")],
  ["text that isn't JSON", "Error: something went wrong"],
  ["no limit in the text", usageAnswer("You are on the Max plan.", "Current week: a lot")],
  ["a percent that isn't one", usageAnswer("Current week (all models): most% used · resets Nov 6 at 7:59pm (UTC)")],
  ["an empty answer", ""],
] as const) {
  test(`${why} with no earlier numbers reads "Could not check", with no numbers and no age`, async () => {
    claude(WEEK);
    state.says["claude -p /usage"] = usage;
    const { popover } = await opened();
    const root = popover.draw();
    expect(words(root)).toEqual(expect.arrayContaining(["Claude Code", "Could not check"]));
    expect(words(root)).not.toContain(NONE);
    expect(limits(root)).toEqual([]);
    expect(words(root).filter((word) => word.startsWith("Updated"))).toEqual([]);
  });
}

test("unreadable sign-in text is a failed check, not a signed-out one", async () => {
  claude(WEEK);
  const { popover } = await opened();
  state.says["claude auth status"] = "Something went wrong";
  refresh(popover);
  await settle();
  expect(words(limits(popover.draw())[0])).toContain("12%");
  expect(words(popover.draw())).toContain("Last checked just now");
});

test("unreadable lines are left out, and the ones that read stay", async () => {
  claude("Current week (all models): most% used", SONNET);
  const { popover } = await opened();
  expect(limits(popover.draw()).map((limit) => words(limit)[0])).toEqual(["Sonnet"]);
});

test("Claude's reset text: date and time, time only, the turn of the year, and none at all", async () => {
  setSystemTime(Date.UTC(2026, 11, 31, 20, 0));
  claude(
    "Current week (all models): 10% used · resets Jan 2 at 8:15pm (UTC)",
    "Current week (Sonnet only): 20% used · resets Dec 31 at 9pm (UTC)",
    "Current week (Opus only): 30% used",
    "Current session: 40% used · resets 7pm (UTC)",
  );
  const { popover } = await opened();
  expect(limits(popover.draw()).map((limit) => words(limit))).toEqual([
    ["This week", "10%", "resets in 2d 0h"],
    ["Sonnet", "20%", "resets in 1h 0m"],
    ["Opus", "30%"],
    ["5 hours", "40%", "resets in 23h 0m"],
  ]);
});

test("Claude is asked with no hooks, plugins, MCP or saved session, and in UTC", async () => {
  claude(WEEK);
  await opened();
  const asked = state.runs.find((run) => run.line.includes("claude -p /usage"))!.line;
  for (const flag of ["--output-format json", "--no-session-persistence", "--strict-mcp-config", "--setting-sources=", "TZ=UTC"]) expect(asked).toContain(flag);
  expect(state.runs.every((run) => /claude (auth status|-p \/usage)|printenv PATH/.test(run.line))).toBe(true);
});

test("Claude's commands run in the PATH of the person's own shell, as a Dock start has none of it", async () => {
  claude(WEEK);
  await opened();
  const asked = state.runs.filter((run) => /claude (auth status|-p)/.test(run.line));
  expect(asked.length).toBe(2);
  for (const run of asked) expect(run.line).toContain("/made/up/bin:/usr/bin");
});

test("no shell PATH to be had still checks, with the PATH Zaki has", async () => {
  claude(WEEK);
  state.says["printenv PATH"] = new Error("no shell");
  const { popover } = await opened();
  expect(limits(popover.draw()).length).toBe(1);
});

test("checking Claude sends no request of its own", async () => {
  claude(WEEK);
  await opened();
  expect(state.fetched).toEqual([]);
});

test("no login, email or organisation reaches shared storage", async () => {
  claude(WEEK, SONNET);
  await opened();
  const saved = JSON.stringify(state.shared);
  expect(saved).toContain("12");
  for (const secret of [ACCOUNT.email, ACCOUNT.orgId, ACCOUNT.orgName]) expect(saved).not.toContain(secret);
  expect(saved).not.toMatch(/email|org/i);
});

test("colors come from the theme, and the popover paints no background over its frame", async () => {
  expect(readFileSync(new URL("../defaults/mods/usage/main.js", import.meta.url), "utf8")).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  claude(WEEK);
  const { popover } = await opened();
  const root = popover.draw(), theirs = new Set(Object.values(colors));
  expect(arg(root, "bg")).toBeUndefined();
  for (const e of all(root)) for (const name of ["bg", "text_color"]) if (arg(e, name)) expect(theirs.has(arg(e, name))).toBe(true);
});

test("the list scrolls inside the popover's 480 px, keeping its header and line in view", async () => {
  claude(WEEK);
  const { popover } = await opened();
  const root = popover.draw(), list = byId(root, "usage-rows")!;
  expect(arg(root, "min_h")).toBe(0);
  expect(arg(list, "min_h")).toBe(0);
  expect(list.calls.some(([name]) => name === "overflow_y_scrollbar")).toBe(true);
  for (const part of root.kids.map(mine).filter((kid) => kid !== list)) expect(part!.calls.some(([name]) => name === "flex_none")).toBe(true);
});

test("a limit over 100% still fills its bar and no more", async () => {
  claude("Current week (all models): 104% used · resets Nov 6 at 7:59pm (UTC)");
  const { popover } = await opened();
  const [limit] = limits(popover.draw());
  expect(words(limit)).toContain("104%");
  expect(filled(limit)).toBe(100);
});

test("the line beside the buttons gives up the gauge's width", () => {
  state.agentsShown = 12;
  const letters = words(footer().draw()).filter((word) => word.length === 1).join("").replaceAll(" ", " ");
  // 25 letters fitted beside two buttons: 22 px more at 5.9 px a letter takes four.
  expect(letters).toBe("THIS COM… · 12 AGENTS");
});

test("the first background check starts 5 seconds after launch, with nothing opened", async () => {
  claude(WEEK);
  footer();
  await wait(4_999);
  expect(checks()).toBe(0);
  await wait(1);
  expect(checks()).toBe(1);
});

test("limits are checked every 15 minutes with the popover closed, and not sooner", async () => {
  claude(WEEK);
  const f = footer();
  await wait(5_000);
  press(f, "usage");
  await settle();
  const popover = openPopover();
  await settle();
  popover.close();
  popover.copy.closed = true;

  await wait(15 * 60_000 - 1);
  expect(checks()).toBe(1);
  await wait(60_000);
  expect(checks()).toBe(2);
  await wait(15 * 60_000);
  expect(checks()).toBe(3);
  await wait(15 * 60_000);
  expect(checks()).toBe(4);
});

test("two footers make one check, whichever notices first and however far apart they started", async () => {
  claude(WEEK);
  footer();
  await wait(7 * 60_000 + 11_000);
  footer();
  await wait(60 * 60_000);
  // At launch, then one for each 15 minutes.
  expect(checks()).toBe(1 + 4);
});

test("two footers that come due together still start one check", async () => {
  const usage = held();
  claude(WEEK);
  state.says["claude -p /usage"] = usage.answer;
  footer();
  footer();
  await wait(5_000);
  expect(checks()).toBe(1);
  usage.release(ANSWER);
});

test("when the footer that has been checking closes, the other carries on", async () => {
  claude(WEEK);
  const first = footer();
  await wait(5_000);
  const second = footer();
  await wait(5_000);
  expect(checks()).toBe(1);

  first.close();
  await wait(16 * 60_000);
  expect(checks()).toBe(2);
  expect(second.copy.closed).toBe(false);
});

test("a footer started over, by a layout switch or a reload, checks on as before", async () => {
  claude(WEEK);
  const first = footer();
  await wait(5_000);
  first.close();

  footer();
  await wait(5_000);
  expect(checks()).toBe(1);
  await wait(16 * 60_000);
  expect(checks()).toBe(2);
});

test("a footer cut off in the middle of a check doesn't stop the next footer checking", async () => {
  const usage = held();
  claude(WEEK);
  state.says["claude -p /usage"] = usage.answer;
  const first = footer();
  await wait(5_000);
  first.close();

  claude(WEEK);
  footer();
  await wait(60_000);
  expect(checks()).toBe(2);
  expect(words(openedAfter().draw())).toContain("Updated just now");
});

const AT = (percent: number) => `Current week (all models): ${percent}% used · resets Nov 6 at 7:59pm (UTC)`;
const dotOn = (root: El) => all(byId(root, "usage")!).find((e) => e.calls.some(([name]) => name === "rounded_full"));

test("the gauge has no dot at 89% used and the orange one at 90%, with nothing opened", async () => {
  claude(AT(89));
  const f = footer();
  await wait(5_000);
  expect(dotOn(f.draw())).toBeUndefined();

  claude(AT(90));
  await wait(16 * 60_000);
  const dot = dotOn(f.draw())!;
  expect(arg(dot, "bg")).toBe(colors.blocked);
});

test("any one limit at 90% is enough for the dot", async () => {
  claude(AT(12), "Current week (Sonnet only): 95% used · resets Nov 3 at 12:30pm (UTC)");
  const f = footer();
  await wait(5_000);
  expect(dotOn(f.draw())).toBeDefined();
});

test("a bar turns orange at 90%, and not at 89%", async () => {
  claude(AT(89), "Current week (Sonnet only): 90% used · resets Nov 3 at 12:30pm (UTC)");
  const { popover } = await opened();
  const [week, sonnet] = limits(popover.draw());
  expect(arg(barOf(week), "bg")).not.toBe(colors.blocked);
  expect(arg(barOf(sonnet), "bg")).toBe(colors.blocked);
});

test("the dot clears once its limit passes the reset time, before any new check", async () => {
  claude("Current session: 96% used · resets 3:30pm (UTC)");
  const f = footer();
  await wait(5_000);
  expect(dotOn(f.draw())).toBeDefined();
  state.says["claude -p /usage"] = new Error("no more checks");

  setSystemTime(NOW + 4 * 3600_000);
  expect(dotOn(f.draw())).toBeUndefined();
});

test("a bar past its reset time isn't orange", async () => {
  claude("Current session: 96% used · resets 3:30pm (UTC)");
  const { popover } = await opened();
  setSystemTime(NOW + 4 * 3600_000);
  expect(arg(barOf(limits(popover.draw())[0]), "bg")).not.toBe(colors.blocked);
});

test("the footer redraws by itself when a limit resets, and not for every look at the clock", async () => {
  claude("Current session: 96% used · resets 12:30pm (UTC)");
  const f = footer();
  await wait(5_000);
  state.says["claude -p /usage"] = new Error("no newer numbers");
  f.draw();
  await wait(5 * 60_000);
  expect(f.copy.notified).toBe(0);

  await wait(30 * 60_000);
  expect(f.copy.notified).toBe(1);
  expect(dotOn(f.draw())).toBeUndefined();
  await wait(5 * 60_000);
  expect(f.copy.notified).toBe(1);
});

function settingsPage() {
  state.shared.layout ??= "main";
  const view: any = new Settings();
  view.init({}, { ...cx, spawn: () => {}, focus_handle: () => ({ focus: () => {} }) });
  view.section = "look";
  view.machineList = [];
  return view.render(cx).el as El;
}
const flip = () => handler(byId(settingsPage(), "st-usage")!, "on_click")({}, cx);

test("Settings has a Usage limits row in its Workspace group, on until turned off", () => {
  const root = settingsPage();
  expect(words(root)).toContain("Usage limits");
  const card = all(root).filter((e) => byId(e, "st-tabs-On top") && byId(e, "st-usage")).at(-1)!;
  expect(arg(card, "bg")).toBe(colors.card);
  expect(arg(byId(root, "st-usage-knob")!, "left")).toBe(18);
  flip();
  expect(state.shared["usage.enabled"]).toBe(false);
  expect(arg(byId(settingsPage(), "st-usage-knob")!, "left")).toBe(2);
});

test("turned off, the gauge goes and the line takes back its room", () => {
  state.agentsShown = 12;
  flip();
  const f = footer(), root = f.draw();
  expect(byId(root, "usage")).toBeUndefined();
  expect(byId(root, "machine")).toBeDefined();
  expect(byId(root, "settings")).toBeDefined();
  const letters = words(root).filter((word) => word.length === 1).join("").replace(/\s/g, " ");
  expect(letters).toBe("THIS COMPUTER · 12 AGENTS");
});

test("turned off, nothing runs: not at launch, not on the timer, not when asked", async () => {
  claude(WEEK);
  flip();
  const f = footer(), popover = openedAfter();
  await settle();
  refresh(popover);
  await settle();
  await wait(2 * 3600_000);
  expect(state.runs).toEqual([]);
  expect(state.fetched).toEqual([]);
  expect(byId(f.draw(), "usage")).toBeUndefined();
});

test("turning it off clears the saved numbers and the OpenCode answer, and with them the dot", async () => {
  claude(AT(95));
  state.shared["usage.opencode"] = false;
  const f = footer();
  await wait(5_000);
  expect(dotOn(f.draw())).toBeDefined();

  flip();
  expect(state.shared.usage ?? null).toBeNull();
  expect(state.shared["usage.opencode"] ?? null).toBeNull();
  expect(byId(f.draw(), "usage")).toBeUndefined();
});

test("turning it back on shows the gauge and checks again, with no old numbers", async () => {
  claude(AT(95));
  const f = footer();
  await wait(5_000);
  flip();
  await wait(5 * 60_000);
  expect(checks()).toBe(1);

  claude(AT(20));
  flip();
  expect(byId(f.draw(), "usage")).toBeDefined();
  expect(dotOn(f.draw())).toBeUndefined();
  await wait(60_000);
  expect(checks()).toBe(2);
  expect(state.shared.usage.entries["claude|"].limits[0].used).toBe(20);
});

test("turning it back on asks OpenCode's question again", async () => {
  state.says["printenv PATH"] = "/made/up/bin\n";
  state.agents[""] = [{ ...CLAUDE, key: "opencode", name: "OpenCode", icon: "icons/opencode.svg" }];
  state.shared["usage.opencode"] = false;
  footer();
  await wait(5_000);
  expect(state.shared.usage.entries).toEqual({});

  flip();
  flip();
  await wait(60_000);
  expect(Object.values(state.shared.usage.entries).map((entry: any) => entry.ask)).toEqual([true]);
});

test("a check running when it's turned off saves nothing", async () => {
  const usage = held();
  claude(WEEK);
  state.says["claude -p /usage"] = usage.answer;
  footer();
  await wait(5_000);
  flip();
  usage.release(ANSWER);
  await settle();
  expect(state.shared.usage ?? null).toBeNull();
});

test("off alone is enough: a check running when anything sets it saves nothing", async () => {
  const usage = held();
  claude(WEEK);
  state.says["claude -p /usage"] = usage.answer;
  footer();
  await wait(5_000);
  state.shared["usage.enabled"] = false;
  const saved = JSON.stringify(state.shared.usage);
  usage.release(ANSWER);
  await settle();
  expect(JSON.stringify(state.shared.usage)).toBe(saved);
});

test("a check running through off and on again can't bring cleared numbers back", async () => {
  const usage = held();
  claude(WEEK);
  footer();
  await wait(5_000);
  claude(AT(95));
  state.says["claude -p /usage"] = usage.answer;
  await wait(16 * 60_000);
  flip();
  flip();
  usage.release(usageAnswer(AT(95)));
  await settle();
  expect(state.shared.usage ?? null).toBeNull();
});

test("nor can it overwrite what a new check found since, even in the same instant", async () => {
  const late = held();
  claude(WEEK);
  state.says["claude -p /usage"] = late.answer;
  footer();
  await wait(5_000);
  flip();
  flip();
  claude(AT(20));
  await wait(60_000);
  expect(state.shared.usage.entries["claude|"].limits[0].used).toBe(20);

  late.release(usageAnswer(AT(95)));
  await settle();
  expect(state.shared.usage.entries["claude|"].limits[0].used).toBe(20);
});

test("turned off midway, the check stops: what it had left to ask is never asked", async () => {
  const auth = held();
  claude(WEEK);
  state.says["claude auth status"] = auth.answer;
  footer();
  await wait(5_000);
  flip();
  auth.release(JSON.stringify(ACCOUNT));
  await settle();
  expect(checks()).toBe(0);
});

test("turned off before an agent is reached, none of its commands run", async () => {
  const shell = held();
  claude(WEEK);
  state.says["printenv PATH"] = shell.answer;
  footer();
  await wait(5_000);
  flip();
  shell.release("/made/up/bin\n");
  await settle();
  expect(state.runs.map((run) => run.line).filter((line) => line.includes("claude"))).toEqual([]);
});

test("a key already read isn't sent once it's turned off, even if it's turned back on", async () => {
  const keys = held();
  state.says["printenv PATH"] = "/made/up/bin\n";
  state.says["sqlite3"] = keys.answer;
  state.agents[""] = [{ ...CLAUDE, key: "opencode", name: "OpenCode", icon: "icons/opencode.svg" }];
  state.shared["usage.opencode"] = true;
  footer();
  await wait(5_000);
  flip();
  flip();
  await wait(60_000);
  keys.release(JSON.stringify({ type: "key", key: "made-up-key" }));
  await settle();
  expect(state.fetched).toEqual([]);
  expect(JSON.stringify(state.shared)).not.toContain("made-up-key");
});

test("a slow check still saves when a later one started beside it, so slow checks can't go on forever", async () => {
  const slow = held();
  claude(WEEK);
  state.says["claude -p /usage"] = slow.answer;
  footer();
  await wait(5_000);
  state.says["claude -p /usage"] = held().answer;
  await wait(2 * 60_000);
  expect(checks()).toBe(2);

  slow.release(ANSWER);
  await settle();
  expect(state.shared.usage.entries["claude|"].limits[0].used).toBe(12);
  await wait(10 * 60_000);
  expect(checks()).toBe(2);
});

test("one check finishing doesn't stop another that's running", async () => {
  const first = held(), second = held();
  claude(WEEK);
  state.says["claude auth status"] = first.answer;
  footer();
  await wait(5_000);
  state.says["claude auth status"] = second.answer;
  await wait(2 * 60_000);

  first.release(JSON.stringify({ loggedIn: false }));
  await settle();
  second.release(JSON.stringify(ACCOUNT));
  await settle();
  expect(checks()).toBe(1);
  expect(state.shared.usage.entries["claude|"].limits[0].used).toBe(12);
});

const OPENCODE = { ...CLAUDE, key: "opencode", name: "OpenCode", icon: "icons/opencode.svg", run: ["opencode"] };
const KEY = "made-up-go-key-0123456789";
const AUTH = "/home/person/.local/share/opencode/auth.json";
const GO = "https://opencode.ai/zen/go/v1/usage";
const ASKS = "Zaki reads your OpenCode key and sends it only to opencode.ai, to ask for your Go plan's limits.";

// OpenCode installed on this computer, with this auth file and no database to read.
function opencode(auth: unknown = { opencode: { type: "api", key: KEY } }) {
  state.agents[""] = [...(Array.isArray(state.agents[""]) ? state.agents[""] : []), OPENCODE];
  state.says["printenv PATH"] = "/made/up/bin:/usr/bin\n";
  state.says["sqlite3"] = new Error("no database");
  state.files[AUTH] = JSON.stringify(auth);
}

const keysRead = () => state.reads.length + state.runs.filter((run) => run.line.includes("sqlite3")).length;

test("with OpenCode installed and no answer yet, the popover asks, and nothing is read or sent", async () => {
  opencode();
  const { popover } = await opened();
  const root = popover.draw();
  expect(words(root)).toEqual(expect.arrayContaining(["OpenCode", ASKS, "Allow", "Not now"]));
  expect(paths(root)).toContain("icons/opencode.svg");
  expect(words(root)).not.toContain(NONE);
  expect(limits(root)).toEqual([]);
  expect(keysRead()).toBe(0);
  expect(state.fetched).toEqual([]);
});

test("OpenCode not installed never asks", async () => {
  opencode();
  state.agents[""] = [{ ...OPENCODE, installed: false }];
  const { popover } = await opened();
  expect(words(popover.draw())).not.toContain(ASKS);
  expect(words(popover.draw())).toContain(NONE);
});

const reply = (popover: { draw: () => El }, id: string) => handler(byId(popover.draw(), id)!, "on_click")({}, cx);
const NOT_NOW = "usage-not-now", ALLOW = "usage-allow";

const GO_SAYS = { usage: {
  rolling: { percent: 33, resetInSec: 3 * 3600 },
  monthly: { percent: 4.4, resetsAt: "2026-11-20T12:00:00Z" },
  weekly: { percent: 12, resetsAt: "2026-11-03T12:00:00Z" },
} };
const go = (body: unknown = GO_SAYS, status = 200) => () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

test("Not now hides the card at once and for good, and no key is read, then or later", async () => {
  opencode();
  const { popover } = await opened();
  reply(popover, NOT_NOW);
  expect(words(popover.draw())).not.toContain(ASKS);
  expect(words(popover.draw())).toContain(NONE);
  expect(state.shared["usage.opencode"]).toBe(false);

  await wait(60_000);
  refresh(popover);
  await settle();
  await wait(2 * 3600_000);
  expect(words(popover.draw())).not.toContain(ASKS);
  expect(Object.keys(state.shared.usage.entries)).toEqual([]);
  expect(keysRead()).toBe(0);
  expect(state.fetched).toEqual([]);
});

test("Allow shows Go's limits straight away, weekly first, with nothing else started", async () => {
  opencode();
  state.answers[GO] = go();
  const { popover } = await opened();
  reply(popover, ALLOW);
  await settle();
  const root = popover.draw();
  expect(state.shared["usage.opencode"]).toBe(true);
  expect(words(root)).not.toContain(ASKS);
  expect(words(root)).toEqual(expect.arrayContaining(["OpenCode", "Go"]));
  expect(limits(root).map((limit) => words(limit))).toEqual([
    ["This week", "12%", "resets in 2d 0h"],
    ["5 hours", "33%", "resets in 3h 0m"],
    ["This month", "4%", "resets in 19d 0h"],
  ]);
  expect(state.fetched.length).toBe(1);
  expect(words(root)).toContain("Updated just now");
});

// The card showing, and a later pass stopped at Claude's usage command.
async function allowDuringAPass() {
  claude(WEEK);
  opencode();
  state.answers[GO] = go();
  const { f, popover } = await opened();
  const usage = held();
  state.says["claude -p /usage"] = usage.answer;
  setSystemTime(NOW + 2 * 60_000);
  refresh(popover);
  await settle();
  expect(checks()).toBe(2);
  expect(words(popover.draw())).toContain(ASKS);
  return { f, popover, usage };
}
const opencodeRow = () => state.shared.usage.entries["opencode|"];
const heldGo = () => {
  const request = held();
  state.answers[GO] = () => request.answer as Promise<Response>;
  return request;
};

test("Allow checks at once during a running check, starting no agent again, and both keep their numbers", async () => {
  const { popover, usage } = await allowDuringAPass();
  reply(popover, ALLOW);
  await settle();
  expect(limits(popover.draw()).map((limit) => words(limit)[0])).toContain("This month");
  expect(words(popover.draw())).toContain("Checking…");
  expect(checks()).toBe(2);

  usage.release(usageAnswer(AT(50)));
  await settle();
  expect(limits(popover.draw()).map((limit) => words(limit).slice(0, 2))).toEqual(expect.arrayContaining([["This month", "4%"], ["This week", "50%"]]));
  expect(words(popover.draw())).not.toContain(ASKS);
  expect(state.fetched.length).toBe(1);
});

test("the running check finishing first leaves Allow's check to finish and save", async () => {
  const { popover, usage } = await allowDuringAPass();
  const request = heldGo();
  reply(popover, ALLOW);
  await settle();
  usage.release(usageAnswer(AT(50)));
  await settle();
  expect(state.shared.usage.entries["claude|"].limits[0].used).toBe(50);
  expect(words(popover.draw())).not.toContain(ASKS);
  expect(words(popover.draw())).not.toContain(NONE);

  request.release(go()());
  await settle();
  expect(state.shared.usage.entries["claude|"].limits[0].used).toBe(50);
  expect(opencodeRow().limits.length).toBe(3);
});

for (const [why, answerGo, row] of [
  ["a refused key", go({}, 401), undefined],
  ["no network", new Error("offline"), "Could not check"],
] as const) {
  test(`${why} from Allow's check stands when the running check ends after it`, async () => {
    const { popover, usage } = await allowDuringAPass();
    state.answers[GO] = answerGo;
    reply(popover, ALLOW);
    await settle();
    usage.release(usageAnswer(AT(50)));
    await settle();
    const root = popover.draw();
    expect(words(root)).not.toContain(ASKS);
    if (row) expect(words(root)).toEqual(expect.arrayContaining(["OpenCode", row]));
    else expect(words(root)).not.toContain("OpenCode");
  });
}

test("Not now during a running check stays answered when that check saves what it asked", async () => {
  const { popover, usage } = await allowDuringAPass();
  reply(popover, NOT_NOW);
  usage.release(ANSWER);
  await settle();
  expect(words(popover.draw())).not.toContain(ASKS);
  expect(words(popover.draw())).not.toContain("OpenCode");
  expect(keysRead()).toBe(0);
  setSystemTime(Date.now() + 60_000);
  refresh(popover);
  await settle();
  expect(opencodeRow()).toBeUndefined();
});

test("while Allow's check runs the line says so and the numbers can't be mistaken for none, then checks go on as before", async () => {
  opencode();
  const request = heldGo();
  const { popover } = await opened();
  reply(popover, ALLOW);
  await settle();
  const root = popover.draw();
  expect(words(root)).toContain("Checking…");
  expect(words(root)).not.toContain(NONE);

  request.release(go()());
  await settle();
  expect(words(popover.draw())).not.toContain("Checking…");
  setSystemTime(NOW + 1);
  state.runs.length = 0;
  refresh(popover);
  await settle();
  expect(state.runs.length).toBeGreaterThan(0);
});

test("a second footer told of the same Allow sends nothing more", async () => {
  opencode();
  state.answers[GO] = go();
  const { popover } = await opened();
  footer();
  await settle();
  reply(popover, ALLOW);
  state.commands.push("allow-opencode");
  await settle();
  expect(state.fetched.length).toBe(1);
});

test("Allow during a check that saves nothing when turned off: its own check saves nothing either", async () => {
  opencode();
  const request = heldGo();
  const { popover } = await opened();
  reply(popover, ALLOW);
  await settle();
  flip();
  request.release(go()());
  await settle();
  expect(state.shared.usage ?? null).toBeNull();
  expect(state.shared["usage.opencode"] ?? null).toBeNull();
});

test("nor can Allow's check bring its row back through off and on again", async () => {
  opencode();
  const request = heldGo();
  const { popover } = await opened();
  reply(popover, ALLOW);
  await settle();
  flip();
  flip();
  await wait(60_000);
  expect(opencodeRow().ask).toBe(true);
  request.release(go()());
  await settle();
  expect(opencodeRow().ask).toBe(true);
  expect(words(popover.draw())).toContain(ASKS);
});

const allowed = async () => {
  const opening = await opened();
  reply(opening.popover, ALLOW);
  await settle();
  return opening;
};
const bearers = () => state.fetched.map((sent) => (sent.init?.headers as Record<string, string>).Authorization);

test("keys come from OpenCode's auth file and its database's credential table, and nothing else is read", async () => {
  opencode({ "opencode-go": { type: "api", key: "made-up-file-key" }, anthropic: { type: "api", key: "made-up-other-key" } });
  state.says["sqlite3"] = `${JSON.stringify({ type: "key", key: "made-up-table-key" })}\n`;
  state.answers[GO] = go({}, 403);
  await allowed();
  expect(bearers()).toEqual(["Bearer made-up-table-key", "Bearer made-up-file-key"]);
  expect(state.reads).toEqual([AUTH]);
  const database = state.runs.filter((run) => run.line.includes("sqlite3"));
  expect(database.length).toBe(1);
  expect(database[0].line).toContain("-readonly /home/person/.local/share/opencode/opencode.db");
  expect(database[0].line).toContain("FROM credential");
  expect(state.runs.filter((run) => !/sqlite3|printenv PATH/.test(run.line))).toEqual([]);
});

for (const written of ["$OPENCODE_API_KEY", "${OPENCODE_API_KEY}", "$(cat key)", "!pass show opencode", " !pass show opencode", "`cat key`", "{env:OPENCODE_API_KEY}", "{file:~/key}", "%OPENCODE_API_KEY%", "two words", "line\nbreak", ""]) {
  test(`a key written as ${JSON.stringify(written)} is never sent, from the file or the table`, async () => {
    opencode({ opencode: { type: "api", key: written }, "opencode-go": written });
    state.says["sqlite3"] = `${JSON.stringify({ type: "key", key: written })}\n`;
    state.answers[GO] = go();
    const { popover } = await allowed();
    expect(state.fetched).toEqual([]);
    expect(words(popover.draw())).not.toContain("Could not check");
    expect(words(popover.draw())).not.toContain("OpenCode");
  });
}

test("the same key in both places is sent once", async () => {
  opencode();
  state.says["sqlite3"] = `${JSON.stringify({ type: "key", key: KEY })}\n`;
  state.answers[GO] = go({}, 401);
  await allowed();
  expect(bearers()).toEqual([`Bearer ${KEY}`]);
});

test("a login that isn't a key, such as a Console session, is left alone", async () => {
  opencode({ opencode: { type: "oauth", access: "made-up-access", refresh: "made-up-refresh", expires: 1 } });
  state.answers[GO] = go();
  await allowed();
  expect(state.fetched).toEqual([]);
});

test("the key goes to opencode.ai over https and nowhere else, as a Bearer header alone", async () => {
  opencode();
  state.answers[GO] = go();
  const { f, popover } = await allowed();
  await wait(16 * 60_000);
  refresh(popover);
  await settle();
  f.draw();
  expect(state.fetched.length).toBeGreaterThan(1);
  for (const { url, init } of state.fetched) {
    expect(new URL(url).origin).toBe("https://opencode.ai");
    expect(url).not.toContain(KEY);
    expect(init?.body).toBeUndefined();
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(Object.entries(headers).filter(([, value]) => value.includes(KEY)).length).toBe(1);
    expect(headers["User-Agent"]).toBe("zaki-usage/1.0");
  }
  expect(JSON.stringify(state.runs)).not.toContain(KEY);
});

for (const status of [401, 403]) {
  test(`a ${status} gives no row and no error`, async () => {
    opencode();
    state.answers[GO] = go({ error: "no" }, status);
    const { popover } = await allowed();
    const root = popover.draw();
    expect(words(root)).not.toContain("OpenCode");
    expect(words(root)).not.toContain("Could not check");
    expect(words(root)).toContain(NONE);
    expect(words(root)).not.toContain("Checking…");
  });

  test(`a ${status} later takes the older row with it`, async () => {
    opencode();
    state.answers[GO] = go();
    const { popover } = await allowed();
    expect(limits(popover.draw()).length).toBe(3);
    state.answers[GO] = go({}, status);
    refresh(popover);
    await settle();
    expect(limits(popover.draw())).toEqual([]);
    expect(words(popover.draw())).not.toContain("OpenCode");
  });
}

test("a key without a Go plan doesn't stop the next one being asked", async () => {
  opencode({ opencode: { type: "api", key: "made-up-zen-key" }, "opencode-go": { type: "api", key: KEY } });
  const answers = [go({}, 401), go()];
  state.answers[GO] = () => answers.shift()!();
  const { popover } = await allowed();
  expect(limits(popover.draw()).length).toBe(3);
});

test("a network failure keeps the last numbers with their age", async () => {
  opencode();
  state.answers[GO] = go();
  const { popover } = await allowed();
  setSystemTime(NOW + 12 * 60_000);
  state.answers[GO] = new Error("offline");
  refresh(popover);
  await settle();
  const root = popover.draw();
  expect(words(limits(root)[0])).toContain("12%");
  expect(words(root)).toContain("Last checked 12m ago");
  expect(words(root)).toContain("Updated 12m ago");
});

for (const [why, reply_] of [
  ["no network", new Error("offline")],
  ["a server error", go("nope", 500)],
  ["text that isn't JSON", go("<html>")],
  ["no limits in the answer", go({ plan: "go" })],
  ["a percent that isn't one", go({ usage: { weekly: { percent: "most" } } })],
  ["a null answer", go("null")],
] as const) {
  test(`${why} with no earlier numbers reads "Could not check"`, async () => {
    opencode();
    state.answers[GO] = reply_;
    const { popover } = await allowed();
    expect(words(popover.draw())).toEqual(expect.arrayContaining(["OpenCode", "Could not check"]));
    expect(limits(popover.draw())).toEqual([]);
    expect(words(popover.draw())).not.toContain(NONE);
  });
}

test("the second spelling of Go's answer and a rate-limited window read too", async () => {
  opencode();
  state.answers[GO] = go({ weeklyUsage: { usagePercent: 80, status: "rate-limited", resetInSec: 3600 } });
  const { popover } = await allowed();
  expect(limits(popover.draw()).map((limit) => words(limit))).toEqual([["This week", "100%", "resets in 1h 0m"]]);
});

test("Go at 90% lights the dot like any other limit", async () => {
  opencode();
  state.answers[GO] = go({ usage: { weekly: { percent: 91, resetInSec: 3600 } } });
  const { f } = await allowed();
  expect(dotOn(f.draw())).toBeDefined();
});

test("with the answer given, later checks ask opencode.ai by themselves, with no card", async () => {
  opencode();
  state.answers[GO] = go();
  state.shared["usage.opencode"] = true;
  const { popover } = await opened();
  expect(words(popover.draw())).not.toContain(ASKS);
  expect(limits(popover.draw()).length).toBe(3);
});

test("OpenCode is checked on this computer only: an added machine's is neither asked about nor read", async () => {
  for (const consent of [undefined, true]) {
    state.shared["usage.opencode"] = consent;
    state.shared.usage = undefined;
    state.machines = [{ name: null, layout: "ready" }, { name: "made-up-box", layout: "ready" }];
    state.agents = { "made-up-box": [OPENCODE] };
    state.says["printenv PATH"] = "/made/up/bin\n";
    state.answers[GO] = go();
    state.reads.length = 0;
    const f = footer();
    await wait(5_000);
    f.close();
    expect(Object.keys(state.shared.usage.entries)).toEqual([]);
    expect(state.reads).toEqual([]);
    expect(state.fetched).toEqual([]);
    expect(state.runs.filter((run) => run.line.includes("sqlite3"))).toEqual([]);
  }
});

for (const [why, reply_] of [
  ["good numbers", go()],
  ["an answer that repeats the key and an email", go({ ...GO_SAYS, key: KEY, email: "someone@example.test" })],
  ["a refused key", go({}, 401)],
  ["a failure that names the key", new Error(`could not send ${KEY}`)],
  ["a server error that names the key", go(KEY, 500)],
] as const) {
  test(`after ${why}, shared storage holds no key, nothing made from it and no email`, async () => {
    opencode();
    state.answers[GO] = reply_;
    await allowed();
    const saved = JSON.stringify(state.shared);
    expect(saved).not.toContain(KEY);
    expect(saved).not.toContain("someone@example.test");
    expect(saved).not.toMatch(/email/i);
    expect(saved).not.toContain(createHash("sha256").update(KEY).digest("hex").slice(0, 8));
    expect(opencodeRow()?.who).toBeUndefined();
  });
}

test("turned off while the key is being read, the rest of it is never read", async () => {
  const database = held();
  opencode();
  state.says["sqlite3"] = database.answer;
  state.answers[GO] = go();
  const { popover } = await opened();
  reply(popover, ALLOW);
  await settle();
  flip();
  database.release(new Error("no database"));
  await settle();
  expect(state.reads).not.toContain(AUTH);
  expect(state.fetched).toEqual([]);
});

test("off alone stops a key that's been read from being sent", async () => {
  const database = held();
  opencode();
  state.says["sqlite3"] = database.answer;
  state.answers[GO] = go();
  const { popover } = await opened();
  reply(popover, ALLOW);
  await settle();
  state.shared["usage.enabled"] = false;
  database.release(`${JSON.stringify({ type: "key", key: KEY })}\n`);
  await settle();
  expect(state.fetched).toEqual([]);
});

test("a key refused by the first request isn't followed by the next once it's turned off", async () => {
  opencode({ opencode: { type: "api", key: "made-up-zen-key" }, "opencode-go": { type: "api", key: KEY } });
  const request = heldGo();
  const { popover } = await opened();
  reply(popover, ALLOW);
  await settle();
  expect(state.fetched.length).toBe(1);
  state.shared["usage.enabled"] = false;
  request.release(go({}, 401)());
  await settle();
  expect(state.fetched.length).toBe(1);
});

test("after Allow, turning it off and on asks again, and reads nothing until answered", async () => {
  opencode();
  state.answers[GO] = go();
  const { popover } = await opened();
  reply(popover, ALLOW);
  await settle();
  flip();
  flip();
  state.reads.length = 0;
  await wait(2 * 3600_000);
  expect(words(popover.draw())).toContain(ASKS);
  expect(limits(popover.draw())).toEqual([]);
  expect(state.reads).toEqual([]);
  expect(state.fetched.length).toBe(1);

  reply(popover, ALLOW);
  await settle();
  expect(limits(popover.draw()).length).toBe(3);
  expect(state.fetched.length).toBe(2);
});

test("the card takes its colors from the theme, with Allow as the primary button", async () => {
  opencode();
  const { popover } = await opened();
  const root = popover.draw(), theirs = new Set(Object.values(colors));
  for (const e of all(root)) for (const name of ["bg", "text_color", "border_color"]) if (arg(e, name)) expect(theirs.has(arg(e, name))).toBe(true);
  expect(arg(byId(root, ALLOW)!, "bg")).toBe(colors.solid);
  expect(arg(byId(root, ALLOW)!, "text_color")).toBe(colors.solid_foreground);
});
