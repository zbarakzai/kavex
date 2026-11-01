import { test, expect, mock, beforeEach, afterEach, setSystemTime } from "bun:test";
import { readFileSync } from "node:fs";

// The real footer button, popover and checks, with only the outside world faked: what `exec`,
// `knownAgents` and `machines` answer, and what's in shared storage. All data here is made up.
//
// To teach it a new agent, add its commands to `state.says` (a piece of the command line, and what
// comes back) and its entry to `state.agents`, by machine ("" is this computer). `state.answers`
// is the same for `fetch`, by address: anything unlisted fails, so no test reaches the network.
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
  const answer = state.answers[String(url)];
  if (!answer) throw new Error(`nothing fakes: ${url}`);
  if (answer instanceof Error) throw answer;
  return answer;
}) as typeof fetch;

mock.module("gpui-kit", () => ({ View: class {}, div: make, image: icon, svg: icon }));
mock.module("gpui-base", () => ({ h_flex: make, v_flex: make, HoverCard: { new: make } }));
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
  settings: () => ({ zoom: 1 }),
  window: () => ({ platform: "macos" }),
  home: () => "/home/person",
  readTextFile: async () => null,
  layout: () => ({ id: "root", children: [{ id: "sidebar", size: { px: state.sidebar } }] }),
  updates: () => ({ app: { ready: false } }),
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

const ticks: number[] = [];
const cx: any = { notify: () => {}, stop_propagation: () => {}, spawn: (f: (cx: any) => unknown) => void f(cx), timer: { every: (ms: number) => void ticks.push(ms), after: () => {} } };
const settle = () => Bun.sleep(0);

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
  const view: any = new WorkspaceChrome();
  state.props = { footer: true };
  view.init?.({}, cx);
  return { draw: () => { state.props = { footer: true }; return view.render(cx).el as El; } };
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
  const view: any = new Usage();
  state.props = own;
  view.init(own, cx);
  return {
    view,
    draw: () => { state.props = own; return view.render(cx).el as El; },
    close: () => view.close(cx),
  };
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
  ticks.length = 0;
  state = {
    says: {},
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
  expect(ticks).toEqual([30_000]);
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
