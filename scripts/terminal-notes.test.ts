import { beforeEach, expect, mock, test } from "bun:test";

const files = new Map<string, string>();
let platform = "linux";
let opened: unknown[] = [];
let revealed: unknown[][] = [];
let canReveal = false;
const shell = { address: "t7", created_ms: 100, program: { key: "shell" } };
let currentTerminal: typeof shell & { labels?: Record<string, string> } = shell;
let clipboard = "";
let dismissed: string[] = [];
let jobs: Promise<unknown>[] = [];
let interfere: (() => void) | null = null;
mock.module("herdr", () => ({
  theme: () => ({}),
  commands: () => [{ name: "mod.open", args: [{ name: "name", required: true }] }],
  layout: () => ({}),
  layouts: () => [],
  keys: () => [],
  props: () => ({ overlay: "palette", terminal: "vps/t9" }),
  run: () => { throw new Error("The palette should open the Notes mod directly."); },
  shared: () => null,
  focused: () => ({ terminal: "t7" }),
  terminals: () => [currentTerminal],
  openOverlay: (spec: unknown) => opened.push(spec),
  closeOverlay: (id: string) => dismissed.push(id),
  notify: () => {},
  revealTerminalNote: async (...args: unknown[]) => {
    revealed.push(args);
    return canReveal;
  },
  home: () => "/home/tester",
  exec: async () => ({ code: 0, stdout: "/home/tester/.claude\n" }),
  appHome: () => platform === "windows" ? "C:\\kavex" : "/kavex",
  window: () => ({ platform }),
  readTextFile: async (path: string) => files.get(path) ?? null,
  writeTextFile: async (path: string, text: string, expected: string | null) => {
    interfere?.();
    interfere = null;
    if ((files.get(path) ?? null) !== expected) throw new Error("stale write");
    files.set(path, text);
  },
}));

type Element = { id?: string; height?: number; label?: string; click?: (_event: unknown, context: unknown) => void; children: Element[] };
function element(): any {
  const node: Element = { children: [] };
  const api: any = new Proxy({}, { get(_target, key) {
    if (key === "node") return node;
    if (key === "id") return (id: string) => { node.id = id; return api; };
    if (key === "h") return (height: number) => { node.height = height; return api; };
    if (key === "child") return (child: any) => {
      node.children.push(typeof child === "string" ? { label: child, children: [] } : child.node);
      return api;
    };
    if (key === "children") return (children: any[]) => children.reduce((builder, child) => builder.child(child), api);
    if (key === "when") return (condition: boolean, apply: (builder: any) => any) => condition ? apply(api) : api;
    if (key === "on_click") return (callback: Element["click"]) => { node.click = callback; return api; };
    return () => api;
  } });
  return api;
}

const input = () => ({ value: () => "", focus() {}, on() {} });
mock.module("gpui-kit", () => ({ View: class {}, div: element, svg: element }));
mock.module("gpui-base", () => ({
  h_flex: element, v_flex: element,
  InputState: { new: input }, TextareaState: { new: input }, Input: { new: element }, Textarea: { new: element },
}));

const cx = {
  spawn: (work: (context: unknown) => Promise<unknown>) => jobs.push(work(cx)),
  timer: { after: (_ms: number, work: (context: unknown) => void) => work(cx) },
  notify() {},
  focus_handle: () => ({ focus() {} }),
  write_to_clipboard: (text: string) => { clipboard = text; },
};
const settle = async () => { while (jobs.length) await jobs.shift(); };
const button = (node: Element, text: string): Element | undefined =>
  node.children.some((child) => child.label === text) && node.click ? node :
    node.children.map((child) => button(child, text)).find(Boolean);

const { default: Palette } = await import("../defaults/frame/palette/main.js");
const { TerminalNotes } = await import("../defaults/mods/agents/notes.js");
const { listNotes, saveNote } = await import("../defaults/mods/agents/notes-store.js");

const { noteScope } = await import("../defaults/mods/agents/notes-scope.js");

const session = { machine: null, agent: "claude", session: "conversation-a" };
const terminal = { machine: null, terminalRun: "core-1:t7:100" };
const quote = { text: "First line\n  indented code", comment: "Look here", anchor: "selection-a" };

beforeEach(() => {
  files.clear();
  opened = [];
  revealed = [];
  canReveal = false;
  clipboard = "";
  currentTerminal = shell;
  dismissed = [];
  jobs = [];
  interfere = null;
  platform = "linux";
});

