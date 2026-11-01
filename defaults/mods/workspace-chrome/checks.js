// What each subscription has used, as its agent reports it. Claude Code and Codex are asked through
// their own commands, on the machine they're signed in on, so their logins never reach Zaki
// (docs/adr/0001-usage-through-agents-own-commands.md). OpenCode has no such command: only with the
// person's consent, its key goes to opencode.ai and nowhere else.
//
// The footer runs the checks and the popover shows them, so each keeps a copy, as mods can't import
// each other's files; scripts/look.test.ts keeps them equal.

import { createHash } from "crypto";
import { exec, home, knownAgents, machines, readTextFile, setShared, shared, window } from "herdr";

export const EVERY = 15 * 60_000;
export const NEAR = 90;

const REUSE = 60_000; // repeated clicks don't start the agents again
const BUSY = 60_000; // a check that long ago was cut off, not still going
const DAY = 24 * 3600_000;
const HERE = "This computer";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CODEX_PLANS = { pro: "Pro 200", prolite: "Pro 100", promax: "Pro 500", team: "Business", self_serve_business_usage_based: "Business", self_serve_business_prolite: "Business Premium" };
const GO_WINDOWS = [["weekly", "This week"], ["rolling", "5 hours"], ["monthly", "This month"]];

const titled = (word) => word.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
const fingerprint = (...parts) => createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);

// Claude writes its reset time for people, in the zone it was run in: "Nov 6 at 7:59pm (UTC)", or
// only the time when that's today. The check asks for UTC so the answer doesn't depend on the machine.
function resetTime(text, now) {
  const m = /^(?:([A-Z][a-z]{2}) (\d{1,2}) at )?(\d{1,2})(?::(\d{2}))?(am|pm)(?: \((.+)\))?$/.exec(text.trim());
  if (!m) return null;
  const hour = (Number(m[3]) % 12) + (m[5] === "pm" ? 12 : 0), minute = Number(m[4] ?? 0), utc = m[6] === "UTC";
  const at = (year, month, day) => (utc ? Date.UTC(year, month, day, hour, minute) : new Date(year, month, day, hour, minute).getTime());
  const today = new Date(now), year = utc ? today.getUTCFullYear() : today.getFullYear();
  if (m[1]) {
    const month = MONTHS.indexOf(m[1]), day = Number(m[2]);
    if (month < 0) return null;
    const when = at(year, month, day);
    return when < now - DAY ? at(year + 1, month, day) : when;
  }
  const when = utc ? at(year, today.getUTCMonth(), today.getUTCDate()) : at(year, today.getMonth(), today.getDate());
  return when <= now ? when + DAY : when;
}

// "/usage" prints lines for people, so anything else in its answer is left alone. No line read
// means the wording changed: the caller keeps the last numbers rather than showing none.
function claudeLimits(text, now) {
  const week = [], other = [], session = [];
  for (const line of text.split("\n")) {
    const m = /^Current (session|week \((.+?)\)): (\d+)% used(?:\W+resets (.+))?$/.exec(line.trim());
    if (!m) continue;
    const scope = m[2], limit = { used: Number(m[3]), resetsAt: m[4] ? resetTime(m[4], now) : null };
    if (m[1] === "session") session.push({ label: "5 hours", ...limit });
    else if (scope === "all models") week.push({ label: "This week", ...limit });
    else other.push({ label: scope.replace(/ only$/, ""), ...limit });
  }
  return [...week, ...other, ...session];
}

const spanName = (minutes) => {
  if (minutes === 300) return "5 hours";
  if (minutes === 10080) return "This week";
  return minutes % 1440 === 0 ? `${minutes / 1440} days` : `${Math.round(minutes / 60)} hours`;
};

// Answers to account/read and account/rateLimits/read. Every bucket counts: a model can have its
// own allowance beside the general one.
function codexReport(output) {
  const answers = {};
  for (const line of output.split("\n")) {
    try {
      const message = JSON.parse(line);
      if (message.id) answers[message.id] = message.result;
    } catch {}
  }
  const account = answers[2]?.account, rates = answers[3];
  if (!answers[2]) throw new Error("no answer from codex");
  if (account?.type !== "chatgpt") return null;
  if (!rates) throw new Error("no limits from codex");
  const buckets = Object.values(rates.rateLimitsByLimitId ?? {});
  const limits = (buckets.length ? buckets : [rates.rateLimits]).flatMap((bucket) =>
    [bucket?.primary, bucket?.secondary].filter(Boolean).map((window) => ({
      span: window.windowDurationMins ?? 0,
      label: bucket.limitName ?? spanName(window.windowDurationMins ?? 0),
      used: Math.round(window.usedPercent ?? 0),
      resetsAt: window.resetsAt ? window.resetsAt * 1000 : null,
    })));
  limits.sort((a, b) => b.span - a.span);
  return { plan: CODEX_PLANS[account.planType] ?? titled(account.planType ?? ""), who: fingerprint(account.email, account.planType), limits: limits.map(({ span, ...limit }) => limit) };
}

