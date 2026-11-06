import { test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";

// Customize > Skills with recording fakes: what each section lists, the updates section, a skill up
// close, the menus, and what the controls ask skills.js to do (seen as the sh scripts it runs).
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
// A Popover's trigger and menu are its children here, so the walk below finds them.
function popover(id: string): any {
  const inner = make().id(id), el = inner.el;
  const self: any = new Proxy(inner, { get: (t, k: string) => (k === "el" ? el : k === "trigger" || k === "content" ? (kid: any) => (el.kids.push(kid), self) : k === "when" ? (on: unknown, f: any) => (on ? f(self) : self) : (...a: any[]) => (t[k](...a), self)) });
  return self;
}
const mine = (n: any): El | null => (n && typeof n === "object" && n.el ? n.el : null);
const all = (e: El): El[] => [e, ...e.kids.flatMap((k) => (mine(k) ? all(mine(k)!) : []))];
const arg = (e: El, name: string) => e.calls.findLast(([k]) => k === name)?.[1][0];
const byId = (root: El, id: string) => all(root).find((e) => arg(e, "id") === id);
const words = (root: El) => all(root).flatMap((e) => e.kids.filter((k) => typeof k === "string"));
const handler = (e: El, name: string) => e.calls.find(([k]) => k === name)?.[1].at(-1);

const file = JSON.parse(readFileSync(new URL("../defaults/themes/zaki.json", import.meta.url), "utf8"));
const colors = { foreground: "#D6D6D6", ...Object.fromEntries((file.ansi ?? []).map((c: string, i: number) => [`ansi${i}`, c])), ...file.colors, background: file.background };
let state: { shared: Record<string, any>; files: Record<string, string>; ran: string[][]; closed: string[]; props: any };
const input = { on: () => {}, value: () => "", focus: () => {}, set_value: () => {} };
mock.module("gpui-kit", () => ({ View: class {}, div: make, svg: make, image: make }));
mock.module("gpui-base", () => ({ h_flex: make, v_flex: make, InputState: { new: () => ({ ...input }) }, Input: { new: make }, Popover: { new: (id: string) => popover(id) }, MarkdownState: { new: (o: any) => ({ value: o.value, set_look: () => {}, release: () => {} }) }, TextView: { state: make } }));
mock.module("herdr", () => ({
  theme: () => colors,
  shared: (k: string) => state.shared[k],
  setShared: (k: string, v: any) => { state.shared[k] = v; },
  appHome: () => "/app",
  home: () => "/home/me",
  readTextFile: async (path: string) => state.files[path] ?? null,
  writeTextFile: async (path: string, text: string) => { state.files[path] = text; return null; },
  // Every script works; the one asking "is this name taken?" answers no.
  exec: async (command: string, args: string[]) => {
    state.ran.push([command, ...args]);
    const taken = command === "sh" && args[1].startsWith('if [ -L "$1" ] && [ "$(readlink "$1")" = "$2" ]; then exit 1');
    return { code: taken ? 1 : 0, stdout: "", stderr: "" };
  },
  window: () => ({ platform: "macos" }),
  notify: () => "n",
  pickFolder: async () => null,
  props: () => state.props,
  closeOverlay: (id: string) => { state.closed.push(id); },
}));
const { default: Customize } = await import("../defaults/mods/customize/main.js");

const cx: any = { notify: () => {}, spawn: (f: any) => f(cx), focus_handle: () => ({ focus: () => {} }), timer: { every: () => {}, after: (_ms: number, f: any) => f(cx) }, stop_propagation: () => {} };
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
const entry = (name: string, repo = "mattpocock/skills", extra: any = {}) => ({ id: `${repo}/skills/${name}`, name, title: name[0].toUpperCase() + name.slice(1), short: `${name} in one line`, description: `All about ${name}.`, repo, path: `skills/${name}`, ref: "main", commit: "a".repeat(40), tree: `t-${name}`, ...extra });
const zaki = (name: string, extra: any = {}) => ({ ...entry(name), source: "catalog", folder: `/app/skills/${name}`, enabled: true, hash: "h", ...extra });

async function open(seed: { catalog?: any[]; lock?: Record<string, any>; personal?: any[]; system?: any[] } = {}) {
  const view: any = new Customize();
  view.init({}, cx);
  await settle();
  const page = view.skills;
  page.loading = false;
  page.seen = state.shared["skills.changed"];
  page.catalog = { version: 1, generated: "g", skills: seed.catalog ?? [] };
  page.state = { lock: { skills: seed.lock ?? {} }, linked: Object.fromEntries(Object.keys(seed.lock ?? {}).map((n) => [n, ["claude", "agents"]])), personal: seed.personal ?? [], system: seed.system ?? [] };
  return { view, page, draw: () => view.render(cx).el as El };
}
const click = async (root: El, id: string) => { handler(byId(root, id)!, "on_click")({}, cx); await settle(); };
const menu = async (root: El, id: string) => { handler(byId(root, `cz-menu-${id}`)!, "on_open_change")(true, cx); await settle(); };
const key = (view: any, k: string) => handler(view.render(cx).el, "on_key_down")({ key: k }, cx);

beforeEach(() => { state = { shared: { "skills.check": { at: Date.now(), error: null } }, files: {}, ran: [], closed: [], props: { overlay: "ov" } }; });

test("the screen takes every color from the theme", () => {
  for (const f of ["main.js", "skills-page.js"]) expect(readFileSync(new URL(`../defaults/mods/customize/${f}`, import.meta.url), "utf8"), f).not.toMatch(/#[0-9a-f]{3,8}\b/i);
});

test("it opens over the whole window, framed by itself, with Skills and Code review in its sidebar", async () => {
  const meta = JSON.parse(readFileSync(new URL("../defaults/mods/customize/mod.json", import.meta.url), "utf8"));
  expect(meta.overlay).toMatchObject({ kind: "dialog", width: 1, height: 1, frame: "none", modal: true });
  const { view, draw } = await open();
  const root = draw();
  expect(byId(root, "cz-p-skills")).toBeTruthy();
  expect(byId(root, "cz-p-review")).toBeTruthy();
  await click(root, "cz-p-review");
  expect(words(draw())).toContain("Coming soon");
  await click(draw(), "cz-back");
  expect(state.closed).toEqual(["ov"]);
  expect(view.page).toBe("review");
});

test("Installed lists Zaki's skills and the person's own, by name; a skill that's off says so", async () => {
  const { draw } = await open({ lock: { tdd: zaki("tdd"), grill: zaki("grill", { enabled: false }) }, personal: [{ name: "mine", title: "Alpha mine", short: "my own", places: ["~/.claude/skills"], folder: "/home/me/.claude/skills/mine" }] });
  const w = words(draw());
  expect(w.filter((x) => ["Alpha mine", "Grill", "Tdd"].includes(x))).toEqual(["Alpha mine", "Grill", "Tdd"]);
  expect(w).toContain("Off");
});

test("Browse: a + for a free name, a check for one installed, nothing for a taken name", async () => {
  const { draw } = await open({ catalog: [entry("tdd"), entry("pdf"), entry("pdf", "openai/skills"), entry("free")], lock: { tdd: zaki("tdd"), pdf: zaki("pdf") } });
  const root = draw();
  expect(byId(root, "cz-get-c:mattpocock/skills/skills/free")).toBeTruthy();
  expect(byId(root, "cz-get-c:mattpocock/skills/skills/tdd")).toBeUndefined();
  expect(byId(root, "cz-get-c:openai/skills/skills/pdf")).toBeUndefined();
});

test("a long section shows eight and says what else there is; search shows every match", async () => {
  const many = Array.from({ length: 20 }, (_, i) => entry(`skill-${String(i).padStart(2, "0")}`));
  const { page, draw } = await open({ catalog: many });
  expect(words(draw())).toContain("See Skill-08, Skill-09, and 10 more");
  await click(draw(), "cz-more-browse");
  expect(words(draw()).some((x) => x.startsWith("See "))).toBe(false);
  page.expanded = {};
  page.query = "skill-1";
  expect(words(draw()).filter((x) => x.startsWith("Skill-")).length).toBe(10);
  page.query = "nothing like it";
  expect(words(draw())).toContain("No skill in the list matches.");
});

test("updates come first; one the person changed asks to replace or keep", async () => {
  const { page, draw } = await open({ lock: { tdd: zaki("tdd"), grill: zaki("grill") } });
  state.shared["skills.updates"] = [{ name: "tdd", title: "Tdd", tree: "t2", entry: entry("tdd") }, { name: "grill", title: "Grill", tree: "t3", entry: entry("grill") }];
  let root = draw();
  const w = words(root);
  expect(w.indexOf("Updates")).toBeLessThan(w.indexOf("Installed"));
  expect(byId(root, "cz-update-tdd") && byId(root, "cz-update-all")).toBeTruthy();
  page.edited.tdd = true;
  root = draw();
  expect(byId(root, "cz-keep-tdd") && byId(root, "cz-replace-tdd")).toBeTruthy();
  expect(byId(root, "cz-update-tdd")).toBeUndefined();
});

test("the + installs: curl downloads into Zaki's folder", async () => {
  state.files["/app/skills.json"] = JSON.stringify({ version: 1, skills: {} });
  const free = { ...entry("free"), files: [{ path: "SKILL.md", size: 10 }] };
  const { draw } = await open({ catalog: [free] });
  await click(draw(), "cz-get-c:mattpocock/skills/skills/free");
  const curl = state.ran.find((r) => r[0] === "curl")!;
  expect(curl).toContain(`https://raw.githubusercontent.com/mattpocock/skills/${"a".repeat(40)}/skills/free/SKILL.md`);
  expect(curl.some((a) => a.startsWith("/app/skills/.staging-free-"))).toBe(true);
});

test("Add and the options open menus over the page; Esc shuts the menu before the screen", async () => {
  const { view, page, draw } = await open();
  await menu(draw(), "add");
  expect(byId(draw(), "cz-add-link") && byId(draw(), "cz-add-folder")).toBeTruthy();
  key(view, "escape");
  expect(page.menu).toBeNull();
  expect(state.closed).toEqual([]);
  await menu(draw(), "options");
  await click(draw(), "cz-auto");
  expect(state.shared["skills.auto"]).toBe(true);
  await click(draw(), "cz-checks");
  expect(state.shared["skills.checks"]).toBe(false);
  page.menu = "add";
  await click(draw(), "cz-add-link");
  expect(page.linking).toBe(true);
  expect(byId(draw(), "cz-link-add")).toBeTruthy();
  key(view, "escape");
  key(view, "escape");
  expect(state.closed).toEqual(["ov"]);
});

test("a skill up close: where it's from, which agents have it, its SKILL.md; turning it off; Esc goes back", async () => {
  state.files["/app/skills/tdd/SKILL.md"] = "---\nname: tdd\n---\n# TDD\nRed, green.";
  state.files["/app/skills.json"] = JSON.stringify({ version: 1, skills: { tdd: zaki("tdd") } });
  const { view, page, draw } = await open({ lock: { tdd: zaki("tdd") } });
  await click(draw(), "cz-tdd");
  const root = draw(), w = words(root);
  expect(byId(root, "cz-d-back")).toBeTruthy();
  expect(w).toContain("mattpocock/skills/skills/tdd");
  expect(w).toContain("Claude Code, Codex, Pi, Gemini CLI, OpenCode, Cursor and Amp");
  expect(page.doc.value).toBe("# TDD\nRed, green.");
  await click(root, "cz-d-on");
  const unlinks = state.ran.filter((r) => r[0] === "sh" && r[2].startsWith('if [ -L "$1" ] && [ "$(readlink "$1")" = "$2" ]; then rm'));
  expect(unlinks.map((r) => r[4])).toEqual(["/home/me/.claude/skills/tdd", "/home/me/.agents/skills/tdd"]);
  expect(JSON.parse(state.files["/app/skills.json"]).skills.tdd.enabled).toBe(false);
  await click(draw(), "cz-d-remove");
  expect(byId(draw(), "cz-d-confirm")).toBeTruthy();
  key(view, "escape");
  expect(byId(draw(), "cz-d-confirm")).toBeUndefined();
  key(view, "escape");
  expect(page.detail).toBeNull();
  expect(state.closed).toEqual([]);
});

test("a catalog skill up close offers Install, and Use this one when the name is the person's", async () => {
  const { page, draw } = await open({ catalog: [entry("ours"), entry("free")], personal: [{ name: "ours", title: "Ours", places: ["~/.agents/skills"], folder: "/x" }] });
  await click(draw(), "cz-c:mattpocock/skills/skills/free");
  expect(byId(draw(), "cz-d-install")).toBeTruthy();
  page.closeDetail();
  await click(draw(), "cz-c:mattpocock/skills/skills/ours");
  expect(byId(draw(), "cz-d-replace")).toBeTruthy();
});

test("System lists the agents' own skills, read-only", async () => {
  const { page, draw } = await open({ system: [{ name: "imagegen", title: "Imagegen", short: "images", from: "Codex", folder: "/home/me/.codex/skills/.system/imagegen" }] });
  await click(draw(), "cz-tab-system");
  expect(page.tab).toBe("system");
  const root = draw();
  expect(words(root)).toContain("Imagegen");
  expect(all(root).some((e) => String(arg(e, "id") ?? "").startsWith("cz-get-"))).toBe(false);
});
