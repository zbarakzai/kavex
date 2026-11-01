import { test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";

// The real Settings screen with recording fakes: every page draws, and what its switches change.
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

const file = JSON.parse(readFileSync(new URL("../defaults/themes/zaki.json", import.meta.url), "utf8"));
const colors = { background: file.background, ...file.colors };
let state: { shared: Record<string, any> };
const input = { on: () => {}, value: () => "", focus: () => {}, set_value: () => {}, set_selected_range: () => {} };
mock.module("gpui-kit", () => ({ View: class {}, div: make, svg: make, image: make }));
mock.module("gpui-base", () => ({ h_flex: make, v_flex: make, InputState: { new: () => input }, Input: { new: make } }));
mock.module("herdr", () => ({
  hc: async () => ({ code: 0, stdout: '{"machines":[]}', stderr: "" }),
  run: () => {},
  theme: () => colors,
  themes: () => [{ name: "zaki", light: false, colors: { ...colors, terminal_foreground: "#fff" } }, { name: "paper", light: true, colors: { ...colors, terminal_foreground: "#000" } }],
  fonts: () => ["Geist"],
  updates: () => ({ app: { version: "0.4.0", updates: true }, core: { version: "0.1.15" }, checks: true }),
  telemetry: () => null,
  settings: () => ({ zoom: 1, font_family: "Geist Mono", font_size: 13, ui_font_family: "Geist", theme_dark: "zaki", theme_light: "paper" }),
  layouts: () => ["main"],
  shared: (k: string) => state.shared[k],
  setShared: (k: string, v: any) => { state.shared[k] = v; },
  appHome: () => "/home",
  readTextFile: async () => "{}",
  writeTextFile: async () => {},
  playSound: () => {},
  props: () => ({ overlay: "ov" }),
  closeOverlay: () => {},
  layout: () => null,
}));
const { default: Settings } = await import("../defaults/frame/settings/main.js");

const cx: any = { notify: () => {}, spawn: () => {}, focus_handle: () => ({ focus: () => {} }), timer: { every: () => {} } };
const open = (section = "look") => {
  const view: any = new Settings();
  view.init({}, cx);
  view.section = section;
  view.machineList = [];
  return { view, draw: () => view.render(cx).el as El };
};
const click = (root: El, id: string) => handler(byId(root, id)!, "on_click")({}, cx);
const knob = (root: El, id: string) => arg(byId(root, `${id}-knob`)!, "left");

beforeEach(() => { state = { shared: { layout: "main" } }; });

test("every page draws", () => {
  for (const page of ["look", "machines", "alerts", "updates", "privacy"]) expect(all(open(page).draw()).length).toBeGreaterThan(10);
});

test("it's the window in small: the canvas behind, rounded to fit the frame, and a panel for the page", () => {
  const root = open().draw(), page = byId(root, "st-body")!;
  expect([arg(root, "bg"), arg(root, "rounded"), arg(root, "p"), arg(root, "gap")]).toEqual([colors.canvas, 13, 6, 6]);
  const panel = all(root).find((e) => e.kids.some((k) => mine(k) === page))!;
  expect([arg(panel, "bg"), arg(panel, "border_color")]).toEqual([colors.panel, colors.panel_border]);
});

test("the shown page is marked like the shown tab", () => {
  const row = byId(open("alerts").draw(), "st-s-alerts")!, other = byId(open("alerts").draw(), "st-s-look")!;
  expect([arg(row, "bg"), arg(row, "border_color")]).toEqual([colors.row_selected_strong, colors.chip_active_ring]);
  expect(arg(other, "bg")).toBeUndefined();
});

test("settings sit on cards, and rows have no lines between them", () => {
  const root = open("alerts").draw();
  const cards = all(root).filter((e) => arg(e, "bg") === colors.card && arg(e, "rounded") === 14);
  expect(cards.map((c) => [arg(c, "rounded"), arg(c, "border_color")])).toEqual([[14, colors.card_border]]);
  expect(all(root).some((e) => e.calls.some(([k]) => k === "border_b"))).toBe(false);
});

test("section labels are spaced mono, and numbers are mono", () => {
  const root = open().draw();
  expect(all(root).find((e) => arg(e, "font_family") === "Geist Mono" && arg(e, "text_size") === 10.5)).toBeTruthy();
  expect(words(root)).not.toContain("LAYOUT");
  const zoom = all(byId(root, "st-zoom-minus") ? root : root).find((e) => e.kids.includes("100%"))!;
  expect(arg(zoom, "font_family")).toBe("Geist Mono");
});

test("buttons and switches are pills like the tab bar's", () => {
  const root = open().draw(), reset = byId(root, "st-zoom-reset")!, tabs = byId(root, "st-tabs-On top")!;
  expect([arg(reset, "h"), arg(reset, "rounded"), arg(reset, "bg"), arg(reset, "border_color")]).toEqual([34, 999, colors.pill, colors.pill_ring]);
  expect([arg(tabs, "h"), arg(tabs, "bg")]).toEqual([26, colors.pill_selected]);
});

test("a switch's knob slides, and an on switch isn't orange", () => {
  const root = open("alerts").draw(), track = byId(root, "st-sounds")!, knobEl = byId(root, "st-sounds-knob")!;
  expect(arg(track, "bg")).not.toBe(colors.accent);
  expect([arg(knobEl, "left"), arg(knobEl, "transition")]).toEqual([18, "left"]);
});

test("both panels start on, and each switch turns its own off and on", () => {
  const { draw } = open();
  expect([knob(draw(), "st-panel-files"), knob(draw(), "st-panel-changes")]).toEqual([18, 18]);
  click(draw(), "st-panel-files");
  expect(state.shared["workspace.panels"]).toEqual(["changes"]);
  expect([knob(draw(), "st-panel-files"), knob(draw(), "st-panel-changes")]).toEqual([2, 18]);
  click(draw(), "st-panel-changes");
  expect(state.shared["workspace.panels"]).toEqual([]);
  click(draw(), "st-panel-files");
  expect(state.shared["workspace.panels"]).toEqual(["files"]);
});

test("panels and tabs are only offered in the layout that has them", () => {
  state.shared.layout = "terminals";
  const root = open().draw();
  expect(byId(root, "st-panel-files")).toBeUndefined();
  expect(byId(root, "st-tabs-On top")).toBeUndefined();
  expect(byId(root, "st-usage")).toBeUndefined();
});

test("Usage limits starts on, and off leaves nothing saved behind", () => {
  state.shared.usage = { checkedAt: 1, entries: {} };
  state.shared["usage.opencode"] = true;
  const { draw } = open();
  expect(knob(draw(), "st-usage")).toBe(18);
  click(draw(), "st-usage");
  expect(state.shared).toMatchObject({ "usage.enabled": false, usage: null, "usage.opencode": null, "usage.warned": null });
  expect(knob(draw(), "st-usage")).toBe(2);

  state.shared.usage = { checkedAt: 2, entries: {} };
  click(draw(), "st-usage");
  expect(state.shared["usage.enabled"]).toBe(true);
  expect(state.shared.usage).toEqual({ checkedAt: 2, entries: {} });
});
