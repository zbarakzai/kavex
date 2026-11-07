import { test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";

// The real panel with recording fakes: what it does with Markdown files, apart from drawing them.
const make = (): any => {
  const self: any = new Proxy(() => self, {
    get: (_t, k: string) => {
      if (k === "when") return (on: unknown, f: (s: any) => any) => (on ? f(self) : self);
      if (k === "then") return undefined;
      return () => self;
    },
    apply: () => self,
  });
  return self;
};

type Doc = { options: any; values: string[]; scrolled: number[]; released: boolean; outlined: any[]; looks: number };
const theme = JSON.parse(readFileSync(new URL("../defaults/themes/kavex.json", import.meta.url), "utf8"));
const colors = { background: theme.background, ansi: theme.ansi, ...theme.colors, ...Object.fromEntries(theme.ansi.map((c: string, i: number) => [`ansi${i}`, c])) };

let state: any;
const editors = () => state.editors as any[];
mock.module("gpui-kit", () => ({ View: class {}, div: make, svg: make, image: make }));
mock.module("gpui-base", () => ({
  h_flex: make, v_flex: make, Input: { new: make }, Editor: { new: make }, Popover: { new: make }, HoverCard: { new: make }, TextView: { state: make },
  InputState: { new: () => ({ on() {}, focus() {}, value: () => "" }) },
  EditorState: { new: (options: any) => { const editor = { options, values: [options.value], released: false, set_value(v: string) { editor.values.push(v); }, release() { editor.released = true; } }; state.editors.push(editor); return editor; } },
  MarkdownState: { new: (options: any) => {
    const doc: Doc & Record<string, any> = { options, values: [options.value], scrolled: [], released: false, outlined: state.outline, looks: 0,
      set_value(v: string) { doc.values.push(v); }, set_look() { doc.looks++; }, outline: () => doc.outlined, scroll_to(b: number) { doc.scrolled.push(b); }, find: () => 0, find_step: () => 0, find_again: () => null, release() { doc.released = true; } };
    state.docs.push(doc);
    return doc;
  } },
}));
mock.module("herdr", () => ({
  spaces: () => [{ id: "s1", active: true, folder: "/repo", machine: state.on, tabs: [] }],
  panes: () => [{ pane: "p1", cwd: "/repo" }], focused: () => ({ pane: "p1", terminal: "t1", cwd: "/repo" }), terminals: () => [],
  exec: async () => ({ code: 1, stdout: "", stderr: "" }), hc: async () => ({ code: 0 }),
  readTextFile: async (path: string, opts: any) => { state.reads.push([path, opts?.on ?? null]); if (!(path in state.files)) throw new Error("gone"); return state.files[path]; },
  watchFolder: (folder: string) => new Promise((resolve) => { state.watches.push({ folder, changed: () => resolve([]) }); }), theme: () => colors, window: () => ({ platform: "macos" }), props: () => state.props,
  run: () => {}, notify: (n: any) => void state.notes.push(n), openOverlay: () => "o", closeOverlay() {}, nextCommand: () => new Promise(() => {}),
  shared: (key: string) => state.shared[key], setShared: (key: string, value: any) => { state.shared[key] = value; }, layout: () => null,
}));
const stored = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) };
const Files = (await import("../defaults/mods/files/main.js")).default;
const { readerLook } = await import("../defaults/mods/files/reader.js");

const tasks = () => {
  const cx: any = { opened: [] as string[], timers: [] as any[], notified: 0, notify() { cx.notified++; }, stop_propagation() {}, open_url: (url: string) => cx.opened.push(url),
    spawn(f: any) { f(cx); return { cancel() {} }; }, timer: { every(ms: number, f: any) { cx.timers.push([ms, f]); }, after(_ms: number, f: any) { f(cx); } } };
  return cx;
};
const settled = () => Bun.sleep(5);
const panel = async () => {
  const f = new Files(), cx = tasks();
  f.init({}, cx);
  await settled();
  return { f, cx };
};

