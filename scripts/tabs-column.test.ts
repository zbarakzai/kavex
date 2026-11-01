import { test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";

// The real column, drawn into a tree of the calls it makes, so its colors and sizes can be
// read back. Layout and painting are GPUI's; this covers what the mod asks for.
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
const text = (e: El) => e.kids.filter((k) => typeof k === "string").join("");
const handler = (e: El, name: string, button?: string) => e.calls.find(([k, a]) => k === name && (!button || a[0] === button))?.[1].at(-1);
const rings = (e: El) => e.kids.map(mine).filter((k): k is El => Boolean(k) && has(k!, "border_color") && has(k!, "inset_0"));

let state: { tabs: any[]; shared: Record<string, any>; ran: [string, any][]; focused: boolean; overlays: any[]; terminals?: any[] };
const colors = JSON.parse(readFileSync(new URL("../defaults/themes/zaki.json", import.meta.url), "utf8")).colors;
const flex = () => make();
const icon = (path: string) => { const s = make(); s.el.calls.push(["path", [path]]); return s; };
mock.module("gpui-kit", () => ({ View: class {}, div: make, image: make, svg: icon }));
mock.module("gpui-base", () => ({ h_flex: flex, v_flex: flex }));
mock.module("herdr", () => ({
  spaces: () => [{ id: "s", active: true, machine: null, tabs: state.tabs }],
  panes: () => state.tabs.map((c) => ({ tab: c.id, pane: `p-${c.id}`, terminal: `t-${c.id}`, focused: true, program: { name: c.id } })),
  terminals: () => state.terminals ?? [],
  theme: () => colors,
  layout: () => null,
  run: (name: string, args: any) => void state.ran.push([name, args]),
  openOverlay: (o: any) => (state.overlays.push(o), "overlay"),
  closeOverlay: () => {},
  shared: (k: string) => state.shared[k],
  setShared: (k: string, v: any) => { state.shared[k] = v; },
  settings: () => ({ zoom: 1 }),
  nextCommand: () => new Promise(() => {}),
  window: () => ({ platform: "macos" }),
}));
const { default: TabsColumn } = await import("../defaults/mods/tabs-column/main.js");

const timers: (() => void)[] = [];
const cx: any = {
  notify: () => {},
  spawn: () => {},
  focus_handle: () => ({ focus: () => { state.focused = true; }, is_focused: () => state.focused }),
  timer: { every: () => {}, after: (_ms: number, f: (cx: any) => void) => timers.push(() => f(cx)) },
};
const flush = () => { while (timers.length) timers.shift()!(); };

const tab = (id: string, extra = {}) => ({ id, name: id, active: false, status: null, ...extra });
const GROUPS = {
  blue: { name: "auth", color: "blue", folded: false, tabs: ["c", "d"] },
  shut: { name: "ship", color: "teal", folded: true, tabs: ["e", "f"] },
};

beforeEach(() => {
  state = { tabs: [tab("a", { active: true }), tab("b"), tab("c"), tab("d", { status: "blocked" }), tab("e"), tab("f")], shared: { "tab.groups": GROUPS }, ran: [], focused: false, overlays: [] };
  timers.length = 0;
});

function column() {
  const view: any = new TabsColumn();
  view.init({}, cx);
  const draw = () => view.render(cx).el as El;
  const root = draw();
  handler(root, "on_size_change")({ height: 700 });
  return { view, draw };
}
const nameOf = (row: El) => all(row).find((e) => has(e, "truncate"))!;
const shown = (row: El) => row.kids.map(mine).filter((k) => k && arg(k, "id")?.startsWith("column-") && arg(k, "opacity") === 1).map((k) => arg(k!, "bg"));
const press = (e: El, y: number, more = {}) => handler(e, "on_mouse_down", "left")({ position: { x: 100, y }, bounds: { y: y - 10 }, click_count: 1, ...more }, cx);
const move = (root: El, y: number, x = 100) => handler(root, "on_mouse_move")({ position: { x, y }, bounds: { y: 0 } }, cx);

test("the panel: surface, radius 14, no border, a 56px header and 32px buttons", () => {
  const root = column().draw();
  expect([arg(root, "bg"), arg(root, "rounded"), has(root, "border_1")]).toEqual(["#161616", 14, false]);
  const header = root.kids.map(mine).find((k) => arg(k!, "h") === 56)!;
  expect([arg(header, "pl"), arg(header, "pr")]).toEqual([18, 10]);
  const button = byId(root, "column-new")!;
  expect([arg(button, "size"), arg(button, "rounded"), arg(button, "text_color")]).toEqual([32, 9, "#A8A8A8"]);
  expect([arg(button.hover!, "bg"), arg(button.hover!, "text_color")]).toEqual(["#222222", "#F2F2F2"]);
});

test("the header's two buttons don't look alike: New group is the menu's layers icon", () => {
  const root = column().draw(), icon = (id: string) => arg(all(byId(root, id)!).find((e) => has(e, "path"))!, "path");
  expect([icon("column-group"), icon("column-new")]).toEqual(["mods/workspace-chrome/icons/layers.svg", "mods/workspace-chrome/icons/plus.svg"]);
});

test("the list has no cards, and sections and rows keep their gaps", () => {
  const root = column().draw(), list = byId(root, "column-list")!;
  expect([arg(list, "gap"), arg(list, "px"), arg(list, "pb")]).toEqual([14, 8, 12]);
  for (const e of all(list)) expect(has(e, "border_1") || arg(e, "bg") === colors.card).toBe(false);
  expect([arg(byId(root, "column-tuck-c")!, "h"), arg(byId(root, "column-group-blue")!, "mb")]).toEqual([32, -2]);
});

test("loose and grouped rows have the spec's sizes", () => {
  const root = column().draw(), loose = byId(root, "column-b")!, inGroup = byId(root, "column-c")!;
  expect([arg(loose, "h"), arg(loose, "pl"), arg(loose, "pr"), arg(loose, "gap"), arg(loose, "rounded")]).toEqual([32, 10, 10, 9, 10]);
  expect([arg(inGroup, "h"), arg(inGroup, "pl"), arg(inGroup, "pr")]).toEqual([30, 27, 10]);
  const tile = (row: El) => row.kids.map(mine).find((k) => has(k!, "justify_center"))!;
  expect([arg(tile(loose), "size"), arg(tile(inGroup), "size"), arg(tile(loose), "rounded")]).toEqual([22, 20, 6]);
});

test("every row state has the spec's background, ring and name", () => {
  const { view, draw } = column();
  const look = (id: string) => {
    const row = byId(draw(), `column-${id}`)!, name = nameOf(row);
    return { bg: shown(row), ring: rings(row).map((r) => arg(r, "border_color")), name: arg(name, "text_color"), weight: arg(name, "font_weight") };
  };
  expect(look("b")).toEqual({ bg: [], ring: [], name: "#E2E2E2", weight: 400 });
  view.over = "b";
  expect(look("b")).toEqual({ bg: ["#1E1E1E"], ring: [], name: "#F2F2F2", weight: 400 });
  view.press = { anchor: "b" };
  expect(look("b")).toEqual({ bg: ["#202020"], ring: [], name: "#F2F2F2", weight: 400 });
  view.press = null; view.over = null;
  expect(look("a")).toEqual({ bg: ["#242424"], ring: ["#2C2C2C"], name: "#F2F2F2", weight: 500 });
  view.over = "a";
  expect(look("a")).toEqual({ bg: ["#282828"], ring: ["#333333"], name: "#F2F2F2", weight: 500 });
});

test("a row's status never changes its background, only the badge shows it", () => {
  const root = column().draw(), row = byId(root, "column-d")!;
  expect(shown(row)).toEqual(shown(byId(root, "column-c")!));
  expect(all(row).some((e) => e.kids.some((k) => mine(k) && text(mine(k)!) === "N"))).toBe(true);
});

test("backgrounds ease over 120ms", () => {
  const sheet = byId(column().draw(), "column-hover-b")!;
  expect(sheet.calls.find(([k]) => k === "transition")![1]).toEqual(["opacity", 120]);
});

test("a group's header: name in its color, hover, and the orange dot when one needs you", () => {
  const root = column().draw(), head = byId(root, "column-fold-blue")!;
  expect([arg(head, "h"), arg(head, "pl"), arg(head, "pr"), arg(head, "gap"), arg(head, "rounded")]).toEqual([30, 8, 10, 8, 9]);
  expect(has(head, "bg")).toBe(false);
  expect([arg(head, "text_color"), arg(head.hover!, "bg"), arg(head.hover!, "text_color")]).toEqual(["#8E8E8E", "#1C1C1C", "#CFCFCF"]);
  expect(arg(nameOf(head), "text_color")).toBe("#8C9CF5");
  expect([arg(nameOf(head), "text_size"), has(nameOf(head), "font_semibold")]).toEqual([13.5, true]);
  const dot = (e: El) => all(e).find((x) => arg(x, "size") === 7);
  expect(arg(dot(head)!, "bg")).toBe("#EC6F3E");
  expect(dot(byId(root, "column-fold-shut")!)).toBeUndefined();
});

test("a failed tab doesn't light the dot: failed isn't needs you", () => {
  state.terminals = [{ address: "t-d", status: "error" }];
  expect(all(byId(column().draw(), "column-fold-blue")!).find((x) => arg(x, "size") === 7)).toBeUndefined();
});

test("a picked row's ring isn't orange: that color means you", () => {
  state.shared["tabs.picked"] = ["b"];
  expect(rings(byId(column().draw(), "column-b")!).map((e) => arg(e, "border_color"))).toEqual([colors.foreground]);
});

test("a fold turns the chevron and hides the tabs", () => {
  const root = column().draw();
  expect(arg(byId(root, "column-tuck-e")!, "h")).toBe(0);
  const chevron = (id: string) => arg(all(byId(root, id)!).find((e) => has(e, "path"))!, "path");
  expect([chevron("column-fold-shut"), chevron("column-fold-blue")]).toEqual(["mods/workspace-chrome/icons/chevron-right.svg", "mods/workspace-chrome/icons/chevron-down.svg"]);
  const clicks = handler(byId(root, "column-fold-blue")!, "on_mouse_up", "left");
  press(byId(root, "column-fold-blue")!, 100);
  clicks({}, cx);
  expect(state.shared["tab.groups"].blue.folded).toBe(true);
});

test("a folded group with the current tab keeps only that row, in its active style", () => {
  state.tabs = state.tabs.map((c) => ({ ...c, active: c.id === "e" }));
  const { draw } = column(), root = draw();
  expect(arg(byId(root, "column-tuck-f")!, "h")).toBe(0);
  expect(arg(byId(root, "column-tuck-e")!, "h")).toBe(32);
  const row = byId(root, "column-e")!;
  expect([arg(row, "h"), shown(row), rings(row).map((r) => arg(r, "border_color"))]).toEqual([30, ["#242424"], ["#2C2C2C"]]);
});

test("the keyboard moves through rows and names, folds, opens a tab and goes back", () => {
  const { view, draw } = column(), ring = (id: string) => rings(byId(draw(), id)!).map((r) => [arg(r, "border_color"), arg(r, "border")]);
  const key = (name: string) => handler(byId(draw(), "column-keys")!, "on_key_down")({ key: name }, cx);
  expect(ring("column-b")).toEqual([]);
  view.command("focus", cx);
  expect([view.cursor, state.focused]).toEqual(["a", true]);
  key("down");
  expect(ring("column-b")).toEqual([["#EC6F3E", 2]]);
  key("up"); key("up");
  expect(view.cursor).toBe("a");
  key("down"); key("down");
  expect(view.cursor).toBe("group:blue");
  expect(ring("column-fold-blue")).toEqual([["#EC6F3E", 2]]);
  key("left");
  expect(state.shared["tab.groups"].blue.folded).toBe(true);
  key("right");
  expect(state.shared["tab.groups"].blue.folded).toBe(false);
  key("enter");
  expect(state.shared["tab.groups"].blue.folded).toBe(true);
  key("enter");
  key("down"); key("enter");
  expect(view.cursor).toBeNull();
  expect(state.ran).toEqual([["tab.select", { id: "c" }], ["pane.focus", { pane: "p-c" }]]);
  view.command("focus", cx); key("escape");
  expect(view.cursor).toBeNull();
  expect(state.ran.at(-1)).toEqual(["pane.focus", { pane: "p-a" }]);
});

test("the ring is for the keyboard: a press with the mouse takes it away", () => {
  const { view, draw } = column();
  view.command("focus", cx);
  press(byId(draw(), "column-b")!, 100);
  expect(view.cursor).toBeNull();
  expect(rings(byId(draw(), "column-a")!).some((r) => arg(r, "border_color") === "#EC6F3E")).toBe(false);
});

test("the ring goes when the keyboard leaves by itself", () => {
  const { view } = column();
  view.command("focus", cx);
  state.focused = false;
  flush();
  expect(view.cursor).toBeNull();
});

const lifted = (id: string, y: number) => {
  const { view, draw } = column(), root = draw();
  press(byId(root, id)!, y);
  move(root, y + 20);
  return { view, draw };
};
// Carries it over a place the way the drag layer does, by the pointer's position.
const aim = (view: any, key: string) => {
  const slot = view.drag.slots.find((s: any) => s.key === key);
  view.command(`drag:100,${slot.y + view.drag.grab + view.drag.listY}`, cx);
  expect(view.drag.slot.key).toBe(key);
};
const roomOf = (view: any, root: El, key: string) => arg(byId(root, `room-${view.drag.n}-${key}`)!, "h");

test("a dragged row has the spec's look, and its room stays open where it was", () => {
  const { view, draw } = lifted("column-b", 110), root = draw(), ghost = byId(root, `ghost-${view.drag.n}`)!;
  const row = all(ghost).find((e) => arg(e, "id") === "column-b")!;
  expect([arg(row, "bg"), has(row, "shadow_2xl"), rings(row).map((r) => arg(r, "border_color")), arg(nameOf(row), "text_color")]).toEqual(["#262626", true, ["#333333"], "#F2F2F2"]);
  expect(roomOf(view, root, view.drag.home.key)).toBe(view.drag.room);
  expect(state.overlays[0]).toMatchObject({ mod: "tab-drag", props: { to: "tabs-column" } });
});

test("rows slide apart where the drag is: one room open, the rest shut, on a spring", () => {
  const { view, draw } = lifted("column-b", 110), home = view.drag.home.key;
  aim(view, "d");
  const root = draw();
  expect([roomOf(view, root, "d"), roomOf(view, root, home)]).toEqual([view.drag.room, 0]);
  expect(byId(root, `room-${view.drag.n}-d`)!.calls.some(([k, a]) => k === "spring" && a[0] === "height")).toBe(true);
  aim(view, "a");
  const next = draw();
  expect([roomOf(view, next, "a"), roomOf(view, next, "d")]).toEqual([view.drag.room, 0]);
});

test("with no loose tabs a row can still leave its group: the rows make room, with the sections' gap", () => {
  state.tabs = [tab("c", { active: true }), tab("d"), tab("e"), tab("f")];
  const { view, draw } = lifted("column-d", 120);
  expect(all(draw()).some((e) => arg(e, "mb") === -14)).toBe(true);
  aim(view, "loose-end");
  expect(roomOf(view, draw(), "loose-end")).toBe(view.drag.room + 12);
});

test("nothing draws a drop line", () => {
  const { view, draw } = lifted("column-b", 110);
  aim(view, "d");
  expect(all(draw()).some((e) => arg(e, "h") === 2)).toBe(false);
});

test("over a folded group a room opens under its name, and shuts as the tab goes in", () => {
  const { view, draw } = lifted("column-b", 110);
  aim(view, "fold:shut");
  expect(roomOf(view, draw(), "fold:shut")).toBe(view.drag.room);
  view.command(`drop:100,${view.drag.slot.y + view.drag.grab + view.drag.listY}`, cx);
  expect(roomOf(view, draw(), "fold:shut")).toBe(0);
});

test("a far pull goes home", () => {
  const { view, draw } = lifted("column-b", 110), root = draw();
  aim(view, "d");
  move(root, 300, 400);
  expect(view.drag.slot === view.drag.home).toBe(true);
  expect(roomOf(view, draw(), view.drag.home.key)).toBe(view.drag.room);
});

test("dropping a tab on a group's row moves it there", () => {
  const { view, draw } = lifted("column-b", 110);
  aim(view, "d");
  const { key, y } = view.drag.slot, at = y + view.drag.grab + view.drag.listY;
  view.command(`drop:100,${at}`, cx);
  expect(view.drag.slot.key).toBe(key);
  flush();
  expect([...state.shared["tab.groups"].blue.tabs].sort()).toEqual(["b", "c", "d"]);
  const order = state.tabs.map((c) => c.id);
  for (const [name, m] of state.ran) if (name === "tab.move") { order.splice(order.indexOf(m.id), 1); order.splice(m.index - 1, 0, m.id); }
  expect(order).toEqual(["a", "c", "b", "d", "e", "f"]);
  draw();
});

test("the current tab of a folded group can be picked up", () => {
  state.tabs = state.tabs.map((c) => ({ ...c, active: c.id === "e" }));
  const { view, draw } = lifted("column-e", 200);
  expect(view.drag.home.key).toBe("fold:shut");
  const root = draw();
  expect(byId(root, `room-${view.drag.n}-fold:shut`)).toBeTruthy();
  expect(arg(byId(root, `room-${view.drag.n}-fold:shut`)!, "h")).toBe(view.drag.room);
});

test("a dragged group carries its header, and sections slide apart for it", () => {
  const { view, draw } = lifted("column-fold-shut", 200);
  aim(view, "before:blue");
  const root = draw(), ghost = byId(root, `ghost-${view.drag.n}`)!;
  expect([arg(ghost, "bg"), has(ghost, "shadow_2xl")]).toEqual(["#262626", true]);
  expect(roomOf(view, root, "before:blue")).toBe(view.drag.room);
});

test("a fold slides each row shut on a spring, and never unmounts it", () => {
  const { draw } = column(), rows = (root: El) => ["column-tuck-e", "column-tuck-f"].map((id) => byId(root, id)!);
  for (const row of rows(draw())) {
    expect([arg(row, "h"), arg(row, "spring")]).toEqual([0, "height"]);
    expect(has(row, "overflow_hidden")).toBe(true);
  }
  state.shared["tab.groups"] = { ...GROUPS, shut: { ...GROUPS.shut, folded: false } };
  expect(rows(draw()).map((row) => arg(row, "h"))).toEqual([32, 32]);
});

test("a tab's color fills its row, under the states, and hover deepens it", () => {
  state.shared["tab.colors"] = { a: "violet", b: "blue" };
  const { view, draw } = column(), rowOf = (id: string) => byId(draw(), `column-${id}`)!;
  expect(shown(rowOf("b"))).toEqual([colors.group_blue_row]);
  expect(shown(rowOf("a"))).toEqual([colors.group_violet_row, colors.group_violet_row]);
  expect(arg(rings(rowOf("a"))[0], "border_color")).toBe(colors.group_violet_ring);
  view.over = "b";
  expect(shown(rowOf("b"))).toEqual([colors.group_blue_row, colors.group_blue_tint]);
});

test("a group's rows stay clear until a color is picked for it", () => {
  const { draw } = column();
  expect(shown(byId(draw(), "column-c")!)).toEqual([]);
  expect(arg(all(byId(draw(), "column-fold-blue")!).find((e) => has(e, "truncate"))!, "text_color")).toBe(colors.group_blue);
});

test("a picked group color fills its rows, a tab's own wins, and none keeps a tab clear", () => {
  state.shared["tab.groups"] = { ...GROUPS, blue: { ...GROUPS.blue, tabs: ["c", "d", "b"], fill: true } };
  state.shared["tab.colors"] = { d: "violet", b: "none" };
  const { draw } = column();
  expect(shown(byId(draw(), "column-c")!)).toEqual([colors.group_blue_row]);
  expect(shown(byId(draw(), "column-d")!)).toEqual([colors.group_violet_row]);
  expect(shown(byId(draw(), "column-b")!)).toEqual([]);
  expect(has(byId(draw(), "column-fold-blue")!, "bg")).toBe(false);
});

test("old saves' \"none\" and an unpainted tab draw no color", () => {
  state.shared["tab.colors"] = { b: "none" };
  const { draw } = column();
  expect(shown(byId(draw(), "column-b")!)).toEqual([]);
});

const openGroup = (root: El) => { handler(byId(root, "column-group")!, "on_mouse_down", "left")({ bounds: { x: 0, y: 0, width: 32, height: 32 } }, cx); handler(byId(root, "column-group")!, "on_click")({}, cx); };

test("the group button drafts a new group and changes nothing", () => {
  state.shared["tabs.picked"] = ["b"];
  const before = JSON.stringify(state.shared);
  openGroup(column().draw());
  expect(JSON.stringify(state.shared)).toBe(before);
  expect(state.overlays[0].props).toMatchObject({ tabs: ["a", "b"], make: true, from: "column-group" });
});

test("on a tab alone in a group, the group button opens that group", () => {
  state.shared["tab.groups"] = { blue: { ...GROUPS.blue, tabs: ["c"] } };
  state.tabs = state.tabs.map((c) => ({ ...c, active: c.id === "c" }));
  openGroup(column().draw());
  expect(state.overlays[0].props).toEqual({ group: "blue", from: "column-group" });
});

test("on a tab with others in its group, the group button drafts a new group", () => {
  state.tabs = state.tabs.map((c) => ({ ...c, active: c.id === "c" }));
  openGroup(column().draw());
  expect(state.overlays[0].props).toMatchObject({ tabs: ["c"], make: true, from: "column-group" });
});

test("a second press on the group button shuts its menu, and the other button still opens", () => {
  const root = column().draw(), group = byId(root, "column-group")!, add = byId(root, "column-new")!;
  const clickAfterShut = (el: El, from: string) => {
    const at = { bounds: { x: 0, y: 0, width: 32, height: 32 } };
    handler(el, "on_mouse_down", "left")(at, cx);
    state.shared["popup.closed"] = { from, at: Date.now() };
    handler(el, "on_click")({}, cx);
  };
  clickAfterShut(group, "column-group");
  expect(state.overlays).toEqual([]);
  clickAfterShut(add, "column-group");
  expect(state.overlays.map((o) => o.mod)).toEqual(["new-menu"]);
});
