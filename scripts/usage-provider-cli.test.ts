import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCopilot } from "../defaults/mods/usage/copilot-probe.js";
import { cliProviders } from "../defaults/mods/usage/provider-cli.js";

type Reply = { stdout?: string; stderr?: string; code?: number };

const when = "2027-01-01T10:00:00Z";
const date = Date.parse(when);
const probe = (replies: Reply[], context = {}) => {
  const calls: { args: string[]; env: Record<string, string>; options?: { timeoutMs?: number; program?: string } }[] = [];
  return {
    calls,
    context: {
      now: () => date - 3600_000,
      read: async () => null,
      platform: "macos",
      async run(args: string[], env: Record<string, string>, options?: { timeoutMs?: number; program?: string }) {
        calls.push({ args, env, options });
        const reply = replies.shift();
        if (!reply) throw new Error("unexpected probe");
        return { code: 0, stdout: "", stderr: "", ...reply };
      },
      ...context,
    },
  };
};

const agyVersion = { stdout: "Antigravity CLI 1.4.2\n" };
const agyQuota = JSON.stringify({
  status: "SUCCESS",
  command: {
    name: "usage",
    data: { groups: [{
      name: "Gemini",
      buckets: [
        { id: "gemini-weekly", window: "weekly", name: "Weekly Limit Remaining", remaining_fraction: 0.73, reset_time: when },
        { id: "gemini-5h", window: "5h", name: "5h Limit Remaining", remaining_fraction: 0, reset_time: when },
        { id: "unmetered", name: "Unlimited", remaining_fraction: 1, disabled: true },
      ],
    }] },
  },
});