beforeEach(() => {
  stored.clear();
  state = { on: null, props: {}, shared: {}, notes: [], reads: [], docs: [], editors: [], outline: [], watches: [], files: { "/repo/README.md": "# Hi\n", "/repo/docs/a.md": "# A\n", "/repo/run.sh": "ls\n", "/plans/plan.md": "# Plan\n" } };
});

test("A Markdown file opens rendered, and no editor is built for it", async () => {
  const { f, cx } = await panel();
  f.show("README.md", cx);
  await settled();
  expect(state.docs).toHaveLength(1);
  expect(state.docs[0].options).toEqual({ value: "# Hi\n", folder: "/repo" });
  expect(editors()).toHaveLength(0);
  f.render(cx);
  expect(state.docs[0].looks).toBe(1);
  f.render(cx);
  expect(state.docs[0].looks).toBe(1);
});

test("Other files still open in the code view", async () => {
  const { f, cx } = await panel();
  f.show("run.sh", cx);
  await settled();
  expect(state.docs).toHaveLength(0);
  expect(editors()).toHaveLength(1);
});

test("Raw is built when first asked for and the document stays, so its place does too", async () => {
  const { f, cx } = await panel();
  f.show("README.md", cx);
  await settled();
  const doc = state.docs[0];
  f.reader.choose("raw", cx);
  expect(editors()).toHaveLength(1);
  expect(editors()[0].options.value).toBe("# Hi\n");
  f.reader.choose("preview", cx);
  f.reader.choose("raw", cx);
  expect(editors()).toHaveLength(1);
  expect(state.docs).toEqual([doc]);
  expect(doc.released).toBe(false);
});

test("Raw is remembered for the next file, built at once", async () => {
  stored.set("markdown", "raw");
  const { f, cx } = await panel();
  f.show("README.md", cx);
  await settled();
  expect(editors()).toHaveLength(1);
});

test("Leaving a file releases what it held", async () => {
  const { f, cx } = await panel();
  f.show("README.md", cx);
  await settled();
  f.reader.choose("raw", cx);
  f.back(cx);
  expect(f.file).toBeNull();
  expect(state.docs[0].released).toBe(true);
  expect(editors()[0].released).toBe(true);
});

test("A save during a find counts again once its parse lands, and a closed find asks nothing", async () => {
  const { f, cx } = await panel();
  f.show("README.md", cx);
  await settled();
  let asked = 0;
  state.docs[0].find_again = () => (++asked < 3 ? null : { found: 4, at: 2 });
  f.reader.openFind(cx);
  f.reader.found = 9; f.reader.foundAt = 7;
  state.files["/repo/README.md"] = "# Hi\n\nmore\n";
  f.reload(cx);
  await settled();
  expect(asked).toBe(3);
  expect([f.reader.found, f.reader.foundAt]).toEqual([4, 2]);
  f.reader.closeFind(cx);
  f.reader.update("# Other\n", cx);
  expect(asked).toBe(3);
});

test("A document follows its file; the same text does nothing", async () => {
  const { f, cx } = await panel();
  f.show("README.md", cx);
  await settled();
  f.reader.choose("raw", cx);
  f.reload(cx);
  await settled();
  expect(state.docs[0].values).toEqual(["# Hi\n"]);
  state.files["/repo/README.md"] = "# Hi\n\nmore\n";
  f.reload(cx);
  await settled();
  expect(state.docs[0].values).toEqual(["# Hi\n", "# Hi\n\nmore\n"]);
  expect(editors()[0].values).toEqual(["# Hi\n", "# Hi\n\nmore\n"]);
});

