// herdr-core already runs commands on added machines. Use the same provider
// module there so tokens and quota HTTP traffic stay on the execution owner.
import { Buffer } from "buffer";
import { appHome, readTextFile } from "herdr";
import { inShell, posixWords, powershellWord } from "./provider-host.js";

const files = new Map();

async function sourceFile(module) {
  if (!files.has(module)) {
    const read = readTextFile(`${appHome()}/mods/workspace-chrome/${module}`);
    files.set(module, read);
    read.catch(() => files.delete(module));
  }
  return files.get(module);
}

// This code runs with Node or Bun on the execution owner. Arguments contain
// public adapter source, executable names and the allowlist, never credentials.
const WORKER = String.raw`
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, platform } from "node:os";
const execFileAsync = promisify(execFile);
const stop = setTimeout(() => process.exit(124), 27000);
stop.unref();

function fixedResult(error) {
  return { state: "error", error, limits: [] };
}

async function execute(program, args = [], env = {}, timeout = 6000) {
  try {
    const result = await execFileAsync(program, args, { env: { ...process.env, ...env }, timeout, maxBuffer: 512000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function read(path) {
  try {
    const value = await readFile(path);
    if (value.length > 1024 * 1024) throw new Error("usage input over limit");
    return value.toString("utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

async function request(input, options = {}) {
  let url = new URL(input);
  const redirects = [301, 302, 303, 307, 308];
  const deadline = AbortSignal.timeout(Math.min(20000, options.timeoutMs ?? 15000));
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (url.protocol !== "https:" || !config.hosts.includes(url.hostname) || url.username || url.password) {
      throw new Error("invalid usage origin");
    }
    const result = await fetch(url, { ...options, signal: deadline, redirect: "manual" });
    if (!redirects.includes(result.status)) return result;
    const location = result.headers.get("location");
    await result.body?.cancel();
    if (!location) throw new Error("usage redirect without location");
    const next = new URL(location, url);
    if (next.origin !== url.origin || (options.method && options.method !== "GET")) throw new Error("untrusted usage redirect");
    url = next;
  }
  throw new Error("usage redirect limit");
}

try {
  if (typeof fetch !== "function") throw new Error("runtime unavailable");
  const source = config.path ? await read(config.path) : config.source;
  if (!source) throw new Error("missing usage source");
  const module = await import("data:text/javascript;base64," + Buffer.from(source, "utf8").toString("base64"));
  const probe = config.export === "networkProviders" ? module.networkProviders[config.key]?.read : module[config.export];
  if (typeof probe !== "function") throw new Error("missing usage adapter");
  const reading = await probe({
    run: (args, env, options) => execute(options?.program ?? config.program, args, env, options?.timeoutMs),
    exec: execute,
    locate: async (program = config.program) => {
      const result = await execute("sh", ["-c", 'command -v "$1"', "sh", program]);
      return result.code === 0 ? result.stdout.trim() || null : null;
    },
    read,
    env: (key) => process.env[key] ?? null,
    request,
    now: Date.now,
    home: homedir(),
    platform: platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : "linux",
    target: config.target,
  });
  process.stdout.write("kavex-usage:" + JSON.stringify(reading) + "\n");
} catch {
  process.stdout.write("kavex-usage:" + JSON.stringify(fixedResult("The provider could not be checked on this machine.")) + "\n");
} finally {
  clearTimeout(stop);
}
`;

function ownerFailure(missing) {
  const error = missing ? "This machine needs Node.js 18 or Bun for account usage." : "The provider could not be checked on this machine.";
  return { state: "error", limits: [], error };
}

export async function readOnOwner(where, key, provider, allowed) {
  const remote = Boolean(where.on);
  try {
    const source = remote ? await sourceFile(provider.ownerModule) : null;
    if ((remote && !source) || !allowed()) return ownerFailure(false);
    const path = !remote ? `${appHome()}/mods/workspace-chrome/${provider.ownerModule}` : null;
    const prefix = "const config = " + JSON.stringify({
      path, source, key, program: where.program, target: where.on, hosts: provider.hosts, export: provider.ownerExport,
    }) + ";\n";
    const worker = prefix + WORKER;
    const posix = `if command -v node >/dev/null 2>&1 && node -e 'process.exit(typeof fetch === "function" ? 0 : 1)'; then exec node --input-type=module -e ${posixWords([worker])}; elif command -v bun >/dev/null 2>&1; then exec bun -e ${posixWords([worker])}; else exit 126; fi`;
    // PowerShell 5.1 rewrites embedded quotes in native command arguments.
    // A data URL is quote-free and carries only the public worker program.
    const data = "data:text/javascript;base64," + Buffer.from(worker, "utf8").toString("base64");
    const powershell = `
if (Get-Command node -ErrorAction SilentlyContinue) {
  & node -e 'process.exit(globalThis.fetch ? 0 : 1)'
  if ($LASTEXITCODE -eq 0) { & node --input-type=module -e 'await import(process.argv[1])' ${powershellWord(data)}; exit $LASTEXITCODE }
}
if (Get-Command bun -ErrorAction SilentlyContinue) { & bun -e 'await import(process.argv[1])' ${powershellWord(data)}; exit $LASTEXITCODE }
exit 126`;
    const result = await inShell(where, posix, powershell);
    const line = result.stdout.split(/\r?\n/).find((line) => line.startsWith("kavex-usage:"));
    if (line) return JSON.parse(line.slice("kavex-usage:".length));
    if (remote) return ownerFailure(result.code === 126);
    // Desktop can use its built-in network host without an external runtime.
    return undefined;
  } catch {
    return remote ? ownerFailure(false) : undefined;
  }
}