// Go's answer nests the windows under "usage"; another deployment spells them "<window>Usage".
function goLimits(answer) {
  const usage = answer?.usage ?? answer ?? {};
  return GO_WINDOWS.flatMap(([name, label]) => {
    const window = usage[name] ?? answer?.[`${name}Usage`];
    const percent = window?.percent ?? window?.usagePercent;
    if (typeof percent !== "number") return [];
    const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : window.resetInSec ? Date.now() + window.resetInSec * 1000 : null;
    return [{ label, used: window.status === "rate-limited" ? 100 : Math.round(percent), resetsAt: Number.isFinite(resetsAt) ? resetsAt : null }];
  });
}

// Dock-started apps miss what shell startup files add (nvm, most of all), so each machine's PATH
// comes from the shell agents start in, and only that: the checks themselves run in `sh`.
const PATH_LINE = `"\${SHELL:-sh}" -ic 'printenv PATH' 2>/dev/null </dev/null | tail -n 1`;
const windows = (on) => !on && window()?.platform === "windows";

async function shellPath(on) {
  if (windows(on)) return "";
  try {
    return (await exec("sh", ["-c", PATH_LINE], { on })).stdout.trim();
  } catch {
    return "";
  }
}

function inShell(on, path, posix, powershell) {
  if (windows(on)) return exec("powershell", ["-NoLogo", "-NoProfile", "-Command", powershell]);
  return exec("sh", ["-c", `[ -n "$1" ] && PATH="$1" && export PATH; ${posix}`, "sh", path], { on });
}

// `--setting-sources=` keeps the person's hooks and plugins out of a check that runs every 15 minutes.
const CLAUDE_USAGE = "claude -p /usage --output-format json --no-session-persistence --strict-mcp-config --setting-sources=";

async function claude(on, path, now) {
  const auth = JSON.parse((await inShell(on, path, "claude auth status", "claude auth status")).stdout);
  if (!auth.loggedIn || auth.authMethod !== "claude.ai") return null;
  const usage = await inShell(on, path, `env TZ=UTC ${CLAUDE_USAGE}`, `$env:TZ='UTC'; ${CLAUDE_USAGE}`);
  const limits = claudeLimits(JSON.parse(usage.stdout).result ?? "", now);
  if (!limits.length) throw new Error("no limits from claude");
  return { plan: titled(auth.subscriptionType ?? ""), who: fingerprint(auth.email, auth.orgId), limits };
}

const CODEX_REQUESTS = [
  { id: 1, method: "initialize", params: { clientInfo: { name: "zaki", version: "1" } } },
  { method: "initialized", params: {} },
  { id: 2, method: "account/read", params: {} },
  { id: 3, method: "account/rateLimits/read" },
].map((request) => JSON.stringify(request));

// The server stops answering once its input ends, so the input stays open until the last answer is in.
const CODEX_POSIX = `out=$(mktemp) || exit 1
{ printf '%s\\n' ${CODEX_REQUESTS.map((line) => `'${line}'`).join(" ")}
  i=0; while [ $i -lt 75 ] && ! grep -q '"id":3' "$out"; do sleep 0.2; i=$((i+1)); done
} | codex -s read-only -a never app-server >"$out" 2>/dev/null
cat "$out"; rm -f "$out"`;
const CODEX_WINDOWS = `& { ${CODEX_REQUESTS.map((line) => `'${line}'`).join("; ")}; Start-Sleep 6 } | codex -s read-only -a never app-server 2>$null`;

async function codex(on, path) {
  return codexReport((await inShell(on, path, CODEX_POSIX, CODEX_WINDOWS)).stdout);
}

