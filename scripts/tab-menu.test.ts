import { test, expect, mock, beforeEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

// The real menu with recording fakes: what each press changes in shared state.
type El = { calls: [string, any[]][]; kids: any[] };
function make(): any {
  const el: El = { calls: [], kids: [] };
  const self: any = new Proxy({}, {
    get: (_t, k: string) => {
      if (k === "el") return el;
      if (k === "when") return (on: unknown, f: (s: any) => any) => (on ? f(self) : self);
      if (k === "child") return (kid: any) => (el.kids.push(kid), self);
      if (k === "children") return (kids: any[]) => (el.kids.push(...kids), self);
      if (k === "hover") return () => self;
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

let state: { shared: Record<string, any>; props: any; closed: string[]; ran: string[]; moved: any[]; input: any };
const file = JSON.parse(readFileSync(new URL("../defaults/themes/kavex.json", import.meta.url), "utf8"));
const colors = { background: file.background, ...file.colors };
const InputState = {
  new: ({ value }: { value: string }) => {
    const on: Record<string, () => void> = {};
    state.input = { text: value, on: (name: string, f: () => void) => { on[name] = f; }, fire: (name: string) => on[name]?.(), value: () => state.input.text, focus: () => {}, set_selected_range: () => {} };
    return state.input;
  },
};
const icon = (path: string) => { const s = make(); s.el.calls.push(["path", [path]]); return s; };
mock.module("gpui-kit", () => ({ View: class {}, div: make, svg: icon, image: make }));
mock.module("gpui-base", () => ({ h_flex: make, v_flex: make, InputState, Input: { new: make } }));
mock.module("herdr", () => ({
  run: (name: string, args: any) => { state.ran.push(name); if (name === "tab.move") state.moved.push(args); },
  props: () => state.props,
  closeOverlay: (id: string) => void state.closed.push(id),
  openOverlay: () => "overlay",
  theme: () => colors,
  keys: () => [],
  spaces: () => [{ id: "s", active: true, tabs: ["a", "b", "c"].map((id) => ({ id })) }],
  shared: (k: string) => state.shared[k],
  setShared: (k: string, v: any) => { state.shared[k] = v; },
  layout: () => null,
}));
const { default: TabMenu } = await import("../defaults/mods/tab-menu/main.js");

const cx: any = { notify: () => {}, focus_handle: () => ({ focus: () => {} }), timer: { after: () => {} } };
const open = (props: any) => {
  state.props = { overlay: "ov", ...props };
  const view: any = new TabMenu();
  view.init({}, cx);
  return { view, draw: () => view.render(cx).el as El };
};
const click = (root: El, id: string) => handler(byId(root, id)!, "on_click")({}, cx);
const rowNamed = (root: El, name: string) => all(root).find((e) => String(arg(e, "id")).startsWith("tm-") && words(e).includes(name))!;
const ringOf = (root: El, id: string) => arg(byId(root, id)!, "border_color");

const GROUP = { name: "auth", color: "blue", folded: false, tabs: ["b"] };
beforeEach(() => {
  state = { shared: { "tab.groups": { auth: GROUP } }, props: {}, closed: [], ran: [], moved: [], input: null };
});

test("a color on a tab fills that tab and moves nothing", () => {
  const { draw } = open({ tabs: ["a"], space: "s" });
  click(draw(), "color-violet");
  expect(state.shared["tab.colors"]).toEqual({ a: "violet" });
  expect(state.shared["tab.groups"]).toEqual({ auth: GROUP });
  expect(state.closed).toEqual([]);
  expect(ringOf(draw(), "color-violet")).toBe(colors.group_violet);
});

test("none takes the color off, and picked tabs change together", () => {
  state.shared["tab.colors"] = { a: "blue", b: "teal" };
  const { draw } = open({ tabs: ["a", "b"], space: "s" });
  expect(words(draw())).toContain("Tab colors");
  expect(ringOf(draw(), "color-none")).toBe(`${colors.surface}00`);
  click(draw(), "color-none");
  expect(state.shared["tab.colors"]).toEqual({});
  expect(ringOf(draw(), "color-none")).toBe(colors.muted);
});

test("a new group changes nothing until it's created", () => {
  const { draw } = open({ tabs: ["b"], make: true, space: "s" });
  state.input.text = "ship";
  click(draw(), "color-teal");
  expect(state.shared["tab.groups"]).toEqual({ auth: GROUP });
  expect(ringOf(draw(), "color-teal")).toBe(colors.group_teal);

  click(rowNamed(draw(), "Create group"), "tm-0");
  const groups = Object.values(state.shared["tab.groups"]) as any[];
  expect(groups).toEqual([{ name: "ship", color: "teal", fill: true, folded: false, tabs: ["b"] }]);
  expect(state.closed).toEqual(["ov"]);
});

test("with tabs on the right a new group's section comes first among the groups", () => {
  state.shared["tabs.placement"] = "right";
  const { draw } = open({ tabs: ["c"], make: true, space: "s" });
  click(rowNamed(draw(), "Create group"), "tm-0");
  expect(state.moved).toEqual([{ id: "c", index: 2 }]);
  expect(state.shared["tabs.hold"]).toBeGreaterThan(Date.now());
});

test("on the bar a new group moves no tab", () => {
  const { draw } = open({ tabs: ["c"], make: true, space: "s" });
  click(rowNamed(draw(), "Create group"), "tm-0");
  expect(state.moved).toEqual([]);
  expect(state.shared["tabs.hold"]).toBeUndefined();
});

test("closing a draft leaves everything as it was", () => {
  state.shared["tabs.picked"] = ["a", "c"];
  open({ tabs: ["a", "c"], make: true, space: "s", from: "column-group" }).view.close();
  expect(state.shared["tab.groups"]).toEqual({ auth: GROUP });
  expect(state.shared["tabs.picked"]).toEqual(["a", "c"]);
  expect(state.shared["popup.closed"].from).toBe("column-group");
});

test("Enter in the name creates the group too, and clears the picks", () => {
  state.shared["tabs.picked"] = ["a", "c"];
  const { draw } = open({ tabs: ["a", "c"], make: true, space: "s" });
  expect(words(draw())).toContain("Create group");
  state.input.fire("submit");
  expect(Object.values(state.shared["tab.groups"]).map((g: any) => g.tabs)).toEqual([["b"], ["a", "c"]]);
  expect(state.shared["tabs.picked"]).toEqual([]);
});

test("the menu's New group drafts in place, it doesn't move the tab", () => {
  const { draw } = open({ tabs: ["b"], space: "s" });
  click(rowNamed(draw(), "New group"), "tm-1");
  expect(state.shared["tab.groups"]).toEqual({ auth: GROUP });
  expect(words(draw())).toContain("Create group");
});

test("a new group's tabs stay clear unless a color is picked, and none is shown as chosen", () => {
  const { draw } = open({ tabs: ["a"], make: true, space: "s" });
  expect(ringOf(draw(), "color-none")).toBe(colors.muted);
  state.input.fire("submit");
  const made = (Object.values(state.shared["tab.groups"]) as any[]).find((g) => g.tabs.includes("a"));
  expect(made.fill).toBe(false);
  expect(made.color).toBe("violet");
});

test("a group's color applies live, and none clears its tabs but keeps its name's color", () => {
  const { draw } = open({ group: "auth" });
  expect(ringOf(draw(), "color-none")).toBe(colors.muted);
  click(draw(), "color-violet");
  expect(state.shared["tab.groups"].auth).toEqual({ ...GROUP, color: "violet", fill: true });
  expect(ringOf(draw(), "color-violet")).toBe(colors.group_violet);
  click(draw(), "color-none");
  expect(state.shared["tab.groups"].auth).toEqual({ ...GROUP, color: "violet", fill: false });
  expect(words(draw())).toContain("Group color");
});

test("none on a tab in a filled group keeps that tab clear, and shows as chosen", () => {
  state.shared["tab.groups"] = { auth: { ...GROUP, fill: true } };
  const { draw } = open({ tabs: ["b"], space: "s" });
  expect(ringOf(draw(), "color-blue")).toBe(colors.group_blue);
  click(draw(), "color-none");
  expect(state.shared["tab.colors"]).toEqual({ b: "none" });
  expect(ringOf(draw(), "color-none")).toBe(colors.muted);
});

test("a popup opened with no button says nothing as it goes", () => {
  open({ tabs: ["a"], space: "s" }).view.close();
  expect(state.shared["popup.closed"]).toBeUndefined();
});

test("no color is the crossed-out circle, in both menus", () => {
  for (const asked of [{ tabs: ["a"], space: "s" }, { group: "auth" }, { tabs: ["a"], make: true, space: "s" }]) {
    const mark = all(byId(open(asked).draw(), "color-none")!).find((e) => arg(e, "path"))!;
    const dot = all(byId(open(asked).draw(), "color-none")!).find((e) => arg(e, "bg"))!;
    expect(arg(mark, "path")).toBe("mods/workspace-chrome/icons/no-color.svg");
    expect([arg(dot, "bg"), arg(dot, "size"), arg(dot, "rounded")]).toEqual([colors.background, 14, 7]);
  }
  expect(existsSync(new URL("../defaults/mods/workspace-chrome/icons/no-color.svg", import.meta.url))).toBe(true);
});
