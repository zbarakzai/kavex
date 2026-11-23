import { beforeEach, expect, mock, test } from "bun:test";

const files = new Map<string, string>();
let platform = "linux";
let opened: unknown[] = [];
let revealed: unknown[][] = [];
let canReveal = false;
const shell = { address: "t7", created_ms: 100, program: { key: "shell" } };
let currentTerminal: typeof shell & { labels?: Record<string, string>; foreground?: { pid: number } } = shell;
let clipboard = "";
let dismissed: string[] = [];
let jobs: Promise<unknown>[] = [];
let noteScrolls: number[] = [];
let interfere: (() => void) | null = null;
let sharedValues: Record<string, any> = {};
let currentFocus: any = { terminal: "t7" };
let currentProps: any = { overlay: "palette", terminal: "vps/t9" };
let holdRead: ((path: string) => Promise<string | null> | undefined) | null = null;
mock.module("herdr", () => ({
  theme: () => ({}),
  commands: () => [{ name: "mod.open", args: [{ name: "name", required: true }] }],
  layout: () => ({}),
  layouts: () => [],
  keys: () => [],
  props: () => currentProps,
  run: () => { throw new Error("The palette should open the Notes mod directly."); },
  shared: (key: string) => sharedValues[key] ?? null,
  setShared: (key: string, value: unknown) => { sharedValues[key] = value; },
  focused: () => currentFocus,
  agents: () => [],
  spaces: () => [],
  settings: () => ({ zoom: 1 }),
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
  readTextFile: async (path: string) => holdRead?.(path) ?? files.get(path) ?? null,
  writeTextFile: async (path: string, text: string, expected: string | null) => {
    interfere?.();
    interfere = null;
    if ((files.get(path) ?? null) !== expected) throw new Error("stale write");
    files.set(path, text);
  },
}));

type Element = {
  id?: string;
  height?: number;
  label?: string;
  click?: (_event: unknown, context: unknown) => void;
  mouseDown?: (event: { local_position: { x: number }; bounds: { width: number } }) => void;
  itemClick?: (id: string, context: unknown) => void;
  keyDown?: (event: { key: string }, context: unknown) => void;
  children: Element[];
};
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
    if (key === "on_mouse_down") return (_button: string, callback: Element["mouseDown"]) => { node.mouseDown = callback; return api; };
    if (key === "on_item_click") return (callback: Element["itemClick"]) => { node.itemClick = callback; return api; };
    if (key === "on_key_down") return (callback: Element["keyDown"]) => { node.keyDown = callback; return api; };
    return () => api;
  } });
  return api;
}

const input = () => ({ value: () => "", focus() {}, on() {} });
mock.module("gpui-kit", () => ({ View: class {}, div: element, image: element, svg: element }));
mock.module("gpui-base", () => ({
  h_flex: element, v_flex: element,
  v_virtual_list: (_id: string, count: number, _sizes: number[], _key: unknown, render: (range: { start: number; end: number }) => unknown[]) =>
    element().children(render({ start: 0, end: count })),
  VirtualListScrollHandle: { new: () => ({ scroll_to_item: (index: number) => noteScrolls.push(index) }) },
  Scrollbar: { vertical: element },
  InputState: { new: input }, TextareaState: { new: input }, Input: { new: element }, Textarea: { new: element },
  HoverCard: { new: element },
}));

const cx = {
  spawn: (work: (context: unknown) => Promise<unknown>) => jobs.push(work(cx)),
  timer: { after: (_ms: number, work: (context: unknown) => void) => work(cx), every() {} },
  notify() {},
  stop_propagation() {},
  focus_handle: () => ({ focus() {} }),
  write_to_clipboard: (text: string) => { clipboard = text; },
};
const settle = async () => { while (jobs.length) await jobs.shift(); };
const button = (node: Element, text: string): Element | undefined =>
  node.children.some((child) => child.label === text) && node.click ? node :
    node.children.map((child) => button(child, text)).find(Boolean);

const { default: Palette } = await import("../defaults/frame/palette/main.js");
const { TerminalNotes } = await import("../defaults/mods/agents/notes.js");
const { NotesStatus } = await import("../defaults/mods/agents/notes-status.js");
const { default: WorkspaceStatus } = await import("../defaults/mods/workspace-status/main.js");
const { listNotes, saveNote } = await import("../defaults/mods/agents/notes-store.js");

const { noteScope } = await import("../defaults/mods/agents/notes-scope.js");