test("A file that vanishes keeps showing, and a reload for a closed file does nothing", async () => {
  const { f, cx } = await panel();
  f.show("README.md", cx);
  await settled();
  delete state.files["/repo/README.md"];
  f.reload(cx);
  await settled();
  expect(f.reloading).toBe(false);
  expect(state.docs[0].released).toBe(false);
  state.files["/repo/README.md"] = "changed\n";
  const reads = state.reads.length;
  f.reload(cx);
  f.show(null);
  await settled();
  expect(state.reads.length).toBe(reads + 1);
  expect(state.docs[0].values).toEqual(["# Hi\n"]);
});

test("file.preview shows a file under the folder by its own path, and is taken once", async () => {
  const { f, cx } = await panel();
  stored.set("markdown", "raw");
  state.shared["files.open"] = { file: "/repo/docs/a.md", on: null };
  f.render(cx);
  await settled();
  expect(f.file).toBe("docs/a.md");
  expect(f.reader.mode).toBe("preview");
  expect(state.shared["files.open"]).toBeNull();
  expect(state.docs).toHaveLength(1);
  f.render(cx);
  await settled();
  expect(state.docs).toHaveLength(1);
});

test("file.preview shows a file outside the folder, and watches where it lives", async () => {
  const { f, cx } = await panel();
  state.shared["files.open"] = { file: "/plans/plan.md" };
  f.render(cx);
  await settled();
  expect(f.file).toBe("/plans/plan.md");
  expect(state.docs[0].options.folder).toBe("/plans");
  state.files["/plans/plan.md"] = "# Plan 2\n";
  state.watches.find((w: any) => w.folder === "/plans").changed();
  await settled();
  expect(state.docs[0].values).toEqual(["# Plan\n", "# Plan 2\n"]);
});

test("A file in the folder shown adds no watch of its own", async () => {
  const { f, cx } = await panel();
  f.show("docs/a.md", cx);
  await settled();
  expect(state.watches.filter((w: any) => w.folder === "/repo/docs")).toEqual([]);
});

test("Nothing polls: an idle document reads its file only when something changes", async () => {
  const { f, cx } = await panel();
  state.shared["files.open"] = { file: "/plans/plan.md" };
  f.render(cx);
  await settled();
  expect(cx.timers.filter(([ms]: [number]) => ms < 10000)).toEqual([]);
});

test("Reloading redraws nothing: the document takes its new text itself", async () => {
  const { f, cx } = await panel();
  f.show("README.md", cx);
  await settled();
  const notified = cx.notified;
  f.reload(cx);
  await settled();
  state.files["/repo/README.md"] = "changed\n";
  f.reload(cx);
  await settled();
  expect(state.docs[0].values.at(-1)).toBe("changed\n");
  expect(cx.notified).toBe(notified);
});

test("A change landing mid-read is read again, as no other event will bring it", async () => {
  const { f, cx } = await panel();
  f.show("README.md", cx);
  await settled();
  f.reload(cx);
  state.files["/repo/README.md"] = "later\n";
  f.reload(cx);
  await settled();
  expect(state.docs[0].values.at(-1)).toBe("later\n");
});

test("Asking for the file already open keeps the place instead of starting over", async () => {
  const { f, cx } = await panel();
  f.show("README.md", cx);
  await settled();
  state.shared["files.open"] = { file: "/repo/README.md" };
  f.render(cx);
  await settled();
  expect(state.docs).toHaveLength(1);
  expect(state.docs[0].released).toBe(false);
});

test("A file on another machine is read there, with no local images", async () => {
  state.files["/srv/a.md"] = "# Remote\n";
  const { f, cx } = await panel();
  state.shared["files.open"] = { file: "/srv/a.md", on: "vps" };
  f.render(cx);
  await settled();
  expect(state.reads.at(-1)).toEqual(["/srv/a.md", "vps"]);
  expect(state.docs[0].options.folder).toBeUndefined();
});

