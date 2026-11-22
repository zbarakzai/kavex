import { test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";

// The real tab bar, Tabs column and side panel header, drawn into a tree of the calls they make.
// Where the system draws no window buttons (`window().buttons`), only the tab bar draws them.
type El = { calls: [string, any[]][]; kids: any[]; hover?: El; self: any };
function make(): any {
  const el: El = { calls: [], kids: [], self: null };
  const self: any = new Proxy({}, {
    get: (_t, k: string) => {
      if (k === "el") return el;
      if (k === "when") return (on: unknown, f: (s: any) => any) => (on ? f(self) : self);
      if (k === "child" || k === "trigger") return (kid: any) => (el.kids.push(kid), self);
      if (k === "children") return (kids: any[]) => (el.kids.push(...kids), self);
      if (k === "hover") return (f: (s: any) => any) => { const sheet = make(); f(sheet); el.hover = sheet.el; return self; };
      return (...args: any[]) => (el.calls.push([k, args]), self);
    },
  });
  el.self = self;
  return self;
}
const mine = (n: any): El | null => (n && typeof n === "object" && n.el ? n.el : null);
const all = (e: El): El[] => [e, ...e.kids.flatMap((k) => (mine(k) ? all(mine(k)!) : []))];
const arg = (e: El, name: string) => e.calls.findLast(([k]) => k === name)?.[1][0];
const has = (e: El, name: string) => e.calls.some(([k]) => k === name);
const byId = (root: El, id: string) => all(root).find((e) => arg(e, "id") === id);
const handler = (e: El, name: string, button?: string) => e.calls.find(([k, a]) => k === name && (!button || a[0] === button))?.[1].at(-1);
const icons = (e: El) => all(e).filter((x) => has(x, "path")).map((x) => arg(x, "path"));

const shipped = readFileSync(new URL("../defaults/layouts/main.json", import.meta.url), "utf8");
const colors = JSON.parse(readFileSync(new URL("../defaults/themes/kavex.json", import.meta.url), "utf8")).colors;
const WINDOWS = { platform: "windows", titlebar: "none", buttons: true, maximized: false, fullscreen: false, active: true };

let state: { window: any; layout: any; shared: Record<string, any>; ran: [string, unknown][] };
const icon = (path: string) => { const s = make(); s.el.calls.push(["path", [path]]); return s; };
mock.module("gpui-kit", () => ({ View: class {}, div: make, image: make, svg: icon }));
mock.module("gpui-base", () => ({ h_flex: make, v_flex: make, HoverCard: { new: make } }));
mock.module("herdr", () => ({
  spaces: () => [{ id: "s", active: true, machine: null, tabs: [{ id: "a", name: "a", active: true, status: null }] }],
  knownAgents: async () => [],
  panes: () => [{ tab: "a", pane: "p", terminal: "t", focused: true, program: { name: "a" } }],
  terminals: () => [],
  machines: () => [{ name: null, layout: "ready" }],
  theme: () => colors,
  layout: () => state.layout,
  run: (name: string, args: unknown) => void state.ran.push([name, args]),
  openOverlay: () => "overlay",
  closeOverlay: () => {},
  shared: (k: string) => state.shared[k],
  setShared: (k: string, v: any) => { state.shared[k] = v; },
  settings: () => ({ zoom: 1 }),
  nextCommand: () => new Promise(() => {}),
  window: () => state.window,
  home: () => "/home",
}));
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {} };
const { default: Tabs } = await import("../defaults/mods/tabs/main.js");
const { default: TabsColumn } = await import("../defaults/mods/tabs-column/main.js");
const { panelHeader } = await import("../defaults/mods/files/panel.js");
const { look } = await import("../defaults/mods/tabs/look.js");
const k = look(colors);

const cx: any = { notify: () => {}, spawn: () => {}, focus_handle: () => ({ focus: () => {}, is_focused: () => false }), timer: { every: () => {}, after: () => {} } };
const draw = (Mod: any) => { const view = new Mod(); view.init({}, cx); return view.render(cx).el as El; };
const header = (panel: string) => panelHeader(look(colors), panel).el as El;
const places = () => ({ tabs: draw(Tabs), column: draw(TabsColumn), files: header("files"), changes: header("changes") });
const holders = () => Object.entries(places()).filter(([, root]) => byId(root, "close-window")).map(([name]) => name);

function show(ids: { panel?: boolean; column?: boolean; width?: number; active?: string }) {
  const root = JSON.parse(shipped), find = (id: string) => root.children.find((n: any) => n.id === id);
  find("panel").hidden = !ids.panel;
  if (ids.active) find("panel").children[0].active = ids.active;
  if (ids.column) root.children.push({ id: "tabs-column", type: "block", content: { mod: "tabs-column" } });
  if (ids.width) find("panel").size.px = ids.width;
  state.layout = root;
  return root;
}