test("Antigravity requests the upstream quota command and reports named, metered windows", async () => {
  const { calls, context } = probe([agyVersion, { stdout: "login PATH diagnostic\n" + agyQuota }]);
  const reading = await cliProviders.antigravity.read(context);
  expect(calls).toEqual([
    { args: ["--version"], env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, options: { timeoutMs: 5000 } },
    { args: ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"], env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, options: { timeoutMs: 30000 } },
  ]);
  expect(reading?.limits).toEqual([
    { key: "gemini-weekly", label: "Gemini · Weekly", used: 27, resetsAt: date, minutes: 10080, scoped: true },
    { key: "gemini-5h", label: "Gemini · 5h", used: 100, resetsAt: date, minutes: 300, scoped: true },
  ]);
});

test("Antigravity does not launch usage on versions that may bill it as a prompt", async () => {
  for (const version of ["1.1.10", "1.1.11-beta.1", "1.1.11.5", "unknown"]) {
    const { calls, context } = probe([{ stdout: version }]);
    expect(await cliProviders.antigravity.read(context)).toMatchObject({ state: "unavailable", limits: [] });
    expect(calls.map((call) => call.args)).toEqual([["--version"]]);
  }
});

test("Antigravity stops polling only the target that executed a model turn", async () => {
  const first = probe([agyVersion, { stdout: JSON.stringify({ status: "SUCCESS", num_turns: 1 }) }], { target: "billed-agent-fixture" });
  expect(await cliProviders.antigravity.read(first.context)).toMatchObject({ state: "unavailable" });
  const second = probe([], { target: "billed-agent-fixture" });
  expect(await cliProviders.antigravity.read(second.context)).toMatchObject({ state: "unavailable" });
  expect(second.calls).toHaveLength(0);
  const other = probe([agyVersion, { stdout: agyQuota }], { target: "other-agent-fixture" });
  expect((await cliProviders.antigravity.read(other.context))?.limits).toHaveLength(2);
});

test("Antigravity holds unattended retries after the CLI opens sign-in", async () => {
  const { context } = probe([agyVersion, { code: 1, stderr: "Authentication required. Please visit the URL" }]);
  expect(await cliProviders.antigravity.read(context)).toMatchObject({
    state: "unavailable",
    limits: [],
    retryAt: Number.MAX_SAFE_INTEGER,
  });
});

const help = { stdout: "Usage: muse [command]\n\nCommands:\n  usage     Read quota\n\nOptions:\n  --help\n" };
const museQuota = { stdout: JSON.stringify({
  schemaVersion: 1,
  allowance: { tier: "Plus", window: { usedPercent: 120, resetsAtMs: date }, weekly: { usedPercent: 15 } },
}) };
const museEnv = { MUSE_NO_AUTO_UPDATE: "1", MUSE_LOGIN: "0", MUSE_LAUNCHER_INSTALL: "0" };

test("Muse verifies the usage command and parses provider measurements", async () => {
  const { calls, context } = probe([help, museQuota]);
  expect(await cliProviders.muse.read(context)).toEqual({
    plan: "Plus",
    limits: [
      { key: "session", label: "5 hours", used: 100, resetsAt: date, minutes: 300 },
      { key: "weekly", label: "This week", used: 15, resetsAt: null, minutes: 10080 },
    ],
  });
  expect(calls).toEqual([
    { args: ["--help"], env: museEnv, options: { timeoutMs: 2000 } },
    { args: ["usage", "--json"], env: museEnv, options: { timeoutMs: 6000 } },
  ]);
});

test("Muse does not attempt usage when help lacks the command", async () => {
  const { calls, context } = probe([{ stdout: "Commands:\n  run     Run a model\n\nOptions:\n  usage     A flag help detail\n" }]);
  expect(await cliProviders.muse.read(context)).toMatchObject({ state: "unavailable", limits: [] });
  expect(calls.map((call) => call.args)).toEqual([["--help"]]);
});

test("Muse resolves the versioned Windows binary and discards a reading if its active build changes", async () => {
  const launcher = "C:\\Tools\\Muse\\muse.exe";
  const pinned = "C:\\Tools\\Muse\\.muse-version";
  const binary = "C:\\Tools\\Muse\\muse-bin-1.4.14-R7309.1";
  const paths: string[] = [];
  const builds = ["1.4.14-R7309.1\n", "1.4.15-R7309.2\n"];
  const { calls, context } = probe([museQuota], {
    platform: "windows",
    locate: async (name?: string) => name ?? launcher,
    read: async (path: string) => { paths.push(path); return builds.shift() ?? null; },
  });
  expect(await cliProviders.muse.read(context)).toMatchObject({ state: "error", limits: [] });
  expect(paths).toEqual([pinned, pinned]);
  expect(calls).toEqual([
    { args: ["usage", "--json"], env: museEnv, options: { program: binary, timeoutMs: 6000 } },
  ]);
});

test("Muse does not equate API-key billing or malformed numbers with zero use", async () => {
  const key = probe([help, { stdout: '{"schemaVersion":1,"allowance":null,"reason":"api_key"}' }]);
  expect(await cliProviders.muse.read(key.context)).toMatchObject({ state: "unavailable", limits: [] });
  const bad = probe([help, { stdout: '{"schemaVersion":1,"allowance":{"weekly":{"usedPercent":-1}}}' }]);
  expect(await cliProviders.muse.read(bad.context)).toMatchObject({ state: "error", limits: [] });
});

test("Amp reads subscription usage and Orb usage from its first-party CLI", async () => {
  const { calls, context } = probe([{ stdout: [
    "Signed in as example@example.test (fixture)",
    "Subscription Megawatt: 97% other usage and 100% orb usage remaining - resets upon renewal in 29 days",
  ].join("\n") }]);
  expect(await cliProviders.amp.read(context)).toMatchObject({
    plan: "Megawatt",
    identity: "example@example.test",
    limits: [
      { key: "agent", label: "Other usage", used: 3, minutes: 43_200, resetsAt: null, resetDescription: "Renewal in 29 days" },
      { key: "orb", label: "Orb usage", used: 0, minutes: 43_200, resetsAt: null, resetDescription: "Renewal in 29 days" },
    ],
  });
  expect(calls).toEqual([
    { args: ["usage", "--no-color"], env: { AMP_SKIP_UPDATE_CHECK: "1" }, options: { timeoutMs: 8000 } },
  ]);
});

test("Amp treats caps and uncapped balances as different types of data", async () => {
  const { context } = probe([{ stdout: [
    "Amp Free: $17.59/$20 remaining (replenishes +$0.83/hour)",
    "Individual credits: $0 remaining - https://ampcode.com/settings",
    "Workspace sample: $12.50 remaining",
  ].join("\n") }]);
  const reading = await cliProviders.amp.read(context);
  expect(reading?.limits).toEqual([{ key: "Amp Free", label: "Amp Free", used: 12, resetsAt: null }]);
  expect(reading?.balances).toEqual([
    { label: "Individual credits", amount: 0, currency: "USD" },
    { label: "Workspace sample", amount: 12.50, currency: "USD" },
  ]);
});

test("Amp leaves unavailable and malformed readings out of its meters", async () => {
  const signedOut = probe([{ code: 1, stderr: "Not signed in. Run amp login to continue." }]);
  expect(await cliProviders.amp.read(signedOut.context)).toBeNull();
  const malformed = probe([{ stdout: "Subscription Gigawatt: 101% other usage and 100% orb usage remaining" }]);
  expect(await cliProviders.amp.read(malformed.context)).toMatchObject({ state: "error", limits: [] });
});

const copilotServer = String.raw`
if (JSON.stringify(process.argv.slice(2)) !== '["--headless","--no-auto-update","--stdio"]') process.exit(1);
const legacy = process.env.KAVEX_QUOTA_FIXTURE === "legacy";
const trace = process.env.KAVEX_QUOTA_TRACE;
const { appendFileSync } = require("node:fs");
let buffer = Buffer.alloc(0), connected = false;
function frame(payload, split = false) {
  const json = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...payload }));
  const bytes = Buffer.concat([Buffer.from("Content-Length: " + json.length + "\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n"), json]);
  if (!split) return process.stdout.write(bytes);
  process.stdout.write(bytes.subarray(0, bytes.length - 8));
  setTimeout(() => {
    connected = true;
    process.stdout.write(bytes.subarray(bytes.length - 8));
  }, 200);
}
function reply(call) {
  if (call.method === "connect") {
    if (legacy) {
      frame({ id: call.id, error: { code: -32601, message: "Unhandled method connect" } });
    } else {
      frame({ method: "log", params: { id: call.id, result: {}, value: "Ångström 🐈" } });
      frame({ id: call.id, result: { protocolVersion: 3, text: "Ångström 🐈" } }, true);
    }
  } else if (call.method === "ping" && legacy) {
    frame({ id: call.id, result: { protocolVersion: 2 } }, true);
  } else if (call.method === "account.getQuota" && connected) {
    frame({ method: "notification", params: { id: call.id, result: {} } });
    frame({ id: call.id, result: { quotaSnapshots: {
      premium_interactions: { entitlementRequests: 150, remainingPercentage: 25, resetDate: "2027-01-01T10:00:00Z" },
      completions: { entitlementRequests: -1, isUnlimitedEntitlement: true, remainingPercentage: 0 },
      chat: { entitlementRequests: 0, remainingPercentage: 0 },
    } } });
  } else {
    process.exit(2);
  }
}
process.stdin.on("data", (chunk) => {
  if (trace) appendFileSync(trace, chunk);
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headers = buffer.indexOf("\r\n\r\n");
    if (headers < 0) return;
    const length = Number(/^Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headers).toString())?.[1]);
    if (!length) process.exit(3);
    const first = headers + 4;
    if (buffer.length < first + length) return;
    const call = JSON.parse(buffer.subarray(first, first + length).toString());
    buffer = buffer.subarray(first + length);
    reply(call);
  }
});
`;

async function wiredCopilot(legacy: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "kavex copilot fixture "));
  const windows = process.platform === "win32";
  const program = join(dir, windows ? "copilot.cmd" : "copilot");
  const source = join(dir, "copilot-fixture.js");
  const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  try {
    writeFileSync(source, copilotServer);
    if (windows) {
      writeFileSync(program, '@echo off\r\n"' + process.execPath + '" "%~dp0copilot-fixture.js" %*\r\n');
    } else {
      writeFileSync(program, "#!/bin/sh\nexec " + shellQuote(process.execPath) + " " + shellQuote(source) + ' "$@"\n');
      chmodSync(program, 0o755);
    }
    return await readCopilot({
      now: () => date - 3600_000,
      async runScript(posix: (exe: string) => string, powershell: (exe: string) => string) {
        const invoked = windows
          ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", powershell("'" + program.replaceAll("'", "''") + "'")]
          : ["sh", "-c", posix(shellQuote(program))];
        const child = Bun.spawn(invoked, { cwd: dir, env: { ...process.env, KAVEX_QUOTA_FIXTURE: legacy ? "legacy" : "current", KAVEX_QUOTA_TRACE: join(dir, "input.bin") }, stderr: "pipe", stdout: "pipe" });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        const trace = existsSync(join(dir, "input.bin")) ? readFileSync(join(dir, "input.bin")).toString("hex").slice(0, 96) : "none";
        expect(code, stderr + "\nFixture input bytes: " + trace).toBe(0);
        return { code, stdout, stderr };
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Copilot bounds the Content-Length handshake and ignores non-reply frames", async () => {
  expect(await wiredCopilot(false)).toEqual({ limits: [
    { key: "premium_interactions", label: "Premium interactions", used: 75, resetsAt: date },
  ] });
}, 30_000);

test("Copilot falls back to the legacy protocol ping before reading quota", async () => {
  expect((await wiredCopilot(true))?.limits).toHaveLength(1);
}, 30_000);

test("Copilot distinguishes signed-out and unsupported CLI replies", async () => {
  const reply = (code: number, message: string) => ({
    now: () => date,
    runScript: async () => ({
      code: 0, stdout: JSON.stringify({ id: 3, error: { code, message } }), stderr: "",
    }),
  });
  expect(await readCopilot(reply(-32603, "Not authenticated"))).toBeNull();
  expect(await readCopilot(reply(-32601, "Unhandled method account.getQuota"))).toMatchObject({ state: "unavailable" });
});
