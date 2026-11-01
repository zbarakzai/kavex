import { test, expect, mock, beforeEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real panel, menu and file operations with recording fakes; `sh` really runs, in a scratch folder.
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
const press = (e: El, name: string, cx: any, button?: string) => e.calls.find(([k, a]) => k === name && (!button || a[0] === button))?.[1].at(-1)({}, cx);

const scratch = mkdtempSync(join(tmpdir(), "zaki-files-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const theme = JSON.parse(readFileSync(new URL("../defaults/themes/zaki.json", import.meta.url), "utf8"));
const colors = { background: theme.background, ...theme.colors, ...Object.fromEntries(theme.ansi.map((c: string, i: number) => [`ansi${i}`, c])) };

(globalThis as any).localStorage = { getItem: () => null, setItem() {} };
let state: any;
const shell = (args: string[], opts?: { on?: string }) => {
  if (opts?.on) state.remote.push(args);
  const r = Bun.spawnSync(["sh", ...args]);
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};
const InputState = {
  new: ({ value }: { value: string }) => {
    const on: Record<string, any> = {};
    state.input = { text: value, range: null, on: (name: string, f: any) => { on[name] = f; }, fire: (name: string, cx: any) => on[name]?.({}, cx), value: () => state.input.text, focus: () => {}, set_selected_range: (r: any) => { state.input.range = r; } };
    return state.input;
  },
};
mock.module("gpui-kit", () => ({ View: class {}, div: make, svg: make, image: make }));
mock.module("gpui-base", () => ({ h_flex: make, v_flex: make, InputState, Input: { new: make }, Editor: { new: make }, EditorState: { new: () => ({ release() {} }) }, MarkdownState: { new: () => ({ release() {}, set_look() {}, outline: () => [] }) }, TextView: { state: make }, Popover: { new: make }, HoverCard: { new: make } }));
mock.module("herdr", () => ({
  spaces: () => [{ id: "s1", active: true, folder: scratch, machine: state.on, tabs: [] }],
  panes: () => [{ pane: "p1", cwd: scratch }],
  focused: () => state.focus,
  terminals: () => state.terminals,
  exec: async (cmd: string, args: string[], opts: any) => {
    if (cmd === "sh") return shell(args, opts);
    state.execs.push([cmd, ...args]);
    return { code: 1, stdout: "", stderr: "" };
  },
  hc: async (args: string[]) => (state.hc.push(args), { code: 0, stdout: "", stderr: "" }),
  readTextFile: async () => "text",
  watchFolder: () => new Promise(() => {}),
  theme: () => colors,
  window: () => ({ platform: state.platform }),
  props: () => state.props,
  run: (name: string, args: any) => void state.ran.push([name, args]),
  notify: (n: any) => void state.notes.push(n),
  openOverlay: (o: any) => (state.opened.push(o), "overlay"),
  closeOverlay: (id: string) => void state.closed.push(id),
  nextCommand: () => new Promise(() => {}),
  shared: (key: string) => state.shared[key],
  setShared: (key: string, value: any) => { state.shared[key] = value; },
  layout: () => null,
}));

const Files = (await import("../defaults/mods/files/main.js")).default;
const FileMenu = (await import("../defaults/mods/file-menu/main.js")).default;
const ops = await import("../defaults/mods/files/ops.js");

const fresh = (props: any = {}) => ({ platform: "linux", focus: { pane: "p1", terminal: "t1", cwd: scratch }, terminals: [{ address: "t1", program: { shell: true, agent: false } }], on: null, props, ran: [], notes: [], opened: [], closed: [], hc: [], execs: [], remote: [], shared: {}, input: null });
const tasks = () => {
  const cx: any = {
    clipboard: "kept", copied: [] as string[],
    notify() {}, stop_propagation() {},
    spawn(f: any) { f(cx); return { cancel() {} }; },
    timer: { every() {}, after(_ms: number, f: any) { f(cx); } },
    focus_handle: () => ({ focus() {} }),
    read_from_clipboard: () => cx.clipboard,
    write_to_clipboard: (text: string) => { cx.copied.push(text); },
    // The panel's command and watch loops never end: give the rest time.
    settled: () => Bun.sleep(40),
  };
  return cx;
};
const menuWords = (props: any) => { state.props = { overlay: "o", ...props }; const m = new FileMenu(); m.init({}, tasks()); return words(m.render().el); };
const panel = async () => {
  const f = new Files(), cx = tasks();
  f.init({}, cx);
  await cx.settled();
  return { f, cx, tree: () => f.render(cx).el };
};

beforeEach(() => {
  state = fresh();
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, "src"), { recursive: true });
  writeFileSync(join(scratch, "src", "one.txt"), "1");
  writeFileSync(join(scratch, "note.md"), "n");
  writeFileSync(join(scratch, "other.md"), "o");
});

test("a folder's menu is Warp's, in its order", () => {
  state.platform = "macos";
  expect(menuWords({ dir: true, local: true })).toEqual(["New file", "cd to directory", "Open in new tab", "Reveal in Finder", "Rename", "Delete", "Attach as context", "Copy path", "Copy relative path"]);
});

test("a file opens in a pane or a tab and has no New file or cd", () => {
  expect(menuWords({ dir: false, local: true })).toEqual(["Open in new pane", "Open in new tab", "Reveal in file manager", "Rename", "Delete", "Attach as context", "Copy path", "Copy relative path"]);
});

test("the folder shown can't be renamed or deleted, and has no relative path", () => {
  const list = menuWords({ dir: true, root: true, local: true });
  for (const gone of ["Rename", "Delete", "Copy relative path"]) expect(list).not.toContain(gone);
});

test("another machine has no Reveal, and no terminal means no cd or Attach", () => {
  expect(menuWords({ dir: true, local: false }).join()).not.toContain("Reveal");
  state.focus = { pane: null, terminal: null };
  const list = menuWords({ dir: true, local: true });
  expect(list).not.toContain("cd to directory");
  expect(list).not.toContain("Attach as context");
});

test("cd is off unless the terminal is at a shell", () => {
  state.terminals = [{ address: "t1", program: { shell: false, agent: true } }];
  state.props = { overlay: "o", dir: true, local: true };
  const m = new FileMenu(), cx = tasks();
  m.init({}, cx);
  const root = m.render().el;
  expect(words(root)).toContain("not in a shell");
  press(byId(root, "fm-cd")!, "on_click", cx);
  expect(state.ran).toEqual([]);
  expect(state.closed).toEqual([]);
});

test("a row closes the menu and hands the panel the action", () => {
  state.props = { overlay: "o", dir: true, local: true };
  const m = new FileMenu(), cx = tasks();
  m.init({}, cx);
  press(byId(m.render().el, "fm-rename")!, "on_click", cx);
  expect(state.closed).toEqual(["o"]);
  expect(state.ran).toEqual([["files.rename", undefined]]);
});

test("a right-click opens the menu on that row and marks it until it shuts", async () => {
  const { f, cx, tree } = await panel();
  press(byId(tree(), "file-note.md")!, "on_mouse_down", cx, "right");
  expect(state.opened.at(-1)).toMatchObject({ mod: "file-menu", kind: "popup", props: { from: "files", dir: false, root: false, local: true } });
  const marked = () => byId(tree(), "file-note.md")!.calls.some(([k]) => k === "bg");
  expect(marked()).toBe(true);
  state.shared["popup.closed"] = { from: "files", at: f.target.at };
  expect(marked()).toBe(false);
});

test("the empty space under the rows is the folder shown", async () => {
  const { cx, tree } = await panel();
  press(byId(tree(), "files-tree")!, "on_mouse_down", cx, "right");
  expect(state.opened.at(-1).props).toMatchObject({ dir: true, root: true });
});

test("New file types into the tree, and Enter makes it, folders on the way too", async () => {
  const { f, cx, tree } = await panel();
  f.target = { path: "src", dir: true, context: f.context, at: 0 };
  await f.command("new", cx);
  await cx.settled();
  expect(byId(tree(), "files-edit")).toBeDefined();
  state.input.text = "deep/two.txt";
  state.input.fire("submit", cx);
  await cx.settled();
  expect(existsSync(join(scratch, "src/deep/two.txt"))).toBe(true);
  expect(byId(tree(), "files-edit")).toBeUndefined();
  expect(state.ran).toContainEqual(["pane.focus", { pane: "p1" }]);
});

test("a name that's taken stays open and says so, and overwrites nothing", async () => {
  const { f, cx, tree } = await panel();
  f.target = { path: "", dir: true, context: f.context, at: 0 };
  await f.command("new", cx);
  state.input.text = "note.md";
  state.input.fire("submit", cx);
  await cx.settled();
  expect(readFileSync(join(scratch, "note.md"), "utf8")).toBe("n");
  expect(words(tree())).toContain("That name is already taken");
  state.input.fire("change", cx);
  expect(words(tree())).not.toContain("That name is already taken");
});

test("Rename picks the name without its extension, and Esc leaves the file alone", async () => {
  const { f, cx, tree } = await panel();
  f.target = { path: "note.md", dir: false, context: f.context, at: 0 };
  await f.command("rename", cx);
  expect(state.input.range).toEqual({ start: 0, end: 4 });
  byId(tree(), "files-edit")!.calls.find(([k]) => k === "on_key_down")![1][0]({ key: "escape" }, cx);
  expect(existsSync(join(scratch, "note.md"))).toBe(true);
  expect(f.edit).toBeNull();
});

test("Rename moves it and an open folder stays open under its new name", async () => {
  const { f, cx } = await panel();
  f.toggle("src", cx);
  await cx.settled();
  f.target = { path: "src", dir: true, context: f.context, at: 0 };
  await f.command("rename", cx);
  state.input.text = "lib";
  state.input.fire("submit", cx);
  await cx.settled();
  expect(existsSync(join(scratch, "lib/one.txt"))).toBe(true);
  expect(f.folders.has("lib")).toBe(true);
  expect(f.folders.has("src")).toBe(false);
});

test("Rename can't reach another folder or take another file's place", async () => {
  expect(ops.badName("a/b", false)).toBeTruthy();
  expect(ops.badName("..", false)).toBeTruthy();
  expect(ops.badName("a/../../b", true)).toBeTruthy();
  expect(ops.badName("/etc/x", true)).toBeTruthy();
  expect(ops.badName("a/b.txt", true)).toBeNull();
  await expect(ops.move(join(scratch, "note.md"), join(scratch, "other.md"), null)).rejects.toThrow("already taken");
  expect(readFileSync(join(scratch, "other.md"), "utf8")).toBe("o");
});

test("Delete asks first, and says what happens where", async () => {
  const { f, cx } = await panel();
  f.target = { path: "src", dir: true, context: f.context, at: 0 };
  await f.command("delete", cx);
  expect(state.opened.at(-1)).toMatchObject({ mod: "confirm", props: { title: "Delete src?", detail: "Moves src and everything in it to the Trash.", command: { name: "files.remove" } } });
  expect(existsSync(join(scratch, "src"))).toBe(true);
  f.on = "vps";
  await f.command("delete", cx);
  expect(state.opened.at(-1).props.detail).toBe("Deletes src and everything in it from vps for good. This can't be undone.");
});

test("Here a failed trash keeps the file; only a machine deletes for good", async () => {
  state.platform = "linux";
  const fakeNoGio = join(scratch, "gone.txt");
  writeFileSync(fakeNoGio, "x");
  await expect(ops.trash(join(scratch, "no-such", "file"), null)).rejects.toThrow();
  await ops.trash(fakeNoGio, "vps");
  expect(existsSync(fakeNoGio)).toBe(false);
  expect(state.remote.at(-1).join(" ")).toContain("rm -rf");
});

test("cd clears the line first and quotes the folder", async () => {
  await ops.cd("t1", "/a/it's here", null);
  expect(state.hc).toEqual([["keys", "t1", "ctrl+e", "ctrl+u"], ["send", "t1", `cd '/a/it'\\''s here'`]]);
});

test("Attach gives an agent @path, unsubmitted, and puts the clipboard back", async () => {
  state.terminals = [{ address: "t1", program: { shell: false, agent: true } }];
  const { f, cx } = await panel();
  f.target = { path: "src", dir: true, context: f.context, at: 0 };
  await f.command("attach", cx);
  expect(cx.copied).toEqual(["@src/ ", "kept"]);
  expect(state.ran.map(([n]: any) => n)).toEqual(["terminal.paste", "pane.focus"]);
  expect(state.hc).toEqual([]);
});

test("Attach gives a shell the quoted path", async () => {
  const { f, cx } = await panel();
  f.target = { path: "note.md", dir: false, context: f.context, at: 0 };
  await f.command("attach", cx);
  expect(cx.copied[0]).toBe(`'${scratch}/note.md' `);
});

test("Copy gives the full path or the one from the folder shown", async () => {
  const { f, cx } = await panel();
  f.target = { path: "src/one.txt", dir: false, context: f.context, at: 0 };
  await f.command("copy", cx);
  await f.command("relative", cx);
  expect(cx.copied).toEqual([`${scratch}/src/one.txt`, "src/one.txt"]);
});

test("Opening: a folder is a terminal there, a file is its preview", async () => {
  const { f, cx } = await panel();
  f.target = { path: "src", dir: true, context: f.context, at: 0 };
  await f.command("tab", cx);
  expect(state.ran.at(-1)).toEqual(["tab.new", { space: "s1", folder: `${scratch}/src` }]);
  f.target = { path: "note.md", dir: false, context: f.context, at: 0 };
  await f.command("tab", cx);
  expect(state.ran.at(-1)).toEqual(["tab.new", { space: "s1", name: "note.md", mod: "files", props: { file: `${scratch}/note.md`, on: null } }]);
  await f.command("pane", cx);
  expect(state.ran.at(-1)).toEqual(["pane.split", { direction: "right", mod: "files", props: { file: `${scratch}/note.md`, on: null } }]);
});

test("A file's own pane shows only it, and takes no commands", async () => {
  state.props = { file: `${scratch}/note.md`, on: null };
  const f = new Files(), cx = tasks();
  f.init({}, cx);
  await cx.settled();
  const root = f.render(cx).el;
  expect(words(root)).toContain("note.md");
  expect(byId(root, "files-tree")).toBeUndefined();
  expect(byId(root, "files-back")).toBeUndefined();
});

test("a menu from before the folder changed does nothing", async () => {
  const { f, cx } = await panel();
  f.target = { path: "note.md", dir: false, context: {}, at: 0 };
  await f.command("copy", cx);
  expect(cx.copied).toEqual([]);
});

test("the new icons ship", () => {
  for (const name of ["file-new", "trash", "copy", "attach"]) expect(existsSync(new URL(`../defaults/mods/workspace-chrome/icons/${name}.svg`, import.meta.url))).toBe(true);
});