beforeEach(() => {
  state = { window: WINDOWS, layout: null, shared: {}, ran: [] };
  show({});
});

const STATES = { "nothing on the right": {}, "the side panel open": { panel: true }, "the Tabs column open": { column: true }, "both, mid-switch": { panel: true, column: true } };

test("the tab bar draws them at its right end in every layout state, and nothing else does", () => {
  for (const [name, open] of Object.entries(STATES)) {
    show(open);
    expect(holders(), name).toEqual(["tabs"]);
    const tabs = draw(Tabs);
    expect(tabs.kids.map(mine).at(-1), name).toBe(byId(tabs, "window-buttons")!);
    expect(arg(tabs, "pr"), name).toBe(6);
  }
});

test("the shipped layout keeps grouped tabs on top with a saved right placement", () => {
  state.shared["tabs.placement"] = "right";
  state.shared["tab.groups"] = { test: { name: "Test", color: "blue", tabs: ["a"] } };
  const tabs = draw(Tabs);
  expect(state.layout.children.some((node: any) => node.id === "tabs-column")).toBe(false);
  expect(byId(tabs, "placement")).toBeUndefined();
  expect(byId(tabs, "group-test")).toBeDefined();
  expect(byId(tabs, "tab-scroll")).toBeDefined();
  expect(state.ran.map(([name]) => name)).not.toContain("layout.show");
});

test("scrolling the tab bar or a custom Tabs column does not select a tab", () => {
  for (const [name, root] of Object.entries(places())) {
    if (name !== "tabs" && name !== "column") continue;
    state.ran = [];
    handler(root, "on_scroll_wheel")?.({ delta_lines: { x: 0, y: 1 } }, cx);
    expect(state.ran.map(([command]) => command), name).not.toContain("tab.select");
    expect(has(root, "on_scroll_wheel"), name).toBe(false);
  }
  expect(has(byId(draw(Tabs), "tab-scroll")!, "overflow_x_scroll")).toBe(true);
});

test("with the Tabs column shown the bar still draws, showing the current tab, with the buttons", () => {
  show({ column: true });
  state.shared["tabs.placement"] = "right";
  const tabs = draw(Tabs);
  expect(byId(tabs, "tab-scroll")).toBeUndefined();
  expect(byId(tabs, "close-window")).toBeDefined();
  expect(holders()).toEqual(["tabs"]);
});

test("the folder and branch buttons each open, select, and close their own view", () => {
  const actions = byId(draw(Tabs), "tab-actions")!;
  expect(arg(actions, "gap")).toBe(2);
  for (const id of ["tab-new", "panel-toggle-files", "panel-toggle-changes"]) {
    expect(arg(byId(actions, id)!, "size")).toBe(28);
  }
  for (const [id, other, label, icon] of [["files", "changes", "Files", "folder"], ["changes", "files", "Changes", "branch"]]) {
    show({ active: other });
    const button = byId(draw(Tabs), `panel-toggle-${id}`)!;
    expect(arg(button, "accessibility_label")).toBe(label);
    expect(icons(button)).toEqual([`mods/workspace-chrome/icons/${icon}.svg`]);
    handler(button, "on_click")({}, cx);
    expect(state.ran.splice(0)).toEqual([["layout.select", { stack: "panel-body", child: id }], ["layout.show", { id: "panel" }]]);

    show({ panel: true, active: other });
    handler(byId(draw(Tabs), `panel-toggle-${id}`)!, "on_click")({}, cx);
    expect(state.ran.splice(0)).toEqual([["layout.select", { stack: "panel-body", child: id }]]);

    show({ panel: true, active: id });
    const tabs = draw(Tabs);
    expect(has(byId(tabs, `panel-toggle-${other}`)!, "bg")).toBe(false);
    expect(has(byId(tabs, `panel-toggle-${id}`)!, "bg")).toBe(true);
    handler(byId(tabs, `panel-toggle-${id}`)!, "on_click")({}, cx);
    expect(state.ran.splice(0)).toEqual([["layout.hide", { id: "panel" }]]);
  }
});

test("settings hide the toolbar button for a disabled view", () => {
  state.shared["workspace.panels"] = ["files"];
  const tabs = draw(Tabs);
  expect(byId(tabs, "panel-toggle-files")).toBeDefined();
  expect(byId(tabs, "panel-toggle-changes")).toBeUndefined();
});

