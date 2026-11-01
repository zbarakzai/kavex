import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { COLUMN, GAP, INNER, away, clicked, columnHome, columnOrder, columnRuns, columnSlots, columnStops, gathered, groupOf, home, labeled, landed, moves, nearest, nearestY, pruned, reopening, runs, sectionHeight, shownIn, slots, stepped } from "../defaults/mods/tabs/groups.js";

const blank = { groups: {}, colors: {}, folders: [] };
const auth = { auth: { name: "auth", color: "ansi4", folded: false, tabs: ["b", "c"] } };

// What `tab.move` does in the app: out of the list, back in at a 1-based position.
function apply(order: string[], calls: { id: string; index: number }[]) {
  const now = [...order];
  for (const { id, index } of calls) {
    now.splice(now.indexOf(id), 1);
    now.splice(Math.min(index - 1, now.length), 0, id);
  }
  return now;
}

test("the bar shows a group's tabs as one run", () => {
  const tabs = ["a", "b", "c", "d"].map((id) => ({ id }));
  expect(runs(tabs, auth).map((r) => (r.group ? r.tabs.map((t) => t.id) : r.tab.id))).toEqual(["a", ["b", "c"], "d"]);
});

test("a split group comes back together at its first tab", () => {
  expect(gathered(["a", "b", "x", "c", "d"], auth)).toEqual(["a", "b", "c", "x", "d"]);
  expect(gathered(["a", "b", "c"], auth)).toEqual(["a", "b", "c"]);
});

test("a tab joining a group goes to it; the group doesn't jump to the tab", () => {
  const groups = { g: { name: "", color: "ansi4", folded: false, tabs: ["b", "c", "d"] } };
  expect(gathered(["d", "x", "b", "c", "y"], groups)).toEqual(["x", "b", "c", "d", "y"]);
});

test("gathering leaves a whole group's own order alone", () => {
  expect(gathered(["a", "c", "b"], auth)).toEqual(["a", "c", "b"]);
});

test("moves turn one order into another, and repeating them changes nothing", () => {
  const from = ["a", "b", "c", "d", "e"], to = ["e", "c", "a", "d", "b"];
  const calls = moves(from, to);
  expect(apply(from, calls)).toEqual(to);
  expect(apply(to, calls)).toEqual(to);
  expect(moves(to, to)).toEqual([]);
});

test("a fold keeps out only the shown tab", () => {
  const groups = { g: { name: "", color: "ansi4", folded: true, tabs: ["a", "b", "c", "d", "e"] } };
  const tabs = [
    { id: "a", active: true, status: null },
    { id: "b", active: false, status: "blocked" },
    { id: "c", active: false, status: "done" },
    { id: "d", active: false, status: "working" },
    { id: "e", active: false, status: null },
    { id: "f", active: false, status: null },
  ];
  expect([...away(tabs, groups)]).toEqual(["b", "c", "d", "e"]);
  expect([...away(tabs, { g: { ...groups.g, folded: false } })]).toEqual([]);
});

test("tabs that are gone leave their group, and an empty group goes", () => {
  expect(pruned(auth, (id) => id === "b").auth.tabs).toEqual(["b"]);
  expect(pruned(auth, () => false)).toEqual({});
});

test("a mouse wheel steps through tabs and stops at the ends", () => {
  const tabs = [{ id: "a", active: true }, { id: "b", settled: true }, { id: "c" }];
  expect(stepped(tabs, true)?.id).toBe("c");
  expect(stepped(tabs, false)).toBeNull();
  expect(stepped([{ id: "a" }, { id: "c", active: true }], true)).toBeNull();
});

// a | [tag b c] | d, every tab 100 wide, every tag 50.
const tabs = ["a", "b", "c", "d"].map((id) => ({ id }));
const bar = runs(tabs, auth);
const width = (key: string) => (key.startsWith("tag:") ? 50 : 100);
const none = new Set<string>();
const at = (list: ReturnType<typeof slots>, key: string) => list.find((s) => s.key === key)!;

