import { test, expect } from "bun:test";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = await readFile(new URL("../defaults/mods/files/main.js", import.meta.url), "utf8");
const directorySource = source.slice(source.indexOf("async function directory("), source.indexOf("\nexport default class"));
const directory = new Function("exec", "window", "fs", `${directorySource}; return directory;`)(
  async (command: string, args: string[]) => {
    const p = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, stdout, stderr };
  },
  () => ({ platform: process.platform === "win32" ? "windows" : process.platform }),
  { readdir: async () => { throw new Error("outside home"); } },
);

const dirent = (name: string, dir = false) => ({ name, isDirectory: () => dir });

test("On Windows a folder in the home folder lists without starting a process", async () => {
  const started: string[] = [];
  const list = new Function("exec", "window", "fs", `${directorySource}; return directory;`)(
    async (command: string) => { started.push(command); return { code: 0, stdout: "[]", stderr: "" }; },
    () => ({ platform: "windows" }),
    { readdir: async () => [dirent(".git", true), dirent("src", true), dirent("a.txt")] },
  );
  expect(await list("C:\\Users\\me\\repo", null)).toEqual([{ name: "src", dir: true }, { name: "a.txt", dir: false }]);
  expect(started).toEqual([]);
});

test("On Windows a folder outside the home folder still lists through PowerShell", async () => {
  for (const readdir of [async () => { throw new Error("rejected"); }, () => { throw new Error("thrown"); }]) {
    const started: string[] = [];
    const list = new Function("exec", "window", "fs", `${directorySource}; return directory;`)(
      async (command: string) => { started.push(command); return { code: 0, stdout: '[{"name":"x","dir":false}]', stderr: "" }; },
      () => ({ platform: "windows" }),
      { readdir },
    );
    expect(await list("D:\\code", null)).toEqual([{ name: "x", dir: false }]);
    expect(started).toEqual(["powershell"]);
  }
});

// The real mod on a stand-in host: `readdir` decides what each folder holds and when it answers.
function panel(readdir: (path: string) => Promise<ReturnType<typeof dirent>[]>) {
  const body = source.replace(/^import .*$/gm, "").replace("export default class Files extends View", "return class Files extends View");
  const element: unknown = new Proxy(() => element, { get: () => element });
  const never = () => new Promise(() => {});
  const host = {
    View: class {}, div: () => element, svg: () => element, v_flex: () => element, h_flex: () => element, Editor: {}, EditorState: {}, fs: { readdir },
    spaces: () => [{ id: "s", active: true, folder: "C:\\repo", machine: null }], panes: () => [], focused: () => ({ pane: null, cwd: "C:\\repo" }),
    exec: async () => ({ code: 128, stdout: "", stderr: "" }), readTextFile: never, watchFolder: never, theme: () => ({}), settings: () => ({}), window: () => ({ platform: "windows" }),
  };
  const Files = new Function(...Object.keys(host), body)(...Object.values(host));
  const cx = { spawn: (task: (cx: unknown) => unknown) => { task(cx); }, notify() {}, timer: { every() {} } };
  const mod = new Files();
  mod.init({}, cx);
  return { mod, cx, visible: () => mod.rows("", 0, [], {}).length };
}
const settled = () => Bun.sleep(1);

test("Reopening a folder shows its rows at once, then the fresh listing", async () => {
  let answer = (_rows: ReturnType<typeof dirent>[]) => {};
  const { mod, cx, visible } = panel(path => path.endsWith("src")
    ? new Promise(resolve => { answer = resolve; })
    : Promise.resolve([dirent("src", true), dirent("a.txt")]));
  await settled();
  mod.toggle("src", cx);
  answer([dirent("x"), dirent("y")]);
  await settled();
  expect(visible()).toBe(4);
  mod.toggle("src", cx);
  expect(visible()).toBe(2);
  mod.toggle("src", cx);
  expect(visible()).toBe(4);
  answer([dirent("x"), dirent("y"), dirent("z")]);
  await settled();
  expect(visible()).toBe(5);
});

test("A closed folder's rows don't count toward the 5,000 limit", async () => {
  const names = Array.from({ length: 12 }, (_, i) => `d${i}`);
  const { mod, cx } = panel(async path => {
    const leaf = names.find(name => path.endsWith(`/${name}`));
    return leaf ? Array.from({ length: 500 }, (_, i) => dirent(`${leaf}-${i}`)) : names.map(name => dirent(name, true));
  });
  await settled();
  for (const name of names) { mod.toggle(name, cx); await settled(); mod.toggle(name, cx); }
  mod.toggle("d0", cx);
  await settled();
  expect(mod.limited).toBeFalsy();
  expect(mod.entries.get("d0").length).toBe(500);
});

test("Files lists literal folder names, not shell expressions", async () => {
  const root = await mkdtemp(join(process.platform === "linux" ? "/var/tmp" : tmpdir(), "herdr-files-"));
  try {
    for (const name of ["Test Folder (ACME)", "O'Brien $folder; (ACME)"]) {
      const folder = join(root, name);
      await mkdir(join(folder, "child"), { recursive: true });
      await writeFile(join(folder, "hello.txt"), "hello");
      const entries = await directory(folder, null);
      expect(entries.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))).toEqual([
        { name: "child", dir: true }, { name: "hello.txt", dir: false },
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
