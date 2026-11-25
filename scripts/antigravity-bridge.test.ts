import { afterEach, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

mock.module("herdr", () => ({ exec() {}, home() {}, readTextFile() {}, window() {}, writeTextFile() {} }));
const { antigravity } = await import("../defaults/mods/agents/antigravity.js");
const { liveReport } = await import("../defaults/mods/agents/antigravity-state.js");
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

const state = (changes = {}) => ({
  product: "antigravity", conversation_id: "11111111-2222-4333-8444-555555555555",
  model: { id: "gemini-model", display_name: "Gemini Model" },
  context_window: { total_input_tokens: 88244, total_output_tokens: 61074, context_window_size: 1048576, used_percentage: 14.24,
    current_usage: { input_tokens: 63382, output_tokens: 346, cache_read_input_tokens: 20857 } },
  cost: { total_usd: 0.4213, subagent_usd: 0.05, estimated: true },
  email: "private@example.com", cwd: "/private/project", conversation_title: "Private prompt", quota: { secret: 123 },
  ...changes,
});

function installation(settings: string | null = null, runtime = true, executable = process.execPath) {
  const home = mkdtempSync(join(tmpdir(), "agy space ‘ title-"));
  temporary.push(home);
  const path = home + "/.gemini/antigravity-cli/settings.json";
  const reads: string[] = [];
  const writes: string[] = [];
  const read = async (file: string) => { reads.push(file); return existsSync(file) ? readFileSync(file, "utf8") : null; };
  const write = async (file: string, text: string, expected: string | null) => {
    if (await read(file) !== expected) throw new Error("The file changed while saving.");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    writes.push(file);
  };
  const files = { home, read, write, keep: async (file: string, text: string) => {
    const before = await read(file);
    if (before !== text) await write(file, text, before);
  } };
  const runs: string[] = [];
  const machine = { on: null, run: async (program: string) => {
    runs.push(program);
    return runtime ? { code: 0, stdout: JSON.stringify(["24.0.0", executable]), stderr: "" } : { code: 127, stdout: "", stderr: "not found" };
  } };
  if (settings !== null) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, settings); }
  return { home, path, files, machine, runs, reads, writes };
}

test("installation preserves settings and the original title command without stacking wrappers", async () => {
  const original = { command: "echo original", enabled: true, type: "command", future: 42 };
  const other = { model: "custom", statusLine: { command: "my-footer" }, title: original };
  const fixture = installation(JSON.stringify(other));
  expect(await antigravity.install?.(fixture.files, fixture.machine)).toBe(true);
  const installed = JSON.parse(readFileSync(fixture.path, "utf8"));
  expect(installed).toMatchObject({ model: "custom", statusLine: other.statusLine, title: { enabled: true, future: 42 } });
  expect(installed.title.command).not.toBe(original.command);
  const backup = fixture.home + "/.kavex/antigravity/title-original.json";
  expect(JSON.parse(readFileSync(backup, "utf8"))).toEqual(original);
  const writeCount = fixture.writes.length;
  expect(await antigravity.install?.(fixture.files, fixture.machine)).toBe(true);
  expect(fixture.writes.length).toBe(writeCount);
  expect(JSON.parse(readFileSync(backup, "utf8"))).toEqual(original);
});

test("unreadable or disabled title settings are left untouched", async () => {
  for (const text of ["{broken", "null", "[]", '{"title":false}', '{"title":{"enabled":false}}', '{"title":"custom"}', '{"title":{"type":"future"}}']) {
    const fixture = installation(text);
    expect(await antigravity.install?.(fixture.files, fixture.machine)).toBe(false);
    expect(readFileSync(fixture.path, "utf8")).toBe(text);
    expect(fixture.writes).toEqual([]);
  }
});

test("a machine without Node or Bun keeps its settings and gets no broken bridge", async () => {
  const fixture = installation('{"model":"personal"}', false);
  expect(await antigravity.install?.(fixture.files, fixture.machine)).toBe(false);
  expect(fixture.runs).toContain(process.platform === "win32" ? "node.exe" : "node");
  expect(fixture.runs).toContain(process.platform === "win32" ? "bun.exe" : "bun");
  expect(fixture.writes).toEqual([]);
});