test("slots sit where the bar draws things, with what's moving taken out", () => {
  const list = slots(bar, { tabs: ["d"] }, width, none);
  expect(list.map((s) => s.key)).toEqual(["a", "before:auth", "b", "c", "in:auth", "end"]);
  const tray = 100 + GAP;
  expect(at(list, "before:auth").x).toBe(tray);
  expect(at(list, "b").x).toBe(tray + 3 + 50 + INNER);
  expect(at(list, "c").x).toBe(tray + 3 + 50 + INNER + 100 + INNER);
  expect(at(list, "in:auth").x).toBe(tray + 3 + 50 + INNER + 2 * (100 + INNER));
  expect(at(list, "end").x).toBe(tray + 3 + 50 + 2 * (INNER + 100) + 3 + GAP);
  expect(list.map((s) => s.at)).toEqual([0, 1, 1, 2, 3, 3]);
  expect(list.map((s) => s.group)).toEqual([null, null, "auth", "auth", "auth", null]);
});

test("a dragged group only has slots beside other groups", () => {
  const list = slots(bar, { group: "auth" }, width, none);
  expect(list.map((s) => s.key)).toEqual(["a", "d", "end"]);
  expect(at(list, "d").x).toBe(100 + GAP);
});

test("a fold takes a tab on its tag, and keeps slots for tabs out of it", () => {
  const list = slots(bar, { tabs: ["a"] }, width, new Set(["b"]));
  expect(list.map((s) => s.key)).toEqual(["before:auth", "fold:auth", "c", "in:auth", "d", "end"]);
  expect(at(list, "fold:auth")).toMatchObject({ fold: true, at: 0, group: "auth", x: 3 });
  expect(at(list, "c")).toMatchObject({ x: 3 + 50 + INNER, at: 1, group: "auth" });
  const shut = slots(bar, { tabs: ["a"] }, width, new Set(["b", "c"]));
  expect(shut.map((s) => s.key)).toEqual(["before:auth", "fold:auth", "d", "end"]);
});

test("the nearest slot wins, whatever has opened on the way", () => {
  const list = slots(bar, { tabs: ["d"] }, width, none);
  expect(nearest(list, 10).key).toBe("a");
  expect(nearest(list, 110).key).toBe("before:auth");
  expect(nearest(list, 150).key).toBe("b");
  expect(nearest(list, 900).key).toBe("end");
});

test("a drag starts from the slot it's already in", () => {
  const order = ["a", "b", "c", "d"];
  const from = (moving: { tabs?: string[]; group?: string }) => home(slots(bar, moving, width, none), order, auth, moving).key;
  expect(from({ tabs: ["a"] })).toBe("before:auth");
  expect(from({ tabs: ["b"] })).toBe("c");
  expect(from({ tabs: ["c"] })).toBe("in:auth");
  expect(from({ tabs: ["d"] })).toBe("end");
  expect(from({ group: "auth" })).toBe("d");
});

test("landing where it started changes nothing", () => {
  const order = ["a", "b", "c", "d"];
  for (const moving of [{ tabs: ["a"] }, { tabs: ["b"] }, { tabs: ["c"] }, { tabs: ["d"] }, { group: "auth" }]) {
    expect(landed(order, auth, moving, home(slots(bar, moving, width, none), order, auth, moving))).toBeNull();
  }
});

test("a tab landing outside a tray is out of its group; an empty group goes", () => {
  const order = ["a", "b", "c", "d"];
  const list = slots(bar, { tabs: ["c"] }, width, none);
  expect(landed(order, auth, { tabs: ["c"] }, at(list, "end"))).toEqual({
    order: ["a", "b", "d", "c"],
    groups: { auth: { ...auth.auth, tabs: ["b"] } },
  });
  const alone = { g: { name: "", color: "ansi4", folded: false, tabs: ["a"] } };
  const two = runs([{ id: "a" }, { id: "b" }], alone);
  expect(landed(["a", "b"], alone, { tabs: ["a"] }, at(slots(two, { tabs: ["a"] }, width, none), "end"))?.groups).toEqual({});
});

test("a tab landing between a group's tabs joins it there", () => {
  const list = slots(bar, { tabs: ["d"] }, width, none);
  expect(landed(["a", "b", "c", "d"], auth, { tabs: ["d"] }, at(list, "c"))).toEqual({
    order: ["a", "b", "d", "c"],
    groups: { auth: { ...auth.auth, tabs: ["b", "c", "d"] } },
  });
});

test("a tab landing on a fold's tag joins it; moved to the same place it still joins", () => {
  const list = slots(bar, { tabs: ["a"] }, width, new Set(["b", "c"]));
  const r = landed(["a", "b", "c", "d"], auth, { tabs: ["a"] }, at(list, "fold:auth"));
  expect(r?.order).toEqual(["a", "b", "c", "d"]);
  expect(groupOf(r!.groups, "a")).toBe("auth");
});

