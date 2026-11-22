import { beforeEach, expect, mock, test } from "bun:test";

type Agent = { key: string; name: string; run: string[]; installed: boolean };
const claude = { key: "claude", name: "Claude Code", run: ["claude"], installed: true };
const codex = { key: "codex", name: "Codex", run: ["codex"], installed: true };
let machine: string | null;
let online: boolean;
let sharedState: Map<string, unknown>;
const sessionState = new Map<string, string>();
let lookups: { on: string | null; resolve: (agents: Agent[]) => void }[];
let launches: unknown[];
let tasks: Promise<unknown>[];

function element() {
  const words: string[] = [];
  const handlers: Record<string, Function> = {};
  const node: any = new Proxy({ words, handlers }, {
    get(target, key: string) {
      if (key in target) return target[key as keyof typeof target];
      if (key === "when") return (condition: boolean, f: Function) => condition ? f(node) : node;
      if (key === "child") return (kid: any) => {
        words.push(...(typeof kid === "string" ? [kid] : kid.words));
        return node;
      };
      if (key === "children") return (kids: any[]) => {
        for (const kid of kids) node.child(kid);
        return node;
      };
      if (key === "on_key_down") return (f: Function) => { handlers.key = f; return node; };
      return () => node;
    },
  });
  return node;
}

mock.module("gpui-kit", () => ({ View: class {}, div: element, svg: element, image: element }));
mock.module("gpui-base", () => ({ h_flex: element, v_flex: element }));
mock.module("herdr", () => ({
  theme: () => ({}), spaces: () => [{ id: "s", active: true, machine }], panes: () => [],
  machines: () => [{ name: machine, layout: online ? "ready" : "unavailable" }],
  knownAgents: ({ on }: { on: string | null }) => new Promise<Agent[]>((resolve) => lookups.push({ on, resolve })),
  run: (command: string, args: unknown) => launches.push({ command, args }),
  openOverlay: () => "ov", closeOverlay: () => {}, props: () => ({ overlay: "ov" }),
  window: () => ({ platform: "macos" }), keys: () => [],
  shared: (key: string) => sharedState.get(key),
  setShared: (key: string, value: unknown) => sharedState.set(key, value),
}));

const { default: NewMenu } = await import("../defaults/mods/new-menu/main.js");
const cx = {
  focus_handle: () => ({ focus() {} }),
  spawn: (run: (cx: unknown) => Promise<unknown>) => { tasks.push(run(cx)); },
  notify() {},
};
function open() {
  const menu = new NewMenu();
  menu.init({}, cx);
  return () => menu.render();
}
async function finishLookup(agents: Agent[]) {
  lookups.at(-1)!.resolve(agents);
  await tasks.at(-1);
}

beforeEach(() => {
  machine = null;
  online = true;
  sharedState = new Map();
  sessionState.clear();
  Object.defineProperty(globalThis, "sessionStorage", {
    value: { getItem: (key: string) => sessionState.get(key) ?? null,
      setItem: (key: string, value: string) => sessionState.set(key, value) },
    configurable: true,
  });
  lookups = [];
  launches = [];
  tasks = [];
});

test("shows cached agents immediately and keeps shortcuts stable during refresh", async () => {
  sharedState.set("new-menu.agents:", [claude, codex]);
  const draw = open();
  expect(draw().words).toContain("Terminal");
  expect(draw().words).toContain("Claude Code");
  expect(draw().words).toContain("Codex");
  expect(draw().words).not.toContain("Checking installed agents…");
  await finishLookup([codex]);
  draw().handlers.key({ key: "1", modifiers: {} });
  expect(launches).toEqual([{ command: "tab.new", args: { space: "s", name: "Claude Code", argv: ["claude"] } }]);
  expect(open()().words).not.toContain("Claude Code");
});

test("a first visit checks the active machine and fills the open menu", async () => {
  sharedState.set("new-menu.agents:", [claude]);
  machine = "other";
  const draw = open();
  expect(draw().words).not.toContain("Claude Code");
  expect(draw().words).toContain("Checking installed agents…");
  expect(lookups.map(({ on }) => on)).toEqual(["other"]);
  await finishLookup([codex]);
  expect(draw().words).toContain("Codex");
  expect(open()().words).toContain("Codex");
  machine = null;
  expect(open()().words).toContain("Claude Code");
});

test("a lookup that completes late cannot replace the newer list", async () => {
  open();
  open();
  await finishLookup([codex]);
  lookups[0].resolve([claude]);
  await tasks[0];
  expect(open()().words).toContain("Codex");
});

test("losing the active machine during discovery keeps its cached agents", async () => {
  machine = "other";
  sharedState.set("new-menu.agents:other", [codex]);
  const draw = open();
  online = false;
  await finishLookup([{ ...codex, installed: false }]);
  expect(draw().words).not.toContain("not installed");
  expect(open()().words).not.toContain("not installed");
  expect(lookups).toHaveLength(1);
});