const session = { machine: null, agent: "claude", session: "conversation-a" };
const terminal = { machine: null, terminalRun: "core-1:t7:100" };
const quote = { text: "First line\n  indented code", comment: "Look here", anchor: "selection-a" };

beforeEach(() => {
  files.clear();
  noteScrolls = [];
  opened = [];
  revealed = [];
  canReveal = false;
  clipboard = "";
  currentTerminal = shell;
  dismissed = [];
  jobs = [];
  interfere = null;
  platform = "linux";
  sharedValues = {};
  currentFocus = { terminal: "t7" };
  currentProps = { overlay: "palette", terminal: "vps/t9" };
  holdRead = null;
});

const footer = () => {
  currentProps = { monitor: true, usage: true };
  const view: any = new WorkspaceStatus();
  view.init({}, cx);
  return view;
};

test("the footer offers existing notes only for the visible terminal and opens that source", async () => {
  await saveNote(terminal, quote);
  currentTerminal = { ...shell, address: "core-1:t7" };
  currentFocus = { shown: currentTerminal.address };
  const status = new NotesStatus();
  status.refresh(cx);
  await settle();
  const view = footer();
  const action = button(view.render(cx).node, "Notes")!;
  expect(action).toBeDefined();
  action.click!({}, cx);
  expect(opened.at(-1)).toMatchObject({ mod: "agents", props: { notes: "browse", source: { address: "core-1:t7", created_ms: 100 } } });

  currentTerminal = { ...shell, address: "t8" };
  currentFocus = { shown: "t8" };
  expect(button(view.render(cx).node, "Notes")).toBeUndefined();
  status.refresh(cx);
  await settle();
  expect(button(view.render(cx).node, "Notes")).toBeUndefined();
});

test("saving the first note updates availability and the footer action supports Enter", async () => {
  const status = new NotesStatus();
  status.refresh(cx);
  await settle();
  const view = footer();
  expect(button(view.render(cx).node, "Notes")).toBeUndefined();
  await saveNote({ machine: null, terminalRun: "t7:100" }, quote);
  expect(sharedValues["terminal.notes.changed"]).toBeTruthy();
  status.refresh(cx);
  await settle();
  button(view.render(cx).node, "Notes")!.keyDown!({ key: "enter" }, cx);
  expect(opened.at(-1)).toMatchObject({ mod: "agents", props: { notes: "browse", source: { address: "t7" } } });
});

test("late note reads cannot make another terminal's Notes action appear", async () => {
  await saveNote({ machine: null, terminalRun: "t7:100" }, quote);
  const savedPath = [...files.keys()][0];
  const saved = files.get(savedPath)!;
  let finishRead!: (value: string) => void;
  holdRead = (path) => path === savedPath ? new Promise((resolve) => { finishRead = resolve; }) : undefined;
  const status = new NotesStatus();
  status.refresh(cx);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  currentTerminal = { ...shell, address: "t8" };
  currentFocus = { shown: "t8" };
  status.refresh(cx);
  finishRead(saved);
  await settle();
  expect(button(footer().render(cx).node, "Notes")).toBeUndefined();
  expect(sharedValues["terminal.notes"]?.source.address).toBe("t8");
});

test("resumed sessions keep their notes, while a new conversation in the same terminal has none", async () => {
  const sessionId = "557dcd48-09b6-4bed-84fb-afbd80910ee0";
  const label = `/home/tester/.codex/sessions/2026/11/21/rollout-${sessionId}.jsonl`;
  const codex = { ...shell, program: { key: "codex" }, labels: { "kavex.session": label } };
  currentTerminal = codex;
  await saveNote({ machine: null, agent: "codex", session: sessionId }, quote);
  const status = new NotesStatus();
  status.refresh(cx);
  await settle();
  const view = footer();
  expect(button(view.render(cx).node, "Notes")).toBeDefined();

  currentTerminal = { ...codex, labels: { "kavex.session": label.replace(sessionId, "657dcd48-09b6-4bed-84fb-afbd80910ee0") } };
  expect(button(view.render(cx).node, "Notes")).toBeUndefined();
  status.refresh(cx);
  await settle();
  expect(button(view.render(cx).node, "Notes")).toBeUndefined();

  currentTerminal = { ...codex, address: "t8", created_ms: 200 };
  currentFocus = { shown: "t8" };
  status.refresh(cx);
  await settle();
  expect(button(view.render(cx).node, "Notes")).toBeDefined();
});

