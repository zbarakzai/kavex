import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { GAP, away, colorOf, gathered, groupOf, home, landed, moves, nearest, pruned, runs, slots, stepped } from "../defaults/mods/tabs/groups.js";

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

test("a tab wears its own color, else its group's, else its deepest folder's", () => {
  const folders = [{ machine: null, folder: "/code", color: "ansi1" }, { machine: null, folder: "/code/zaki", color: "ansi2" }];
  expect(colorOf("a", { ...blank, folders }, "/code/zaki/src", null)).toBe("ansi2");
  expect(colorOf("a", { ...blank, folders, colors: { a: "ansi3" } }, "/code/zaki", null)).toBe("ansi3");
  expect(colorOf("b", { groups: auth, colors: { b: "ansi3" }, folders }, "/code/zaki", null)).toBe("ansi3");
  expect(colorOf("b", { groups: auth, colors: {}, folders }, "/code/zaki", null)).toBe("ansi4");
});

test("no color on a grouped tab means its group's color", () => {
  expect(colorOf("b", { groups: auth, colors: { b: "none" }, folders: [] }, null, null)).toBe("ansi4");
});

test("no color beats a colored folder", () => {
  const folders = [{ machine: null, folder: "/code", color: "ansi1" }];
  expect(colorOf("a", { ...blank, folders, colors: { a: "none" } }, "/code", null)).toBeNull();
});

test("a folder's color needs its machine and a whole folder name", () => {
  const folders = [{ machine: "vps", folder: "/code", color: "ansi1" }];
  expect(colorOf("a", { ...blank, folders }, "/code", null)).toBeNull();
  expect(colorOf("a", { ...blank, folders }, "/code", "vps")).toBe("ansi1");
  expect(colorOf("a", { ...blank, folders }, "/code-old", "vps")).toBeNull();
  expect(colorOf("a", { ...blank, folders: [{ machine: null, folder: "C:\\code", color: "ansi1" }] }, "C:\\code\\zaki", null)).toBe("ansi1");
});

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

test("a fold keeps out the shown tab and any tab that needs the person", () => {
  const groups = { g: { name: "", color: "ansi4", folded: true, tabs: ["a", "b", "c", "d", "e"] } };
  const tabs = [
    { id: "a", active: true, status: null },
    { id: "b", active: false, status: "blocked" },
    { id: "c", active: false, status: "done" },
    { id: "d", active: false, status: "working" },
    { id: "e", active: false, status: null },
    { id: "f", active: false, status: null },
  ];
  expect([...away(tabs, groups)]).toEqual(["d", "e"]);
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
const width = (key: string) => (key.startsWith("tag:") ? 50 : key.startsWith("lights:") ? 20 : 100);
const none = new Set<string>();
const at = (list: ReturnType<typeof slots>, key: string) => list.find((s) => s.key === key)!;

test("slots sit where the bar draws things, with what's moving taken out", () => {
  const list = slots(bar, { tabs: ["d"] }, width, none);
  expect(list.map((s) => s.key)).toEqual(["a", "before:auth", "b", "c", "in:auth", "end"]);
  const tray = 100 + GAP;
  expect(at(list, "before:auth").x).toBe(tray);
  expect(at(list, "b").x).toBe(tray + 6 + 50 + GAP);
  expect(at(list, "c").x).toBe(tray + 6 + 50 + GAP + 100 + GAP);
  expect(at(list, "in:auth").x).toBe(tray + 6 + 50 + GAP + 2 * (100 + GAP));
  expect(at(list, "end").x).toBe(tray + 6 + 50 + 2 * (GAP + 100) + 6 + GAP);
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
  expect(at(list, "fold:auth")).toMatchObject({ fold: true, at: 0, group: "auth", x: 6 });
  expect(at(list, "c")).toMatchObject({ x: 6 + 50 + GAP + 20 + GAP, at: 1, group: "auth" });
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
  const object = new Function("run", `return { busy: false, at: null, ${send} };`)((c: string) => sent.push(c));
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
