import { test, expect, mock } from "bun:test";
import { readFileSync } from "node:fs";

const element = () => new Proxy({}, { get: (_t, _k, self) => () => self });
mock.module("gpui-kit", () => ({ View: class {}, div: element, svg: element, PathBuilder: { stroke: element } }));
mock.module("gpui-base", () => ({ v_flex: element }));
mock.module("herdr", () => ({ theme: () => ({ dim: "#555555", accent: "#EC6F3E" }), keys: () => [] }));
const { default: Trail } = await import("../defaults/mods/start/trail.js");
const { STRETCHES } = await import("../defaults/mods/start/outline.js");

const start = new URL("../defaults/mods/start/", import.meta.url).pathname;

function trail() {
  const view = new Trail(), timers: ((cx: any) => void)[] = [];
  const cx = { notify: () => {}, timer: { after: (_ms: number, f: (cx: any) => void) => timers.push(f) } };
  view.init();
  view.sized({ width: 800, height: 600 });
  return { view, cx, timers, tick: () => timers.shift()!(cx) };
}

const notified = (view: any, x: number, y: number) => {
  let notifies = 0;
  view.moved({ x, y }, { notify: () => { notifies += 1; }, timer: { after: () => {} } });
  return notifies;
};

test("the wake is 0 at its edge, 1 further in, and brackets in the middle", () => {
  const { view, cx, tick } = trail();
  view.moved({ x: 100, y: 200 }, cx);
  view.moved({ x: 400, y: 200 }, cx);
  tick();
  expect(view.bits.join("")).toMatch(/^[01 ]+$/);
  expect(view.bits.join("")).toContain("0");
  expect(view.bits.join("")).toContain("1");
  expect(view.marks.join("")).toMatch(/^[{}[\]()<> ]+$/);
  expect(view.marks.join("").trim().length).toBeGreaterThan(0);
  expect(view.bits[0]).toBe("");
});

test("the cells stay spaced apart, a character and a gap", () => {
  const { view, cx, tick } = trail();
  view.moved({ x: 400, y: 300 }, cx);
  tick();
  for (const line of [...view.bits, ...view.marks]) for (let i = 1; i < line.length; i += 2) expect(line[i]).toBe(" ");
});

test("no cell shows a bit and a bracket at once, so the two colors line up", () => {
  const { view, cx, tick } = trail();
  view.moved({ x: 100, y: 200 }, cx);
  view.moved({ x: 400, y: 260 }, cx);
  tick();
  view.bits.forEach((line: string, row: number) => {
    const marks = view.marks[row];
    for (let col = 0; col < line.length; col += 1) expect(line[col] !== " " && marks[col] && marks[col] !== " ").toBeFalsy();
  });
});

test("the pointer never redraws by itself: only the timer does, however fast it moves", () => {
  const { view } = trail();
  for (let x = 0; x < 50; x += 1) expect(notified(view, 100 + x, 200)).toBe(0);
});

test("it's gone in under a second and the timer stops, until the pointer moves again", () => {
  const { view, cx, timers, tick } = trail();
  view.moved({ x: 300, y: 300 }, cx);
  expect(timers.length).toBe(1);
  let ticks = 0;
  while (timers.length && ticks < 100) { tick(); ticks += 1; }
  expect(ticks * 40).toBeLessThan(1000);
  expect(view.bits.join("").trim()).toBe("");
  expect(view.marks.join("").trim()).toBe("");
  view.moved({ x: 340, y: 300 }, cx);
  expect(timers.length).toBe(1);
});

test("the ram's art draws from the head outward and uses no fixed color", () => {
  expect(STRETCHES.length).toBeLessThan(200);
  for (const stretch of STRETCHES) {
    expect(stretch.at).toBeGreaterThanOrEqual(0);
    expect(stretch.at).toBeLessThanOrEqual(1);
  }
  for (const file of ["main.js", "trail.js"]) expect(readFileSync(`${start}${file}`, "utf8")).not.toMatch(/#[0-9a-f]{6}\b/i);
});

test("the ram never leaves once it's in: nothing in the mod fades the body back out", () => {
  const source = readFileSync(`${start}main.js`, "utf8");
  expect(source).toContain('opacity(this.stage === "before" ? 0 : 1)');
  expect(source).toContain("from: 0.9, to: 1");
});