test("a new Claude conversation in the same process never opens the previous conversation's notes", async () => {
  const record = "/home/tester/.claude/sessions/101.json";
  currentTerminal = { ...shell, program: { key: "claude" }, foreground: { pid: 101 } };
  files.set(record, JSON.stringify({ sessionId: "old-conversation", cwd: "/project" }));
  await saveNote({ machine: null, agent: "claude", session: "old-conversation" }, quote);
  const status = new NotesStatus();
  status.refresh(cx);
  await settle();
  const view = footer();
  expect(button(view.render(cx).node, "Notes")).toBeDefined();

  files.set(record, JSON.stringify({ sessionId: "new-conversation", cwd: "/project" }));
  button(view.render(cx).node, "Notes")!.click!({}, cx);
  const browser = new TerminalNotes((opened.at(-1) as any).props, cx);
  await settle();
  expect(browser.scope.session).toBe("new-conversation");
  expect(browser.items).toEqual([]);
  status.refresh(cx);
  await settle();
  expect(button(view.render(cx).node, "Notes")).toBeUndefined();
});

test("an unreadable notes file clears availability without overwriting the notes", async () => {
  await saveNote({ machine: null, terminalRun: "t7:100" }, quote);
  const status = new NotesStatus();
  status.refresh(cx);
  await settle();
  const view = footer();
  expect(button(view.render(cx).node, "Notes")).toBeDefined();
  const path = [...files.keys()][0];
  files.set(path, "{ incomplete");
  status.refresh(cx);
  await settle();
  expect(button(view.render(cx).node, "Notes")).toBeUndefined();
  expect(files.get(path)).toBe("{ incomplete");
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

test("moving the keyboard selection keeps the active note visible", async () => {
  const scope = { machine: null, terminalRun: "t7:100" };
  for (let i = 0; i < 12; i++) await saveNote(scope, { text: `Sample output ${i}` });
  const panel = new TerminalNotes({ notes: "browse", overlay: "o1" }, cx);
  await settle();

  for (let i = 0; i < 9; i++) panel.keys({ key: "down" }, cx);
  expect(panel.at).toBe(9);
  expect(noteScrolls.at(-1)).toBe(9);
});

test("the editor accepts the macOS save shortcut without a mouse", async () => {
  platform = "macos";
  const panel = new TerminalNotes({ notes: "edit", terminal: "t7", overlay: "o1", text: quote.text, anchor: quote.anchor }, cx);
  await settle();
  panel.keys({ key: "enter", modifiers: { platform: true, control: false } }, cx);
  await settle();

  expect(await listNotes({ machine: null, terminalRun: "t7:100" })).toMatchObject([{ text: quote.text }]);
  expect(dismissed).toEqual(["o1"]);
});

test("the notes picker reserves room for each saved row and its excerpt", async () => {
  const scope = { machine: null, terminalRun: "t7:100" };
  await saveNote(scope, { text: "A note without a comment" });
  await saveNote(scope, quote);
  const panel = new TerminalNotes({ notes: "browse", overlay: "o1" }, cx);
  await settle();

  const list = (panel.render(cx).node as Element).children.find((node) => node.id === "notes-list")!;
  const [withComment, withoutComment] = list.children[0].children;
  expect(withComment.children[0].height).toBeGreaterThan(withoutComment.children[0].height!);
  expect(list.height).toBe(withComment.height! + withoutComment.height!);
});

test("choosing a live note jumps in its terminal and dismisses the picker", async () => {
  const note = await saveNote({ machine: null, terminalRun: "t7:100" }, quote);
  const panel = new TerminalNotes({ notes: "browse", overlay: "o1" }, cx);
  await settle();
  canReveal = true;
  const list = (panel.render(cx).node as Element).children.find((node) => node.id === "notes-list")!;
  list.children[0].itemClick!(note.id, cx);
  await settle();

  expect(revealed).toEqual([["t7", quote.anchor, quote.text]]);
  expect(dismissed).toEqual(["o1"]);
});

test("copying a note from its row puts the full excerpt on the clipboard and keeps the picker open", async () => {
  const note = await saveNote({ machine: null, terminalRun: "t7:100" }, quote);
  const panel = new TerminalNotes({ notes: "browse", overlay: "o1" }, cx);
  await settle();

  const list = (panel.render(cx).node as Element).children.find((node) => node.id === "notes-list")!;
  list.mouseDown!({ local_position: { x: 465 }, bounds: { width: 490 } });
  list.children[0].itemClick!(note.id, cx);
  await settle();

  expect(clipboard).toBe(quote.text);
  expect(revealed).toEqual([]);
  expect(dismissed).toEqual([]);
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
