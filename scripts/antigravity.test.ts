import { beforeEach, expect, mock, test } from "bun:test";

let terms: any[];
let saved: Record<string, any>;
let tasks: Promise<unknown>[];
let labels: string[][];
let offline: boolean;
mock.module("herdr", () => ({
  agents: () => terms,
  terminals: () => terms,
  machines: () => [{ name: null, layout: "ready" }, { name: "remote", layout: offline ? "unavailable" : "ready" }],
  home: () => "/test-home",
  window: () => ({ platform: "windows" }),
  shared: (key: string) => saved[key],
  setShared: (key: string, value: unknown) => { saved[key] = value; },
  hc: async (args: string[]) => { labels.push(args); },
  exec: async () => { throw new Error("A reported session needs no subprocess."); },
  readTextFile: async () => { throw new Error("A reported session needs no file read."); },
  writeTextFile: async () => { throw new Error("Already installed."); },
  watchFolder: async () => { throw new Error("No session files to watch."); },
}));

function element() {
  const words: string[] = [];
  const node: any = new Proxy({ words }, { get(target, key: string) {
    if (key === "words") return words;
    if (key === "child") return (child: any) => { words.push(...(typeof child === "string" ? [child] : child.words)); return node; };
    if (key === "when") return (condition: boolean, run: Function) => condition ? run(node) : node;
    return () => node;
  } });
  return node;
}
mock.module("gpui-kit", () => ({ div: element, image: element, svg: element }));
mock.module("gpui-base", () => ({ h_flex: element, v_flex: element }));

const { Sessions } = await import("../defaults/mods/agents/sessions.js");
const { noteScope } = await import("../defaults/mods/agents/notes-scope.js");
const { dropdown } = await import("../defaults/mods/agents/dropdown.js");
const theme = await Bun.file(new URL("../defaults/themes/kavex.json", import.meta.url)).json();
const colors = { background: theme.background, ...theme.colors, ...Object.fromEntries(theme.ansi.map((color: string, i: number) => [`ansi${i}`, color])) };
const cx: any = {
  spawn: (run: (cx: unknown) => Promise<unknown>) => { tasks.push(run(cx)); },
  timer: { every() {} },
  notify() {},
};
const settle = async () => { while (tasks.length) await tasks.shift(); };
const report = (values = {}) => "antigravity:" + JSON.stringify({
  session: "11111111-2222-4333-8444-555555555555",
  terminal: "t1",
  model: "Gemini 4 Argon (Medium)",
  percent: 14.24,
  total: 1048576,
  input: 88244,
  output: 61074,
  cost: 0.4213,
  estimated: true,
  ...values,
});
const terminal = (address = "t1", label = report()) => ({
  address, state: "live", status: "idle", program: { key: "antigravity" },
  labels: { "kavex.session": label },
});

beforeEach(() => {
  terms = [terminal()];
  saved = { "agents.setup": { antigravity: 1 } };
  tasks = [];
  labels = [];
  offline = false;
});

test("Antigravity shows its reported context and API cost without reading conversations", async () => {
  const sessions = new Sessions();
  sessions.start(cx);
  await settle();
  expect(sessions.shown("t1")).toEqual({
    state: "ready", model: "Gemini 4 Argon (Medium)",
    context: { percent: 14.24, total: 1048576 },
    tokens: { input: 88244, output: 61074 },
    cost: 0.4213, estimated: true,
  });
  expect(saved["agents.contexts"]).toEqual({ t1: 14.24 });
});

test("simultaneous Antigravity sessions keep their own figures, including on another machine", async () => {
  saved["agents.setup"]["remote/antigravity"] = 1;
  terms.push(terminal("t2", report({ terminal: "t2", percent: 70, cost: 2 })));
  terms.push(terminal("remote/t1", report({ percent: 3, cost: 0.01 })));
  const sessions = new Sessions();
  sessions.start(cx);
  await settle();
  expect(sessions.contextOf("t1")).toBe(14.24);
  expect(sessions.contextOf("t2")).toBe(70);
  expect(sessions.contextOf("remote/t1")).toBe(3);
  expect(sessions.shown("remote/t1").cost).toBe(0.01);
  offline = true;
  terms[2].labels["kavex.session"] = report({ percent: 90 });
  sessions.tick(cx);
  await settle();
  expect(sessions.contextOf("remote/t1")).toBe(3);
});

test("a new conversation, compaction and a model change replace rather than add to the snapshot", async () => {
  const sessions = new Sessions();
  sessions.start(cx);
  await settle();
  terms[0].labels["kavex.session"] = report({ percent: 2, model: "Different model", cost: 0 });
  sessions.tick(cx);
  await settle();
  expect(sessions.shown("t1")).toMatchObject({ model: "Different model", context: { percent: 2 }, cost: 0 });
  terms[0].labels["kavex.session"] = report({ session: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", percent: 0, input: 0, output: 0, cost: 0 });
  sessions.tick(cx);
  await settle();
  expect(sessions.shown("t1")).toMatchObject({ context: { percent: 0 }, tokens: { input: 0, output: 0 }, cost: 0 });
});

test("another terminal's or a malformed report never becomes this agent's figures", async () => {
  for (const label of [report({ terminal: "t9" }), report({ session: "bad-id" }), "antigravity:{broken", "/someone/else.jsonl"]) {
    terms = [{ ...terminal("t1", label), status: "working" }];
    const sessions = new Sessions();
    sessions.start(cx);
    await settle();
    expect(sessions.shown("t1").state).toBe("waiting");
    expect(sessions.shown("t1").cost).toBeUndefined();
  }
});

test("missing or invalid numbers stay unknown while real zero remains zero", async () => {
  terms[0].labels["kavex.session"] = report({ percent: 101, total: 0, input: -1, output: "12", cost: -0.5 });
  const sessions = new Sessions();
  sessions.start(cx);
  await settle();
  expect(sessions.shown("t1").state).toBe("empty");
  terms[0].labels["kavex.session"] = report({ percent: 0, input: 0, output: 0, cost: 0 });
  sessions.tick(cx);
  await settle();
  expect(sessions.shown("t1")).toMatchObject({ context: { percent: 0 }, tokens: { input: 0, output: 0 }, cost: 0 });
});

test("returning to the shell clears the report and the published context", async () => {
  const sessions = new Sessions();
  sessions.start(cx);
  await settle();
  terms[0].program.key = "shell";
  terms[0].program.shell = true;
  sessions.tick(cx);
  await settle();
  expect(labels).toEqual([["label", "t1", "kavex.session="]]);
  expect(saved["agents.contexts"]).toEqual({});
});

test("terminal notes use Antigravity's exact reported conversation", async () => {
  expect(await noteScope(terms[0])).toEqual({ machine: null, agent: "antigravity", session: "11111111-2222-4333-8444-555555555555" });
});

test("the dropdown distinguishes unavailable token figures from zero", async () => {
  const sessions = new Sessions();
  sessions.start(cx);
  await settle();
  const text = dropdown(colors, sessions.shown("t1")).words.join(" ");
  expect(text).toContain("14.24%");
  expect(text).toContain("1M max");
  expect(text).toContain("cached ?");
  expect(text).not.toMatch(/NaN|undefined/);
});
