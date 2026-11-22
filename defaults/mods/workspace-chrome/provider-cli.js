import { readCopilot } from "./copilot-probe.js";

// Antigravity and Muse use their own CLI for credentials and subscription usage.
const AGY_ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: "true" };
const AGY_USAGE = ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"];
const MUSE_ENV = { MUSE_NO_AUTO_UPDATE: "1", MUSE_LOGIN: "0", MUSE_LAUNCHER_INSTALL: "0" };
const MUSE_VERSION = /^(\d+)\.(\d+)\.(\d+)-R\d+(?:\.\d+)?$/;
const FIVE_HOURS = 300;
const WEEK = 10_080;

const unsupportedAgy = new Set();

function unavailable(error) {
  return { limits: [], state: "unavailable", error };
}

function failed(error) {
  return { limits: [], state: "error", error };
}

function versionAtLeast(parts, minimum, acceptsEqual = true) {
  for (let index = 0; index < minimum.length; index++) {
    const version = Number(parts[index]);
    if (version !== minimum[index]) return version > minimum[index];
  }
  return acceptsEqual;
}

function agySupportsUsage(output) {
  const version = output.match(/(?<![\w.-])v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?![\w+-]|\.\w)/);
  return version !== null && versionAtLeast(version.slice(1, 4), [1, 1, 11], !version[4]);
}

function jsonLines(output, marker = "") {
  const frames = [];
  for (const line of output.split("\n")) {
    const index = line.indexOf(marker);
    if (index < 0) continue;
    const payload = line.slice(index + marker.length).trim();
    if (!payload.startsWith("{")) continue;
    try { frames.push(JSON.parse(payload)); } catch {}
  }
  return frames;
}

function agyLimits(frame) {
  if (frame.status !== "SUCCESS" || frame.command?.name !== "usage") return null;
  const groups = frame.command.data?.groups;
  if (!Array.isArray(groups)) return null;
  const limits = [];
  for (const group of groups) {
    if (typeof group?.name !== "string" || !group.name || !Array.isArray(group.buckets)) continue;
    const enabled = group.buckets.filter((bucket) => bucket && bucket.disabled !== true);
    for (const bucket of enabled) {
      if (typeof bucket.id !== "string" || !bucket.id || !Number.isFinite(bucket.remaining_fraction)) continue;
      const windowName = typeof bucket.name === "string" ? bucket.name.replace(/\s*limit remaining$/i, "").trim() : "";
      const resetsAt = typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : NaN;
      const minutes = bucket.window === "weekly" ? WEEK : bucket.window === "5h" ? FIVE_HOURS : 0;
      const used = Math.max(0, Math.min(100, Math.round((1 - bucket.remaining_fraction) * 100)));
      limits.push({
        key: bucket.id,
        label: enabled.length > 1 && windowName ? group.name + " · " + windowName : group.name,
        used,
        resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
        minutes,
        scoped: true,
      });
    }
  }
  return groups.length && !limits.length ? null : limits;
}

function agyFailure(output) {
  for (const frame of jsonLines(output, "AGY_ERROR:")) {
    if (frame.status === "UNAUTHENTICATED" || frame.error_code === 401) return null;
    if (frame.status === "PERMISSION_DENIED" || frame.error_code === 403) return failed("This account has no Antigravity quota.");
    if (frame.status === "RESOURCE_EXHAUSTED" || frame.error_code === 429) return failed("Antigravity is rate-limiting this account.");
    if (frame.error_code >= 500 && frame.error_code < 600) return failed("Antigravity could not load quota.");
  }
  if (/\b(?:not (?:logged|signed) in|not[- ]authenticated|unauthenticated|run agy login|please (?:sign|log) in|sign in to antigravity|no credentials|authentication required)\b/i.test(output)) return null;
  return failed("Antigravity did not return a recognized quota response.");
}

