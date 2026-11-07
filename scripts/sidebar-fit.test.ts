import { test, expect } from "bun:test";
import { fitRow } from "../defaults/mods/agents/fit.js";
import { SIDEBAR_MIN, snapTarget } from "../defaults/mods/workspace-chrome/snap.js";

// The shipped sidebar is 230px: a row gets 206 after the sidebar's padding and the scrollbar's room.
const DEFAULT = 206;
const row = (over: object = {}) => ({ name: "atelier", tab: 4, status: "working", label: "WORKING", percent: "11%", time: "23m", hot: false, hovered: false, extra: 0, ...over });

test("a wide row shows everything", () => {
  expect(fitRow(320, row())).toEqual({ gap: 9, spinner: true, time: true, percent: true, word: true });
  expect(fitRow(Infinity, row())).toEqual({ gap: 9, spinner: true, time: true, percent: true, word: true });
});

test("an idle row at the default width is as designed", () => {
  expect(fitRow(DEFAULT, row({ status: "idle", label: "IDLE", percent: "19%" }))).toEqual({ gap: 9, spinner: false, time: true, percent: true, word: true });
});

test("a working row at the default width keeps its name: the spinner and the time give way", () => {
  expect(fitRow(DEFAULT, row())).toEqual({ gap: 6, spinner: false, time: false, percent: true, word: true });
  // A short name needs less: the time stays.
  expect(fitRow(DEFAULT, row({ name: "web" }))).toEqual({ gap: 6, spinner: false, time: true, percent: true, word: true });
});

test("just above the rail, a row is its name and a dot", () => {
  expect(fitRow(136, row())).toEqual({ gap: 6, spinner: false, time: false, percent: false, word: false });
  expect(fitRow(136, row({ status: "blocked", label: "BLOCKED" }))).toEqual({ gap: 6, spinner: false, time: false, percent: false, word: false });
});

test("an idle row turns into a dot before it loses its numbers", () => {
  expect(fitRow(180, row({ status: "idle", label: "IDLE" }))).toEqual({ gap: 6, spinner: false, time: true, percent: true, word: false });
});

test("a context at 90% or more is a warning: it outlasts the badge", () => {
  expect(fitRow(145, row({ percent: "92%", hot: true }))).toEqual({ gap: 6, spinner: false, time: false, percent: true, word: false });
  expect(fitRow(145, row())).toEqual({ gap: 6, spinner: false, time: false, percent: false, word: false });
});

test("a hovered row keeps its pin", () => {
  expect(fitRow(DEFAULT, row({ hovered: true })).time).toBe(true);
  expect(fitRow(136, row({ hovered: true, time: null })).time).toBe(true);
});

test("a row with nothing extra to show drops nothing it doesn't have", () => {
  expect(fitRow(DEFAULT, row({ percent: null, time: null }))).toEqual({ gap: 9, spinner: true, time: false, percent: false, word: true });
});

test("the sidebar is the rail or at least the minimum", () => {
  for (const rail of [44, 76]) {
    expect(snapTarget(rail, rail)).toBeNull();
    expect(snapTarget(230, rail)).toBeNull();
    expect(snapTarget(SIDEBAR_MIN, rail)).toBeNull();
    expect(snapTarget(rail + 10, rail)).toBe(rail);
    expect(snapTarget(SIDEBAR_MIN - 10, rail)).toBe(SIDEBAR_MIN);
  }
  // Dragged most of the way in, it goes to the rail; opened partway from it, to the minimum.
  expect(snapTarget(120, 76)).toBe(76);
  expect(snapTarget(150, 76)).toBe(SIDEBAR_MIN);
  expect(snapTarget(undefined, 76)).toBeNull();
});

test("at the minimum, a working row still shows its name and its badge", () => {
  expect(fitRow(SIDEBAR_MIN - 24, row())).toMatchObject({ word: true });
});
