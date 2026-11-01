import { test, expect, mock } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const element = () => new Proxy({}, { get: (_t, _k, self) => () => self });
mock.module("gpui-kit", () => ({ div: element, svg: element }));
mock.module("gpui-base", () => ({ h_flex: element }));
mock.module("herdr", () => ({ layout: () => null, run: () => {}, shared: () => null }));
const { look, groupHue, logoOf, tagOf } = await import("../defaults/mods/spaces/look.js");

const root = new URL("../defaults/", import.meta.url).pathname;
const zaki = JSON.parse(readFileSync(join(root, "themes/zaki.json"), "utf8"));

// What a theme without the design's names resolves to: only what src/settings.rs always gives.
const plain = Object.fromEntries(["background", "canvas", "chrome", "surface", "raised", "hover", "selected", "border", "input", "foreground", "muted", "dim",
  "accent", "accent_foreground", "working", "blocked", "done", "idle", "unknown", ...Array.from({ length: 16 }, (_, i) => `ansi${i}`)].map((name) => [name, "#123456"]));

test("every mod's look.js is the same file", () => {
  const copies = readdirSync(join(root, "mods")).map((mod) => join(root, "mods", mod, "look.js")).filter(existsSync).map((path) => readFileSync(path, "utf8"));
  expect(copies.length).toBeGreaterThan(1);
  expect(new Set(copies).size).toBe(1);
});

test("the bar and the Tabs column keep the same groups.js", () => {
  expect(readFileSync(join(root, "mods/tabs/groups.js"), "utf8")).toBe(readFileSync(join(root, "mods/tabs-column/groups.js"), "utf8"));
});

test("the zaki theme's values come through untouched", () => {
  const k = look(zaki.colors);
  expect(k.panel).toBe("#0E0E0E");
  expect([k.row_name, k.row_pressed, k.row_active_hover, k.row_dragging, k.row_ring]).toEqual(["#E2E2E2", "#202020", "#282828", "#262626", "#333333"]);
  expect(k.status.blocked).toEqual({ label: "NEEDS YOU", bg: "#EC6F3E2E", fg: "#F5A27E", dot: "#EC6F3E" });
  expect(k.status.queued).toEqual({ label: "QUEUED", bg: "#FFFFFF0D", fg: "#9A9A9A", dot: "#4A4A4A" });
});

test("no color is missing under a theme without the design's names", () => {
  const k = look(plain);
  const colors = Object.entries({ ...k, ...Object.fromEntries(Object.entries(k.status).flatMap(([name, s]) => Object.entries(s).filter(([part]) => part !== "label").map(([part, value]) => [`${name}.${part}`, value]))) }).filter(([name]) => name !== "status" && name !== "groups");
  for (const [name, value] of colors) expect(value, name).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i);
});

test("the Tabs column's focus key sits beside the panel key, on a key nothing else uses", () => {
  for (const [file, key] of [["keys.macos.json", "cmd-shift-r"], ["keys.json", "ctrl-shift-r"]] as const) {
    const keys = JSON.parse(readFileSync(join(root, file), "utf8"));
    expect(keys["layout:main"][key]).toBe("tabs-column.focus");
    for (const section of ["global", "terminal"]) expect(keys[section][key], section).toBeUndefined();
  }
});

test("a group saved under an old color keeps the nearest of the three, never orange", () => {
  const k = look(zaki.colors);
  expect(groupHue(k, "violet").text).toBe("#B9A8F7");
  expect(groupHue(k, "ansi4").text).toBe("#8C9CF5");
  expect(groupHue(k, "ansi2").text).toBe("#6FCFAE");
  expect(groupHue(k, "ansi3").text).toBe("#8C9CF5");
  expect(groupHue(k, "#ff0000").tint).toBe("#8C9CF512");
});

test("a file shows its logo, and each logo is shipped", () => {
  expect(["a/App.tsx", "main.js", "x.test.ts", "lib.rs", "Dockerfile", "icon.SVG", "LICENSE", "notes.txt", "a.constructor"].map(logoOf)).toEqual(["react", "javascript", "tsc", "rust", "docker", "svg", null, null, null]);
  const source = readFileSync(join(root, "mods/spaces/look.js"), "utf8").match(/const LOGOS = \{([^}]*)\}/)[1];
  for (const [, logo] of source.matchAll(/: "([a-z0-9]+)"/g)) expect(existsSync(join(root, `icons/${logo}.svg`))).toBe(true);
});

test("a file's tag says its type", () => {
  expect(["a/AGENTS.md", "main.js", "x.test.ts", "keys.json", "justfile", "run.sh", "lib.rs", "LICENSE", ".env"].map(tagOf)).toEqual(["MD", "JS", "TS", "{ }", ">_", ">_", "RS", "··", "··"]);
});