async function readAntigravity({ run, target = null }) {
  const upgrade = "Update agy to 1.1.11 or newer to view usage.";
  const unsupported = "This version of agy ran a model turn for /usage. Update agy and restart Kavex.";
  if (unsupportedAgy.has(target)) return unavailable(unsupported);
  // Older agy builds send /usage as a billed prompt. Recheck the live binary before every request.
  const version = await run(["--version"], AGY_ENV, { timeoutMs: 5000 });
  if (version.code !== 0 || !agySupportsUsage(version.stdout.trim() || version.stderr)) return unavailable(upgrade);

  const reply = await run(AGY_USAGE, AGY_ENV, { timeoutMs: 30_000 });
  const frames = jsonLines(reply.stdout);
  for (const frame of frames) {
    const limits = agyLimits(frame);
    if (limits) return limits.length ? { limits } : unavailable("Antigravity reported no quota for this account.");
  }
  if (reply.code !== 0 && reply.stderr.includes("Authentication required. Please visit the URL")) {
    // The CLI opened sign-in. The service should only retry when explicitly refreshed.
    return { ...unavailable("Sign in with agy, then refresh usage."), retryAt: Number.MAX_SAFE_INTEGER };
  }
  if (frames.some((frame) => frame.num_turns > 0 || (typeof frame.conversation_id === "string" && frame.conversation_id.length > 0))) {
    unsupportedAgy.add(target);
    return unavailable(unsupported);
  }
  return agyFailure(reply.stdout + "\n" + reply.stderr);
}

async function museVersion(path, read) {
  try {
    const version = (await read(path))?.trim();
    return MUSE_VERSION.test(version) ? version : null;
  } catch {
    return null;
  }
}

async function museInstall({ locate, read, platform }) {
  const launcher = await locate?.();
  if (typeof launcher !== "string" || !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(launcher)) return {};
  const dir = launcher.slice(0, Math.max(launcher.lastIndexOf("/"), launcher.lastIndexOf("\\")) + 1);
  const versionFile = dir + ".muse-version";
  const version = await museVersion(versionFile, read);
  if (!version) return {};
  const binary = dir + "muse-bin-" + version;
  const program = await locate(binary) || (platform === "windows" ? await locate(binary + ".exe") : null);
  return { versionFile, version, program };
}

function museHelpSupportsUsage(output) {
  const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const commands = clean.split(/^Commands:[ \t]*\r?$/m)[1]?.split(/^\S/m)[0];
  return commands !== undefined && /^[ \t]+usage(?:[ \t]{2,}|[ \t]*\r?$)/m.test(commands);
}

function museWindow(value, key, label, minutes) {
  if (value == null) return null;
  if (!Number.isFinite(value.usedPercent) || value.usedPercent < 0) return undefined;
  const resetsAt = value.resetsAtMs ?? null;
  if (resetsAt !== null && (!Number.isFinite(resetsAt) || resetsAt <= 0)) return undefined;
  return { key, label, minutes, resetsAt, used: Math.min(100, value.usedPercent) };
}

function decodeMuseUsage(output) {
  try {
    const payload = JSON.parse(output.trim());
    if (payload?.schemaVersion !== 1 || !("allowance" in payload)) return null;
    const data = payload.allowance;
    if (data === null) return { reason: payload.reason };
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const session = museWindow(data.window, "session", "5 hours", FIVE_HOURS);
    const weekly = museWindow(data.weekly, "weekly", "This week", WEEK);
    if (session === undefined || weekly === undefined) return null;
    const limits = [session, weekly].filter(Boolean);
    return limits.length ? { limits, ...(typeof data.tier === "string" && data.tier ? { plan: data.tier } : {}) } : { reason: payload.reason };
  } catch {
    return null;
  }
}

async function readMuse(context) {
  const { run, read } = context;
  const upgrade = "Update Muse to 1.4.13 or newer to view usage.";
  const { version, versionFile, program } = await museInstall(context);
  if (version) {
    if (!versionAtLeast(MUSE_VERSION.exec(version).slice(1, 4), [1, 4, 13])) return unavailable(upgrade);
  } else {
    // On launchers without an active version file, help is the only safe capability check.
    const help = await run(["--help"], MUSE_ENV, { timeoutMs: 2000 });
    if (help.code !== 0) return failed("Muse did not answer --help.");
    if (!museHelpSupportsUsage(help.stdout)) return unavailable(upgrade);
  }
  const reply = await run(["usage", "--json"], MUSE_ENV, { timeoutMs: 6000, ...(program ? { program } : {}) });
  if (versionFile && (await museVersion(versionFile, read)) !== version) return failed("Muse updated during the refresh. Try again.");
  if (reply.code !== 0) {
    if (/\bnot (?:logged|signed) in\b/i.test(reply.stdout + "\n" + reply.stderr)) return null;
    return failed("Muse could not load the subscription allowance.");
  }
  const reading = decodeMuseUsage(reply.stdout);
  if (!reading) return failed("Muse did not return a recognized usage response.");
  if (reading.limits) return reading;
  if (reading.reason === "api_key") return unavailable("Muse is signed in with an API key.");
  if (reading.reason === "no_allowance") return unavailable("This Muse account has no subscription allowance.");
  return unavailable("Muse did not report a subscription allowance.");
}