test("several selected tabs move as one, keeping their order", () => {
  const order = ["a", "b", "c", "d", "e"];
  const five = runs(order.map((id) => ({ id })), auth);
  const moving = { tabs: ["e", "a"] };
  const r = landed(order, auth, moving, at(slots(five, moving, width, none), "c"));
  expect(r?.order).toEqual(["b", "a", "e", "c", "d"]);
  expect(groupOf(r!.groups, "e")).toBe("auth");
});

test("a dragged group lands whole, beside another group", () => {
  const groups = { ...auth, more: { name: "", color: "ansi1", folded: false, tabs: ["d", "e"] } };
  const order = ["a", "b", "c", "d", "e"];
  const both = runs(order.map((id) => ({ id })), groups);
  const before = at(slots(both, { group: "more" }, width, none), "before:auth");
  expect(landed(order, groups, { group: "more" }, before)?.order).toEqual(["a", "d", "e", "b", "c"]);
  const after = at(slots(both, { group: "auth" }, width, none), "end");
  expect(landed(order, groups, { group: "auth" }, after)?.order).toEqual(["a", "d", "e", "b", "c"]);
  expect(landed(order, groups, { group: "auth" }, after)?.groups).toBe(groups);
});

// The drag layer's delivery, run as written: the rest of the mod needs the app.
const layer = await readFile(new URL("../defaults/mods/tab-drag/main.js", import.meta.url), "utf8");
const send = layer.slice(layer.indexOf("  send() {"), layer.indexOf("  // The bar closes this"));
function dragLayer() {
  const sent: string[] = [];
  const object = new Function("run", `return { busy: false, at: null, to: () => "tabs", ${send} };`)((c: string) => sent.push(c));
  const move = (x: number) => { object.at = { x, y: 0 }; object.send(); };
  const ready = () => { object.busy = false; object.send(); };
  return { sent, move, ready };
}

test("a held tab can't fall behind: one place on its way at a time, and the newest wins", () => {
  const { sent, move, ready } = dragLayer();
  for (const x of [1, 2, 3, 4, 5]) move(x);
  expect(sent).toEqual(["tabs.drag:1,0"]);
  ready();
  expect(sent).toEqual(["tabs.drag:1,0", "tabs.drag:5,0"]);
});

test("the layer stops asking when there's nothing new to say", () => {
  const { sent, move, ready } = dragLayer();
  move(1);
  ready();
  ready();
  expect(sent).toEqual(["tabs.drag:1,0"]);
  move(2);
  expect(sent).toEqual(["tabs.drag:1,0", "tabs.drag:2,0"]);
});

// The column: two loose tabs round a two-tab group, a folded group, then one more loose tab.
const col = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id, active: id === "a", status: null }));
const cg = { one: { name: "one", color: "blue", folded: false, tabs: ["c", "d"] }, two: { name: "two", color: "teal", folded: true, tabs: ["e", "f"] } };
const ids = (list: { id: string }[]) => list.map((c) => c.id);
const key = (list: { key: string }[], k: string) => list.find((s) => s.key === k) as any;
const orderIds = col.map((c) => c.id);

test("the column lists loose tabs first, then one section per group in tab order", () => {
  const { loose, sections } = columnRuns(col, cg);
  expect(ids(loose)).toEqual(["a", "b", "g"]);
  expect(sections.map((c) => c.group)).toEqual(["one", "two"]);
});

test("column slots sit where the rows draw", () => {
  const list = columnSlots(col, cg, {});
  const { gap, row, rowGap, head, inRow } = COLUMN;
  expect(key(list, "b").y).toBe(row + rowGap);
  const section = 3 * row + 2 * rowGap + gap;
  expect(key(list, "before:one").y).toBe(section);
  expect(key(list, "d").y).toBe(section + head + rowGap + inRow + rowGap);
  expect(key(list, "before:two").y).toBe(section + sectionHeight(cg.one, ["c", "d"].map((id) => col.find((c) => c.id === id))) + gap);
});

test("the spec's sizes", () => {
  expect(COLUMN).toEqual({ row: 32, inRow: 30, head: 30, rowGap: 2, gap: 14 });
});