async function opencodeKeys() {
  const data = `${home()}/.local/share/opencode`, keys = [];
  const add = (entry) => {
    const key = typeof entry === "string" ? entry : entry?.type === "key" || entry?.key ? entry.key : "";
    // A `$VAR` or `!command` entry is for OpenCode to resolve, and is never sent.
    if (typeof key === "string" && key.trim() && !/^[!$]/.test(key.trim()) && !keys.includes(key.trim())) keys.push(key.trim());
  };
  try {
    const rows = await exec("sqlite3", ["-readonly", `${data}/opencode.db`, "SELECT value FROM credential WHERE active = 1 AND integration_id IN ('opencode-go', 'opencode') ORDER BY integration_id = 'opencode-go' DESC"]);
    for (const row of rows.stdout.split("\n").filter(Boolean)) add(JSON.parse(row));
  } catch {}
  try {
    const auth = JSON.parse((await readTextFile(`${data}/auth.json`)) ?? "{}");
    add(auth.opencode);
    add(auth["opencode-go"]);
  } catch {}
  return keys;
}

// Only a Go plan has limits: a key OpenCode refuses (401) or one without a plan (403) is no trouble.
async function opencode() {
  let unreachable = false;
  for (const key of await opencodeKeys()) {
    try {
      const answer = await fetch("https://opencode.ai/zen/go/v1/usage", { headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "zaki-usage/1.0" } });
      if (answer.status === 401 || answer.status === 403) continue;
      const limits = answer.ok ? goLimits(await answer.json()) : [];
      if (limits.length) return { plan: "Go", who: fingerprint(key), limits };
      unreachable = true;
    } catch {
      unreachable = true;
    }
  }
  if (unreachable) throw new Error("no answer from opencode.ai");
  return null;
}

const CHECKS = {
  claude,
  codex,
  // The key can't leave for another machine's sake: OpenCode is checked on this computer only.
  opencode: (on) => (on ? null : opencode()),
};

async function checkMachine(on, last, now) {
  const mine = Object.entries(last).filter(([, entry]) => entry.machine === on);
  let agents;
  try {
    agents = await knownAgents({ on });
  } catch {
    return Object.fromEntries(mine.map(([id, entry]) => [id, { ...entry, failed: true }]));
  }
  const path = await shellPath(on);
  const found = await Promise.all(agents.filter((agent) => agent.installed && CHECKS[agent.key] && (agent.key !== "opencode" || !on)).map(async (agent) => {
    const id = `${agent.key}|${on ?? ""}`, base = { agent: agent.key, name: agent.name, icon: agent.icon, tint: agent.tint, machine: on };
    if (agent.key === "opencode" && shared("usage.opencode") !== true) return shared("usage.opencode") === false ? null : [id, { ...base, ask: true, limits: [] }];
    try {
      const report = await CHECKS[agent.key](on, path, now);
      return report && [id, { ...base, ...report, checkedAt: now }];
    } catch {
      return [id, last[id] ? { ...last[id], failed: true } : { ...base, limits: [], failed: true }];
    }
  }));
  return Object.fromEntries(found.filter(Boolean));
}

export const checking = (usage, now) => Boolean(usage.startedAt) && now - usage.startedAt < BUSY;

export async function checkUsage({ force = false } = {}) {
  const last = shared("usage") ?? {}, now = Date.now();
  if (shared("usage.enabled") === false) return;
  if (checking(last, now)) return;
  if (!force && last.checkedAt && now - last.checkedAt < REUSE) return;
  setShared("usage", { ...last, startedAt: now });
  const names = [...new Set([null, ...machines().map((machine) => machine.name)])];
  const results = await Promise.all(names.map((on) => checkMachine(on, last.entries ?? {}, now)));
  setShared("usage", { checkedAt: Date.now(), entries: Object.assign({}, ...results) });
}

// A limit past its reset time has started over, whatever the last check said.
export const usedNow = (limit, now) => (limit.resetsAt && limit.resetsAt <= now ? 0 : limit.used);

// One row per subscription: machines signed in to the same account share it, with the newest numbers.
export function subscriptions(entries) {
  const rows = new Map();
  for (const entry of Object.values(entries ?? {})) {
    const key = entry.who ?? `${entry.agent}|${entry.machine ?? ""}`, place = entry.machine ?? HERE, had = rows.get(key);
    if (!had) rows.set(key, { ...entry, machines: [place] });
    else rows.set(key, { ...((entry.checkedAt ?? 0) > (had.checkedAt ?? 0) ? entry : had), machines: [...had.machines, place] });
  }
  return [...rows.values()];
}

export const nearLimit = (entries, now) => subscriptions(entries).some((row) => row.limits.some((limit) => usedNow(limit, now) >= NEAR));