test("Back returns to the machine a file came from", async () => {
  state.files["/srv/a.md"] = "# Remote\n";
  state.files["/srv/b.md"] = "# Other\n";
  const { f, cx } = await panel();
  state.shared["files.open"] = { file: "/srv/a.md", on: "vps" };
  f.render(cx);
  await settled();
  f.follow("b.md", cx);
  await settled();
  expect(state.reads.at(-1)).toEqual(["/srv/b.md", "vps"]);
  f.back(cx);
  await settled();
  expect(state.reads.at(-1)).toEqual(["/srv/a.md", "vps"]);
  expect(state.docs.at(-1).options.folder).toBeUndefined();
});

test("Going elsewhere and back keeps the machine too", async () => {
  state.files["/srv/a.md"] = "# Remote\n";
  const { f, cx } = await panel();
  state.shared["files.open"] = { file: "/srv/a.md", on: "vps" };
  f.render(cx);
  await settled();
  const context = f.context.key;
  expect(f.fileOn).toBe("vps");
  f.saved.set(context, { folders: f.folders, shown: f.shownFile() });
  f.context = { key: "elsewhere" };
  f.refresh(cx);
  await settled();
  expect(state.reads.at(-1)).toEqual(["/srv/a.md", "vps"]);
});

test("Following links: a file, back, a heading, the web, and nothing else", async () => {
  state.outline = [{ level: 2, text: "Set up", block: 4 }];
  const { f, cx } = await panel();
  f.show("README.md", cx);
  await settled();
  f.follow("https://a.com", cx);
  expect(cx.opened).toEqual(["https://a.com"]);
  f.follow("#set-up", cx);
  expect(state.docs[0].scrolled).toEqual([4]);
  f.follow("mailto:a@b.c", cx);
  expect(state.notes).toHaveLength(1);
  f.follow("docs/a.md#set-up", cx);
  await settled();
  expect(f.file).toBe("docs/a.md");
  expect(state.docs[1].scrolled).toContain(4);
  f.back(cx);
  await settled();
  expect(f.file).toBe("README.md");
  f.back(cx);
  expect(f.file).toBeNull();
});

test("A link to the document itself only moves within it", async () => {
  state.outline = [{ level: 2, text: "Top", block: 1 }];
  const { f, cx } = await panel();
  f.show("README.md", cx);
  await settled();
  f.follow("README.md#top", cx);
  await settled();
  expect(state.docs).toHaveLength(1);
  expect(f.trail).toEqual([]);
  expect(state.docs[0].scrolled).toEqual([1]);
});

test("A pinned file watches its own folder", async () => {
  state.props = { file: "/plans/plan.md" };
  const { f } = await panel();
  await settled();
  expect(f.file).toBe("plan.md");
  state.files["/plans/plan.md"] = "new\n";
  state.watches.find((w: any) => w.folder === "/plans").changed();
  await settled();
  expect(state.docs[0].values.at(-1)).toBe("new\n");
});

test("A pinned file on another machine is read gently, with no watch", async () => {
  state.props = { file: "/srv/a.md", on: "vps" };
  state.files["/srv/a.md"] = "# Remote\n";
  const { cx } = await panel();
  await settled();
  expect(state.watches.filter((w: any) => w.folder === "/srv")).toEqual([]);
  expect(cx.timers.map(([ms]: [number]) => ms)).toContain(10000);
});

test("The look only uses the theme's colors, each one a color, and marks in no orange", () => {
  const look = readerLook(colors);
  const values = Object.entries(look).filter(([key]) => !key.endsWith("_icon")).flatMap(([, value]) => (typeof value === "string" ? [value] : Object.values(value as object)));
  for (const color of values) expect(color).toMatch(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
  expect(Object.keys(look.alerts)).toEqual(["note", "tip", "important", "warning", "caution"]);
  // Selections paint over the glyphs: opaque, they hide what's selected.
  expect(look.selection).toMatch(/^#[0-9a-fA-F]{8}$/);
  expect(look.mark_active.slice(0, 7).toLowerCase()).not.toBe(colors.accent.toLowerCase());
});