test("a saved note keeps the exact quote, optional comment, and selection anchor", async () => {
  expect(await listNotes(session)).toEqual([]);
  const first = await saveNote(session, quote);
  const second = await saveNote(session, { text: "Another quote" });

  expect(await listNotes(session)).toEqual([
    { id: second.id, text: "Another quote", comment: "", anchor: null, created: second.created },
    { id: first.id, ...quote, created: first.created },
  ]);
  expect(first.id).not.toBe(second.id);
  expect(JSON.parse([...files.values()][0]).version).toBe(1);
});

test("a reused terminal and a session on another machine keep their own notes", async () => {
  await saveNote(session, quote);
  await saveNote(terminal, { text: "shell output" });

  expect(await listNotes({ ...session, session: "conversation-b" })).toEqual([]);
  expect(await listNotes({ ...session, machine: "remote" })).toEqual([]);
  expect(await listNotes({ ...terminal, terminalRun: "core-2:t7:100" })).toEqual([]);
  expect((await listNotes(terminal)).map((note: { text: string }) => note.text)).toEqual(["shell output"]);
});

test("a note added while saving is kept alongside the new note", async () => {
  const prior = await saveNote(session, quote);
  const path = [...files.keys()][0];
  interfere = () => files.set(path, JSON.stringify({ version: 1, items: [
    { id: "second-window", text: "from the other window", comment: "", anchor: null, created: prior.created },
    prior,
  ] }));
  await saveNote(session, { text: "from this window" });

  expect((await listNotes(session)).map((note: { text: string }) => note.text))
    .toEqual(["from this window", "from the other window", quote.text]);
});

test("an unreadable notes document is preserved when saving", async () => {
  await saveNote(session, quote);
  const path = [...files.keys()][0];
  files.set(path, "{ incomplete");
  await expect(saveNote(session, { text: "new" })).rejects.toThrow();
  expect(files.get(path)).toBe("{ incomplete");
});

test("scope names cannot introduce directories or collide on case-insensitive systems", async () => {
  platform = "windows";
  const one = { ...session, session: "../A" };
  const two = { ...one, session: "../a" };
  await saveNote(one, quote);
  await saveNote(two, { text: "different" });

  const paths = [...files.keys()];
  expect(paths.map((path) => path.slice("C:\\kavex\\terminal-notes\\".length)))
    .toEqual([expect.stringMatching(/^[a-z0-9]+\.json$/), expect.stringMatching(/^[a-z0-9]+\.json$/)]);
  expect(paths[0].toLowerCase()).not.toBe(paths[1].toLowerCase());
  expect((await listNotes(one))[0].text).toBe(quote.text);
});

test("Codex notes follow the conversation across terminals and change with the session", async () => {
  const codex = { address: "vps/t7", created_ms: 100, program: { key: "codex" }, labels: {
    "kavex.session": "/home/tester/.codex/sessions/2026/11/21/rollout-557dcd48-09b6-4bed-84fb-afbd80910ee0.jsonl",
  } };
  expect(await noteScope(codex)).toEqual({ agent: "codex", machine: "vps", session: "557dcd48-09b6-4bed-84fb-afbd80910ee0" });
  expect(await noteScope({ ...codex, address: "vps/t8", created_ms: 200 })).toEqual(await noteScope(codex));
  expect(await noteScope({ ...codex, labels: {} })).toEqual({ machine: "vps", terminalRun: "t7:100" });
});

test("Claude notes use the session record of the foreground process", async () => {
  files.set("/home/tester/.claude/sessions/101.json", JSON.stringify({ sessionId: "claude-run", cwd: "/project" }));
  const claude = { address: "t7", created_ms: 100, program: { key: "claude" }, foreground: { pid: 101 } };
  expect(await noteScope(claude)).toEqual({ machine: null, agent: "claude", session: "claude-run" });
  expect(await noteScope({ ...claude, foreground: { pid: 102 } })).toEqual({ machine: null, terminalRun: "t7:100" });
});