test("the live payload keeps only documented numbers and never invents cached or current-context tokens", () => {
  expect(liveReport(state(), "t1")).toEqual({
    session: "11111111-2222-4333-8444-555555555555", terminal: "t1", model: "Gemini Model",
    percent: 14.24, total: 1048576, input: 88244, output: 61074, cost: 0.4213, estimated: true,
  });
  expect(liveReport(state({ context_window: { current_usage: null, total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 } }), "t1")).toMatchObject({
    input: undefined, output: undefined, percent: undefined, cost: undefined,
  });
});

// Only the hc boundary is replaced. The installed script, JSON stdin, title command and
// platform shell all run in real child processes, with no connection to a person's core.
function callback(fixture: ReturnType<typeof installation>, payload: unknown, terminal: string | null, configured = false, cwd?: string, path = process.env.PATH) {
  const trace = join(fixture.home, "hc.json");
  const preload = join(fixture.home, "hc-fixture.cjs");
  writeFileSync(preload, `const cp = require('node:child_process'); const real = cp.spawnSync;
cp.spawnSync = (program, args, options) => {
  if (args?.[0] === 'label') { require('node:fs').writeFileSync(${JSON.stringify(trace)}, JSON.stringify(args)); return { status: 0 }; }
  return real(program, args, options);
};`);
  const script = fixture.home + "/.kavex/antigravity/title.cjs";
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: fixture.home, USERPROFILE: fixture.home, HC_TERMINAL_ID: terminal ?? "", NODE_OPTIONS: "--require " + JSON.stringify(preload) };
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  env.PATH = path;
  // Bun does not implement NODE_OPTIONS --require, so explicitly preload for both runtimes.
  const command = JSON.parse(readFileSync(fixture.path, "utf8")).title.command;
  const reply = configured
    ? spawnSync(command, { shell: true, cwd, env, input: JSON.stringify(payload), encoding: "utf8", windowsHide: true })
    : spawnSync(process.execPath, ["--require", preload, script], { env, input: JSON.stringify(payload), encoding: "utf8", windowsHide: true });
  expect(reply.status).toBe(0);
  expect(reply.stderr).toBe("");
  return { stdout: reply.stdout, labels: existsSync(trace) ? JSON.parse(readFileSync(trace, "utf8")) : [] };
}

test("the installed bridge forwards title stdin and output while reporting a sanitized terminal label", async () => {
  const fixture = installation();
  const titleScript = join(fixture.home, "original.cjs");
  writeFileSync(titleScript, "const s=JSON.parse(require('node:fs').readFileSync(0,'utf8')); process.stdout.write('Own title: ' + s.model.display_name);");
  const command = process.platform === "win32" ? `\"${process.execPath}\" \"${titleScript}\"` : `'${process.execPath}' '${titleScript}'`;
  mkdirSync(dirname(fixture.path), { recursive: true });
  writeFileSync(fixture.path, JSON.stringify({ title: { command } }));
  expect(await antigravity.install?.(fixture.files, fixture.machine)).toBe(true);
  const result = callback(fixture, state(), "t9");
  expect(result.stdout).toBe("Own title: Gemini Model");
  expect(result.labels.slice(0, 2)).toEqual(["label", "t9"]);
  const label = result.labels[2];
  expect(label).not.toMatch(/private|quota|current_usage|transcript/);
  const located = antigravity.locate({ term: { address: "remote/t9" }, label: label.slice("kavex.session=".length) });
  expect(located?.result).toMatchObject({ context: { percent: 14.24 }, cost: 0.4213 });
});

test("outside Kavex the title still works but the bridge never contacts hc", async () => {
  const fixture = installation('{"title":{"command":"echo Existing title"}}');
  expect(await antigravity.install?.(fixture.files, fixture.machine)).toBe(true);
  const result = callback(fixture, state(), null);
  expect(result.stdout.trim()).toBe("Existing title");
  expect(result.labels).toEqual([]);
});

test.skipIf(!Bun.which("node"))("the configured command works through the real platform shell and Node.js", async () => {
  const fixture = installation('{"title":{"command":"echo User title"}}', true, Bun.which("node")!);
  expect(await antigravity.install?.(fixture.files, fixture.machine)).toBe(true);
  const result = callback(fixture, state(), "t3", true);
  expect(result.stdout.trim()).toBe("User title");
  expect(result.labels.slice(0, 2)).toEqual(["label", "t3"]);
});

test("a callback before the next conversation exists clears the previous session label", async () => {
  const fixture = installation();
  expect(await antigravity.install?.(fixture.files, fixture.machine)).toBe(true);
  const result = callback(fixture, state({ conversation_id: "" }), "t1");
  expect(antigravity.locate({ term: { address: "t1" }, label: result.labels[2].slice("kavex.session=".length) })).toEqual({
    id: null, result: { state: "empty", say: "No usage yet" },
  });
});

