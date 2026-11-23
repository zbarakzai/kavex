import { test, expect, mock, beforeEach, afterEach, setSystemTime } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real footer menu, popover, Settings row and checks, with only the outside world faked: what `exec`,
// `knownAgents` and `machines` answer, and what's in shared storage. All data here is made up.
//
// To teach it a new agent, add its commands to `state.says` (a piece of the command line, and what
// comes back) and its entry to `state.agents`, by machine ("" is this computer). A machine with its
// own table in `state.on` answers from that instead. `state.answers` is the same for `fetch`, by
// address: anything unlisted fails, so no test reaches the network. `state.files` is what
// `readTextFile` finds; `state.reads` lists every path it was asked for.
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
// `spaced` draws a label one letter at a time: it reads as one word here.
const spelled = (e: El) => e.kids.length > 0 && e.kids.every((kid) => { const [letter, more] = mine(kid)?.kids ?? []; return typeof letter === "string" && letter.length === 1 && more === undefined; });
const words = (root: El): string[] => spelled(root) ? [root.kids.map((kid) => mine(kid)!.kids[0]).join("").replaceAll("\u00a0", " ")]
  : root.kids.flatMap((kid) => (typeof kid === "string" ? [kid] : mine(kid) ? words(mine(kid)!) : []));
const handler = (e: El, name: string) => e.calls.find(([k]) => k === name)?.[1].at(-1);
const paths = (root: El) => all(root).map((e) => arg(e, "path")).filter(Boolean);
const icon = (path: string) => { const s = make(); s.el.calls.push(["path", [path]]); return s; };

type Asked = { args: string[]; on: string | null };
type Reply = string | Error | { code?: number; stdout?: string; stderr?: string } | ((asked: Asked) => Reply | Promise<Reply>) | Promise<Reply>;
let state: {
  says: Record<string, Reply>;
  on: Record<string, Record<string, Reply>>;
  platform: string;
  zoom?: number;
  active: boolean;
  awake?: { mode: string; active: boolean };
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
  useShippedLayout?: boolean;
  agentsShown: number;
  space: any;
  overlays: any[];
  closedOverlays: string[];
  ran: string[];
  lastRun?: { name: string; args: unknown };
  commands: string[];
  waiting: ((command: string) => void) | null;
  notes: { title: string; body: string; level: string }[];
};