test("the selection buttons copy the captured text or open an editor for it", () => {
  const panel = new TerminalNotes({ notes: "selection", terminal: "t7", overlay: "o1", text: quote.text, anchor: quote.anchor }, cx);
  button(panel.render(cx).node, "Copy")!.click!({}, cx);
  expect(clipboard).toBe(quote.text);
  expect(dismissed).toEqual(["o1"]);

  const another = new TerminalNotes({ notes: "selection", terminal: "t7", overlay: "o2", text: quote.text, anchor: quote.anchor }, cx);
  button(another.render(cx).node, "Add note")!.click!({}, cx);
  expect(opened[0]).toMatchObject({ mod: "agents", kind: "dialog", props: { notes: "edit", text: quote.text, anchor: quote.anchor } });
});

test("the note editor saves a quoted selection without requiring a comment", async () => {
  const panel = new TerminalNotes({ notes: "edit", terminal: "t7", overlay: "o1", text: quote.text, anchor: quote.anchor }, cx);
  await settle();
  button(panel.render(cx).node, "Save note")!.click!({}, cx);
  await settle();
  expect(await listNotes({ machine: null, terminalRun: "t7:100" })).toMatchObject([{ text: quote.text, comment: "", anchor: quote.anchor }]);
  expect(dismissed).toEqual(["o1"]);
});

test("%note in the command palette opens the session notes", () => {
  const palette = new Palette();
  Object.defineProperty(globalThis, "localStorage", { value: { setItem() {} }, configurable: true });
  palette.recent = [];
  palette.query = "%note";
  palette.go(palette.rows()[0]?.e);
  expect(opened[0]).toMatchObject({ mod: "agents", kind: "dialog", props: { notes: "browse", terminal: "vps/t9" } });
  expect(dismissed).toEqual(["palette"]);
});

test("a note without a live match still opens its saved quote and comment", async () => {
  await saveNote({ machine: null, terminalRun: "t7:100" }, quote);
  await saveNote({ machine: null, terminalRun: "t8:100" }, { text: "Different terminal" });
  const panel = new TerminalNotes({ notes: "browse", overlay: "o1" }, cx);
  await settle();
  expect(panel.matches().map((note: { text: string }) => note.text)).toEqual([quote.text]);
  panel.choose(panel.matches()[0], cx);
  await settle();
  const copy = button(panel.render(cx).node, "Copy excerpt");
  expect(copy).toBeDefined();
  copy!.click!({}, cx);
  expect(clipboard).toBe(quote.text);
  expect(panel.detail.comment).toBe(quote.comment);
});

test("the notes picker reserves room for each saved row and its excerpt", async () => {
  const scope = { machine: null, terminalRun: "t7:100" };
  await saveNote(scope, { text: "A note without a comment" });
  await saveNote(scope, quote);
  const panel = new TerminalNotes({ notes: "browse", overlay: "o1" }, cx);
  await settle();

  const list = (panel.render(cx).node as Element).children.find((node) => node.id === "notes-list")!;
  const [withComment, withoutComment] = list.children;
  expect(withComment.height).toBeGreaterThan(withoutComment.height!);
  expect(list.height).toBeGreaterThan(withComment.height! + withoutComment.height!);
});

test("choosing a live note jumps in its terminal and dismisses the picker", async () => {
  await saveNote({ machine: null, terminalRun: "t7:100" }, quote);
  const panel = new TerminalNotes({ notes: "browse", overlay: "o1" }, cx);
  await settle();
  canReveal = true;
  panel.choose(panel.matches()[0], cx);
  await settle();

  expect(revealed).toEqual([["t7", quote.anchor, quote.text]]);
  expect(dismissed).toEqual(["o1"]);
});

test("notes saved before an agent reports its ID remain available under Terminal notes", async () => {
  const run = { machine: null, terminalRun: "t7:100" };
  await saveNote(run, { text: "Saved before the session was known" });
  const id = "557dcd48-09b6-4bed-84fb-afbd80910ee0";
  currentTerminal = { ...shell, program: { key: "codex" }, labels: {
    "kavex.session": `/home/tester/.codex/sessions/2026/11/21/rollout-${id}.jsonl`,
  } };
  await saveNote({ machine: null, agent: "codex", session: id }, { text: "Saved for this conversation" });

  const panel = new TerminalNotes({ notes: "browse", overlay: "o1" }, cx);
  await settle();
  expect(panel.matches().map((note: { text: string }) => note.text)).toEqual(["Saved for this conversation"]);
  button(panel.render(cx).node, "Terminal notes")!.click!({}, cx);
  expect(panel.matches().map((note: { text: string }) => note.text)).toEqual(["Saved before the session was known"]);
});
