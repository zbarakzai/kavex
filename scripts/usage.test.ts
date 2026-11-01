import { test, expect, mock, beforeEach, afterEach, setSystemTime } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real footer button, popover, Settings row and checks, with only the outside world faked: what `exec`,
// `knownAgents` and `machines` answer, and what's in shared storage. All data here is made up.
//
// To teach it a new agent, add its commands to `state.says` (a piece of the command line, and what
// comes back) and its entry to `state.agents`, by machine ("" is this computer). A machine with its
// own table in `state.on` answers from that instead. `state.answers` is the same for `fetch`, by
// address: anything unlisted fails, so no test reaches the network.
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

type Asked = { args: string[]; on: string | null };
type Reply = string | Error | { code?: number; stdout?: string; stderr?: string } | ((asked: Asked) => Reply | Promise<Reply>) | Promise<Reply>;
let state: {
  says: Record<string, Reply>;
  on: Record<string, Record<string, Reply>>;
  platform: string;
  agents: Record<string, any[] | Error>;
  machines: { name: string | null; layout: string }[];
  runs: { line: string; on: string | null }[];
  answers: Record<string, Response | Error>;
  fetched: { url: string; init?: RequestInit }[];
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

const colors = JSON.parse(readFileSync(new URL("../defaults/themes/zaki.json", import.meta.url), "utf8")).colors;

async function exec(command: string, args: string[] = [], options: { on?: string | null } = {}) {
  const line = [command, ...args].join(" "), on = options.on ?? null;
  state.runs.push({ line, on });
  const says = state.on[on ?? ""] ?? state.says;
  const piece = Object.keys(says).find((said) => line.includes(said));
  if (piece === undefined) throw new Error(`nothing fakes: ${line}`);
  let reply: Reply = says[piece];
  while (typeof reply === "function" || reply instanceof Promise) reply = await (typeof reply === "function" ? reply({ args, on }) : reply);
  if (reply instanceof Error) throw reply;
  return typeof reply === "string" ? { code: 0, stdout: reply, stderr: "" } : { code: 0, stdout: "", stderr: "", ...reply };
}

globalThis.fetch = (async (url: string, init?: RequestInit) => {
  state.fetched.push({ url: String(url), init });
  const answer = state.answers[String(url)];
  if (!answer) throw new Error(`nothing fakes: ${url}`);
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
  shared: (k: string) => state.shared[k],
  setShared: (k: string, v: any) => { state.shared[k] = v === undefined ? v : JSON.parse(JSON.stringify(v)); },
  props: () => state.props,
  theme: () => colors,
  settings: () => ({ zoom: 1, font_family: "Geist Mono", font_size: 13, ui_font_family: "Geist", theme_dark: "zaki", theme_light: "paper" }),
  window: () => ({ platform: state.platform }),
  home: () => "/home/person",
  appHome: () => "/home/person/.config/zaki",
  readTextFile: async () => null,
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
    on: {},
    platform: "macos",
    agents: {},
    machines: [{ name: null, layout: "ready" }],
    runs: [],
    answers: {},
    fetched: [],
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
  state.says["command -v"] = "zaki-asked\n";
  const { popover } = await opened();
  expect(state.runs.some((run) => /claude (auth|-p)/.test(run.line))).toBe(false);
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

test("an agent waiting to be asked for consent is no subscription", async () => {
  state.says["printenv PATH"] = "/made/up/bin\n";
  state.agents[""] = [{ ...CLAUDE, key: "opencode", name: "OpenCode", icon: "icons/opencode.svg" }];
  const { popover } = await opened();
  expect(words(popover.draw())).not.toContain("OpenCode");
  expect(words(popover.draw())).toContain(NONE);
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

const CODEX = { ...CLAUDE, key: "codex", name: "Codex", icon: "icons/codex.svg", run: ["codex"] };
const PRO = { type: "chatgpt", email: "someone@example.test", planType: "prolite" };
const window_ = (usedPercent: number, windowDurationMins: number | null, inHours: number) => ({ usedPercent, windowDurationMins, resetsAt: NOW / 1000 + inHours * 3600 });
const bucket = (limitId: string | null, limitName: string | null, primary: any, secondary: any = null) => ({ limitId, limitName, primary, secondary, credits: null, planType: "prolite" });
const GENERAL = bucket("codex", null, window_(33.4, 300, 3.5), window_(12.4, 10080, 127));
const SPARK = bucket("codex_spark", "GPT-5-Spark", window_(30, 300, 1), window_(20, 10080, 30));
const RATES = { rateLimits: GENERAL, rateLimitsByLimitId: { codex_spark: SPARK, codex: GENERAL } };

// What `codex app-server` prints: an answer per request, and news nobody asked for between them.
const codexSays = (account: any, rates: any = RATES) => [
  { id: 1, result: { userAgent: "made-up/0" } },
  { method: "configWarning", params: { summary: "made up" } },
  { id: 2, result: { account, requiresOpenaiAuth: !account } },
  rates ? { id: 3, result: rates } : { error: { code: -32600, message: "sign in first" }, id: 3 },
].map((line) => JSON.stringify(line)).join("\n") + "\n";

function codex(account: any = PRO, rates: any = RATES) {
  state.agents[""] = [CODEX];
  state.says["printenv PATH"] = "/made/up/bin:/usr/bin\n";
  state.says["app-server"] = codexSays(account, rates);
}

test("a Codex subscription shows its tier and every limit: weekly, then a model's own, then shorter ones", async () => {
  codex();
  const { popover } = await opened();
  const root = popover.draw();
  expect(paths(root)).toContain("icons/codex.svg");
  expect(words(root)).toEqual(expect.arrayContaining(["Codex", "Pro 100"]));
  expect(limits(root).map((limit) => words(limit))).toEqual([
    ["This week", "12%", "resets in 5d 7h"],
    ["GPT-5-Spark", "20%", "resets in 1d 6h"],
    ["5 hours", "33%", "resets in 3h 30m"],
    ["GPT-5-Spark · 5 hours", "30%", "resets in 1h 0m"],
  ]);
});

test("a Codex answer with one bucket and no list of them still shows its limits", async () => {
  codex(PRO, { rateLimits: GENERAL, rateLimitsByLimitId: null });
  const { popover } = await opened();
  expect(limits(popover.draw()).map((limit) => words(limit)[0])).toEqual(["This week", "5 hours"]);
});

test("a model's bucket with no name of its own still shows", async () => {
  codex(PRO, { rateLimits: GENERAL, rateLimitsByLimitId: { codex: GENERAL, codex_other: bucket("codex_other", null, window_(5, 10080, 2)) } });
  const { popover } = await opened();
  expect(limits(popover.draw()).map((limit) => words(limit)[0])).toEqual(["This week", "Codex other", "5 hours"]);
});

test("a window of any other length reads as what it is", async () => {
  codex(PRO, { rateLimitsByLimitId: { codex: bucket("codex", null, window_(1, 60, 1), window_(2, 1440, 2)), codex_a: bucket("codex_a", "A", window_(3, 45, 1), window_(4, 43200, 2)), codex_b: bucket("codex_b", "B", window_(5, null, 1)) } });
  const { popover } = await opened();
  expect(limits(popover.draw()).map((limit) => words(limit)[0]).sort()).toEqual(["1 day", "1 hour", "A · 30 days", "A · 45 minutes", "B"]);
});

for (const [planType, tier] of [
  ["free", "Free"], ["go", "Go"], ["plus", "Plus"], ["pro", "Pro 200"], ["prolite", "Pro 100"], ["promax", "Pro 500"],
  ["team", "Business"], ["business", "Business"], ["self_serve_business_usage_based", "Business"], ["self_serve_business_prolite", "Business Premium"],
  ["enterprise", "Enterprise"], ["ent26", "Enterprise"], ["enterprise_cbp_usage_based", "Enterprise"], ["enterprise_cbp_automation", "Enterprise"],
  ["edu", "Edu"], ["edu_plus", "Edu Plus"], ["edu_pro", "Edu Pro"],
] as const) {
  test(`Codex's ${planType} plan reads ${tier}`, async () => {
    codex({ ...PRO, planType });
    const { popover } = await opened();
    expect(words(popover.draw())).toContain(tier);
  });
}

test("a Codex plan it doesn't name itself shows no made-up tier", async () => {
  codex({ ...PRO, planType: "unknown" });
  const { popover } = await opened();
  expect(words(popover.draw())).toContain("Codex");
  expect(words(popover.draw())).not.toContain("Unknown");
});

for (const [why, account] of [
  ["signed out", null],
  ["using an API key", { type: "apiKey" }],
  ["signed in through Amazon Bedrock", { type: "amazonBedrock", usesCodexManagedCredentials: false }],
] as const) {
  test(`Codex ${why} gives no row, whatever the limits answer says, and takes an older row with it`, async () => {
    codex();
    const { popover } = await opened();
    expect(limits(popover.draw()).length).toBe(4);

    state.says["app-server"] = codexSays(account, null);
    refresh(popover);
    await settle();
    expect(words(popover.draw())).not.toContain("Codex");
    expect(words(popover.draw())).toContain(NONE);
  });
}

for (const [why, answer] of [
  ["a failure", new Error("sh took longer than 30 s and was stopped")],
  ["nothing at all", ""],
  ["text that isn't JSON", "Error: something went wrong\n"],
  ["no answer about the account", JSON.stringify({ error: { code: -32603, message: "made up" }, id: 2 })],
  ["no answer about the limits", codexSays(PRO, null)],
  ["limits with no window in them", codexSays(PRO, { rateLimits: bucket("codex", null, null), rateLimitsByLimitId: { codex: bucket("codex", null, null) } })],
  ["limits with no bucket at all", codexSays(PRO, {})],
] as const) {
  test(`${why} from Codex with no earlier numbers reads "Could not check"`, async () => {
    codex();
    state.says["app-server"] = answer;
    const { popover } = await opened();
    const root = popover.draw();
    expect(words(root)).toEqual(expect.arrayContaining(["Codex", "Could not check"]));
    expect(limits(root)).toEqual([]);
  });

  test(`${why} from Codex keeps the last numbers with their age`, async () => {
    codex();
    const { popover } = await opened();
    setSystemTime(NOW + 12 * 60_000);
    state.says["app-server"] = answer;
    refresh(popover);
    await settle();
    expect(words(limits(popover.draw())[0])).toContain("12%");
    expect(words(popover.draw())).toContain("Last checked 12m ago");
  });
}

test("a question from Codex's server is no answer to ours", async () => {
  codex();
  state.says["app-server"] = JSON.stringify({ id: 2, method: "item/tool/requestUserInput", params: {} }) + "\n" + codexSays(PRO) + JSON.stringify({ id: 3, method: "item/tool/requestUserInput", params: {} }) + "\n";
  const { popover } = await opened();
  expect(limits(popover.draw()).length).toBe(4);
});

test("checking Codex sends no request of its own and reads no login", async () => {
  codex();
  await opened();
  expect(state.fetched).toEqual([]);
  expect(state.runs.every((run) => /app-server|printenv PATH/.test(run.line))).toBe(true);
  expect(state.runs.some((run) => /auth\.json|keychain|security /i.test(run.line))).toBe(false);
});

test("no email reaches shared storage from Codex", async () => {
  codex();
  await opened();
  const saved = JSON.stringify(state.shared);
  expect(saved).toContain("Pro 100");
  expect(saved).not.toContain(PRO.email);
  expect(saved).not.toMatch(/email/i);
});

// The check's own script in a real `sh`, against a made-up program that behaves like Codex's server:
// each answer arrives `after` seconds later, and only if its input is still open by then.
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function realShell(program: string, says: string, after = 0.5) {
  const dir = mkdtempSync(join(tmpdir(), "usage-test-"));
  scratch.push(dir);
  mkdirSync(join(dir, "tmp"));
  const answers = says.trim().split("\n").filter((line) => line.includes('"id"')).map((line) => `printf '%s\\n' '${line}'`).join("\n");
  writeFileSync(join(dir, program), `#!/bin/sh\necho "$@" > "${dir}/asked"\nread -r first\n( sleep ${after}\n${answers}\n) &\nwhile read -r line; do :; done\nkill $! 2>/dev/null\n`);
  chmodSync(join(dir, program), 0o755);
  state.agents[""] = [{ ...CODEX, run: [program] }];
  state.says["printenv PATH"] = `${dir}:/usr/bin:/bin\n`;
  state.says["app-server"] = state.says["command -v"] = async ({ args }) => {
    const child = Bun.spawn(["sh", ...args], { env: { TMPDIR: join(dir, "tmp"), PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(child.stdout).text();
    return { code: await child.exited, stdout };
  };
  return dir;
}

const checked = async () => { while (!state.shared.usage?.checkedAt) await Bun.sleep(10); };

test("a Codex check keeps its input open for a slow last answer, and stops as soon as it's in", async () => {
  const dir = realShell("codex", codexSays(PRO));
  const started = Bun.nanoseconds();
  const { popover } = await opened();
  await checked();
  expect(limits(popover.draw()).length).toBe(4);
  expect((Bun.nanoseconds() - started) / 1e9).toBeLessThan(5);
  expect(readdirSync(join(dir, "tmp"))).toEqual([]);
}, 10_000);

test("a signed-out Codex's refused last answer ends the wait too", async () => {
  realShell("codex", codexSays(null, null));
  const started = Bun.nanoseconds();
  const { popover } = await opened();
  await checked();
  expect(words(popover.draw())).toContain(NONE);
  expect((Bun.nanoseconds() - started) / 1e9).toBeLessThan(5);
}, 10_000);

test("Codex is asked read-only, with no approvals", async () => {
  const dir = realShell("codex", codexSays(PRO));
  await opened();
  await checked();
  expect(readFileSync(join(dir, "asked"), "utf8").trim()).toBe("-s read-only -a never app-server");
}, 10_000);

test("a program whose name the shell would take apart still runs as itself, and only that", async () => {
  const dir = realShell("it's my; touch injected", codexSays(PRO));
  const { popover } = await opened();
  await checked();
  expect(limits(popover.draw()).length).toBe(4);
  expect(existsSync(join(dir, "injected"))).toBe(false);
  expect(existsSync("injected")).toBe(false);
}, 10_000);

test("the program in programs.json runs instead of plain claude, with what it's started with", async () => {
  claude(WEEK);
  state.agents[""] = [{ ...CLAUDE, run: ["my-claude", "--profile", "work"] }];
  state.says["my-claude --profile work auth status"] = JSON.stringify(ACCOUNT);
  state.says["my-claude --profile work -p /usage"] = usageAnswer(WEEK);
  delete state.says["claude auth status"];
  delete state.says["claude -p /usage"];
  const { popover } = await opened();
  expect(limits(popover.draw()).length).toBe(1);
});

test("the program in programs.json runs instead of plain codex", async () => {
  codex();
  state.agents[""] = [{ ...CODEX, run: ["my-codex"] }];
  await opened();
  const asked = state.runs.find((run) => run.line.includes("app-server"))!.line;
  expect(asked).toContain("my-codex -s read-only -a never app-server");
  expect(asked).not.toMatch(/(^|[^-])codex -s/);
});

test("on Windows the agents are asked through PowerShell, with no PATH to fetch and their names quoted for it", async () => {
  state.platform = "windows";
  claude(WEEK);
  state.agents[""] = [{ ...CLAUDE, run: ["my claude's"] }, { ...CODEX, run: ["codex’s"] }];
  delete state.says["printenv PATH"];
  state.says["auth status"] = JSON.stringify(ACCOUNT);
  state.says["/usage"] = usageAnswer(WEEK);
  state.says["app-server"] = codexSays(PRO);
  const { popover } = await opened();
  expect(limits(popover.draw()).length).toBe(5);
  expect(state.runs.map((run) => run.line.slice(0, "powershell -NoLogo -NoProfile -Command".length))).toEqual(Array(3).fill("powershell -NoLogo -NoProfile -Command"));
  const line = (piece: string) => state.runs.find((run) => run.line.includes(piece))!.line;
  expect(line("auth status")).toEndWith("-Command & 'my claude''s' auth status");
  expect(line("/usage")).toContain("$env:TZ='UTC'; & 'my claude''s' -p /usage");
  expect(line("app-server")).toContain("| & 'codex’’s' -s read-only -a never app-server");
});

const OTHER = { ...ACCOUNT, email: "someone-else@example.test", orgId: "org-also-made-up" };
const SHELL = "/remote/bin:/usr/bin\n";
const rows = (root: El) => byId(root, "usage-rows")!.kids.map((kid) => mine(kid)!);

function added(name: string, layout = "ready") {
  state.machines.push({ name, layout });
}

// Claude Code on an added machine, signed in to `account`.
function claudeOn(on: string, account: any, ...lines: string[]) {
  added(on);
  state.agents[on] = [CLAUDE];
  state.on[on] = { "printenv PATH": SHELL, "claude auth status": JSON.stringify(account), "claude -p /usage": usageAnswer(...lines) };
}

const weekAt = (percent: number) => `Current week (all models): ${percent}% used · resets Nov 6 at 7:59pm (UTC)`;

test("Claude Code and Codex are checked on every added machine, on that machine, in its own shell PATH", async () => {
  claudeOn("vps", ACCOUNT, WEEK);
  claudeOn("box", OTHER, WEEK);
  state.agents.box.push(CODEX);
  state.on.box["app-server"] = codexSays(PRO);
  await opened();
  const on = (name: string) => state.runs.filter((run) => run.on === name);
  expect(on("vps").length).toBe(3);
  expect(on("box").length).toBe(4);
  for (const run of [...on("vps"), ...on("box")].filter((run) => !run.line.includes("printenv PATH"))) expect(run.line).toContain(SHELL.trim());
});

test("a row on this computer alone has no machine label, even with a machine added", async () => {
  claude(WEEK);
  added("vps");
  const { popover } = await opened();
  expect(words(rows(popover.draw())[0])).toEqual(["Claude Code", "Max", "This week", "12%", "resets in 5d 7h"]);
});

test("a row on an added machine is labelled with it", async () => {
  claudeOn("vps", ACCOUNT, WEEK);
  const { popover } = await opened();
  expect(words(rows(popover.draw())[0])).toContain("vps");
});

test("one account on two machines is one row, labelled with both", async () => {
  claude(WEEK);
  claudeOn("vps", ACCOUNT, WEEK);
  const { popover } = await opened();
  const root = popover.draw();
  expect(rows(root).length).toBe(1);
  expect(limits(root).length).toBe(1);
  expect(words(root)).toContain("This computer, vps");
});

for (const last of ["vps", "this computer"]) {
  test(`one account shows the newest numbers, with ${last} answering last`, async () => {
    const usage = held();
    claude(weekAt(10));
    claudeOn("vps", ACCOUNT, weekAt(10));
    (last === "vps" ? state.on.vps : state.says)["claude -p /usage"] = usage.answer;
    const { popover } = await opened();
    setSystemTime(NOW + 5000);
    usage.release(usageAnswer(weekAt(11)));
    await settle();
    expect(rows(popover.draw()).length).toBe(1);
    expect(words(limits(popover.draw())[0])).toContain("11%");
  });
}

test("different accounts on two machines are two rows, each labelled with its machine", async () => {
  claude(weekAt(10));
  claudeOn("vps", OTHER, weekAt(20));
  const { popover } = await opened();
  const shown = rows(popover.draw());
  expect(shown.length).toBe(2);
  expect(words(shown[0])).toEqual(expect.arrayContaining(["This computer", "10%"]));
  expect(words(shown[1])).toEqual(expect.arrayContaining(["vps", "20%"]));
});

test("different agents on two machines leave this computer's row unlabelled, as nothing needs telling apart", async () => {
  claude(WEEK);
  added("vps");
  state.agents.vps = [CODEX];
  state.on.vps = { "printenv PATH": SHELL, "app-server": codexSays(PRO) };
  const { popover } = await opened();
  const shown = rows(popover.draw());
  expect(words(shown[0])).not.toContain("This computer");
  expect(words(shown[1])).toContain("vps");
});

test("Claude Code and Codex on one email stay two rows, as they're two subscriptions", async () => {
  claude(WEEK);
  state.agents[""].push(CODEX);
  state.says["app-server"] = codexSays(PRO);
  const { popover } = await opened();
  expect(rows(popover.draw()).length).toBe(2);
});

test("accounts with no email can't be matched, so they stay apart, each with bars of its own", async () => {
  codex({ ...PRO, email: null });
  added("vps");
  state.agents.vps = [CODEX];
  state.on.vps = { "printenv PATH": SHELL, "app-server": codexSays({ ...PRO, email: null }) };
  const { popover } = await opened();
  const root = popover.draw();
  expect(rows(root).length).toBe(2);
  const ids = limits(root).map((limit) => arg(limit, "id"));
  expect(new Set(ids).size).toBe(ids.length);
});

test("an unreachable machine keeps its last numbers, marked with their age, and is asked nothing", async () => {
  claudeOn("vps", ACCOUNT, weekAt(40));
  const { popover } = await opened();
  setSystemTime(NOW + 12 * 60_000);
  state.machines[1].layout = "unavailable";
  state.agents.vps = [{ ...CLAUDE, installed: false }];
  state.runs.length = 0;
  refresh(popover);
  await settle();
  const root = popover.draw();
  expect(state.runs.filter((run) => run.on === "vps")).toEqual([]);
  expect(words(limits(root)[0])).toContain("40%");
  expect(words(root)).toEqual(expect.arrayContaining(["vps", "Last checked 12m ago"]));
});

test("an unreachable machine with no last numbers shows nothing, and leaves the others alone", async () => {
  claude(WEEK);
  added("vps", "unavailable");
  const { popover } = await opened();
  expect(rows(popover.draw()).length).toBe(1);
  expect(words(popover.draw())).not.toContain("Could not check");
});

test("a machine still connecting is asked like any other", async () => {
  claudeOn("vps", ACCOUNT, WEEK);
  state.machines[1].layout = "loading";
  const { popover } = await opened();
  expect(limits(popover.draw()).length).toBe(1);
});

test("this computer is always asked, whatever its layout says", async () => {
  claude(WEEK);
  state.machines[0].layout = "unavailable";
  const { popover } = await opened();
  expect(limits(popover.draw()).length).toBe(1);
});

test("a machine lost after it last looked ready keeps its rows too", async () => {
  claudeOn("vps", ACCOUNT, weekAt(40));
  const { popover } = await opened();
  setSystemTime(NOW + 12 * 60_000);
  state.agents.vps = [{ ...CLAUDE, installed: false }];
  state.on.vps = { "printenv PATH": new Error("machine vps is offline"), "command -v": new Error("machine vps is offline") };
  refresh(popover);
  await settle();
  expect(words(limits(popover.draw())[0])).toContain("40%");
  expect(words(popover.draw())).toContain("Last checked 12m ago");
});

for (const [why, machine] of [
  ["fails on this computer", "this computer"],
  ["fails on the added machine", "vps"],
  ["can't reach the added machine", "offline"],
] as const) {
  test(`a shared row keeps the fresh numbers when one check ${why}, and both names`, async () => {
    claude(weekAt(10));
    claudeOn("vps", ACCOUNT, weekAt(10));
    const { popover } = await opened();
    setSystemTime(NOW + 12 * 60_000);
    state.says["claude -p /usage"] = machine === "this computer" ? new Error("no") : usageAnswer(weekAt(30));
    state.on.vps["claude -p /usage"] = machine === "vps" ? new Error("no") : usageAnswer(weekAt(30));
    if (machine === "offline") state.machines[1].layout = "unavailable";
    refresh(popover);
    await settle();
    const root = popover.draw();
    expect(rows(root).length).toBe(1);
    expect(words(limits(root)[0])).toContain("30%");
    expect(words(root)).toContain("This computer, vps");
    expect(words(root).filter((word) => word.startsWith("Last checked"))).toEqual([]);
  });
}

test("a shared row failing everywhere shows the newest it has, with its age", async () => {
  claude(weekAt(10));
  claudeOn("vps", ACCOUNT, weekAt(10));
  const { popover } = await opened();
  setSystemTime(NOW + 12 * 60_000);
  state.says["claude -p /usage"] = state.on.vps["claude -p /usage"] = new Error("no");
  refresh(popover);
  await settle();
  expect(words(popover.draw())).toContain("Last checked 12m ago");
});

test("one machine's failure leaves another machine's agents alone", async () => {
  claude(weekAt(10));
  state.agents[""].push(CODEX);
  state.says["app-server"] = codexSays(PRO);
  claudeOn("vps", OTHER, weekAt(20));
  state.on.vps["claude -p /usage"] = new Error("no");
  const { popover } = await opened();
  const root = popover.draw();
  expect(rows(root).length).toBe(3);
  expect(words(root)).toContain("Could not check");
  expect(words(root)).toEqual(expect.arrayContaining(["10%", "12%"]));
});

test("a removed machine's rows go after the next check", async () => {
  claude(weekAt(10));
  claudeOn("vps", OTHER, weekAt(20));
  const { popover } = await opened();
  expect(rows(popover.draw()).length).toBe(2);

  state.machines.pop();
  refresh(popover);
  await settle();
  const root = popover.draw();
  expect(rows(root).length).toBe(1);
  expect(words(root)).not.toContain("vps");
  expect(words(root)).not.toContain("This computer");
});

test("a shared row loses a removed machine's name, and its label with it", async () => {
  claude(WEEK);
  claudeOn("vps", ACCOUNT, WEEK);
  const { popover } = await opened();
  state.machines.pop();
  refresh(popover);
  await settle();
  expect(words(popover.draw()).filter((word) => /computer|vps/.test(word))).toEqual([]);
  expect(rows(popover.draw()).length).toBe(1);
});

const SURE_NOT = "zaki-asked\n";

for (const [why, shell, probe] of [
  ["its shell can't be read", new Error("no shell"), SURE_NOT],
  ["its shell can't say", "/made/up/bin\n", new Error("no")],
  ["its shell answers nothing", "/made/up/bin\n", ""],
] as const) {
  test(`a false "not installed" keeps this computer's row when ${why}`, async () => {
    claude(WEEK);
    const { popover } = await opened();
    setSystemTime(NOW + 12 * 60_000);
    state.agents[""] = [{ ...CLAUDE, installed: false }];
    state.says["printenv PATH"] = shell;
    state.says["command -v"] = probe;
    state.runs.length = 0;
    refresh(popover);
    await settle();
    expect(words(limits(popover.draw())[0])).toContain("12%");
    expect(words(popover.draw())).toContain("Last checked 12m ago");
    expect(checks()).toBe(0);
  });

  test(`"not installed" with no older row gives none when ${why}`, async () => {
    claude(WEEK);
    state.agents[""] = [{ ...CLAUDE, installed: false }];
    state.says["printenv PATH"] = shell;
    state.says["command -v"] = probe;
    const { popover } = await opened();
    expect(words(popover.draw())).toContain(NONE);
  });
}

test("an agent really gone takes its row with it, once its shell says so", async () => {
  claude(WEEK);
  const { popover } = await opened();
  state.agents[""] = [{ ...CLAUDE, installed: false }];
  state.says["command -v"] = SURE_NOT;
  refresh(popover);
  await settle();
  expect(limits(popover.draw())).toEqual([]);
  expect(words(popover.draw())).toContain(NONE);
});

test("an agent only the machine's own shell can find is still checked", async () => {
  claudeOn("vps", ACCOUNT, WEEK);
  state.agents.vps = [{ ...CLAUDE, installed: false, run: ["my-claude"] }];
  state.on.vps["command -v"] = "zaki-has:my-claude\nzaki-asked\n";
  state.on.vps["my-claude auth status"] = JSON.stringify(ACCOUNT);
  state.on.vps["my-claude -p /usage"] = usageAnswer(WEEK);
  const { popover } = await opened();
  expect(limits(popover.draw()).length).toBe(1);
  const asked = state.runs.find((run) => run.line.includes("command -v"))!;
  expect(asked.on).toBe("vps");
  expect(asked.line).toContain(SHELL.trim());
});

test("the shell's own word on what's installed works in a real sh", async () => {
  realShell("codex", codexSays(PRO));
  state.agents[""] = [{ ...CODEX, installed: false }, { ...CLAUDE, installed: false, run: ["no-such-program-here"] }];
  const { popover } = await opened();
  await checked();
  expect(rows(popover.draw()).length).toBe(1);
  expect(words(popover.draw())).toContain("Codex");
}, 10_000);

test("on Windows PowerShell says what's installed", async () => {
  state.platform = "windows";
  state.agents[""] = [{ ...CODEX, installed: false }];
  state.says["app-server"] = codexSays(PRO);
  state.says["Get-Command"] = "zaki-has:codex\r\nzaki-asked\r\n";
  const { popover } = await opened();
  expect(limits(popover.draw()).length).toBe(4);
});

for (const [why, list] of [["fails", new Error("no")], ["comes back empty", []]] as const) {
  test(`a list of agents that ${why} keeps a machine's rows`, async () => {
    claude(WEEK);
    const { popover } = await opened();
    setSystemTime(NOW + 12 * 60_000);
    state.agents[""] = list;
    refresh(popover);
    await settle();
    expect(words(limits(popover.draw())[0])).toContain("12%");
    expect(words(popover.draw())).toContain("Last checked 12m ago");
  });
}

test("OpenCode isn't checked on an added machine", async () => {
  claudeOn("vps", ACCOUNT, WEEK);
  state.agents.vps.push({ ...CLAUDE, key: "opencode", name: "OpenCode", icon: "icons/opencode.svg" });
  const { popover } = await opened();
  expect(rows(popover.draw()).length).toBe(1);
  expect(Object.keys(state.shared.usage.entries)).toEqual(["claude|vps"]);
});

test("the same limit on two machines counts once, following the numbers on show", async () => {
  const { nearLimit } = await import("../defaults/mods/usage/checks.js");
  claude(weekAt(95));
  claudeOn("vps", ACCOUNT, weekAt(95));
  const { popover } = await opened();
  expect(nearLimit(state.shared.usage.entries, NOW)).toBe(true);

  setSystemTime(NOW + 12 * 60_000);
  state.says["claude -p /usage"] = new Error("no");
  state.on.vps["claude -p /usage"] = usageAnswer(weekAt(10));
  refresh(popover);
  await settle();
  expect(words(limits(popover.draw())[0])).toContain("10%");
  expect(nearLimit(state.shared.usage.entries, NOW + 12 * 60_000)).toBe(false);
});

test("no email or organisation is saved from any machine, only a fingerprint", async () => {
  claude(WEEK);
  claudeOn("vps", OTHER, WEEK);
  await opened();
  const saved = JSON.stringify(state.shared);
  for (const secret of [ACCOUNT.email, ACCOUNT.orgId, OTHER.email, OTHER.orgId]) expect(saved).not.toContain(secret);
  const entries: any[] = Object.values(state.shared.usage.entries);
  expect(entries.map((entry) => entry.who).every((who) => /^[0-9a-f]{16}$/.test(who))).toBe(true);
  expect(entries[0].who).not.toBe(entries[1].who);
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