test("a payload without session identity leaves the terminal's current label alone", async () => {
  const fixture = installation();
  expect(await antigravity.install?.(fixture.files, fixture.machine)).toBe(true);
  expect(callback(fixture, state({ conversation_id: undefined }), "t1").labels).toEqual([]);
});

test("settings changed during installation are never replaced", async () => {
  const fixture = installation('{"model":"before"}');
  const write = fixture.files.write;
  fixture.files.write = async (path, text, expected) => {
    if (path === fixture.path) writeFileSync(path, '{"model":"edited by user"}');
    await write(path, text, expected);
  };
  await expect(antigravity.install(fixture.files, fixture.machine)).rejects.toThrow("changed");
  expect(readFileSync(fixture.path, "utf8")).toBe('{"model":"edited by user"}');
});

test("an existing title command beginning with tilde retains its arguments", async () => {
  const fixture = installation('{"title":{"command":"~/.title.cmd kept"}}');
  const script = join(fixture.home, ".title.cmd");
  writeFileSync(script, process.platform === "win32" ? "@echo off\r\n@echo Title argument: %~1\r\n" : '#!/bin/sh\nprintf "Title argument: %s\\n" "$1"\n');
  chmodSync(script, 0o755);
  expect(await antigravity.install?.(fixture.files, fixture.machine)).toBe(true);
  expect(callback(fixture, state(), "t1").stdout.trim()).toBe("Title argument: kept");
});

test("tilde expansion preserves adjacent shell operators in an existing title command", async () => {
  const fixture = installation('{"title":{"command":"~/.title.cmd&echo Second"}}');
  const script = join(fixture.home, ".title.cmd");
  writeFileSync(script, process.platform === "win32" ? "@echo off\r\n@echo First\r\n" : '#!/bin/sh\nprintf "First\\n"\n');
  chmodSync(script, 0o755);
  expect(await antigravity.install?.(fixture.files, fixture.machine)).toBe(true);
  const words = callback(fixture, state(), "t1").stdout.trim().split(/\s+/).sort();
  expect(words).toEqual(["First", "Second"]);
});

test.skipIf(!Bun.which("node"))("runtime upgrades do not leave the bridge pointing at an old binary", async () => {
  const fixture = installation('{"title":{"command":"echo Active runtime"}}');
  const removed = join(fixture.home, process.platform === "win32" ? "removed-node.exe" : "removed-node");
  fixture.machine.run = async () => ({ code: 0, stdout: JSON.stringify(["24.0.0", removed]), stderr: "" });
  expect(await antigravity.install(fixture.files, fixture.machine)).toBe(true);
  expect(callback(fixture, state(), "t1", true).stdout.trim()).toBe("Active runtime");
});

test.skipIf(process.platform !== "win32" || !Bun.which("node"))("a workspace runtime cannot shadow the verified Windows PATH runtime", async () => {
  const fixture = installation('{"title":{"command":"echo Trusted runtime"}}', true, Bun.which("node")!);
  const project = join(fixture.home, "project");
  mkdirSync(project);
  writeFileSync(join(project, "node.exe"), "not a runtime");
  writeFileSync(join(project, "node.cmd"), "@echo Unsafe runtime\r\n");
  expect(await antigravity.install(fixture.files, fixture.machine)).toBe(true);
  expect(callback(fixture, state(), "t1", true, project).stdout.trim()).toBe("Trusted runtime");
});

test.skipIf(process.platform !== "win32" || !Bun.which("node"))("an accepted Windows runtime shim also works when no native runtime is in PATH", async () => {
  const fixture = installation('{"title":{"command":"echo Shim runtime"}}');
  const bin = join(fixture.home, "shim-bin");
  mkdirSync(bin);
  const node = Bun.which("node")!;
  writeFileSync(join(bin, "node.cmd"), `@echo off\r\n\"${node}\" %*\r\n`);
  fixture.machine.run = async (program) => program === "node" || program === "node.cmd"
    ? { code: 0, stdout: JSON.stringify(["24.0.0", node]), stderr: "" }
    : { code: 127, stdout: "", stderr: "" };
  expect(await antigravity.install(fixture.files, fixture.machine)).toBe(true);
  expect(callback(fixture, state(), "t1", true, fixture.home, bin).stdout.trim()).toBe("Shim runtime");
});