// `solid` and its text are made for every theme by src/settings.rs, not written in the file.
const themeFile = JSON.parse(readFileSync(new URL("../defaults/themes/kavex.json", import.meta.url), "utf8"));
const shippedLayout = JSON.parse(readFileSync(new URL("../defaults/layouts/main.json", import.meta.url), "utf8"));
const colors = { background: themeFile.background, foreground: themeFile.foreground, ...themeFile.colors, solid: "#abcdef", solid_foreground: "#123456" };

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
  settings: () => ({ zoom: state.zoom ?? 1, font_family: "Geist Mono", font_size: 13, ui_font_family: "Geist", theme_dark: "kavex", theme_light: "paper" }),
  window: () => ({ platform: state.platform, active: state.active, awake: state.awake }),
  home: () => "/home/person",
  appHome: () => "/home/person/.config/kavex",
  readTextFile: async (path: string) => { state.reads.push(path); return state.files[path] ?? null; },
  writeTextFile: async () => {},
  hc: async () => ({ code: 0, stdout: '{"machines":[]}', stderr: "" }),
  themes: () => [],
  fonts: () => ["Geist"],
  telemetry: () => null,
  layouts: () => ["main"],
  playSound: () => {},
  closeOverlay: (id: string) => void state.closedOverlays.push(id),
  notify: (note: any) => void state.notes.push(note),
  layout: () => state.useShippedLayout ? shippedLayout : { id: "root", children: [{ id: "sidebar", size: { px: state.sidebar } }] },
  updates: () => ({ app: { ready: false, version: "0.4.0", updates: true }, core: { version: "0.1.15" }, checks: true }),
  agents: () => Array.from({ length: state.agentsShown }, () => ({})),
  spaces: () => (state.space ? [state.space] : []),
  openOverlay: (spec: any) => (state.overlays.push(spec), `overlay-${state.overlays.length}`),
  run: (name: string, args: unknown) => {
    state.ran.push(name);
    state.lastRun = { name, args };
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
const { default: WorkspaceStatus } = await import("../defaults/mods/workspace-status/main.js");
const { subscriptions } = await import("../defaults/mods/usage/checks.js");

// A mod copy's context. Its timers run as `wait` moves the clock, and stop when the copy closes.
type Copy = { closed: boolean; notified: number; every: number[] };
let timers: { at: number; every?: number; run: (cx: any) => void; cx: any; copy: Copy }[] = [];
function copyContext() {
  const copy: Copy = { closed: false, notified: 0, every: [] };
  const start = (ms: number, run: (cx: any) => void, every?: number) => void timers.push({ at: Date.now() + ms, every, run, cx: context, copy });
  const context: any = {
    notify: () => { copy.notified += 1; },
    stop_propagation: () => {},
    focus_handle: () => ({ focus: () => {} }),
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
const barColor = (limit: El) => arg(all(barOf(limit)).find((e) => arg(e, "bg"))!, "bg");
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

function footerMenu(spec = state.overlays.findLast((overlay) => overlay.props?.footerMenu)) {
  const view: any = new WorkspaceChrome(), { context } = copyContext();
  const own = { ...spec?.props, footerMenu: true, overlay: "footer-menu" };
  state.props = own;
  view.init(own, context);
  return {
    draw: () => { state.props = own; return view.render(context).el as El; },
    close: () => { state.props = own; view.close(context); },
  };
}

function chooseUsage(f: ReturnType<typeof footer>) {
  press(f, "footer-more");
  handler(byId(footerMenu().draw(), "footer-action-usage")!, "on_click")({}, cx);
}

// What the app does when an overlay opens: a new copy of its mod, with the spec's props.
function openPopover(spec = state.overlays.at(-1)) {
  const own = { ...spec.props, overlay: `overlay-${state.overlays.length}` };
  const view: any = new Usage(), { copy, context } = copyContext();
  state.props = own;
  view.init(own, context);
  return {
    view,
    copy,
    draw: () => { state.props = own; return view.render(context).el as El; },
    close: () => view.close(context),
  };
}

function providerPopover(roster: { draw: () => El }, provider: string) {
  const row = all(roster.draw()).find((node) => String(arg(node, "id")).startsWith("usage-row-" + provider + "-"));
  if (!row) throw new Error("Usage roster row is missing: " + provider);
  handler(row, "on_click")({}, cx);
  return roster;
}

function cachedRows() {
  return subscriptions(state.shared.usage?.entries, Date.now());
}

function cachedLimits() {
  return cachedRows().flatMap((row) => row.limits.map(({ label, used, resetsAt }: any) => ({ label, used, resetsAt })));
}

const checkingShown = (root: El) => !paths(byId(root, "usage-refresh")!).includes("mods/workspace-chrome/icons/refresh.svg");

function expectCachedAge(minutes: number) {
  const checkedAt = Date.now() - minutes * 60_000;
  expect(cachedRows().some((row) => row.failed && row.limits.length > 0 && row.checkedAt === checkedAt)).toBe(true);
}

// The popover as it looks with nothing more asked of it: checks made so far, none started.
function openedAfter() {
  state.overlays.push({ props: { from: "usage" } });
  return openPopover();
}

// Opened the way a person opens it, with the footer running: `settled` waits for the check.
async function opened(settled = true) {
  const f = footer();
  chooseUsage(f);
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
    active: true,
    agents: {},
    machines: [{ name: null, layout: "ready" }],
    runs: [],
    answers: {},
    fetched: [],
    files: {},
    reads: [],
    // The footer also looks for skill updates (scripts/skills.test.ts); these tests are about Usage alone.
    shared: { "skills.checks": false, "usage.presentation": { display: "used" } },
    props: null,
    sidebar: 230,
    agentsShown: 2,
    space: null,
    overlays: [],
    closedOverlays: [],
    ran: [],
    commands: [],
    waiting: null,
    notes: [],
  };
});
afterEach(() => { setSystemTime(); });

test("the footer exposes More actions and Settings, with three short menu rows", () => {
  const f = footer(), root = f.draw();
  expect(byId(root, "footer-more")).toBeDefined();
  expect(paths(byId(root, "footer-more")!)).toEqual(["mods/workspace-chrome/icons/heroicons/bars-3.svg"]);
  expect(byId(root, "settings")).toBeDefined();
  expect(byId(root, "usage")).toBeUndefined();
  expect(byId(root, "machine")).toBeUndefined();
  expect(byId(root, "customize")).toBeUndefined();
  press(f, "footer-more");
  const menu = footerMenu().draw();
  expect(words(menu)).toEqual(["Usage limits", "Add machine", "Customize"]);
  expect(paths(menu)).toEqual([
    "mods/workspace-chrome/icons/heroicons/chart-pie.svg",
    "mods/workspace-chrome/icons/heroicons/server-stack.svg",
    "mods/workspace-chrome/icons/heroicons/square-3-stack-3d.svg",
  ]);
});

test("More actions offers only Add machine and Customize when Usage has a dedicated button", async () => {
  state.useShippedLayout = true;
  claude(AT(92));
  const f = footer();
  await wait(5_000);
  expect(dotOn(f.draw())).toBeUndefined();
  press(f, "footer-more");
  expect(words(footerMenu().draw())).toEqual(["Add machine", "Customize"]);
});

test("the collapsed sidebar footer shows only Settings", () => {
  state.sidebar = 44;
  const root = footer().draw();
  expect(byId(root, "footer-more")).toBeUndefined();
  const settings = byId(root, "settings")!;
  expect([arg(settings, "w"), arg(settings, "h")]).toEqual([30, 30]);
});

test("the dropdown opens above the footer and Usage limits opens beside the buttons", () => {
  const f = footer();
  chooseUsage(f);
  const [menu, usage] = state.overlays;
  expect(menu).toMatchObject({ mod: "workspace-chrome", kind: "popup", props: { footerMenu: true } });
  expect(menu.at.y + menu.height).toBeLessThan(BUTTON.y);
  expect(usage).toMatchObject({ mod: "usage", kind: "popup", width: 400, height: 540, props: { from: "usage" } });
  expect(usage.at.x).toBeGreaterThan(BUTTON.x + BUTTON.width);
  expect(state.closedOverlays).toEqual(["footer-menu"]);
});

test("a second press on More actions closes its menu", () => {
  const f = footer();
  press(f, "footer-more");
  const menu = footerMenu();
  press(f, "footer-more", () => menu.close());
  expect(state.overlays.length).toBe(1);

  setSystemTime(NOW + 5000);
  press(f, "footer-more");
  expect(state.overlays.length).toBe(2);
});

test("keyboard selection and clicks open the original footer actions", () => {
  const f = footer();
  press(f, "footer-more");
  const panel = byId(footerMenu().draw(), "footer-actions")!;
  handler(panel, "on_key_down")({ key: "down" }, cx);
  handler(panel, "on_key_down")({ key: "enter" }, cx);
  expect(state.lastRun).toEqual({ name: "mod.open", args: { name: "machine-add" } });
  press(f, "footer-more");
  handler(byId(footerMenu().draw(), "footer-action-customize")!, "on_click")({}, cx);
  expect(state.lastRun).toEqual({ name: "mod.open", args: { name: "customize" } });
});

test("a Customize update keeps its mark in the menu and on the More actions button", () => {
  state.shared["skills.updates"] = [{ name: "example" }];
  const f = footer();
  expect(dotOn(f.draw())).toBeDefined();
  press(f, "footer-more");
  const row = byId(footerMenu().draw(), "footer-action-customize")!;
  expect(all(row).some((e) => arg(e, "bg") === colors.accent)).toBe(true);
});


test("the detailed roster uses Kavex cards and shows the provider, plan, quota and reset", async () => {
  claude(WEEK);
  const { popover } = await opened();
  const root = popover.draw();
  expect(paths(root)).toContain("icons/claude.svg");
  expect(words(root)).toEqual(expect.arrayContaining(["Usage limits", "Claude Code", "· Max", "Resets in 5d 7h"]));
  expect(arg(root, "bg")).toBe(colors.canvas);
  expect(arg(root, "rounded")).toBe(13);
  const [row] = rows(root);
  expect(arg(row, "bg")).toBe(colors.card);
  expect(arg(row, "border_color")).toBe(colors.card_border);
  expect(arg(row, "rounded")).toBe(10);
  expect(arg(byId(root, "usage-refresh")!, "bg")).toBe(colors.accent);
  const [week] = limits(root);
  expect(words(week)).toEqual(["wk", "12%"]);
  expect(filled(week)).toBe(12);
});


test("detailed Claude usage shows every window, with the next reset beside the provider", async () => {
  claude(SESSION, SONNET, WEEK);
  const { popover } = await opened();
  const root = popover.draw();
  expect(limits(root).map(words)).toEqual([["wk", "12%"], ["Sonnet", "4%"], ["5h", "33%"]]);
  expect(words(root)).toContain("Resets in 3h 30m");
});

const checks = () => state.runs.filter((run) => run.line.includes("claude -p /usage")).length;
const refresh = (popover: { draw: () => El }) => handler(byId(popover.draw(), "usage-refresh")!, "on_click")({}, cx);
function held() {
  let release!: (reply: Reply) => void;
  const answer = new Promise<Reply>((resolve) => { release = resolve; });
  return { answer, release };
}
const ANSWER = usageAnswer(WEEK);

test("opening the roster reuses fresh data for five minutes", async () => {
  claude(WEEK);
  const { f, popover } = await opened();
  expect(checks()).toBe(1);
  popover.close();

  setSystemTime(NOW + 5 * 60_000 - 1);
  chooseUsage(f);
  openPopover();
  await settle();
  expect(checks()).toBe(1);

  setSystemTime(NOW + 5 * 60_000);
  chooseUsage(f);
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

test("refreshes during a check coalesce into one follow-up", async () => {
  const usage = held();
  claude(WEEK);
  state.says["claude -p /usage"] = usage.answer;
  const { f, popover } = await opened();
  refresh(popover);
  refresh(popover);
  await settle();
  chooseUsage(f);
  openPopover();
  await settle();
  expect(checks()).toBe(1);
  state.says["claude -p /usage"] = usageAnswer(weekAt(45));
  usage.release(ANSWER);
  await settle();
  expect(checks()).toBe(2);
  expect(words(popover.draw())).toContain("45%");
});


test("refresh progress is visible in the roster and the provider detail shows the reading age", async () => {
  const usage = held();
  claude(WEEK);
  state.says["claude -p /usage"] = usage.answer;
  const { popover } = await opened();
  expect(words(popover.draw())).toContain("Loading usage…");
  expect(checkingShown(popover.draw())).toBe(true);

  usage.release(ANSWER);
  await settle();
  expect(checkingShown(popover.draw())).toBe(false);
  const detail = providerPopover(popover, "claude");
  expect(words(detail.draw())).toContain("Updated just now");

  setSystemTime(NOW + 3 * 60_000);
  expect(words(detail.draw())).toContain("Updated 3m ago");
});

test("closing the popover midway leaves the check to finish, so its numbers still arrive", async () => {
  const usage = held();
  claude(WEEK);
  state.says["claude -p /usage"] = usage.answer;
  const { f, popover } = await opened();
  popover.close();
  usage.release(ANSWER);
  await settle();

  chooseUsage(f);
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
  expect(checkingShown(popover.draw())).toBe(true);
});


test("the open roster redraws at the next displayed countdown boundary", async () => {
  claude(SESSION);
  const { popover } = await opened();
  expect(words(popover.draw())).toContain("Resets in 3h 30m");
  expect(popover.copy.every).toEqual([]);
  await wait(1);
  expect(popover.copy.notified).toBe(1);
  expect(words(popover.draw())).toContain("Resets in 3h 29m");
});

test("a reset hides only the expired reading until the provider reports the new window", async () => {
  claude(WEEK, "Current session: 96% used · resets 12:04pm (UTC)");
  const { popover } = await opened();
  setSystemTime(NOW + 4 * 60_000);
  const root = popover.draw();
  expect(limits(root).map(words)).toEqual([["wk", "12%"]]);
  expect(cachedRows()[0].expired).toBe(true);
  expect(words(root)).not.toContain("0%");
});

test("the next background tick after a reset asks for the new window", async () => {
  claude("Current session: 96% used · resets 12:04pm (UTC)");
  const f = footer();
  await wait(5_000);
  expect(dotOn(f.draw())).toBeDefined();
  claude("Current session: 15% used · resets 5pm (UTC)");
  await wait(4 * 60_000);
  expect(checks()).toBe(2);
  expect(words(openedAfter().draw())).toContain("15%");
  expect(dotOn(f.draw())).toBeUndefined();
});

test("repeated failures retire old numbers and their warning after 30 minutes", async () => {
  claude(AT(95));
  const { f, popover } = await opened();
  state.says["claude -p /usage"] = new Error("unavailable");
  await wait(16 * 60_000);
  expect(words(popover.draw())).toContain("95%");
  expect(dotOn(f.draw())).toBeDefined();
  await wait(15 * 60_000);
  expect(limits(popover.draw())).toEqual([]);
  expect(words(popover.draw())).toContain("Could not check");
  expect(dotOn(f.draw())).toBeUndefined();
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

const NONE = "No usage data";

for (const [why, answer] of [
  ["signed out", { code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }) }],
  ["using an API key", JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" })],
] as const) {
  test(`Claude ${why} clears prior quota and stops the provider probe`, async () => {
    claude(WEEK);
    const { popover } = await opened();
    expect(limits(popover.draw()).length).toBe(1);

    state.says["claude auth status"] = answer;
    state.runs.length = 0;
    refresh(popover);
    await settle();
    expect(checks()).toBe(0);
    expect(limits(popover.draw())).toEqual([]);
    expect(words(popover.draw())).toContain("Claude Code");
    expect(words(popover.draw())).toContain(why === "signed out" ? "not signed in" : "This account uses API billing.");
  });
}

test("Claude not installed gives no row and runs nothing of Claude's", async () => {
  claude(WEEK);
  state.agents[""] = [{ ...CLAUDE, installed: false }];
  state.says["command -v"] = "kavex-asked\n";
  const { popover } = await opened();
  expect(state.runs.some((run) => /claude (auth|-p)/.test(run.line))).toBe(false);
  expect(words(popover.draw())).toContain(NONE);
});

test("with no agents at all the popover reads as a result, and Usage limits stays in the menu", async () => {
  state.says["printenv PATH"] = "/made/up/bin\n";
  const { popover } = await opened();
  expect(words(popover.draw())).toContain(NONE);
  expect(state.shared.usage.checkedAt).toBe(NOW);
  expect(byId(footerMenu().draw(), "footer-action-usage")).toBeDefined();
});

test("before the first check ends, nothing claims there are no subscriptions", async () => {
  const auth = held();
  claude(WEEK);
  state.says["claude auth status"] = auth.answer;
  const { popover } = await opened();
  expect(words(popover.draw())).not.toContain(NONE);
  auth.release(JSON.stringify(ACCOUNT));
});


test("a failed check keeps the last numbers and shows their age in the provider detail", async () => {
  claude(WEEK);
  const { popover } = await opened();
  setSystemTime(NOW + 12 * 60_000);
  state.says["claude -p /usage"] = new Error("claude took longer than 30 s and was stopped");
  refresh(popover);
  await settle();
  const detail = providerPopover(popover, "claude");
  const text = words(detail.draw());
  expect(text).toEqual(expect.arrayContaining(["12%", "Updated 12m ago", "Refresh failed · showing cached data"]));
  expect(text).not.toContain("Could not check");
});

test("the next good check clears the note", async () => {
  claude(WEEK);
  const { popover } = await opened();
  state.says["claude -p /usage"] = new Error("no");
  setSystemTime(NOW + 2 * 60_000);
  refresh(popover);
  await settle();
  claude(WEEK);
  setSystemTime(Date.now() + 30_000);
  refresh(popover);
  await settle();
  expect(cachedRows().every((row) => !row.failed)).toBe(true);
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

test("Claude reads only the result from a stream with events before and after it", async () => {
  claude(WEEK);
  state.says["claude -p /usage"] = [
    '{"type":"assistant","result":"Current session: 97% used"}',
    usageAnswer(WEEK),
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
  ].join("\n");
  const { popover } = await opened();
  expect(cachedLimits()).toEqual([{ label: "This week", used: 12, resetsAt: Date.UTC(2026, 10, 6, 19, 59) }]);
});

test("unreadable sign-in text is a failed check, not a signed-out one", async () => {
  claude(WEEK);
  const { popover } = await opened();
  state.says["claude auth status"] = "Something went wrong";
  refresh(popover);
  await settle();
  expect(words(limits(popover.draw())[0])).toContain("12%");
  expectCachedAge(0);
});

test("unreadable lines are left out, and the ones that read stay", async () => {
  claude("Current week (all models): most% used", SONNET);
  const { popover } = await opened();
  expect(limits(popover.draw()).map((limit) => words(limit)[0])).toEqual(["Sonnet"]);
});

test("a line whose reset text can't be read gives no limit, and the ones that read stay", async () => {
  claude("Current week (all models): 12% used · resets when it feels like it", SONNET);
  const { popover } = await opened();
  expect(limits(popover.draw()).map((limit) => words(limit)[0])).toEqual(["Sonnet"]);
});

test("every line's reset text unreadable is a failed check, keeping the last numbers", async () => {
  claude(WEEK);
  const { popover } = await opened();
  setSystemTime(NOW + 12 * 60_000);
  claude("Current week (all models): 40% used · resets Someday at noon");
  refresh(popover);
  await settle();
  expect(words(limits(popover.draw())[0])).toContain("12%");
  expectCachedAge(12);
});


test("Claude's reset text handles a date, midnight, the turn of the year, and no reset", async () => {
  setSystemTime(Date.UTC(2026, 11, 31, 20, 0));
  claude(
    "Current week (all models): 10% used · resets Jan 2 at 8:15pm (UTC)",
    "Current week (Sonnet only): 20% used · resets Dec 31 at 9pm (UTC)",
    "Current week (Opus only): 30% used",
    "Current session: 40% used · resets 1am (UTC)",
  );
  await opened();
  expect(cachedLimits()).toEqual([
    { label: "This week", used: 10, resetsAt: Date.UTC(2027, 0, 2, 20, 15) },
    { label: "Sonnet", used: 20, resetsAt: Date.UTC(2026, 11, 31, 21) },
    { label: "Opus", used: 30, resetsAt: null },
    { label: "5 hours", used: 40, resetsAt: Date.UTC(2027, 0, 1, 1) },
  ]);
});

// As Claude printed it on Windows, where `TZ` changes nothing: the machine's own zone, by name.
test("Claude's reset text with a comma and a named zone reads as this computer's time", async () => {
  claude(
    "Current week (all models): 35% used · resets Nov 6, 7:59pm (Europe/London)",
    "Current week (Fable): 3% used · resets Nov 6, 7:59pm (Europe/London)",
    "Current session: 40% used · resets 7pm (Europe/London)",
  );
  const { popover } = await opened();
  expect(limits(popover.draw()).map((limit) => words(limit)[0])).toEqual(["wk", "Fable", "5h"]);
  const [{ limits: saved }] = Object.values<any>(state.shared.usage.entries);
  expect(saved[0].resetsAt).toBe(new Date(2026, 10, 6, 19, 59).getTime());
  expect(saved[2].resetsAt).toBe(new Date(2026, 10, 1, 19, 0).getTime());
});

test("Claude is asked with no hooks, plugins, MCP or saved session, and in UTC", async () => {
  claude(WEEK);
  await opened();
  const asked = state.runs.find((run) => run.line.includes("claude -p /usage"))!.line;
  for (const flag of ["--output-format stream-json --verbose", "--no-session-persistence", "--strict-mcp-config", "--setting-sources=", "TZ=UTC"]) expect(asked).toContain(flag);
  expect(state.runs.every((run) => /claude (auth status|-p \/usage)|printenv PATH|command -v/.test(run.line))).toBe(true);
});

test("Claude's commands run in the PATH of the person's own shell, as a Dock start has none of it", async () => {
  claude(WEEK);
  await opened();
  const asked = state.runs.filter((run) => /claude (auth status|-p)/.test(run.line));
  expect(asked.length).toBe(2);
  for (const run of asked) expect(run.line).toContain("/made/up/bin:/usr/bin");
});

test("no shell PATH to be had still checks, with the PATH Kavex has", async () => {
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

function expectThemeColors(root: El) {
  const palette = Object.values(colors).filter((color): color is string => typeof color === "string");
  const rgb = new Set(palette.map((color) => color.slice(0, 7).toLowerCase()));
  for (const e of all(root)) {
    for (const name of ["bg", "text_color", "border_color"]) {
      const shade = arg(e, name);
      if (typeof shade === "string") expect(rgb.has(shade.slice(0, 7).toLowerCase())).toBe(true);
    }
  }
}

test("colors come from the theme, and the popover sits on the window's darkest color", async () => {
  expect(readFileSync(new URL("../defaults/mods/usage/main.js", import.meta.url), "utf8")).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  claude(WEEK);
  const { popover } = await opened();
  const root = popover.draw();
  expect(arg(root, "bg")).toBe(colors.canvas);
  expectThemeColors(root);
});

test("a list that fits has no scroller to collapse; a longer one scrolls inside the popover's 540 px", async () => {
  const scrolls = (list: El) => list.calls.some(([name]) => name === "overflow_y_scrollbar");
  claude(WEEK);
  const { popover } = await opened();
  expect(scrolls(byId(popover.draw(), "usage-rows")!)).toBe(false);

  const limit = { label: "This week", used: 1 };
  const many = Array.from({ length: 8 }, (_, i) => [`claude|m${i}`, { agent: "claude", name: "Claude Code", icon: "icons/claude.svg", machine: `m${i}`, who: `who${i}`, limits: [limit, limit], checkedAt: 1 }]);
  state.shared.usage = { checkedAt: 1, entries: Object.fromEntries(many) };
  const root = popover.draw(), list = byId(root, "usage-rows")!;
  expect(scrolls(list)).toBe(true);
  expect(arg(list, "h") + 44 + 46 + 2).toBeLessThanOrEqual(540);
  expect(arg(list, "h")).toBeGreaterThan(300);
  expect(arg(root, "min_h")).toBe(0);
  expect(arg(list, "min_h")).toBe(0);
  for (const part of root.kids.map(mine).filter((kid) => kid !== list)) expect(part!.calls.some(([name]) => name === "flex_none")).toBe(true);
});

test("a limit over 100% still fills its bar and no more", async () => {
  claude("Current week (all models): 104% used · resets Nov 6 at 7:59pm (UTC)");
  const { popover } = await opened();
  const [limit] = limits(popover.draw());
  expect(words(limit)).toContain("100%");
  expect(filled(limit)).toBe(100);
});

test("the footer has room for the machine name and agent count", () => {
  state.agentsShown = 12;
  expect(words(footer().draw())).toEqual(expect.arrayContaining(["THIS COMPUTER", "· 12 AGENTS"]));
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
  expect(words(root)).toEqual(expect.arrayContaining(["Codex", "· Pro 100"]));
  expect(limits(root).map(words)).toEqual([
    ["wk", "12%"], ["GPT-5-Spark", "20%"], ["5h", "33%"], ["GPT-5-Spark · 5 hours", "30%"],
  ]);
});

test("a Codex answer with one bucket and no list of them still shows its limits", async () => {
  codex(PRO, { rateLimits: GENERAL, rateLimitsByLimitId: null });
  const { popover } = await opened();
  expect(limits(popover.draw()).map((limit) => words(limit)[0])).toEqual(["wk", "5h"]);
});

test("a model's bucket with no name of its own still shows", async () => {
  codex(PRO, { rateLimits: GENERAL, rateLimitsByLimitId: { codex: GENERAL, codex_other: bucket("codex_other", null, window_(5, 10080, 2)) } });
  const { popover } = await opened();
  expect(limits(popover.draw()).map((limit) => words(limit)[0])).toEqual(["wk", "Codex other", "5h"]);
});

test("a window of any other length reads as what it is", async () => {
  codex(PRO, { rateLimitsByLimitId: { codex: bucket("codex", null, window_(1, 60, 1), window_(2, 1440, 2)), codex_a: bucket("codex_a", "A", window_(3, 45, 1), window_(4, 43200, 2)), codex_b: bucket("codex_b", "B", window_(5, null, 1)) } });
  const { popover } = await opened();
  expect(limits(popover.draw()).map((limit) => words(limit)[0]).sort()).toEqual(["1d", "1h", "A · 30 days", "A · 45 minutes", "B"]);
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
    expect(words(popover.draw())).toContain(`· ${tier}`);
  });
}

test("a Codex plan it doesn't name itself shows no made-up tier", async () => {
  codex({ ...PRO, planType: "unknown" });
  const { popover } = await opened();
  expect(words(popover.draw())).toContain("Codex");
  expect(words(popover.draw())).not.toContain("Unknown");
});

for (const [why, account, rates] of [
  ["signed out, its limits refused", null, null],
  ["signed out, its limits empty", null, {}],
  ["signed out, its limits with no window in them", null, { rateLimits: bucket("codex", null, null), rateLimitsByLimitId: { codex: bucket("codex", null, null) } }],
  ["using an API key", { type: "apiKey" }, null],
  ["using an API key, with limits in the answer", { type: "apiKey" }, RATES],
  ["signed in through Amazon Bedrock", { type: "amazonBedrock", usesCodexManagedCredentials: false }, null],
  ["signed in through Amazon Bedrock, with limits in the answer", { type: "amazonBedrock", usesCodexManagedCredentials: false }, RATES],
] as const) {
  test(`Codex ${why} clears previously read usage and shows account status`, async () => {
    codex();
    const { popover } = await opened();
    expect(limits(popover.draw()).length).toBe(4);

    state.says["app-server"] = codexSays(account, rates);
    refresh(popover);
    await settle();
    expect(words(popover.draw())).toContain("Codex");
    expect(words(popover.draw())).toContain(account === null ? "not signed in" : "This account uses API billing.");
  });
}

for (const [why, answer] of [
  ["a failure", new Error("sh took longer than 30 s and was stopped")],
  ["nothing at all", ""],
  ["text that isn't JSON", "Error: something went wrong\n"],
  ["no answer about the account", JSON.stringify({ error: { code: -32603, message: "made up" }, id: 2 })],
  ["no answer about the limits", codexSays(PRO, null)],
  ["no account beside real limits", codexSays(null)],
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
    expectCachedAge(12);
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
  expect(state.runs.every((run) => /app-server|printenv PATH|command -v/.test(run.line))).toBe(true);
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
function realShell(program: string, says: string, after = 0.5, gap = 0) {
  const dir = mkdtempSync(join(tmpdir(), "usage-test-"));
  scratch.push(dir);
  mkdirSync(join(dir, "tmp"));
  mkdirSync(join(dir, program, ".."), { recursive: true });
  const answers = says.trim().split("\n").filter((line) => line.includes('"id"')).map((line) => `printf '%s\\n' '${line}'`).join(`\nsleep ${gap}\n`);
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

test("Codex requests the account and limits only after a successful initialize reply", async () => {
  const dir = realShell("codex", codexSays(PRO));
  const server = join(dir, "codex");
  const answers = codexSays(PRO).trim().split("\n");
  writeFileSync(server, `#!/bin/sh
read -r init
exec 5<&0
(
  read -r notification
  [ -f "${dir}/ready" ] || touch "${dir}/early"
  read -r account
  read -r limits
  printf '%s\\n' "$init" "$notification" "$account" "$limits" > "${dir}/requests"
  printf '%s\\n' '${answers[2]}' '${answers[3]}'
  while read -r line; do :; done
) <&5 &
printf '%s\\n' '{"id":1,"method":"unrelated/request","params":{"result":{}}}'
sleep 0.4
touch "${dir}/ready"
printf '%s\\n' '${answers[0]}'
wait
`);
  const { popover } = await opened();
  await checked();
  expect(limits(popover.draw()).length).toBe(4);
  expect(existsSync(join(dir, "early"))).toBe(false);
  expect(readFileSync(join(dir, "requests"), "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    expect.objectContaining({ jsonrpc: "2.0", method: "initialized" }),
    expect.objectContaining({ jsonrpc: "2.0", id: 2, method: "account/read" }),
    expect.objectContaining({ jsonrpc: "2.0", id: 3, method: "account/rateLimits/read" }),
  ]);
}, 10_000);

test("an incomplete Codex window cannot replace the last real reading with zero", async () => {
  codex();
  const { popover } = await opened();
  state.says["app-server"] = codexSays(PRO, { rateLimits: bucket("codex", null, { windowDurationMins: 10080 }) });
  refresh(popover);
  await settle();
  expect(words(popover.draw())).toContain("12%");
  expectCachedAge(0);
});

test("a Codex reply split across writes is read after the closing brace", async () => {
  const dir = realShell("codex", codexSays(PRO));
  const [init, , account, limitsReply] = codexSays(PRO).trim().split("\n");
  writeFileSync(join(dir, "codex"), `#!/bin/sh
read -r init
printf '%s\\n' '${init}'
read -r notification
read -r account
read -r limits
printf '%s\\n' '${account}'
printf '%s' '{"id":3,"result":'
sleep 0.6
printf '%s\\n' '${limitsReply.slice('{"id":3,"result":'.length)}'
while read -r line; do :; done
`);
  const { popover } = await opened();
  await checked();
  expect(limits(popover.draw()).length).toBe(4);
}, 10_000);

test("a Codex that answers limits before the account still gets to finish", async () => {
  realShell("codex", codexSays(PRO).trim().split("\n").reverse().join("\n"), 0.1, 0.5);
  const { popover } = await opened();
  await checked();
  expect(limits(popover.draw()).length).toBe(4);
}, 10_000);

test("a signed-out Codex's refused last answer ends the wait too", async () => {
  realShell("codex", codexSays(null, null));
  const started = Bun.nanoseconds();
  const { popover } = await opened();
  await checked();
  expect(words(popover.draw())).toContain("not signed in");
  expect((Bun.nanoseconds() - started) / 1e9).toBeLessThan(5);
}, 10_000);

test("Codex is asked read-only, with no approvals", async () => {
  const dir = realShell("codex", codexSays(PRO));
  await opened();
  await checked();
  expect(readFileSync(join(dir, "asked"), "utf8").trim()).toBe("-c approval_policy=never -c features.plugins=false -s read-only -a never app-server");
}, 10_000);

test("a path the shell would take apart still runs as itself, and only that", async () => {
  const program = "it's my; touch injected #/codex", dir = realShell(program, codexSays(PRO));
  state.agents[""] = [{ ...CODEX, run: [join(dir, program)] }];
  const { popover } = await opened();
  await checked();
  expect(limits(popover.draw()).length).toBe(4);
  expect(existsSync(join(dir, "injected"))).toBe(false);
  expect(existsSync("injected")).toBe(false);
}, 10_000);

test("a custom path to claude in programs.json is used, and the person's flags stay out of the checks", async () => {
  claude(WEEK);
  state.agents[""] = [{ ...CLAUDE, run: ["/opt/made-up/bin/claude", "--profile", "work"] }];
  const { popover } = await opened();
  expect(limits(popover.draw()).length).toBe(1);
  const asked = state.runs.filter((run) => /claude (auth status|-p)/.test(run.line));
  expect(asked.length).toBe(2);
  for (const run of asked) {
    expect(run.line).toContain("/opt/made-up/bin/claude ");
    expect(run.line).not.toContain("--profile");
  }
});

test("a custom path to codex in programs.json is used, and the person's flags stay out of the checks", async () => {
  codex();
  state.agents[""] = [{ ...CODEX, run: ["/opt/made-up/bin/codex", "--profile", "work"] }];
  await opened();
  const asked = state.runs.find((run) => run.line.includes("app-server"))!.line;
  expect(asked).toContain("/opt/made-up/bin/codex -c approval_policy=never -c features.plugins=false -s read-only -a never app-server");
  expect(asked).not.toContain("--profile");
});

test("a custom path with a space in it stays one word", async () => {
  claude(WEEK);
  state.agents[""] = [{ ...CLAUDE, run: ["/opt/made up/claude"] }];
  state.says["'/opt/made up/claude' auth status"] = JSON.stringify(ACCOUNT);
  state.says["'/opt/made up/claude' -p /usage"] = usageAnswer(WEEK);
  const { popover } = await opened();
  expect(limits(popover.draw()).length).toBe(1);
});

test("a program of another name in programs.json isn't started: the plain agent is, once its shell finds it", async () => {
  claude(WEEK);
  state.agents[""] = [{ ...CLAUDE, run: ["my-claude", "--profile", "work"] }];
  state.says["command -v"] = "kavex-has:claude\nkavex-asked\n";
  const { popover } = await opened();
  expect(limits(popover.draw()).length).toBe(1);
  expect(state.runs.filter((run) => run.line.includes("my-claude"))).toEqual([]);
});

test("a program of another name with no plain agent to run gives no row, as it's the plain one that's missing", async () => {
  claude(WEEK);
  state.agents[""] = [{ ...CLAUDE, run: ["my-claude"] }];
  state.says["command -v"] = "kavex-asked\n";
  const { popover } = await opened();
  expect(checks()).toBe(0);
  expect(words(popover.draw())).toContain(NONE);
});

test("on Windows the agents are asked through PowerShell, with no PATH to fetch and their paths quoted for it, .exe and .cmd counting as theirs", async () => {
  state.platform = "windows";
  claude(WEEK);
  state.agents[""] = [{ ...CLAUDE, run: ["C:\\made up\\it's\\claude.exe", "--profile", "work"] }, { ...CODEX, run: ["C:\\made up\\it’s\\codex.CMD"] }];
  delete state.says["printenv PATH"];
  state.says["auth status"] = JSON.stringify(ACCOUNT);
  state.says["/usage"] = usageAnswer(WEEK);
  state.says["app-server"] = codexSays(PRO);
  const { popover } = await opened();
  expect(limits(popover.draw()).length).toBe(5);
  expect(state.runs.every((run) => run.line.startsWith("powershell -NoLogo -NoProfile -Command"))).toBe(true);
  expect(state.runs.filter((run) => /auth status|\/usage|app-server/.test(run.line))).toHaveLength(3);
  const line = (piece: string) => state.runs.find((run) => run.line.includes(piece))!.line;
  expect(line("auth status")).toEndWith("-Command & 'C:\\made up\\it''s\\claude.exe' auth status");
  expect(line("/usage")).toContain("$env:TZ='UTC'; & 'C:\\made up\\it''s\\claude.exe' -p /usage");
  expect(line("app-server")).toContain(`'/d /c ""' + 'C:\\made up\\it’’s\\codex.CMD' + '" -c approval_policy=never -c features.plugins=false -s read-only -a never app-server 2>nul"'`);
});

// Windows PowerShell gives a pipe's input to a program only once the pipe has ended, and the server
// stops answering when its input ends: a sleep in a pipe got the first answer and no others.
test("on Windows Codex's input stays open in a process of its own until both answers are in", async () => {
  state.platform = "windows";
  state.agents[""] = [CODEX];
  delete state.says["printenv PATH"];
  state.says["app-server"] = codexSays(PRO);
  await opened();
  const asked = state.runs.find((run) => run.line.includes("app-server"))!.line;
  expect(asked).not.toContain("Start-Sleep");
  expect(asked).toContain("RedirectStandardInput = $true");
  expect(asked).toMatch(/Send-Line ''[\s\S]*"method":"initialize"[\s\S]*until \(\$reply\.message\.id -eq 1\)[\s\S]*"method":"initialized"[\s\S]*"method":"account\/rateLimits\/read"/);
  expect(asked).toContain("$server.StandardInput.Close()");
});

test.skipIf(process.platform !== "win32")("native Windows Codex probe waits for initialize and reads both replies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage probe "));
  scratch.push(dir);
  const server = join(dir, "codex.cmd");
  writeFileSync(server, '@echo off\r\n"' + process.execPath + '" "%~dp0server.js"\r\n');
  writeFileSync(join(dir, "server.js"), `
import { createInterface } from "node:readline";
let ready = false;
const send = (message) => console.log(JSON.stringify(message));
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.jsonrpc !== "2.0") process.exit(1);
  if (request.method === "initialize") {
    send({ id: 1, method: "windows/unrelated", params: { result: {} } });
    setTimeout(() => {
      ready = true;
      send({ result: { userAgent: "made-up/0" }, id: 1 });
    }, 300);
    return;
  }
  if (!ready) process.exit(1);
  if (request.method === "account/rateLimits/read") {
    send({ id: 2, method: "windows/unrelated", params: {} });
    send({ result: ${JSON.stringify(RATES)}, id: 3 });
    setTimeout(() => send({ id: 2, result: { account: ${JSON.stringify(PRO)} } }), 100);
  }
});
`);
  state.platform = "windows";
  state.agents[""] = [{ ...CODEX, run: [server] }];
  let result: { code: number; stdout: string; stderr: string } | undefined;
  state.says["app-server"] = async ({ args }) => {
    const child = Bun.spawn(["powershell.exe", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    result = { code, stdout, stderr };
    return result;
  };
  const { popover } = await opened();
  await checked();
  expect(result?.code, result?.stderr).toBe(0);
  expect(limits(popover.draw()).length).toBe(4);
}, 15_000);

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
  const on = (name: string) => state.runs.filter((run) => run.on === name && /printenv PATH|claude auth status|claude -p \/usage|app-server/.test(run.line));
  expect(on("vps").length).toBe(3);
  expect(on("box").length).toBe(4);
  for (const run of [...on("vps"), ...on("box")].filter((run) => !run.line.includes("printenv PATH"))) expect(run.line).toContain(SHELL.trim());
});

test("a row on this computer alone has no machine label, even with a machine added", async () => {
  claude(WEEK);
  added("vps");
  const { popover } = await opened();
  expect(words(rows(popover.draw())[0])).toEqual(["Claude Code", "· Max", "Resets in 5d 7h", "wk", "12%"]);
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
  expect(words(shown[0])).toEqual(expect.arrayContaining(["vps", "20%"]));
  expect(words(shown[1])).toEqual(expect.arrayContaining(["This computer", "10%"]));
});

test("different agents on two machines leave this computer's row unlabelled, as nothing needs telling apart", async () => {
  claude(WEEK);
  added("vps");
  state.agents.vps = [CODEX];
  state.on.vps = { "printenv PATH": SHELL, "app-server": codexSays(PRO) };
  const { popover } = await opened();
  const shown = rows(popover.draw());
  expect(words(shown.find((row) => words(row).includes("Claude Code"))!)).not.toContain("This computer");
  expect(words(shown.find((row) => words(row).includes("Codex"))!)).toContain("vps");
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
  expect(words(root)).toContain("vps");
  expectCachedAge(12);
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
  expectCachedAge(12);
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
    expect(cachedRows().every((row) => !row.failed)).toBe(true);
  });
}

test("a failed usage check on a newly signed-in account clears the old account reading", async () => {
  claude(WEEK);
  const { popover } = await opened();
  state.says["claude auth status"] = JSON.stringify(OTHER);
  state.says["claude -p /usage"] = new Error("unavailable");
  refresh(popover);
  await settle();
  expect(limits(popover.draw())).toEqual([]);
  expect(words(popover.draw())).toContain("Could not check");
});

test("a shared row failing everywhere shows the newest it has, with its age", async () => {
  claude(weekAt(10));
  claudeOn("vps", ACCOUNT, weekAt(10));
  const { popover } = await opened();
  setSystemTime(NOW + 12 * 60_000);
  state.says["claude -p /usage"] = state.on.vps["claude -p /usage"] = new Error("no");
  refresh(popover);
  await settle();
  expectCachedAge(12);
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

const SURE_NOT = "kavex-asked\n";

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
    expectCachedAge(12);
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
  state.agents.vps = [{ ...CLAUDE, installed: false, run: ["/opt/made-up/claude"] }];
  state.on.vps["command -v"] = "kavex-has:/opt/made-up/claude\nkavex-asked\n";
  const { popover } = await opened();
  expect(limits(popover.draw()).length).toBe(1);
  const asked = state.runs.find((run) => run.line.includes("command -v"))!;
  expect(asked.on).toBe("vps");
  expect(asked.line).toContain(SHELL.trim());
});

test("the shell's own word on what's installed works in a real sh", async () => {
  realShell("codex", codexSays(PRO));
  state.agents[""] = [{ ...CODEX, installed: false }, { ...CLAUDE, installed: false, run: ["/no/such/folder/claude"] }];
  const { popover } = await opened();
  await checked();
  expect(rows(popover.draw()).length).toBe(1);
  expect(words(popover.draw())).toContain("Codex");
}, 10_000);

test("on Windows PowerShell says what's installed", async () => {
  state.platform = "windows";
  state.agents[""] = [{ ...CODEX, installed: false }];
  state.says["app-server"] = codexSays(PRO);
  state.says["Get-Command"] = "kavex-has:codex\r\nkavex-asked\r\n";
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
    expectCachedAge(12);
  });
}


test("an added machine gets an OpenCode setup row before any credential check", async () => {
  claudeOn("vps", ACCOUNT, WEEK);
  state.agents.vps.push(OPENCODE);
  const { popover } = await opened();
  expect(rows(popover.draw())).toHaveLength(2);
  expect(state.shared.usage.entries["opencode|vps"]).toMatchObject({ ask: true, state: "setup", limits: [] });
  expect(state.reads).toEqual([]);
  expect(state.fetched).toEqual([]);
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

test("the first background check starts 1 second after launch, with nothing opened", async () => {
  claude(WEEK);
  footer();
  await wait(999);
  expect(checks()).toBe(0);
  await wait(1);
  expect(checks()).toBe(1);
});

test("limits are checked every 15 minutes with the popover closed, and not sooner", async () => {
  claude(WEEK);
  const f = footer();
  await wait(5_000);
  chooseUsage(f);
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
  expect(words(providerPopover(openedAfter(), "claude").draw())).toContain("Updated just now");
});

const AT = (percent: number) => `Current week (all models): ${percent}% used · resets Nov 6 at 7:59pm (UTC)`;
const dotOn = (root: El) => all(byId(root, "footer-more")!).find((e) => e.calls.some(([name]) => name === "rounded_full"));

test("More actions gets an orange dot at 90% used, with the menu closed", async () => {
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


test("overview and details use Kavex provider colors and the near-limit theme color", async () => {
  claude(AT(45), "Current week (Sonnet only): 80% used", "Current week (Opus only): 90% used");
  const { popover } = await opened();
  const overview = limits(popover.draw());
  expect(new Set(overview.map(barColor)).size).toBe(1);
  const detail = limits(providerPopover(popover, "claude").draw());
  expect(detail.map(barColor)).toEqual([colors.accent, colors.accent, colors.blocked]);
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

test("the roster always shows all windows with only Used and Left choices", async () => {
  delete state.shared["usage.presentation"];
  claude(WEEK, SESSION);
  const { popover } = await opened();
  const root = popover.draw(), display = byId(root, "usage-display")!;
  expect(words(display)).toEqual(["Used", "Left"]);
  expect(paths(display)).toEqual([]);
  expect(arg(display, "p")).toBe(3);
  expect(arg(display, "bg")).toBe(colors.pill);
  expect(arg(byId(root, "usage-used")!, "bg")).toBe(colors.pill_selected);
  expect(arg(byId(root, "usage-used")!, "h")).toBe(26);
  expect(byId(root, "usage-density")).toBeUndefined();
  expect(limits(root).map(words)).toEqual([["wk", "12%"], ["5h", "33%"]]);

  state.shared["usage.presentation"] = { display: "used", mode: "compact" };
  expect(limits(popover.draw()).map(words)).toEqual([["wk", "12%"], ["5h", "33%"]]);

  handler(byId(root, "usage-remaining")!, "on_click")({}, cx);
  expect(arg(byId(popover.draw(), "usage-remaining")!, "bg")).toBe(colors.pill_selected);
  expect(limits(popover.draw()).map(words)).toEqual([["wk", "88%"], ["5h", "67%"]]);
  expect(state.shared["usage.presentation"]).toEqual({ display: "remaining" });

  const detail = providerPopover(popover, "claude");
  expect(arg(byId(detail.draw(), "usage-remaining")!, "aria_selected")).toBe(true);
  handler(byId(detail.draw(), "usage-used")!, "on_click")({}, cx);
  expect(limits(detail.draw()).map(words).flat()).toContain("33%");
  expect(state.shared["usage.presentation"]).toEqual({ display: "used" });
});

test("the roster links to provider details, refresh history and account management", async () => {
  claude(WEEK);
  const { popover } = await opened();
  const [row] = rows(popover.draw());
  expect(handler(row, "on_mouse_move")).toBeUndefined();
  expect(handler(row, "on_hover")).toBeUndefined();

  const overlayCount = state.overlays.length;
  const detail = providerPopover(popover, "claude");
  expect(state.overlays.length).toBe(overlayCount);
  expect(byId(detail.draw(), "usage-provider")).toBeDefined();
  expect(words(detail.draw())).toEqual(expect.arrayContaining(["This week", "12%", "Updated just now"]));
  handler(byId(detail.draw(), "usage-back")!, "on_click")({}, cx);
  expect(state.overlays.length).toBe(overlayCount);
  expect(byId(popover.draw(), "usage-rows")).toBeDefined();

  handler(popover.draw(), "on_key_down")({ key: "right" }, cx);
  expect(byId(popover.draw(), "usage-provider")).toBeDefined();
  handler(popover.draw(), "on_key_down")({ key: "left" }, cx);
  expect(byId(popover.draw(), "usage-rows")).toBeDefined();
  expect(state.overlays.length).toBe(overlayCount);

  handler(byId(popover.draw(), "usage-history")!, "on_click")({}, cx);
  const historyDialog = openPopover();
  const history = historyDialog.draw();
  expect(byId(history, "usage-history-page")).toBeDefined();
  const { width, height } = state.overlays.at(-1);
  expectThemeColors(history);
  expect(words(history)).toEqual(expect.arrayContaining(["Claude Code", "12%"]));
  handler(byId(history, "usage-remaining")!, "on_click")({}, cx);
  expect(words(historyDialog.draw())).toContain("88%");

  handler(byId(popover.draw(), "usage-accounts")!, "on_click")({}, cx);
  const accounts = openPopover().draw();
  expect(byId(accounts, "usage-accounts-page")).toBeDefined();
  expect(state.overlays.at(-1)).toMatchObject({ width, height });
  expectThemeColors(accounts);
  expect(words(accounts)).toContain("Claude Code");

  for (const [root, name] of [[history, "history"], [accounts, "accounts"]] as const) {
    expect(arg(root, "bg")).toBe(colors.panel);
    expect(root.calls.some(([method]) => method === "border_1")).toBe(false);
    expect(mine(root.kids[1])).toBe(byId(root, `usage-${name}-list`));
    expect(arg(byId(root, "usage-close")!, "accessibility_label")).toBe("Close");
  }
});

test("saved provider readings without a window length still render", async () => {
  claude(WEEK);
  const { popover } = await opened();
  state.shared.usage.entries["claude|"].limits = [{ label: "This week", used: 80, resetsAt: NOW + 3 * 86_400_000 }];
  expect(limits(popover.draw()).map(words)).toEqual([["This week", "80%"]]);
});

test("the standalone Usage button opens the roster at the right edge for the active machine", async () => {
  claude(WEEK);
  claudeOn("vps", OTHER, AT(81));
  await opened();
  state.space = { id: "remote", active: true, machine: "vps" };
  const view: any = new WorkspaceStatus();
  state.props = { usage: true };
  const status = view.render(cx).el as El;
  expect(arg(status, "bg")).toBeUndefined();
  expect(arg(status, "border_t")).toBeUndefined();
  expect(status.calls.some(([name]) => name === "justify_end")).toBe(true);
  const strip = byId(status, "usage-status")!;
  expect(words(strip)).toEqual(["Usage"]);
  expect(paths(strip)).toEqual(["mods/workspace-chrome/icons/heroicons/chart-pie.svg"]);
  handler(strip, "on_mouse_down")({ bounds: BUTTON }, cx);
  handler(strip, "on_click")({}, cx);
  expect(state.overlays.at(-1)).toMatchObject({ mod: "usage", width: 400, props: { from: "usage-status", machine: "vps" } });
  expect(state.overlays.at(-1).at).toEqual({ x: BUTTON.x + BUTTON.width - 400, y: BUTTON.y - (92 + 53 + 23) - 8 });

  state.shared["usage.enabled"] = false;
  expect(byId(view.render(cx).el, "usage-status")).toBeUndefined();
});

test("Keep computer awake sits beside Usage and stays available when usage checks are off", () => {
  const view = new WorkspaceStatus();
  state.props = { usage: true };
  const status = view.render().el;
  const controls = all(status).filter((el) => ["keep-awake", "usage-status"].includes(arg(el, "id")));
  expect(controls.map(words)).toEqual([["Usage"], ["Keep awake"]]);
  state.shared["usage.enabled"] = false;
  expect(byId(view.render().el, "keep-awake")).toBeDefined();
  expect(byId(view.render().el, "usage-status")).toBeUndefined();
});

test("the awake menu opens upward, picks a mode with the keyboard, and toggles closed on a second press", () => {
  const view = new WorkspaceStatus();
  state.props = { usage: true };
  const trigger = byId(view.render().el, "keep-awake")!;
  expect(arg(trigger, "tab_index")).toBe(0);
  const click = () => {
    handler(trigger, "on_mouse_down")({ bounds: BUTTON }, cx);
    handler(trigger, "on_click")({}, cx);
  };
  click();
  const popup = state.overlays[0];
  expect(popup).toMatchObject({ mod: "workspace-status", kind: "popup", props: { awakeMenu: true } });
  expect(popup.at.x + popup.width).toBe(BUTTON.x + BUTTON.width);
  expect(popup.at.y + popup.height).toBeLessThan(BUTTON.y);
  expect(words(view.render().el)).not.toContain("Closing the Mac's lid still allows sleep.");

  // A press on the trigger dismisses the open popup before the click reaches the trigger.
  state.props = { ...popup.props, overlay: "awake-popup" };
  new WorkspaceStatus().close();
  state.props = { usage: true };
  click();
  expect(state.overlays).toHaveLength(1);

  setSystemTime(Date.now() + 101);
  click();
  expect(state.overlays).toHaveLength(2);
  state.props = { ...popup.props, overlay: "awake-popup" };
  const menu = new WorkspaceStatus();
  menu.init({}, cx);
  const tree = menu.render().el;
  expect(arg(byId(tree, "awake-off")!, "aria_selected")).toBe(true);
  const key = handler(byId(tree, "awake-menu")!, "on_key_down");
  key({ key: "up" }, cx);
  const focused = menu.render().el;
  expect(arg(byId(focused, "awake-auto")!, "border_color")).toBe(colors.accent);
  expect(arg(byId(focused, "awake-auto")!, "aria_selected")).toBe(false);
  expect(arg(byId(focused, "awake-off")!, "aria_selected")).toBe(true);
  key({ key: "enter" }, cx);
  expect(state.shared["awake.mode"]).toBe("auto");
  expect(state.closedOverlays).toEqual(["awake-popup"]);

  state.props = { usage: true };
  state.awake = { mode: "auto", active: true };
  expect(arg(byId(view.render().el, "keep-awake")!, "accessibility_label")).toBe("Keep computer awake, Agent · Active");
});

test("hover emphasizes a single spaced row and leaves the saved mode checked", () => {
  state.props = { awakeMenu: true, overlay: "awake-popup" };
  const menu = new WorkspaceStatus();
  menu.init({}, cx);
  const resting = menu.render().el;
  expect(arg(byId(resting, "awake-options")!, "gap")).toBe(4);
  expect(words(byId(resting, "awake-auto")!)).toEqual(["Agent", "While local agents work"]);
  const hover = handler(byId(resting, "awake-on")!, "on_hover");
  hover(true, cx);
  const pointed = menu.render().el;
  const on = byId(pointed, "awake-on")!, off = byId(pointed, "awake-off")!;
  expect(arg(on, "bg")).toBe(`${colors.foreground.slice(0, 7)}24`);
  expect(arg(off, "bg")).toBeUndefined();
  expect(arg(off, "aria_selected")).toBe(true);
  expect(paths(off)).toEqual(["mods/workspace-chrome/icons/check.svg"]);
  hover(false, cx);
  expect(arg(byId(menu.render().el, "awake-off")!, "bg")).toBe(colors.selected);
});

test("reaching 90% raises one toast saying which limit and when it resets", async () => {
  claude(AT(92));
  footer();
  await wait(5_000);
  expect(state.notes).toEqual([{ title: "Claude Code limit at 92%", body: "This week, resets in 5d 7h", level: "warning" }]);
});

test("under 90% raises none, and neither does the check after it that stays under", async () => {
  claude(AT(89));
  footer();
  await wait(5_000 + 15 * 60_000);
  expect(state.notes).toEqual([]);
  expect(state.shared["usage.warned"] ?? []).toEqual([]);
});

test("a limit past 90 warns once, however many checks and however its reset time drifts", async () => {
  claude(weekAt(70));
  const f = footer();
  await wait(5_000);
  expect(state.notes).toEqual([]);
  state.says["claude -p /usage"] = usageAnswer("Current week (all models): 91% used · resets Nov 4 at 12:00pm (UTC)");
  await wait(16 * 60_000);
  expect(state.notes.length).toBe(1);
  state.says["claude -p /usage"] = usageAnswer("Current week (all models): 95% used · resets Nov 4 at 12:01pm (UTC)");
  await wait(16 * 60_000);
  state.says["claude -p /usage"] = usageAnswer("Current week (all models): 99% used · resets Nov 4 at 11:59am (UTC)");
  await wait(16 * 60_000);
  expect(state.notes.length).toBe(1);
  f.close();
});

test("a restart doesn't repeat it: what's been warned about is saved", async () => {
  claude(AT(92));
  const first = footer();
  await wait(5_000);
  first.close();
  await wait(2 * 60_000);
  footer();
  await wait(5_000);
  expect(state.notes.length).toBe(1);
});

test("after a reset and a low reading, crossing 90% can warn again", async () => {
  claude("Current session: 92% used · resets 12:04pm (UTC)");
  footer();
  await wait(5_000);
  expect(state.notes.length).toBe(1);

  state.says["claude -p /usage"] = usageAnswer("Current session: 3% used · resets 5pm (UTC)");
  await wait(4 * 60_000);
  expect(state.shared["usage.warned"]).toEqual([]);

  state.says["claude -p /usage"] = usageAnswer("Current session: 90% used · resets 5pm (UTC)");
  await wait(16 * 60_000);
  expect(state.notes.map((note) => note.title)).toEqual(["Claude Code limit at 92%", "Claude Code limit at 90%"]);
});

test("each limit warns for itself", async () => {
  claude(AT(92));
  footer();
  await wait(5_000);
  state.says["claude -p /usage"] = usageAnswer(AT(93), "Current session: 96% used · resets 3:30pm (UTC)");
  await wait(16 * 60_000);
  expect(state.notes.map((note) => note.body.split(",")[0])).toEqual(["This week", "5 hours"]);
});

test("a failed check repeats nothing, and neither do the numbers it keeps", async () => {
  claude(AT(92));
  footer();
  await wait(5_000);
  state.says["claude -p /usage"] = new Error("no answer");
  await wait(16 * 60_000);
  expect(state.notes.length).toBe(1);
  expect(state.shared["usage.warned"].length).toBe(1);
});

test("one account on two machines warns once, and a limit with no reset time still can", async () => {
  claude("Current week (all models): 92% used");
  state.machines = [{ name: null, layout: "ready" }, { name: "studio", layout: "ready" }];
  state.agents.studio = [CLAUDE];
  state.on.studio = state.says;
  footer();
  await wait(5_000);
  expect(state.notes).toEqual([{ title: "Claude Code (This computer, studio) limit at 92%", body: "This week", level: "warning" }]);
});

test("different accounts warn apart, though their limits share a name", async () => {
  claude(AT(92));
  state.machines = [{ name: null, layout: "ready" }, { name: "studio", layout: "ready" }];
  state.agents.studio = [CLAUDE];
  state.on.studio = { ...state.says, "claude auth status": JSON.stringify({ ...ACCOUNT, email: "other@example.test" }) };
  footer();
  await wait(5_000);
  expect(state.notes.map((note) => note.title).sort()).toEqual(["Claude Code (This computer) limit at 92%", "Claude Code (studio) limit at 92%"]);
});

test("what's saved about a warning holds no login, email or organisation", async () => {
  claude(AT(92));
  footer();
  await wait(5_000);
  const saved = JSON.stringify(state.shared["usage.warned"]);
  for (const secret of [ACCOUNT.email, ACCOUNT.orgId, ACCOUNT.orgName]) expect(saved).not.toContain(secret);
  expect(saved).toContain("This week");
});

test("turning it off clears the warnings too, so turned back on it warns again", async () => {
  claude(AT(92));
  footer();
  await wait(5_000);
  expect(state.notes.length).toBe(1);
  flip();
  expect(state.shared["usage.warned"] ?? null).toBeNull();
  flip();
  await wait(61_000);
  expect(state.notes.length).toBe(2);
});

test("a check cut off by turning it off raises nothing", async () => {
  let answer: (reply: string) => void = () => {};
  claude(AT(92));
  state.says["claude -p /usage"] = () => new Promise<Reply>((resolve) => { answer = resolve; });
  footer();
  await wait(5_000);
  flip();
  answer(usageAnswer(AT(92)));
  await settle();
  expect(state.notes).toEqual([]);
});

test("OpenCode's limits warn too, as soon as Allow brings them", async () => {
  opencode();
  state.answers[GO] = go({ usage: { ...GO_SAYS.usage, weekly: { percent: 94, resetsAt: "2026-11-03T12:00:00Z" } } });
  const { popover } = await opened();
  expect(state.notes).toEqual([]);
  reply(popover, ALLOW);
  await settle();
  expect(state.notes).toEqual([{ title: "OpenCode limit at 94%", body: "This week, resets in 2d 0h", level: "warning" }]);
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
  const card = all(root).filter((e) => byId(e, "st-panel-files") && byId(e, "st-usage")).at(-1)!;
  expect(arg(card, "bg")).toBe(colors.card);
  expect(arg(byId(root, "st-usage-knob")!, "left")).toBe(18);
  flip();
  expect(state.shared["usage.enabled"]).toBe(false);
  expect(arg(byId(settingsPage(), "st-usage-knob")!, "left")).toBe(2);
});

test("turning Usage limits off leaves Add machine and Customize in the menu", () => {
  flip();
  press(footer(), "footer-more");
  expect(words(footerMenu().draw())).toEqual(["Add machine", "Customize"]);
});

test("turned off, nothing runs: not at launch, not on the timer, not when asked", async () => {
  claude(WEEK);
  flip();
  footer();
  const popover = openedAfter();
  await settle();
  refresh(popover);
  await settle();
  await wait(2 * 3600_000);
  expect(state.runs).toEqual([]);
  expect(state.fetched).toEqual([]);
  expect(byId(footerMenu().draw(), "footer-action-usage")).toBeUndefined();
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
  expect(dotOn(f.draw())).toBeUndefined();
  expect(byId(footerMenu().draw(), "footer-action-usage")).toBeUndefined();
});

test("turning it back on restores Usage limits and checks again, with no old numbers", async () => {
  claude(AT(95));
  const f = footer();
  await wait(5_000);
  flip();
  await wait(5 * 60_000);
  expect(checks()).toBe(1);

  claude(AT(20));
  flip();
  expect(byId(footerMenu().draw(), "footer-action-usage")).toBeDefined();
  expect(dotOn(f.draw())).toBeUndefined();
  await wait(60_000);
  expect(checks()).toBe(2);
  expect(state.shared.usage.entries["claude|"].limits[0].used).toBe(20);
});

test("turning it back on asks OpenCode's question again", async () => {
  state.says["printenv PATH"] = "/made/up/bin\n";
  state.agents[""] = [OPENCODE];
  state.shared["usage.opencode"] = false;
  footer();
  await wait(5_000);
  expect(state.shared.usage.entries["opencode|"]).toMatchObject({ ask: false, state: "unavailable", limits: [] });

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
  state.agents[""] = [OPENCODE];
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

test("an older check finishing late cannot replace a newer good reading", async () => {
  const first = held();
  claude(WEEK);
  state.says["claude -p /usage"] = first.answer;
  const { popover } = await opened();
  claude(weekAt(25));
  await wait(2 * 60_000);
  expect(words(popover.draw())).toContain("25%");
  first.release(usageAnswer(weekAt(90)));
  await settle();
  expect(words(popover.draw())).toContain("25%");
  expect(state.notes).toEqual([]);
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
const ASKS = "Kavex reads your OpenCode key and sends it only to opencode.ai, to ask for your Go plan's limits.";

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
  expect(words(root)).toEqual(expect.arrayContaining(["OpenCode", "Connect usage"]));
  expect(words(providerPopover(popover, "opencode").draw())).toEqual(expect.arrayContaining([ASKS, "Allow", "Not now"]));
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
  expect(words(popover.draw())).not.toContain("Connect usage");
  expect(words(popover.draw())).toContain(NONE);
});

const reply = (popover: { draw: () => El }, id: string, provider = "opencode") => {
  const detail = providerPopover(popover, provider);
  const button = all(detail.draw()).find((node) => String(arg(node, "id")).startsWith(id + "-"));
  if (!button) throw new Error("Usage consent button is missing: " + provider);
  handler(button, "on_click")({}, cx);
  handler(byId(detail.draw(), "usage-back")!, "on_click")({}, cx);
};
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
  expect(words(popover.draw())).toContain("Usage access declined");
  expect(words(popover.draw())).not.toContain("Connect usage");
  expect(state.shared["usage.opencode"]).toBe(false);

  await wait(60_000);
  refresh(popover);
  await settle();
  await wait(2 * 3600_000);
  expect(words(popover.draw())).not.toContain("Connect usage");
  expect(opencodeRow()).toMatchObject({ ask: false, state: "unavailable", limits: [] });
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
  expect(words(root)).not.toContain("Connect usage");
  expect(words(root)).toEqual(expect.arrayContaining(["OpenCode", "· Go"]));
  expect(limits(root).map((limit) => words(limit))).toEqual([
    ["wk", "12%"], ["5h", "33%"], ["30d", "4%"],
  ]);
  expect(state.fetched.length).toBe(1);
  expect(words(providerPopover(popover, "opencode").draw())).toContain("Updated just now");
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
  expect(words(popover.draw())).toContain("Connect usage");
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
  expect(limits(popover.draw()).map((limit) => words(limit)[0])).toContain("30d");
  expect(checkingShown(popover.draw())).toBe(true);
  expect(checks()).toBe(2);

  usage.release(usageAnswer(AT(50)));
  await settle();
  expect(limits(popover.draw()).map((limit) => words(limit).slice(0, 2))).toEqual(expect.arrayContaining([["30d", "4%"], ["wk", "50%"]]));
  expect(words(popover.draw())).not.toContain("Connect usage");
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
  expect(words(popover.draw())).not.toContain("Connect usage");
  expect(words(popover.draw())).not.toContain(NONE);

  request.release(go()());
  await settle();
  expect(state.shared.usage.entries["claude|"].limits[0].used).toBe(50);
  expect(opencodeRow().limits.length).toBe(3);
});

for (const [why, answerGo, row] of [
  ["a refused key", go({}, 401), "not signed in"],
  ["no network", new Error("offline"), "OpenCode Go usage is unavailable."],
] as const) {
  test(`${why} from Allow's check stands when the running check ends after it`, async () => {
    const { popover, usage } = await allowDuringAPass();
    state.answers[GO] = answerGo;
    reply(popover, ALLOW);
    await settle();
    usage.release(usageAnswer(AT(50)));
    await settle();
    const root = popover.draw();
    expect(words(root)).not.toContain("Connect usage");
    expect(words(root)).toEqual(expect.arrayContaining(["OpenCode", row]));
  });
}

test("Not now during a running check stays answered when that check saves what it asked", async () => {
  const { popover, usage } = await allowDuringAPass();
  reply(popover, NOT_NOW);
  usage.release(ANSWER);
  await settle();
  expect(words(popover.draw())).not.toContain("Connect usage");
  expect(words(popover.draw())).toContain("OpenCode");
  expect(words(popover.draw())).not.toContain("Connect usage");
  expect(keysRead()).toBe(0);
  setSystemTime(Date.now() + 60_000);
  refresh(popover);
  await settle();
  expect(opencodeRow()).toMatchObject({ ask: false, state: "unavailable", limits: [] });
});

test("while Allow's check runs the line says so and the numbers can't be mistaken for none, then checks go on as before", async () => {
  opencode();
  const request = heldGo();
  const { popover } = await opened();
  reply(popover, ALLOW);
  await settle();
  const root = popover.draw();
  expect(checkingShown(root)).toBe(true);
  expect(words(root)).not.toContain(NONE);

  request.release(go()());
  await settle();
  expect(checkingShown(popover.draw())).toBe(false);
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

// Allow's request hung past a minute, so a later check has started beside it, knowing no numbers yet.
async function hungAllow() {
  opencode();
  const request = heldGo();
  const { popover } = await opened();
  reply(popover, ALLOW);
  await settle();
  setSystemTime(NOW + 61_000);
  return { popover, request };
}

test("a failed check can't replace with \"Could not check\" the numbers a hung Allow saved as it ran", async () => {
  const { popover, request } = await hungAllow();
  const later = heldGo();
  refresh(popover);
  await settle();
  expect(state.fetched.length).toBe(2);

  request.release(go()());
  await settle();
  later.release(new Error("offline"));
  await settle();
  expect(limits(popover.draw()).length).toBe(3);
  expect(words(popover.draw())).not.toContain("Could not check");
});

test("nor can a hung Allow failing at last replace the numbers a later check found", async () => {
  const { popover, request } = await hungAllow();
  state.answers[GO] = go();
  refresh(popover);
  await settle();
  expect(limits(popover.draw()).length).toBe(3);

  request.release(new Error("offline"));
  await settle();
  expect(limits(popover.draw()).length).toBe(3);
  expect(words(popover.draw())).not.toContain("Could not check");
});

test("any agent's failed check keeps numbers saved since it began, marked with their age", async () => {
  const first = held(), second = held();
  claude(WEEK);
  state.says["claude -p /usage"] = first.answer;
  footer();
  await wait(5_000);
  state.says["claude -p /usage"] = second.answer;
  await wait(2 * 60_000);
  expect(checks()).toBe(2);

  first.release(ANSWER);
  await settle();
  second.release(new Error("no"));
  await settle();
  const root = openedAfter().draw();
  expect(words(limits(root)[0])).toContain("12%");
  expectCachedAge(0);
});

const { run: kavexDo } = await import("herdr");

test("Allow's press is the answer: saved at once, with the card gone and no false \"none\" while the check starts", async () => {
  opencode();
  state.answers[GO] = go();
  const { popover } = await opened();
  reply(popover, ALLOW);
  expect(state.shared["usage.opencode"]).toBe(true);
  expect(state.ran).toContain("workspace-chrome.allow-opencode");
  expect(words(popover.draw())).not.toContain("Connect usage");
  expect(words(popover.draw())).not.toContain(NONE);
  await settle();
  expect(limits(popover.draw()).length).toBe(3);
});

test("the footer's command alone is no consent: no answer saved, no key read, nothing sent, the card still up", async () => {
  opencode();
  state.answers[GO] = go();
  const { popover } = await opened();
  kavexDo("workspace-chrome.allow-opencode");
  await settle();
  expect(state.shared["usage.opencode"] ?? null).toBeNull();
  expect(keysRead()).toBe(0);
  expect(state.fetched).toEqual([]);
  expect(words(popover.draw())).toContain("Connect usage");
});

test("nor does the command undo Not now", async () => {
  opencode();
  state.answers[GO] = go();
  const { popover } = await opened();
  reply(popover, NOT_NOW);
  kavexDo("workspace-chrome.allow-opencode");
  await settle();
  expect(state.shared["usage.opencode"]).toBe(false);
  expect(keysRead()).toBe(0);
  expect(state.fetched).toEqual([]);
});

test("the command after Allow's check starts nothing more", async () => {
  opencode();
  state.answers[GO] = go();
  const { popover } = await opened();
  reply(popover, ALLOW);
  await settle();
  kavexDo("workspace-chrome.allow-opencode");
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
  expect(words(popover.draw())).toContain("Connect usage");
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
  expect(state.runs.filter((run) => !/sqlite3|printenv (?:PATH|XDG_DATA_HOME)|command -v/.test(run.line))).toEqual([]);
});

for (const written of ["$OPENCODE_API_KEY", "${OPENCODE_API_KEY}", "$(cat key)", "!pass show opencode", " !pass show opencode", "`cat key`", "{env:OPENCODE_API_KEY}", "{file:~/key}", "%OPENCODE_API_KEY%", "two words", "line\nbreak", ""]) {
  test(`a key written as ${JSON.stringify(written)} is never sent, from the file or the table`, async () => {
    opencode({ opencode: { type: "api", key: written }, "opencode-go": written });
    state.says["sqlite3"] = `${JSON.stringify({ type: "key", key: written })}\n`;
    state.answers[GO] = go();
    const { popover } = await allowed();
    expect(state.fetched).toEqual([]);
    expect(words(popover.draw())).not.toContain("Could not check");
    expect(words(popover.draw())).toContain("not signed in");
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
    expect(headers["User-Agent"]).toBe("kavex-usage/1.0");
  }
  expect(JSON.stringify(state.runs)).not.toContain(KEY);
});

for (const status of [401, 403]) {
  test(`a ${status} leaves a signed-out OpenCode row with no quota`, async () => {
    opencode();
    state.answers[GO] = go({ error: "no" }, status);
    const { popover } = await allowed();
    const root = popover.draw();
    expect(words(root)).toEqual(expect.arrayContaining(["OpenCode", "not signed in"]));
    expect(limits(root)).toEqual([]);
    expect(words(root)).not.toContain("Could not check");
    expect(checkingShown(root)).toBe(false);
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
    expect(words(popover.draw())).toContain("not signed in");
  });
}

test("a locked OpenCode credential database keeps the last Go reading with its age", async () => {
  opencode({});
  state.says["sqlite3"] = JSON.stringify({ type: "key", key: KEY });
  state.answers[GO] = go();
  const { popover } = await allowed();
  delete state.files[AUTH];
  state.says["sqlite3"] = { code: 5, stderr: "Error: database is locked" };
  setSystemTime(NOW + 8 * 60_000);
  refresh(popover);
  await settle();
  expect(words(popover.draw())).toContain("12%");
  expectCachedAge(8);
});

test("an OpenCode entitlement error from the migrated endpoint removes the old Go reading", async () => {
  opencode();
  state.answers[GO] = go();
  const { popover } = await allowed();
  state.answers[GO] = go({ error: { type: "EntitlementError" } }, 400);
  refresh(popover);
  await settle();
  expect(words(popover.draw())).toContain("not signed in");
  expect(limits(popover.draw())).toEqual([]);
});

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
  expectCachedAge(12);

});

for (const [why, reply_] of [
  ["no network", new Error("offline")],
  ["a server error", go("nope", 500)],
  ["text that isn't JSON", go("<html>")],
  ["no limits in the answer", go({ plan: "go" })],
  ["a percent that isn't one", go({ usage: { weekly: { percent: "most" } } })],
  ["a null answer", go("null")],
] as const) {
  test(`${why} with no earlier numbers shows an unavailable OpenCode reading`, async () => {
    opencode();
    state.answers[GO] = reply_;
    const { popover } = await allowed();
    expect(words(popover.draw())).toEqual(expect.arrayContaining(["OpenCode", "OpenCode Go usage is unavailable."]));
    expect(limits(popover.draw())).toEqual([]);
    expect(words(popover.draw())).not.toContain(NONE);
  });
}

test("the second spelling of Go's answer and a rate-limited window read too", async () => {
  opencode();
  state.answers[GO] = go({ weeklyUsage: { usagePercent: 80, status: "rate-limited", resetInSec: 3600 } });
  const { popover } = await allowed();
  expect(cachedLimits()).toEqual([{ label: "This week", used: 100, resetsAt: NOW + 3600_000 }]);
});

test("Go at 90% lights the dot like any other limit", async () => {
  opencode();
  state.answers[GO] = go({ usage: { ...GO_SAYS.usage, weekly: { percent: 91, resetInSec: 3600 } } });
  const { f } = await allowed();
  expect(dotOn(f.draw())).toBeDefined();
});

test("with the answer given, later checks ask opencode.ai by themselves, with no card", async () => {
  opencode();
  state.answers[GO] = go();
  state.shared["usage.opencode"] = true;
  const { popover } = await opened();
  expect(words(popover.draw())).not.toContain("Connect usage");
  expect(limits(popover.draw()).length).toBe(3);
});


test("local OpenCode consent never grants access on an added machine", async () => {
  state.shared["usage.opencode"] = true;
  added("made-up-box");
  state.agents = { "made-up-box": [OPENCODE] };
  state.says["printenv PATH"] = "/made/up/bin\n";
  state.answers[GO] = go();
  const { popover } = await opened();
  expect(words(popover.draw())).toContain("Connect usage");
  expect(state.shared.usage.entries["opencode|made-up-box"]).toMatchObject({ ask: true, state: "setup", limits: [] });
  expect(state.reads).toEqual([]);
  expect(state.fetched).toEqual([]);
  expect(state.runs.filter((run) => run.line.includes("sqlite3"))).toEqual([]);
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
  expect(words(popover.draw())).toContain("Connect usage");
  expect(limits(popover.draw())).toEqual([]);
  expect(state.reads).toEqual([]);
  expect(state.fetched.length).toBe(1);

  reply(popover, ALLOW);
  await settle();
  expect(limits(popover.draw()).length).toBe(3);
  expect(state.fetched.length).toBe(2);
});


test("the consent detail uses theme colors and emphasizes Allow", async () => {
  opencode();
  const { popover } = await opened();
  const root = providerPopover(popover, "opencode").draw();
  expectThemeColors(root);
  const allow = byId(root, ALLOW + "-opencode-local")!;
  expect(arg(allow, "bg")).toBe(colors.solid);
  expect(arg(allow, "text_color")).toBe(colors.solid_foreground);

  handler(byId(root, "usage-accounts")!, "on_click")({}, cx);
  const accounts = openPopover().draw();
  const card = byId(accounts, "usage-account-opencode-local")!;
  expect(arg(card, "rounded")).toBe(14);
  expect(arg(card, "bg")).toBe(colors.card);
  expect(words(card)).toEqual(expect.arrayContaining(["OpenCode", "Not now", "Allow"]));
  const accountAllow = byId(card, ALLOW + "-opencode-local")!;
  expect(arg(accountAllow, "h")).toBe(34);
  expect(arg(accountAllow, "bg")).toBe(colors.solid);
});

const GROK = { ...CLAUDE, key: "grok", name: "Grok", icon: "icons/grok.svg", run: ["grok"] };
const GROK_AUTH = "/home/person/.grok/auth.json";
const GROK_USAGE = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_TOKEN = "grok-synthetic-session";

function grok() {
  state.agents[""] = [...(Array.isArray(state.agents[""]) ? state.agents[""] : []), GROK];
  state.says["printenv PATH"] = "/made/up/bin:/usr/bin\n";
  state.says["printenv GROK_"] = "";
  state.files[GROK_AUTH] = JSON.stringify({ "https://auth.x.ai": { key: GROK_TOKEN, email: "grok@example.test" } });
  state.answers[GROK_USAGE] = () => Response.json({
    creditUsagePercent: 27, subscriptionTier: "SuperGrok", billingPeriodEnd: "2026-11-05T12:00:00Z",
  });
}

test("Grok joins the roster and reads the existing login only after its own Allow", async () => {
  claude(WEEK);
  grok();
  const { popover } = await opened();
  const before = words(popover.draw());
  expect(before).toEqual(expect.arrayContaining(["Claude Code", "12%", "Grok", "Connect usage"]));
  expect(state.reads).toEqual([]);
  expect(state.fetched).toEqual([]);

  reply(popover, ALLOW, "grok");
  await settle();
  expect(state.shared["usage.consent"]).toEqual({ grok: true });
  expect(words(popover.draw())).toEqual(expect.arrayContaining(["Grok", "· SuperGrok", "27%"]));
  expect(state.reads).toEqual([GROK_AUTH]);
  expect(state.fetched).toHaveLength(1);
  expect(state.fetched[0].url).toBe(GROK_USAGE);
  expect(new Headers(state.fetched[0].init?.headers).get("Authorization")).toBe("Bearer " + GROK_TOKEN);
  expect(JSON.stringify(state.shared)).not.toMatch(/grok-synthetic-session|grok@example\.test/);
});

test("a provider's completed reading becomes visible while a sibling probe waits", async () => {
  const usage = held();
  claude(WEEK);
  grok();
  state.shared["usage.consent"] = { grok: true };
  state.says["claude -p /usage"] = usage.answer;
  const { popover } = await opened();

  expect(checkingShown(popover.draw())).toBe(true);
  expect(words(popover.draw())).toContain("27%");
  expect(words(popover.draw())).not.toContain("12%");
  usage.release(ANSWER);
  await settle();
  expect(checkingShown(popover.draw())).toBe(false);
  expect(words(popover.draw())).toEqual(expect.arrayContaining(["27%", "12%"]));
});

test("per-provider Retry-After protects cached usage from automatic and explicit retries", async () => {
  grok();
  state.shared["usage.consent"] = { grok: true };
  const { popover } = await opened();
  expect(words(popover.draw())).toContain("27%");

  state.answers[GROK_USAGE] = () => new Response(null, { status: 429, headers: { "Retry-After": "120" } });
  await wait(60_000);
  refresh(popover);
  await settle();
  expect(state.fetched).toHaveLength(2);
  expect(words(popover.draw())).toContain("27%");
  expect(state.shared.usage.entries["grok|"].retryAt).toBe(NOW + 180_000);

  await wait(119_999);
  expect(state.fetched).toHaveLength(2);
  refresh(popover);
  await settle();
  expect(state.fetched).toHaveLength(2);
  await wait(1);
  expect(state.fetched).toHaveLength(3);
});

test("the workspace footer defers background polling while inactive and refreshes when activated", async () => {
  state.active = false;
  claude(WEEK);
  const f = footer();
  await wait(20 * 60_000);
  expect(checks()).toBe(0);
  state.active = true;
  f.draw();
  await settle();
  expect(checks()).toBe(1);

  state.active = false;
  f.draw();
  await wait(6 * 60_000);
  expect(checks()).toBe(1);
  state.active = true;
  f.draw();
  await settle();
  expect(checks()).toBe(2);
});

test("consent for a remote OpenCode account runs the probe on its execution owner", async () => {
  const machine = "owner";
  added(machine);
  state.agents[machine] = [OPENCODE];
  const module = "provider-opencode.js";
  state.files["/home/person/.config/kavex/mods/workspace-chrome/" + module] =
    readFileSync(new URL("../defaults/mods/usage/" + module, import.meta.url), "utf8");
  state.on[machine] = {
    "printenv PATH": SHELL,
    "exec node --input-type=module": "kavex-usage:" + JSON.stringify({
      plan: "Go",
      limits: [{ label: "This week", used: 26, minutes: 10_080, resetsAt: NOW + 6 * 3600_000 }],
    }),
  };
  const { popover } = await opened();
  expect(words(popover.draw())).toContain("Connect usage");
  expect(state.reads).toEqual([]);
  expect(state.fetched).toEqual([]);

  reply(popover, ALLOW);
  await settle();
  expect(state.shared["usage.opencode"] ?? null).toBeNull();
  expect(state.shared["usage.consent"]).toEqual({ "opencode|owner": true });
  const worker = state.runs.find((run) => run.line.includes("exec node --input-type=module"));
  expect(worker?.on).toBe(machine);
  expect(words(popover.draw())).toEqual(expect.arrayContaining(["OpenCode", "owner", "26%"]));
  expect(state.reads).toEqual(["/home/person/.config/kavex/mods/workspace-chrome/" + module]);
  expect(state.fetched).toEqual([]);
});

test("the main footer keeps System monitor, Usage and Keep computer awake together", () => {
  const status = shippedLayout.children.find((node: any) => node.id === "work-area")
    .children.find((node: any) => node.id === "workspace-status");
  state.props = status.content.props;
  state.space = { id: "remote", active: true, machine: "vps" };
  const view: any = new WorkspaceStatus();
  const root = view.render(cx).el as El;
  const monitor = byId(root, "system-monitor-status")!;
  expect(arg(monitor, "accessibility_label")).toBe("System monitor");
  expect(paths(monitor)).toEqual(["mods/workspace-chrome/icons/heroicons/cpu-chip.svg"]);
  const buttons = all(root).filter((el) => ["system-monitor-status", "usage-status", "keep-awake"].includes(arg(el, "id")));
  expect(buttons.map((el) => arg(el, "id"))).toEqual(["system-monitor-status", "usage-status", "keep-awake"]);
  expect(buttons.map(words)).toEqual([["System"], ["Usage"], ["Keep awake"]]);
  expect(arg(root, "gap")).toBe(2);
  for (const button of buttons) {
    expect(arg(button, "h")).toBe(24);
    expect(arg(button, "px")).toBe(5);
    expect(arg(button, "gap")).toBe(5);
    expect(arg(button, "w")).toBeUndefined();
  }
  handler(monitor, "on_mouse_down")({ bounds: BUTTON }, cx);
  handler(monitor, "on_click")({}, cx);
  expect(state.overlays.at(-1)).toMatchObject({
    mod: "system-monitor", kind: "popup", at: { x: BUTTON.x + BUTTON.width - 442, y: BUTTON.y - 344 },
    props: { from: "system-monitor-status" },
  });

  state.shared["usage.enabled"] = false;
  const withoutUsage = view.render(cx).el as El;
  expect(byId(withoutUsage, "system-monitor-status")).toBeDefined();
  expect(byId(withoutUsage, "keep-awake")).toBeDefined();
  expect(byId(withoutUsage, "usage-status")).toBeUndefined();
});

test("the system monitor anchor fits a small window at high zoom", () => {
  const prior = globalThis.window;
  globalThis.window = { viewport_size: () => ({ width: 400, height: 280 }) } as any;
  try {
    state.props = { monitor: true };
    state.zoom = 2;
    const root = new WorkspaceStatus().render(cx).el as El;
    const monitor = byId(root, "system-monitor-status")!;
    handler(monitor, "on_mouse_down")({ bounds: BUTTON }, cx);
    handler(monitor, "on_click")({}, cx);
    expect(state.overlays.at(-1)).toMatchObject({ width: 192, height: 132 });
  } finally {
    globalThis.window = prior;
  }
});

test("the monitor button has a keyboard focus ring and opens with Enter", () => {
  state.props = { monitor: true };
  const view = new WorkspaceStatus();
  view.init(null, cx);
  const button = byId(view.render(cx).el, "system-monitor-status")!;
  expect(arg(button, "tab_stop")).toBe(true);
  const focusStyle = make();
  handler(button, "focus")(focusStyle);
  expect(arg(focusStyle.el, "border_color")).toBe(colors.accent);
  handler(button, "on_key_down")({ key: "enter" }, cx);
  expect(state.overlays.at(-1)).toMatchObject({ mod: "system-monitor" });
});