test("a tab with nothing loose above it doesn't shift the list when picked up", () => {
  const tabs = ["c", "d", "e"].map((id) => ({ id, active: id === "c", status: null }));
  const groups = { one: { name: "one", color: "blue", folded: false, tabs: ["c", "d", "e"] } };
  expect(key(columnSlots(tabs, groups, { tabs: ["e"] }), "c").y).toBe(key(columnSlots(tabs, groups, {}), "c").y);
});

test("a folded group shows the shown tab, and only that", () => {
  const tabs = col.map((c) => ({ ...c, active: c.id === "e" }));
  expect(ids(shownIn(cg.two, tabs.filter((c) => cg.two.tabs.includes(c.id))))).toEqual(["e"]);
  expect(key(columnSlots(tabs, cg, {}), "fold:two")).toMatchObject({ fold: true, group: "two" });
});

test("the shown tab of a folded group can be found and carried off", () => {
  const tabs = col.map((c) => ({ ...c, active: c.id === "e" }));
  const { head, rowGap } = COLUMN, all = columnSlots(tabs, cg, {});
  expect(key(all, "e").y).toBe(key(all, "fold:two").y + head + rowGap);
  const moving = { tabs: ["e"] }, list = columnSlots(tabs, cg, moving);
  expect(key(list, "e")).toBeUndefined();
  expect(columnHome(list, tabs, cg, moving).key).toBe("fold:two");
});

test("the keyboard stops on every row shown and every group's name, top to bottom", () => {
  expect(columnStops(col, cg)).toEqual(["a", "b", "g", "group:one", "c", "d", "group:two"]);
  const tabs = col.map((c) => ({ ...c, active: c.id === "f" }));
  expect(columnStops(tabs, cg)).toEqual(["a", "b", "g", "group:one", "c", "d", "group:two", "f"]);
});

test("reordering loose tabs keeps them loose and in that order", () => {
  const moving = { tabs: ["g"] }, list = columnSlots(col, cg, moving);
  const r = landed(orderIds, cg, moving, key(list, "b"));
  expect(columnRuns(r!.order.map((id) => ({ id, active: false })), r!.groups).loose.map((c) => c.id)).toEqual(["a", "g", "b"]);
});

test("a loose tab dropped between a group's rows joins it there", () => {
  const moving = { tabs: ["a"] }, list = columnSlots(col, cg, moving);
  const r = landed(orderIds, cg, moving, key(list, "d"));
  expect(r!.groups.one.tabs.sort()).toEqual(["a", "c", "d"]);
  expect(r!.order.indexOf("a")).toBeLessThan(r!.order.indexOf("d"));
  expect(gathered(r!.order, r!.groups)).toEqual(r!.order);
});

test("a tab dropped at the end of a section joins it last", () => {
  const moving = { tabs: ["g"] }, r = landed(orderIds, cg, moving, key(columnSlots(col, cg, moving), "in:one"));
  expect(r!.groups.one.tabs).toEqual(["c", "d", "g"]);
  expect(r!.order.indexOf("g")).toBe(r!.order.indexOf("d") + 1);
});

test("a tab dropped on a folded section joins it", () => {
  const moving = { tabs: ["a"] }, r = landed(orderIds, cg, moving, key(columnSlots(col, cg, moving), "fold:two"));
  expect(r!.groups.two.tabs).toContain("a");
});

test("a group's tab dropped among the loose tabs leaves the group", () => {
  const moving = { tabs: ["c"] }, r = landed(orderIds, cg, moving, key(columnSlots(col, cg, moving), "loose-end"));
  expect(r!.groups.one.tabs).toEqual(["d"]);
  expect(columnRuns(r!.order.map((id) => ({ id, active: false })), r!.groups).loose.at(-1)!.id).toBe("c");
});

test("the only tab of a group can be carried off, and its section keeps a place to come back", () => {
  const groups = { solo: { name: "solo", color: "blue", folded: false, tabs: ["c"] } };
  const moving = { tabs: ["c"] }, list = columnSlots(col, groups, moving);
  expect(key(list, "in:solo")).toBeTruthy();
  expect(columnHome(list, col, groups, moving).key).toBe("in:solo");
  expect(landed(orderIds, groups, moving, key(list, "loose-end"))!.groups).toEqual({});
});

