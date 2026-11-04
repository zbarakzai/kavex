import { test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";

// The real tab bar, Tabs column and side panel header, drawn into a tree of the calls they make.
// Where the system draws no window buttons (`window().buttons`), one of them draws them.
type El = { calls: [string, any[]][]; kids: any[]; hover?: El; self: any };
function make(): any {
  const el: El = { calls: [], kids: [], self: null };
  const self: any = new Proxy({}, {
    get: (_t, k: string) => {
      if (k === "el") return el;
      if (k === "when") return (on: unknown, f: (s: any) => any) => (on ? f(self) : self);
      if (k === "child") return (kid: any) => (el.kids.push(kid), self);
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
const colors = JSON.parse(readFileSync(new URL("../defaults/themes/zaki.json", import.meta.url), "utf8")).colors;
const WINDOWS = { platform: "windows", titlebar: "none", buttons: true, maximized: false, fullscreen: false, active: true };

let state: { window: any; layout: any; shared: Record<string, any>; ran: string[] };
const icon = (path: string) => { const s = make(); s.el.calls.push(["path", [path]]); return s; };
mock.module("gpui-kit", () => ({ View: class {}, div: make, image: make, svg: icon }));
mock.module("gpui-base", () => ({ h_flex: make, v_flex: make }));
mock.module("herdr", () => ({
  spaces: () => [{ id: "s", active: true, machine: null, tabs: [{ id: "a", name: "a", active: true, status: null }] }],
  panes: () => [{ tab: "a", pane: "p", terminal: "t", focused: true, program: { name: "a" } }],
  terminals: () => [],
  machines: () => [{ name: null, layout: "ready" }],
  theme: () => colors,
  layout: () => state.layout,
  run: (name: string) => void state.ran.push(name),
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

function show(ids: { panel?: boolean; column?: boolean; width?: number }) {
  const root = JSON.parse(shipped), find = (id: string) => root.children.find((n: any) => n.id === id);
  find("panel").hidden = !ids.panel;
  find("tabs-column").hidden = !ids.column;
  if (ids.width) find("panel").size.px = ids.width;
  state.layout = root;
  return root;
}

beforeEach(() => {
  state = { window: WINDOWS, layout: null, shared: {}, ran: [] };
  show({});
});

test("the tab bar holds them when nothing is open on the right", () => {
  expect(holders()).toEqual(["tabs"]);
});

test("an open side panel holds them, and the tab bar gives them up", () => {
  show({ panel: true });
  expect(holders()).toEqual(["files", "changes"]); // the panel's two mods: its stack shows one at a time
});

test("the Tabs column holds them while it's open", () => {
  show({ column: true });
  expect(holders()).toEqual(["column"]);
});

test("mid-switch, with panel and column both shown for a moment, only the rightmost has them", () => {
  show({ panel: true, column: true });
  expect(holders()).toEqual(["column"]);
});

test("a sidebar moved to the right edge has no buttons, so the rightmost that can hold them does", () => {
  const root = show({});
  root.children.push(root.children.shift());
  expect(holders()).toEqual(["tabs"]);
  root.children.find((n: any) => n.id === "panel").hidden = false;
  expect(holders()).toEqual(["files", "changes"]);
});

test("a tab bar in a block with another name keeps them", () => {
  const root = show({});
  root.children.find((n: any) => n.id === "work").children[0].id = "my-bar";
  expect(holders()).toEqual(["tabs"]);
});

test("Files or Changes open as a pane never draw them, wherever the corner is", () => {
  const root = show({ panel: true });
  root.children.find((n: any) => n.id === "panel").children = [];
  expect(byId(header("files"), "close-window")).toBeUndefined();
});

test("where the system draws the buttons (macOS), no block draws any and every header stays as it was", () => {
  for (const window of [{ platform: "macos", titlebar: "none", buttons: false }, { platform: "linux", titlebar: "none", buttons: false }]) {
    state.window = window;
    for (const open of [{}, { panel: true }, { column: true }]) {
      show(open);
      expect(holders()).toEqual([]);
    }
  }
  show({});
  expect(arg(draw(Tabs), "pr")).toBe(6);
  const row = draw(TabsColumn).kids.map(mine).find((k) => arg(k!, "h") === 56)!;
  expect([arg(row, "pl"), arg(row, "pr")]).toEqual([18, 10]);
  show({ panel: true });
  expect([arg(header("files"), "px"), arg(header("files"), "h")]).toEqual([6, 46]);
});

test("Linux with client decorations gets the same place and buttons, with its own glyphs", () => {
  state.window = { ...WINDOWS, platform: "linux" };
  show({ column: true });
  expect(holders()).toEqual(["column"]);
  const root = draw(TabsColumn), buttons = byId(root, "window-buttons")!;
  expect(icons(buttons)).toEqual(["mods/workspace-chrome/icons/close.svg"]);
  expect(arg(byId(buttons, "close-window")!, "size")).toBe(26);
});

test("they're the tab bar's small buttons, at the end of each header with its usual padding", () => {
  const places = [draw(Tabs), (show({ column: true }), draw(TabsColumn)), (show({ panel: true }), header("files"))];
  for (const root of places) {
    const row = byId(root, "window-buttons")!;
    expect([arg(row, "gap"), has(row, "flex_none")]).toEqual([4, true]);
    for (const button of row.kids.map((b) => mine(b)!)) {
      expect([arg(button, "size"), arg(button, "rounded"), has(button, "flex_none")]).toEqual([26, 8, true]);
      expect([has(button, "w"), has(button, "rounded_tr"), has(button, "mt")]).toEqual([false, false, false]);
    }
  }
  const tabs = (show({}), draw(Tabs));
  expect(arg(tabs, "pr")).toBe(6);
  expect(tabs.kids.map(mine).at(-1)).toBe(byId(tabs, "window-buttons")!); // after the folder button
  expect(has(byId(tabs, "window-buttons")!, "mt")).toBe(false);
  const column = (show({ column: true }), draw(TabsColumn)), row = column.kids.map(mine).find((k) => arg(k!, "h") === 56)!;
  expect([arg(row, "pl"), arg(row, "pr")]).toEqual([18, 10]);
  show({ panel: true });
  expect(arg(header("files"), "px")).toBe(6);
});

test("they look as before, muted at rest, and only close turns red on hover", () => {
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
    expect(state.ran.at(-1)).toBe(commands[i]);
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

test("the column's own controls stay beside the strip", () => {
  show({ column: true });
  const row = draw(TabsColumn).kids.map(mine).find((k) => arg(k!, "h") === 56)!, ids = all(row).map((e) => arg(e, "id")).filter(Boolean);
  expect(ids.indexOf("column-group")).toBeLessThan(ids.indexOf("column-new"));
  expect(ids.indexOf("column-new")).toBeLessThan(ids.indexOf("window-buttons"));
  expect(row.kids.map(mine).at(-1)).toBe(byId(row, "window-buttons")!);
});

test("a panel too narrow for the buttons beside its tabs gives them a row of their own, and a wider one doesn't", () => {
  show({ panel: true, width: 330 });
  const narrow = header("files"), [top, tabs] = narrow.kids.map((k) => mine(k)!);
  expect(arg(top, "h")).toBe(34);
  expect(byId(top, "window-buttons")).toBeDefined();
  expect([arg(tabs, "h"), byId(tabs, "window-buttons")]).toEqual([46, undefined]);
  expect(byId(tabs, "panel-expand")).toBeDefined();
  for (const width of [370, 680]) {
    show({ panel: true, width });
    const wide = header("files");
    expect([arg(wide, "h"), byId(wide, "panel-expand") !== undefined, byId(wide, "window-buttons") !== undefined]).toEqual([46, true, true]);
  }
});
