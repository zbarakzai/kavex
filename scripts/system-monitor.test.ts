import { expect, test } from "bun:test";
import { parseLinux, parseMac, parseWindows, readSnapshot } from "../defaults/mods/system-monitor/collect.js";
import { measure } from "../defaults/mods/system-monitor/measure.js";

const app = { pid: 10, parent: 1, start: 1, cpu: 200, memory: 80 };
const shell = { pid: 20, parent: 1, start: 2, cpu: 300, memory: 20 };
const agent = { pid: 21, parent: 20, start: 3, cpu: 400, memory: 120 };
const helper = { pid: 22, parent: 21, start: 4, cpu: 500, memory: 40 };
const unrelated = { pid: 90, parent: 1, start: 5, cpu: 600, memory: 400 };
const records = [
  { address: "t1", pid: 20, state: "live", program: { agent: true, name: "Codex" } },
  { address: "t2", pid: 22, state: "live", report: { app: "claude-code" } },
  { address: "remote/t3", pid: 90, state: "live", program: { agent: true } },
  { address: "t4", pid: 90, state: "finished", program: { agent: true } },
];
function snapshot(rows: typeof app[], time: number, busy: number) {
  return { appPid: 10, processes: rows, capacity: time, cpu: { total: time, busy },
    memory: { total: 1000, available: 250 }, cores: 8 };
}

test("host and process CPU share an all-core scale; nested agent processes count once", () => {
  const before = snapshot([app, shell, agent, helper, unrelated], 1000, 500);
  const after = snapshot([
    { ...app, cpu: 240 }, { ...shell, cpu: 320 }, { ...agent, cpu: 460 },
    { ...helper, cpu: 520 }, { ...unrelated, cpu: 900 },
  ], 1400, 700);
  expect(measure(before, after, records)).toMatchObject({
    memory: { total: 1000, used: 750, available: 250, percent: 75 },
    cpu: 50, cores: 8,
    desktop: { memory: 80, cpu: 10 },
    agents: { memory: 180, cpu: 25 },
    sessions: [
      { address: "t1", name: "Codex", memory: 140, cpu: 20 },
      { address: "t2", name: "claude-code", memory: 40, cpu: 5 },
    ],
  });
});

test("initial and reused PID readings do not invent process CPU", () => {
  const before = snapshot([app, shell, agent], 1000, 500);
  const after = snapshot([app, shell, { ...agent, start: 30, cpu: 800 }], 1400, 700);
  expect(measure(null, before, records)).toMatchObject({ cpu: null, desktop: { memory: 80, cpu: null } });
  expect(measure(before, after, records).sessions[0]).toMatchObject({ memory: 140, cpu: 0 });
  expect(measure(before, after, records).sessions[1]).toMatchObject({ memory: null, cpu: null });
});

test("a recycled live terminal PID stays unavailable until the core reports a new owner", () => {
  const bindings = new Map();
  const first = snapshot([app, shell, agent], 1000, 500);
  const recycled = snapshot([app, { ...shell, start: 30 }, { ...agent, start: 31 }], 1400, 700);
  const terminal = { ...records[0], created_ms: 100 };
  expect(measure(null, first, [terminal], bindings).agents.memory).toBe(140);
  expect(measure(first, recycled, [terminal], bindings).agents.memory).toBeNull();
  expect(measure(recycled, recycled, [terminal], bindings).agents.memory).toBeNull();
  expect(measure(recycled, recycled, [{ ...terminal, created_ms: 200 }], bindings).agents.memory).toBe(140);
});

test("Linux uses MemAvailable and ignores guest ticks already included in user time", () => {
  const stat = "20 (not ) a delimiter) S 1 0 0 0 0 0 0 0 0 0 10 20 0 0 0 0 0 0 123 0 42";
  expect(parseLinux(`10 4096 8
cpu 40 1 10 100 9 2 2 6 7 1
MemTotal: 16000 kB
MemFree: 100 kB
MemAvailable: 6300 kB
--
${stat}
`)).toMatchObject({
    appPid: 10, cores: 8, capacity: 170, cpu: { total: 170, busy: 61 },
    memory: { total: 16384000, available: 6451200 },
    processes: [{ pid: 20, parent: 1, cpu: 30, start: 123, memory: 172032 }],
  });
});

test("macOS reads kernel CPU ticks and converts BSD process time", () => {
  expect(parseMac(`10 16384000 8
cpu-ticks ${Buffer.from(Uint32Array.of(40, 20, 100, 5).buffer).toString("base64")}
Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages wired down: 400.
Pages purgeable: 100.
Anonymous pages: 700.
Pages occupied by compressor: 250.
--
 10 1 250 1:02.34 Sun Nov 22 21:45:01 2026
`, 1000)).toMatchObject({
    appPid: 10, cores: 8, capacity: 8000, cpu: { total: 165, busy: 65 },
    memory: { total: 16384000, available: 11264000 },
    processes: [{ pid: 10, parent: 1, cpu: 62340, memory: 256000 }],
  });
  expect(parseMac("10 16384000 8\n 51 49 0\n 20 19 61\n", 1000).cpu).toEqual({ percent: 39 });
});

test("Windows reads raw CPU and working-set counters without rounding", () => {
  expect(parseWindows(JSON.stringify({
    appPid: 10, cores: 8, total: 8192, available: 1255, clock: 2000, processClock: 2100, idle: 1500,
    processes: [{ pid: 10, parent: 1, start: "2026-11-22T21:45:01Z", cpu: 45, memory: 64 }],
  }))).toMatchObject({
    appPid: 10, cores: 8, capacity: 16800, cpu: { total: 2000, busy: 500 },
    memory: { total: 8192, available: 1255 },
    processes: [{ pid: 10, parent: 1, cpu: 45, memory: 64 }],
  });
});

const native = { linux: "linux", darwin: "macos", win32: "windows" }[process.platform];
test.skipIf(!native)("the native collector identifies its app parent and returns live host readings", async () => {
  const exec = async (file: string, args: string[]) => {
    const child = Bun.spawn([file, ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
    if (code) throw new Error(stderr || `Collector exited ${code}`);
    return { code, stdout, stderr };
  };
  const before = await readSnapshot(native, exec);
  await Bun.sleep(110);
  const after = await readSnapshot(native, exec);
  const current = measure(before, after, []);
  if (native === "macos") expect(before.cpu).toMatchObject({ total: expect.any(Number), busy: expect.any(Number) });
  expect(after.appPid).toBe(process.pid);
  expect(after.cores).toBeGreaterThan(0);
  expect(current.memory.used).toBeGreaterThan(0);
  expect(current.cpu).toBeGreaterThanOrEqual(0);
  expect(current.cpu).toBeLessThanOrEqual(100);
  expect(current.desktop.memory).toBeGreaterThan(0);
  expect(current.desktop.cpu).toBeGreaterThanOrEqual(0);
}, 20000);