test("a group only lands between sections, and moves whole", () => {
  const moving = { group: "two" }, list = columnSlots(col, cg, moving);
  expect(list.map((s) => s.key)).toEqual(["before:one", "end"]);
  const r = landed(orderIds, cg, moving, key(list, "before:one"));
  expect(columnRuns(r!.order.map((id) => ({ id, active: false })), r!.groups).sections.map((c) => c.group)).toEqual(["two", "one"]);
});

test("a column drag starts where it is, and setting it down there is no move", () => {
  for (const moving of [{ tabs: ["a"] }, { tabs: ["b"] }, { tabs: ["g"] }, { tabs: ["c"] }, { tabs: ["d"] }, { tabs: ["e"] }, { group: "one" }, { group: "two" }]) {
    const list = columnSlots(col, cg, moving);
    expect(columnHome(list, col, cg, moving)).toBeTruthy();
  }
  const moving = { tabs: ["b"] };
  expect(columnHome(columnSlots(col, cg, moving), col, cg, moving).key).toBe("g");
});

test("several picked tabs carry together, in tab order", () => {
  const moving = { tabs: ["a", "g"] }, list = columnSlots(col, cg, moving);
  const r = landed(orderIds, cg, moving, key(list, "in:one"));
  expect(r!.groups.one.tabs).toEqual(["c", "d", "a", "g"]);
});

test("the nearest place wins in the column too", () => {
  const list = columnSlots(col, cg, { tabs: ["a"] });
  expect(nearestY(list, key(list, "d").y + 3).key).toBe("d");
});

test("a click shows, Command picks one by one, Shift picks a range", () => {
  const tabs = ["a", "b", "c", "d"].map((id) => ({ id, active: id === "b" })), c = tabs[3];
  expect(clicked(tabs, c, { shift: false, picking: false }, ["a"])).toBeNull();
  expect(clicked(tabs, c, { shift: false, picking: true }, ["a"])).toEqual(["a", "d"]);
  expect(clicked(tabs, c, { shift: false, picking: true }, ["a", "d"])).toEqual(["a"]);
  expect(clicked(tabs, c, { shift: true, picking: false }, [])).toEqual(["b", "c", "d"]);
});

test("a label puts a tab in its group, makes one if needed, and moves it from another", () => {
  const colors = ["blue", "violet", "teal"];
  const made = labeled({}, "a", "sweep", colors, "g1");
  expect(made).toEqual({ g1: { name: "sweep", color: "blue", folded: false, tabs: ["a"] } });
  const joined = labeled(made, "b", "sweep", colors, "g2");
  expect(joined.g1.tabs).toEqual(["a", "b"]);
  expect(labeled(joined, "b", "sweep", colors, "g3")).toBe(joined);
  const moved = labeled(joined, "b", "checks", colors, "g4");
  expect(moved.g1.tabs).toEqual(["a"]);
  expect(moved.g4).toMatchObject({ name: "checks", color: "violet", tabs: ["b"] });
});

test("the column's order is what it draws: loose tabs, then each group", () => {
  const tabs = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  expect(columnOrder(tabs, auth)).toEqual(["a", "d", "e", "b", "c"]);
  expect(columnOrder(tabs, {})).toEqual(["a", "b", "c", "d", "e"]);
});

test("in the column, ungrouping leaves the tabs at the end of the loose ones", () => {
  const two = { ...auth, ops: { name: "ops", color: "teal", folded: false, tabs: ["e"] } };
  const drawn = columnOrder(["a", "b", "c", "d", "e"].map((id) => ({ id })), two), { ops, ...rest } = two;
  expect(drawn).toEqual(["a", "d", "b", "c", "e"]);
  expect(columnOrder(drawn.map((id) => ({ id })), { ops })).toEqual(["a", "d", "b", "c", "e"]);
  expect(columnOrder(drawn.map((id) => ({ id })), rest)).toEqual(["a", "d", "e", "b", "c"]);
});

test("a press that closed its own button's popup doesn't open it again", () => {
  expect(reopening({ from: "x", at: 1000 }, "x", 1000)).toBe(true);
  expect(reopening({ from: "x", at: 950 }, "x", 1000)).toBe(true);
  expect(reopening({ from: "x", at: 500 }, "x", 1000)).toBe(false);
  expect(reopening({ from: "y", at: 1000 }, "x", 1000)).toBe(false);
  expect(reopening(undefined, "x", 1000)).toBe(false);
});