const AMP_ENV = { AMP_SKIP_UPDATE_CHECK: "1" };
const MONTH = 43_200;

function ampLimit(key, label, remaining, minutes, resetDescription) {
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100) return null;
  return {
    key, label, used: Math.round(100 - remaining), resetsAt: null,
    ...(minutes ? { minutes } : {}),
    ...(resetDescription ? { resetDescription } : {}),
  };
}

const dollars = (value) => Number(value.replaceAll(",", ""));

function readAmpUsage(output) {
  const limits = [], balances = [];
  let identity, plan;
  for (const line of output.split(/\r?\n/).map((line) => line.trim())) {
    const account = /^Signed in as ([^\s@]+@[^\s@]+)(?:\s*\(|$)/i.exec(line);
    if (account) identity = account[1].toLowerCase();
    // Amp prints approximate renewal text. Keep it verbatim in meaning without deriving an exact timestamp.
    const subscription = /^Subscription ([^:]{1,80}):\s+(\d+(?:\.\d+)?)%\s+other usage and\s+(\d+(?:\.\d+)?)%\s+orb usage remaining(?:\s+-\s+resets upon renewal in\s+([0-9]+ (?:day|hour|minute)s?))?\s*$/i.exec(line);
    if (subscription) {
      const [, name, agent, orb, interval] = subscription;
      const renewal = interval && "Renewal in " + interval;
      const agentLimit = ampLimit("agent", "Other usage", Number(agent), MONTH, renewal);
      const orbLimit = ampLimit("orb", "Orb usage", Number(orb), MONTH, renewal);
      if (!agentLimit || !orbLimit) return failed("Amp returned an invalid subscription reading.");
      plan = name.trim();
      limits.push(agentLimit, orbLimit);
      continue;
    }
    const free = /^(Amp Free):\s+(\d+(?:\.\d+)?)%\s+remaining\b(?:\s+-\s+(resets [\w: ]{1,45}))?/i.exec(line);
    if (free) {
      const limit = ampLimit("free", free[1], Number(free[2]), 1440, free[3]);
      if (limit) limits.push(limit);
      continue;
    }
    const money = /^([^:]{1,80}):\s+\$((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:\s*\/\s*\$((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?))?\s+remaining\b/i.exec(line);
    if (!money) continue;
    const [, label, rest, cap] = money;
    const amount = dollars(rest);
    if (!Number.isFinite(amount)) continue;
    if (cap) {
      const limit = ampLimit(label, label, 100 * amount / dollars(cap));
      if (limit) limits.push(limit);
    } else {
      balances.push({ label, amount, currency: "USD" });
    }
  }
  if (!limits.length && !balances.length) return failed("Amp did not return a recognized usage reading.");
  return {
    limits,
    ...(balances.length ? { balances } : {}),
    ...(identity ? { identity } : {}),
    ...(plan ? { plan } : {}),
  };
}

async function readAmp({ run }) {
  const result = await run(["usage", "--no-color"], AMP_ENV, { timeoutMs: 8000 });
  if (/\b(?:not (?:logged|signed) in|run amp login)\b/i.test(result.stdout + "\n" + result.stderr)) return null;
  if (result.code !== 0) return failed("Amp could not read account usage.");
  return readAmpUsage(result.stdout);
}

export const cliProviders = {
  amp: { program: "amp", read: readAmp },
  antigravity: { program: "agy", read: readAntigravity },
  copilot: { program: "copilot", read: readCopilot },
  muse: { program: "muse", name: "Muse", read: readMuse },
};
