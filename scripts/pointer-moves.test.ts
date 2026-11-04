import { test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";

// The spaces sidebar, the tab bar and the tabs column listen to the pointer only while a press is held: a
// move handler is a call into the mod on every move over it, at the mouse's rate. Their
// real code is drawn into a tree of the calls it makes, and driven through its handlers.
type El = { calls: [string, any[]][]; kids: any[]; self: any };
function make(): any {
  const el: El = { calls: [], kids: [], self: null };
  const self: any = new Proxy({}, {
    get: (_t, k: string) => {
      if (k === "el") return el;
      if (k === "when") return (on: unknown, f: (s: any) => any) => (on ? f(self) : self);
      if (k === "child") return (kid: any) => (el.kids.push(kid), self);
      if (k === "children") return (kids: any[]) => (el.kids.push(...kids), self);
      if (k === "hover") return (f: (s: any) => any) => (f(make()), self);
      return (...args: any[]) => (el.calls.push([k, args]), self);
    },
  });
  el.self = self;
  return self;
}
const mine = (n: any): El | null => (n && typeof n === "object" && n.el ? n.el : null);
const all = (e: El): El[] => [e, ...e.kids.flatMap((k) => (mine(k) ? all(mine(k)!) : []))];
const arg = (e: El, name: string) => e.calls.findLast(([k]) => k === name)?.[1][0];
const byId = (root: El, id: string) => all(root).find((e) => arg(e, "id") === id)!;
const handler = (e: El, name: string, button?: string) => e.calls.find(([k, a]) => k === name && (!button || a[0] === button))?.[1].at(-1);
const listening = (root: El) => all(root).filter((e) => handler(e, "on_mouse_move")).map((e) => arg(e, "id"));

const colors = JSON.parse(readFileSync(new URL("../defaults/themes/zaki.json", import.meta.url), "utf8")).colors;
let state: { spaces: any[]; shared: Record<string, any>; ran: [string, any][]; overlays: any[] };
mock.module("gpui-kit", () => ({ View: class {}, div: make, image: make, svg: make }));
mock.module("gpui-base", () => ({ h_flex: make, v_flex: make }));
mock.module("herdr", () => ({
  spaces: () => state.spaces,
  machines: () => [],
  panes: () => [],
  terminals: () => [],
  theme: () => colors,
  layout: () => null,
  window: () => ({ platform: "windows", active: false }),
  settings: () => ({ zoom: 1 }),
  shared: (k: string) => state.shared[k],
  setShared: (k: string, v: any) => { state.shared[k] = v; },
  run: (name: string, args: any) => void state.ran.push([name, args]),
  openOverlay: (o: any) => (state.overlays.push(o), `overlay-${state.overlays.length}`),
  closeOverlay: () => {},
  nextCommand: () => new Promise(() => {}),
  exec: () => new Promise(() => {}),
  hc: () => new Promise(() => {}),
  watchFolder: () => new Promise(() => {}),
  home: () => "/home/me",
}));
const { default: Spaces } = await import("../defaults/mods/spaces/main.js");
const { default: Tabs } = await import("../defaults/mods/tabs/main.js");
const { default: TabsColumn } = await import("../defaults/mods/tabs-column/main.js");

const timers: (() => void)[] = [];
const cx: any = {
  notify: () => {},
  spawn: () => {},
  stop_propagation: () => {},
  focus_handle: () => ({ focus: () => {}, is_focused: () => false }),
  timer: { every: () => {}, after: (_ms: number, f: (cx: any) => void) => timers.push(() => f(cx)) },
};
const flush = () => { while (timers.length) timers.shift()!(); };
const at = (x: number, y: number, more = {}) => ({ position: { x, y }, bounds: { x: 0, y: 0 }, click_count: 1, modifiers: {}, ...more });

const tab = (id: string, active = false) => ({ id, name: id, active, settled: false, status: null });
const space = (id: string, active = false) => ({ id, name: id, named: true, active, machine: null, folder: "/w", status: null, tabs: [tab(`${id}1`, true)] });

beforeEach(() => {
  state = { spaces: [space("s0", true), space("s1"), space("s2")], shared: {}, ran: [], overlays: [] };
  timers.length = 0;
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
});

function mount(View: any) {
  const view: any = new View();
  view.init({}, cx);
  return { view, draw: () => view.render(cx).el as El };
}

test("spaces: no row hears plain pointer moves", () => {
  expect(listening(mount(Spaces).draw())).toEqual([]);
});

test("spaces: a held press makes every row listen, and dragging one still reorders", () => {
  const { draw } = mount(Spaces);
  handler(byId(draw(), "space-s0"), "on_mouse_down", "left")(at(10, 10), cx);
  const held = draw();
  expect(listening(held)).toEqual(["space-s0", "space-s1", "space-s2"]);
  handler(byId(held, "space-s2"), "on_mouse_move")(at(10, 90), cx);
  const over = draw();
  // The line that shows where it lands, on the row under the pointer.
  expect(byId(over, "space-s2").kids.some((k) => mine(k) && arg(mine(k)!, "h") === 2)).toBe(true);
  handler(byId(over, "space-s2"), "on_mouse_up", "left")(at(10, 90), cx);
  expect(state.ran).toEqual([["space.move", { id: "s0", index: 3 }]]);
  expect(listening(draw())).toEqual([]);
});

test("spaces: a click without a move still switches", () => {
  const { draw } = mount(Spaces);
  handler(byId(draw(), "space-s1"), "on_mouse_down", "left")(at(10, 50), cx);
  handler(byId(draw(), "space-s1"), "on_mouse_up", "left")(at(10, 50), cx);
  expect(state.ran).toEqual([["space.select", { id: "s1" }]]);
});

function bar() {
  state.spaces = [{ ...space("s0", true), tabs: [tab("a", true), tab("b"), tab("c")] }];
  const m = mount(Tabs), root = m.draw();
  for (const id of ["a", "b", "c"]) handler(byId(root, `tab-${id}`), "on_size_change")({ width: 80, height: 34 });
  handler(byId(root, "tab-scroll"), "on_size_change")({ width: 600, height: 34 });
  return m;
}

test("tabs: the bar doesn't hear plain pointer moves", () => {
  expect(listening(bar().draw())).toEqual([]);
});

test("tabs: pressing a tab makes the bar listen, and a drag lifts it, carries it and lands it", () => {
  const { view, draw } = bar();
  handler(byId(draw(), "tab-a"), "on_mouse_down", "left")(at(40, 20, { bounds: { x: 6, y: 5 } }), cx);
  const held = draw();
  expect(listening(held)).toEqual(["tabs"]);
  handler(held, "on_mouse_move")(at(60, 20), cx); // past START: picked up
  expect(state.overlays.map((o) => o.mod)).toEqual(["tab-drag"]);
  const carried = draw();
  expect(listening(carried)).toEqual(["tabs"]);
  expect(byId(carried, `ghost-${view.drag.n}`)).toBeTruthy();
  handler(carried, "on_mouse_move")(at(600, 20), cx); // the strip's far end: its last place
  handler(draw(), "on_mouse_up", "left")(at(600, 20), cx);
  flush();
  expect(state.ran.filter(([n]) => n === "tab.move")).toEqual([["tab.move", { id: "b", index: 1 }], ["tab.move", { id: "c", index: 2 }]]);
});

test("tabs: a press let go without a move is a click, and the bar stops listening", () => {
  const { draw } = bar();
  handler(byId(draw(), "tab-b"), "on_mouse_down", "left")(at(130, 20, { bounds: { x: 92, y: 5 } }), cx);
  handler(byId(draw(), "tab-b"), "on_mouse_up", "left")(at(130, 20), cx);
  expect(state.ran).toEqual([["tab.select", { id: "b" }]]);
  expect(listening(draw())).toEqual([]);
});

function column() {
  state.spaces = [{ ...space("s0", true), tabs: [tab("a", true), tab("b"), tab("c")] }];
  const m = mount(TabsColumn);
  handler(m.draw(), "on_size_change")({ width: 330, height: 700 });
  return m;
}

test("tabs column: the column doesn't hear plain pointer moves", () => {
  expect(listening(column().draw())).toEqual([]);
});

test("tabs column: pressing a row makes the column listen, and a drag lifts it and lets it go", () => {
  const { view, draw } = column();
  handler(byId(draw(), "column-b"), "on_mouse_down", "left")(at(100, 110, { bounds: { x: 8, y: 100 } }), cx);
  const held = draw();
  expect(listening(held)).toEqual(["tabs-column"]);
  handler(held, "on_mouse_move")(at(100, 130), cx); // past START: picked up
  expect(state.overlays.map((o) => o.mod)).toEqual(["tab-drag"]);
  const carried = draw();
  expect(listening(carried)).toEqual(["tabs-column"]);
  expect(byId(carried, `ghost-${view.drag.n}`)).toBeTruthy();
  handler(carried, "on_mouse_up", "left")(at(100, 130), cx);
  flush();
  expect(view.drag).toBeNull();
  expect(listening(draw())).toEqual([]);
});

test("tabs column: a click without a move still selects", () => {
  const { draw } = column();
  handler(byId(draw(), "column-b"), "on_mouse_down", "left")(at(100, 110, { bounds: { x: 8, y: 100 } }), cx);
  handler(byId(draw(), "column-b"), "on_mouse_up", "left")(at(100, 110), cx);
  expect(state.ran).toEqual([["tab.select", { id: "b" }]]);
  expect(listening(draw())).toEqual([]);
});
