import { test, expect, mock } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const element = () => new Proxy({}, { get: (_t, _k, self) => () => self });
mock.module("gpui-kit", () => ({ div: element, image: element, svg: element }));
mock.module("gpui-base", () => ({ h_flex: element, v_flex: element }));
mock.module("herdr", () => ({ layout: () => null, run: () => {}, shared: () => null }));
const { look, groupHue } = await import("../defaults/mods/spaces/look.js");
const { DOTS } = await import("../defaults/mods/agents/loader.js");
const { logoOf, tagOf } = await import("../defaults/mods/files/filetypes.js");

const root = new URL("../defaults/", import.meta.url).pathname;
const zaki = JSON.parse(readFileSync(join(root, "themes/zaki.json"), "utf8"));

// What a theme without the design's names resolves to: only what src/settings.rs always gives.
const plain = Object.fromEntries(["background", "canvas", "chrome", "surface", "raised", "hover", "selected", "border", "input", "foreground", "muted", "dim",
  "accent", "accent_foreground", "working", "blocked", "done", "idle", "unknown", ...Array.from({ length: 16 }, (_, i) => `ansi${i}`)].map((name) => [name, "#123456"]));

test("every mod's look.js is the same file", () => {
  const copies = [...readdirSync(join(root, "mods")).map((mod) => join(root, "mods", mod, "look.js")), join(root, "frame/settings/look.js")].filter(existsSync).map((path) => readFileSync(path, "utf8"));
  expect(copies.length).toBeGreaterThan(1);
  expect(new Set(copies).size).toBe(1);
});

test("mods that share a file keep the same copy", () => {
  for (const [file, mods] of [["groups.js", ["tabs", "tabs-column", "tab-menu"]], ["filetypes.js", ["files", "changes"]], ["panel.js", ["files", "changes"]]] as const) {
    expect(new Set(mods.map((mod) => readFileSync(join(root, "mods", mod, file), "utf8"))).size, file).toBe(1);
  }
});

test("every copy of the loader is the same file, and nothing still spins", () => {
  const mods = readdirSync(join(root, "mods")).map((mod) => join(root, "mods", mod));
  const screens = [...mods, join(root, "frame/settings")];
  const copies = screens.map((dir) => join(dir, "loader.js")).filter(existsSync);
  expect(copies.length).toBe(10);
  expect(new Set(copies.map((path) => readFileSync(path, "utf8"))).size).toBe(1);
  for (const dir of screens) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".js"))) expect(readFileSync(join(dir, file), "utf8"), `${dir}/${file}`).not.toContain(".spin(");
  }
});

test("the loader's bright dot steps around the edge, the rest stay readable, in the theme's color", () => {
  expect(DOTS.map((row: number[][]) => row.length)).toEqual([1, 2, 3, 4]);
  const dots = DOTS.flat() as number[][], middle = DOTS[2][1] as number[], edge = dots.filter((values) => values !== middle);
  expect(edge.length).toBe(9);
  expect(new Set(middle).size).toBe(1);
  expect(dots.flat().every((value) => value >= 0.26 && value <= 1)).toBe(true);
  for (const values of edge) expect(Math.max(...values)).toBe(1);
  for (let stop = 0; stop < middle.length; stop += 1) expect(edge.filter((values) => values[stop] === 1).length).toBe(1);
  expect(readFileSync(join(root, "mods/agents/loader.js"), "utf8")).not.toMatch(/#[0-9a-f]{3,8}\b/i);
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

test("no framed overlay paints its own background over the rounded frame", () => {
  const screens = ["mods/picker", "mods/machine-add", "mods/tab-menu", "mods/file-menu", "mods/new-menu", "mods/confirm", "mods/menu", "mods/worktree", "mods/agents", "mods/help", "mods/toast", "mods/prompt", "frame/palette", "frame/settings", "frame/whatsnew", "frame/feedback"];
  for (const screen of screens) expect(readFileSync(join(root, screen, "main.js"), "utf8"), screen).not.toContain(".bg(t.popover)");
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
  const source = readFileSync(join(root, "mods/files/filetypes.js"), "utf8").match(/const LOGOS = \{([^}]*)\}/)[1];
  for (const [, logo] of source.matchAll(/: "([a-z0-9]+)"/g)) expect(existsSync(join(root, `icons/${logo}.svg`))).toBe(true);
});

test("a file's tag says its type", () => {
  expect(["a/AGENTS.md", "main.js", "x.test.ts", "keys.json", "justfile", "run.sh", "lib.rs", "LICENSE", ".env"].map(tagOf)).toEqual(["MD", "JS", "TS", "{ }", ">_", ">_", "RS", "··", "··"]);
});

// Sizes in fixed steps, never per icon: an icon's art fills 19 of its 24 units, so 16 draws about
// 13 px, level with 13 px text, even alone in a button: a bigger one beside it looks oversized. A
// caret is 12, and only the welcome screen's tiles take 20. Logos have no margin and stay 14;
// no-color is sized to its swatch.
test("interface icons come in three sizes", async () => {
  const steps: Record<string, number> = {};
  const bad: string[] = [];
  const paths = [...new Bun.Glob("{mods,frame}/**/*.js").scanSync({ cwd: root })].filter((p) => !p.startsWith("mods/win98/"));
  const args = "(?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*";
  for (const path of paths) {
    const source = await Bun.file(join(root, path)).text();
    if (/\.size\([^)]*\?/.test(source)) bad.push(`${path}: a size chosen per icon`);
    const uses = [
      ...[...source.matchAll(new RegExp(`\\bsvg\\((${args})\\)(?:\\.[a-z_]+\\([^()]*\\))*?\\.size\\((\\d+)\\)`, "g"))].map((m) => [m[1], m[2]]),
      ...[...source.matchAll(/\bicon\(("[a-z-]+"|name|more\.name),\s*(\d+)\)/g)].map((m) => [m[1], m[2]]),
    ];
    for (const [name, size] of uses) {
      if (!/workspace-chrome|^I\(|^"|^name$|more\.name|^icon$|menuIcon/.test(name) || /icons\/shell|no-color/.test(name)) continue;
      steps[size] = (steps[size] ?? 0) + 1;
      if (!(/chevron/.test(name) ? ["12", "16"] : path === "frame/welcome/main.js" ? ["16", "20"] : ["16"]).includes(size)) bad.push(`${path}: ${name} at ${size}`);
    }
  }
  expect(bad).toEqual([]);
  expect(Object.keys(steps).sort()).toEqual(["12", "16", "20"]);
});