test("the side panel header shows only the current view with its own close button at any width", () => {
  for (const width of [330, 370, 680, 900]) {
    show({ panel: true, column: true, width });
    for (const panel of ["files", "changes"]) {
      const h = header(panel);
      expect([arg(h, "h"), arg(h, "px"), byId(h, "window-buttons")], `${panel} ${width}`).toEqual([46, 6, undefined]);
      expect(byId(h, "panel-expand")).toBeDefined();
      const other = panel === "files" ? "changes" : "files";
      expect(byId(h, `panel-${other}`)).toBeUndefined();
      const close = byId(h, `panel-close-${panel}`)!;
      handler(close, "on_click")({}, cx);
      expect(state.ran.pop()).toEqual(["layout.hide", { id: "panel" }]);
    }
  }
  const row = draw(TabsColumn).kids.map(mine).find((k) => arg(k!, "h") === 56)!;
  expect([arg(row, "pl"), arg(row, "pr")]).toEqual([18, 10]);
  expect(mine(row.kids.at(-1))!.kids.map((x) => arg(mine(x)!, "id"))).toEqual(["column-group", "column-new"]);
});

test("a tab bar in a block with another name keeps them", () => {
  const root = show({ panel: true });
  const work = root.children.find((n: any) => n.id === "work-area").children.find((n: any) => n.id === "work");
  work.children.find((n: any) => n.id === "tabs").id = "my-bar";
  expect(holders()).toEqual(["tabs"]);
});

test("where the system draws the buttons (macOS), no block draws any", () => {
  for (const window of [{ platform: "macos", titlebar: "none", buttons: false }, { platform: "linux", titlebar: "none", buttons: false }]) {
    state.window = window;
    for (const open of Object.values(STATES)) {
      show(open);
      expect(holders()).toEqual([]);
    }
  }
  show({});
  expect(arg(draw(Tabs), "pr")).toBe(6);
});

test("Linux with client decorations gets them in the tab bar too, with its own glyphs", () => {
  state.window = { ...WINDOWS, platform: "linux" };
  show({ column: true });
  expect(holders()).toEqual(["tabs"]);
  const buttons = byId(draw(Tabs), "window-buttons")!;
  expect(icons(buttons)).toEqual(["mods/workspace-chrome/icons/close.svg"]);
  expect(arg(byId(buttons, "close-window")!, "size")).toBe(26);
});

test("they're small: 26 px, rounded 8, 4 apart", () => {
  const row = byId(draw(Tabs), "window-buttons")!;
  expect([arg(row, "gap"), has(row, "flex_none"), has(row, "mt")]).toEqual([4, true, false]);
  for (const button of row.kids.map((b) => mine(b)!)) {
    expect([arg(button, "size"), arg(button, "rounded"), has(button, "flex_none")]).toEqual([26, 8, true]);
    expect([has(button, "w"), has(button, "rounded_tr"), has(button, "mt")]).toEqual([false, false, false]);
  }
});

test("they're muted at rest, and only close turns red with a white icon on hover", () => {
  const strip = byId(draw(Tabs), "window-buttons")!, [min, max, close] = strip.kids.map((k) => mine(k)!);
  for (const button of [min, max, close]) expect(arg(button, "text_color")).toBe(k.muted);
  for (const button of [min, max]) expect([arg(button.hover!, "bg"), arg(button.hover!, "text_color")]).toEqual([k.hover_strong, k.foreground]);
  expect([arg(close.hover!, "bg"), arg(close.hover!, "text_color")]).toEqual(["#c42b1c", "#ffffff"]);
});

test("each button keeps its press from the draggable bar, whichever button, and runs its command", () => {
  const strip = byId(draw(Tabs), "window-buttons")!, commands = ["window.minimize", "window.maximize", "window.close"];
  strip.kids.map((k) => mine(k)!).forEach((button, i) => {
    for (const side of ["left", "right"]) {
      let stopped = 0;
      handler(button, "on_mouse_down", side)({}, { stop_propagation: () => { stopped += 1; } });
      expect(stopped, side).toBe(1);
    }
    handler(button, "on_click")({}, cx);
    expect(state.ran.at(-1)?.[0]).toBe(commands[i]);
  });
});

test("the middle button shows what it will do", () => {
  const icon = (maximized: boolean) => {
    state.window = { ...WINDOWS, maximized };
    return icons(byId(draw(Tabs), "maximize")!);
  };
  expect(icon(false)).toEqual(["mods/workspace-chrome/icons/win-maximize.svg"]);
  expect(icon(true)).toEqual(["mods/workspace-chrome/icons/win-restore.svg"]);
});
