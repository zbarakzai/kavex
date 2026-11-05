import { test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";

// The sidebar's Spaces and Agents lists scroll, and their scrollbar is drawn over the list's
// right edge. While a list scrolls its rows stop short of the bar, so it never covers an agent's
// percent, time or badge; a list that fits keeps its full width. Their real code is drawn into
// a tree of the calls it makes, and sized through its handlers as the app would.
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

const colors = JSON.parse(readFileSync(new URL("../defaults/themes/zaki.json", import.meta.url), "utf8")).colors;
let state: { spaces: any[]; agents: any[]; sidebar: number; notified: number };
mock.module("gpui-kit", () => ({ View: class {}, div: make, image: make, svg: make }));
mock.module("gpui-base", () => ({ h_flex: make, v_flex: make }));
mock.module("herdr", () => ({
  spaces: () => state.spaces,
  agents: () => state.agents,
  machines: () => [],
  panes: () => [],
  terminals: () => [],
  focused: () => null,
  theme: () => colors,
  layout: () => ({ id: "root", children: [{ id: "sidebar", size: { px: state.sidebar } }, { id: "spaces", size: { px: 200 } }] }),
  window: () => ({ platform: "windows", active: false }),
  settings: () => ({ zoom: 1 }),
  props: () => ({}),
  shared: () => undefined,
  setShared: () => {},
  setAgentOrder: () => {},
  run: () => {},
  openOverlay: () => "overlay",
  closeOverlay: () => {},
  nextCommand: () => new Promise(() => {}),
  exec: () => new Promise(() => {}),
  hc: () => new Promise(() => {}),
  watchFolder: () => new Promise(() => {}),
  readTextFile: () => new Promise(() => {}),
  writeTextFile: async () => {},
  home: () => "/home/me",
}));
const { default: Spaces } = await import("../defaults/mods/spaces/main.js");
const { default: Agents } = await import("../defaults/mods/agents/main.js");

const cx: any = {
  notify: () => { state.notified++; },
  spawn: () => ({ cancel() {} }),
  stop_propagation: () => {},
  focus_handle: () => ({ focus: () => {}, is_focused: () => false }),
  timer: { every: () => {}, after: () => {} },
};

const space = (n: number) => ({ id: `s${n}`, name: `s${n}`, named: true, active: n === 0, machine: null, folder: "/w", status: null, tabs: [{ id: `t${n}`, name: "t", active: true }] });
const agent = (n: number) => ({ address: `a${n}`, pane: `p${n}`, space: "s0", space_name: "s0", tab: "t0", tab_index: 1, status: "idle", program: { key: "claude", name: "Claude Code" }, seq: n, focused: false });

beforeEach(() => {
  state = { spaces: Array.from({ length: 12 }, (_, i) => space(i)), agents: Array.from({ length: 12 }, (_, i) => agent(i)), sidebar: 230, notified: 0 };
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
});

function mount(View: any) {
  const view: any = new View();
  view.init({}, cx);
  const draw = () => view.render(cx).el as El;
  return { view, draw };
}

// Each list: the scroll area, and the rows in it whose right padding clears the bar.
const LISTS = [["spaces", Spaces, "space-list", "space-rows"], ["agents", Agents, "ag-list", "ag-rows"]] as const;

for (const [name, View, list, rows] of LISTS) {
  test(`${name}: the rows always stop short of the scrollbar's 16 px lane at the list's right edge`, () => {
    const { draw } = mount(View);
    const root = draw();
    expect(byId(root, list).calls.some(([k]) => k === "overflow_y_scrollbar")).toBe(true);
    // Before any size is known, and whatever the sizes: nothing waits on a measurement.
    expect(arg(byId(root, rows), "pr")).toBe(16);
    state.spaces = state.spaces.slice(0, 1);
    state.agents = state.agents.slice(0, 1);
    expect(arg(byId(draw(), rows), "pr")).toBe(16);
  });

  test(`${name}: the narrow rail keeps its full width`, () => {
    state.sidebar = 44;
    const { draw } = mount(View);
    expect(arg(byId(draw(), rows), "pr")).toBeUndefined();
  });
}

test("agents: the rows sit in the scrolled list, with their gap", () => {
  const { draw } = mount(Agents);
  const box = byId(draw(), "ag-rows");
  expect(arg(box, "gap")).toBe(2);
  expect(box.kids.map((k) => arg(mine(k)!, "id")).sort()).toEqual(state.agents.map((a) => `ag-${a.address}`).sort());
});
