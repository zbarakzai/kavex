// How each agent is read: docs/adr/0001-usage-through-agents-own-commands.md. The footer runs the
// checks and the popover shows them, so each keeps a copy, as mods can't import each other's files;
// scripts/look.test.ts keeps them equal.

import { createHash } from "crypto";
import { exec as execute, home, knownAgents, machines, notify, readTextFile, setShared, shared, window } from "herdr";
import { codexPosix, codexPowershell } from "./codex-probe.js";

export const EVERY = 15 * 60_000;
export const NEAR = 90;
export const POPOVER_WIDTH = 400;
export const POPOVER_HEIGHT = 540;

const REUSE = 60_000;
const BUSY = 60_000;
const STALE = 30 * 60_000;
const SESSION_MINUTES = 300;
const WEEK_MINUTES = 7 * 1440;
const MONTH_MINUTES = 30 * 1440;
const SETTLING = 0.05;
const HERE = "This computer";

const entryId = (agent, machine) => `${agent}|${machine ?? ""}`;
const OPENCODE = entryId("opencode");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CODEX_PLANS = {
  pro: "Pro 200", prolite: "Pro 100", promax: "Pro 500", team: "Business", self_serve_business_usage_based: "Business", self_serve_business_prolite: "Business Premium",
  ent26: "Enterprise", enterprise_cbp_automation: "Enterprise", enterprise_cbp_usage_based: "Enterprise", edu_plus: "Edu Plus", edu_pro: "Edu Pro", unknown: "",
};
const GO_WINDOWS = [["weekly", "This week", WEEK_MINUTES], ["rolling", "5 hours", SESSION_MINUTES], ["monthly", "This month", MONTH_MINUTES]];

export function timeText(ms) {
  const minutes = Math.floor(ms / 60_000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (days) return `${days}d ${hours % 24}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return minutes ? `${minutes}m` : "<1m";
}

const titled = (word) => word.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
const fingerprint = (...parts) => (parts[0] ? createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16) : undefined);

export const usageOff = () => shared("usage.enabled") === false;

async function exec(...call) {
  if (usageOff() || !shared("usage")?.era) throw new Error("usage was turned off");
  return execute(...call);
}

// Claude writes its reset time for people, in the zone it was run in: "Nov 6 at 7:59pm (UTC)" or
// "Nov 6, 7:59pm (Europe/London)", or only the time when that's today. The check asks for UTC so the
// answer doesn't depend on the machine. Windows ignores that and names its own zone, which is only
// ever this computer's, so any other zone is read as local time.
function resetTime(text, now) {
  const clock = /^(?:([A-Z][a-z]{2})\s+(\d{1,2})(?:\s+at|,)\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s+\((.+)\))?$/i.exec(text.trim());
  if (!clock) return null;
  const [, monthName, dayText, hourText, minuteText, meridiem, zone] = clock;
  const hour12 = Number(hourText), minute = Number(minuteText ?? 0), utc = zone?.toUpperCase() === "UTC";
  if (hour12 < 1 || hour12 > 12 || minute >= 60) return null;
  const hour = (hour12 % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  const today = new Date(now);
  const year = utc ? today.getUTCFullYear() : today.getFullYear();
  const month = utc ? today.getUTCMonth() : today.getMonth();
  const day = utc ? today.getUTCDate() : today.getDate();
  const at = (y, m, d) => (utc ? new Date(Date.UTC(y, m, d, hour, minute)) : new Date(y, m, d, hour, minute));
  if (monthName) {
    const namedMonth = MONTHS.findIndex((name) => name.toLowerCase() === monthName.toLowerCase()), namedDay = Number(dayText);
    if (namedMonth < 0 || namedDay < 1) return null;
    // A weekly limit can cross New Year in either direction.
    const offset = month === 11 && namedMonth === 0 ? 1 : month === 0 && namedMonth === 11 ? -1 : 0;
    const reset = at(year + offset, namedMonth, namedDay);
    if ((utc ? reset.getUTCMonth() : reset.getMonth()) !== namedMonth) return null;
    return reset.getTime();
  }
  const when = at(year, month, day).getTime();
  const tomorrow = at(year, month, day + 1).getTime();
  return when < now && tomorrow - now <= SESSION_MINUTES * 60_000 ? tomorrow : when;
}

function claudeLimits(text, now) {
  const week = [], other = [], session = [];
  for (const line of text.split("\n")) {
    const m = /^Current (session|week \((.+?)\)): (\d+(?:\.\d+)?)\s*%\s+used(?:\W+resets (.+))?$/.exec(line.trim());
    if (!m) continue;
    const scope = m[2], minutes = m[1] === "session" ? SESSION_MINUTES : WEEK_MINUTES, limit = { used: Math.round(Number(m[3])), resetsAt: m[4] ? resetTime(m[4], now) : null, minutes };
    if (m[4] && limit.resetsAt === null) continue;
    if (m[1] === "session") session.push({ label: "5 hours", ...limit });
    else if (scope === "all models") week.push({ label: "This week", ...limit });
    else other.push({ label: scope.replace(/ only$/, ""), ...limit });
  }
  return [...week, ...other, ...session];
}

function periodName(minutes) {
  if (minutes === WEEK_MINUTES) return "This week";
  const [count, unit] = minutes % 1440 === 0 ? [minutes / 1440, "day"] : minutes >= 60 ? [Math.round(minutes / 60), "hour"] : [minutes, "minute"];
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

const rank = ({ minutes, model }) => (minutes === WEEK_MINUTES ? (model ? 1 : 0) : 2);

function codexLimits(rates) {
  const buckets = { ...rates?.rateLimitsByLimitId };
  if (!buckets.codex && rates?.rateLimits) buckets.codex = rates.rateLimits;
  const limits = Object.entries(buckets).flatMap(([id, bucket]) => {
    const name = typeof bucket?.limitName === "string" && bucket.limitName.trim();
    const model = id === "codex" ? null : name || titled(id);
    return [bucket?.primary, bucket?.secondary].filter((period) => Number.isFinite(period?.usedPercent) && period.usedPercent >= 0).map((period) => {
      const minutes = Number.isInteger(period.windowDurationMins) && period.windowDurationMins > 0 ? period.windowDurationMins : 0;
      const name = minutes ? periodName(minutes) : null;
      const label = !model ? name ?? "Limit" : !name || minutes === WEEK_MINUTES ? model : `${model} · ${name}`;
      return { minutes, model, label, used: Math.round(period.usedPercent), resetsAt: Number.isFinite(period.resetsAt) && period.resetsAt > 0 ? period.resetsAt * 1000 : null };
    });
  });
  limits.sort((a, b) => rank(a) - rank(b) || b.minutes - a.minutes || Boolean(a.model) - Boolean(b.model));
  return limits.map(({ label, used, resetsAt, minutes }) => ({ label, used, resetsAt, minutes }));
}

function codexReport(output) {
  const answers = {};
  for (const line of output.split("\n")) {
    try {
      const message = JSON.parse(line);
      if (Number.isInteger(message?.id) && !("method" in message) && "result" in message) answers[message.id] = message.result;
    } catch {}
  }
  if (!answers[1] || !answers[2] || !("account" in answers[2])) throw new Error("no account answer from codex");
  const { account } = answers[2], limits = codexLimits(answers[3]);
  // A signed-out reply and real limits together do not identify an account.
  if (account === null && !limits.length) return null;
  if (account?.type === "apiKey" || account?.type === "amazonBedrock") return null;
  if (account?.type !== "chatgpt") throw new Error("no account usage from codex");
  const tier = typeof account.planType === "string" ? account.planType : "";
  const plan = Object.hasOwn(CODEX_PLANS, tier) ? CODEX_PLANS[tier] : titled(tier);
  return { plan, who: fingerprint(account.email, tier), limits, ...(!limits.length && { failed: true }) };
}

// Go's answer nests the windows under "usage"; another deployment spells them "<window>Usage".
function goLimits(answer) {
  const usage = answer?.usage ?? answer ?? {};
  const limits = GO_WINDOWS.flatMap(([name, label, minutes]) => {
    const window = usage[name] ?? answer?.[`${name}Usage`];
    const percent = window?.percent ?? window?.usagePercent;
    if (!Number.isFinite(percent) || percent < 0) return [];
    const delay = window.resetInSec;
    const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.isFinite(delay) && delay >= 0 ? Date.now() + delay * 1000 : null;
    return [{ label, used: window.status === "rate-limited" ? 100 : Math.round(percent), resetsAt: Number.isFinite(resetsAt) ? resetsAt : null, minutes }];
  });
  // A partial keyed response is a failed read. Older flat replies can contain individual windows.
  if (answer?.usage && ![WEEK_MINUTES, SESSION_MINUTES].every((duration) => limits.some((limit) => limit.minutes === duration))) return [];
  return limits;
}

// Dock-started apps miss what shell startup files add (nvm, most of all), so each machine's PATH
// comes from the shell agents start in, and only that: the checks themselves run in `sh`.
const PATH_LINE = `"\${SHELL:-sh}" -ic 'printenv PATH' 2>/dev/null </dev/null | tail -n 1`;
const usesPowershell = (on) => !on && window()?.platform === "windows";

async function shellPath(on) {
  // Windows apps get the person's PATH from the system, not from shell startup files, and there's no `sh`.
  if (usesPowershell(on)) return "";
  try {
    return (await exec("sh", ["-c", PATH_LINE], { on })).stdout.trim();
  } catch {
    return "";
  }
}

function inShell({ on, path }, posix, powershell) {
  if (usesPowershell(on)) return exec("powershell", ["-NoLogo", "-NoProfile", "-Command", powershell]);
  return exec("sh", ["-c", `[ -n "$1" ] && PATH="$1" && export PATH; ${posix}`, "sh", path], { on });
}

// programs.json's `run` is the person's, so it reaches a shell as words and never as script. PowerShell
// also ends a quoted string at a curly quote.
const posixWords = (run) => run.map((word) => (/^[\w@%+:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)).join(" ");
const powershellWord = (word) => `'${word.replace(/['‘’‚‛]/g, "$&$&")}'`;
const powershellCall = (program) => `& ${powershellWord(program)}`;

// `run` counts only as the agent's own program at a path of its own. Its flags would land in a
// background check, ahead of `auth status`, where nobody can say what they'd spend.
function programOf({ key, run }) {
  const name = run[0].split(/[\\/]/).pop().replace(/\.(exe|cmd)$/i, "");
  return name === key ? run[0] : key;
}

const HAS = "kavex-has:", ASKED = "kavex-asked";

// knownAgents also says "not installed" when it couldn't ask, and on an added machine it looks in
// another PATH than the agents', so the machine's own shell settles it. Null: it can't be asked.
async function shellFinds(where, programs) {
  if (!programs.length) return new Set();
  if (!where.path && !usesPowershell(where.on)) return null;
  try {
    const { stdout } = await inShell(where,
      `for c in ${posixWords(programs)}; do command -v "$c" >/dev/null 2>&1 && echo "${HAS}$c"; done; echo ${ASKED}`,
      `foreach ($c in @(${programs.map(powershellWord).join(",")})) { if (Get-Command $c -ErrorAction SilentlyContinue) { "${HAS}$c" } }; "${ASKED}"`);
    if (!stdout.includes(ASKED)) return null;
    return new Set(stdout.split(/\r?\n/).filter((line) => line.startsWith(HAS)).map((line) => line.slice(HAS.length)));
  } catch {
    return null;
  }
}

// `--setting-sources=` keeps the person's hooks and plugins out of a check that runs every 15 minutes.
const CLAUDE_USAGE = "-p /usage --output-format stream-json --verbose --no-session-persistence --strict-mcp-config --setting-sources=";

function claudeResult(output) {
  // System, assistant and rate-limit events can surround the command result.
  let result;
  for (const line of output.split("\n")) {
    try {
      const message = JSON.parse(line);
      if (message?.type === "result") result = message;
    } catch {}
  }
  return result;
}

async function claude(where) {
  const posix = posixWords([where.program]), powershell = powershellCall(where.program);
  const auth = JSON.parse((await inShell(where, `${posix} auth status`, `${powershell} auth status`)).stdout);
  if (auth.loggedIn === false) return null;
  if (auth.loggedIn !== true || typeof auth.authMethod !== "string") throw new Error("no sign-in status from claude");
  if (auth.authMethod !== "claude.ai") return null;
  const account = { plan: titled(auth.subscriptionType ?? ""), who: fingerprint(auth.email, auth.orgId) };
  try {
    const usage = await inShell(where, `env TZ=UTC ${posix} ${CLAUDE_USAGE}`, `$env:TZ='UTC'; ${powershell} ${CLAUDE_USAGE}`);
    const report = claudeResult(usage.stdout);
    if (usage.code === 0 && report?.is_error === false && typeof report.result === "string") {
      const limits = claudeLimits(report.result, Date.now());
      if (limits.length) return { ...account, limits };
    }
  } catch {}
  return { ...account, limits: [], failed: true };
}

async function codex(where) {
  const result = await inShell(where, codexPosix(posixWords([where.program])), codexPowershell(powershellWord(where.program)));
  return codexReport(result.stdout);
}

const opencodeAllowed = () => !usageOff() && shared("usage.opencode") === true;

async function opencodeKeys() {
  const data = `${home()}/.local/share/opencode`, keys = [];
  const add = (entry) => {
    const key = String((typeof entry === "string" ? entry : entry?.key) ?? "").trim();
    // A real key is one token. `$VAR`, `!command`, `{env:VAR}` and the like are for OpenCode to
    // resolve, and are never sent. Going by what a key is leaves no such spelling to miss.
    if (/^[A-Za-z0-9][\w.~+/=-]*$/.test(key) && !keys.includes(key)) keys.push(key);
  };
  let databaseFailed = false;
  try {
    const query = "SELECT value FROM credential WHERE active = 1 AND integration_id IN ('opencode-go', 'opencode') ORDER BY integration_id = 'opencode-go' DESC";
    const rows = await exec("sqlite3", ["-cmd", ".timeout 1000", "-readonly", `${data}/opencode.db`, query]);
    if (rows.code === 0) {
      for (const row of rows.stdout.split("\n").filter(Boolean)) add(JSON.parse(row));
    } else {
      // Old installs may have only auth.json, or a database from before the credential table.
      databaseFailed = !/unable to open database file|no such table: credential/i.test(rows.stderr);
    }
  } catch (error) {
    databaseFailed = error instanceof SyntaxError;
  }
  if (!opencodeAllowed()) return [];
  try {
    const auth = JSON.parse((await readTextFile(`${data}/auth.json`)) ?? "{}");
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw new Error("invalid OpenCode auth file");
    add(auth["opencode-go"]);
    add(auth.opencode);
  } catch (error) {
    if (!keys.length) throw error;
  }
  if (databaseFailed && !keys.length) throw new Error("could not read OpenCode credentials");
  return keys;
}

async function opencode() {
  let unreachable = false;
  for (const key of await opencodeKeys()) {
    if (!opencodeAllowed()) return null;
    try {
      const answer = await fetch("https://opencode.ai/zen/go/v1/usage", { headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "kavex-usage/1.0" } });
      if (answer.status === 401 || answer.status === 403) continue;
      const body = await answer.json();
      if (!answer.ok && ["AuthError", "EntitlementError"].includes(body?.error?.type)) continue;
      const limits = answer.ok ? goLimits(body) : [];
      if (limits.length) return { plan: "Go", limits };
      unreachable = true;
    } catch {
      unreachable = true;
    }
  }
  if (unreachable) throw new Error("no answer from opencode.ai");
  return null;
}

const CHECKS = {
  claude: { read: claude },
  codex: { read: codex },
  opencode: { read: opencode, localOnly: true, needsConsent: true },
};

async function checked(base, read) {
  try {
    const report = await read();
    return report && { ...base, ...report, ...(!report.failed && { checkedAt: Date.now() }) };
  } catch {
    return { ...base, limits: [], failed: true };
  }
}

async function checkMachine(on, last) {
  const kept = (id) => last[id] && [id, { ...last[id], failed: true }];
  const keepAll = () => Object.fromEntries(Object.keys(last).filter((id) => last[id].machine === on).map(kept));
  if (on && machines().find((machine) => machine.name === on)?.layout === "unavailable") return keepAll();
  const [agents, path] = await Promise.all([knownAgents({ on }).catch(() => []), shellPath(on)]);
  if (!agents.length) return keepAll();
  const ours = agents.filter((agent) => CHECKS[agent.key] && !(on && CHECKS[agent.key].localOnly)).map((agent) => ({ ...agent, program: programOf(agent) }));
  // `installed` is about run[0], which may not be what runs here.
  const sure = (agent) => agent.installed && agent.program === agent.run[0];
  const finds = await shellFinds({ on, path }, ours.filter((agent) => !sure(agent)).map((agent) => agent.program));
  const found = await Promise.all(ours.map(async (agent) => {
    const { read, needsConsent } = CHECKS[agent.key], answer = shared("usage.opencode");
    const id = entryId(agent.key, on), base = { agent: agent.key, name: agent.name, icon: agent.icon, tint: agent.tint, machine: on };
    if (!sure(agent) && !finds?.has(agent.program)) return finds ? null : kept(id);
    if (needsConsent && answer !== true) return answer === false ? null : [id, { ...base, ask: true, limits: [] }];
    const entry = await checked(base, () => read({ on, path, program: agent.program }));
    return entry && [id, entry];
  }));
  return Object.fromEntries(found.filter(Boolean));
}

export const checking = (usage, now) => Boolean(usage.startedAt) && now - usage.startedAt < BUSY;

function withOpencode(entries, entry) {
  const { [OPENCODE]: _, ...others } = entries ?? {};
  return entry ? { ...others, [OPENCODE]: entry } : others;
}

// A failed check can keep the latest reading unless the agent identifies a different account.
function orSaved(entry, saved) {
  if (entry?.failed && saved?.limits.length && (!entry.who || entry.who === saved.who)) return { ...saved, failed: true };
  return entry;
}

// A limit warns once on reaching NEAR, and can again only after falling below it. Going by that and
// not by the reset time means no window to track: resets drift by seconds between checks.
function warnNear() {
  const now = Date.now(), warned = shared("usage.warned") ?? [], near = [];
  for (const row of subscriptions(shared("usage")?.entries, now)) {
    for (const limit of row.limits) {
      const used = limit.used, id = `${row.who ?? entryId(row.agent, row.machine)}|${limit.label}`;
      if (used < NEAR) continue;
      near.push(id);
      if (warned.includes(id)) continue;
      const where = row.place ? ` (${row.place})` : "", resets = limit.resetsAt ? `, resets in ${timeText(limit.resetsAt - now)}` : "";
      notify({ title: `${row.name}${where} limit at ${used}%`, body: `${limit.label}${resets}`, level: "warning" });
    }
  }
  if (String(near) !== String(warned)) setShared("usage.warned", near);
}

// `era` names one stretch of Usage being on, and goes with the numbers when it's turned off. A pass
// saves only into the era it started in, so one from before can't bring cleared numbers back, even
// with Usage on again. It isn't one mark per pass: a pass over a minute long has another start beside
// it, and if that took away its right to save, checks that slow would never save at all.
export async function checkUsage({ force = false, within = REUSE } = {}) {
  const last = shared("usage") ?? {}, now = Date.now(), era = last.era ?? Math.random(), answer = shared("usage.opencode");
  if (usageOff()) return;
  if (checking(last, now)) {
    if (force && !last.refreshPending) setShared("usage", { ...last, refreshPending: true });
    return;
  }
  const reset = Object.values(last.entries ?? {}).some((entry) => entry.limits.some((limit) =>
    limit.resetsAt > last.checkedAt && limit.resetsAt <= now));
  if (!force && !last.refreshPending && !reset && last.checkedAt && now - last.checkedAt < within) return;
  setShared("usage", { ...last, era, startedAt: now, refreshPending: false });
  const names = [...new Set([null, ...machines().map((machine) => machine.name)])];
  const results = await Promise.all(names.map((on) => checkMachine(on, last.entries ?? {})));
  const current = shared("usage");
  if (usageOff() || current?.era !== era || current.checkedAt > now) return;
  const saved = current.entries ?? {}, found = Object.assign({}, ...results);
  for (const id in found) found[id] = orSaved(found[id], saved[id]);
  // Answered midway, OpenCode's entry is no longer this pass's to save: Allow runs its own check.
  return saveUsage(current, now, {
    era,
    checkedAt: now,
    entries: shared("usage.opencode") === answer ? found : withOpencode(found, saved[OPENCODE]),
  });
}

// Consent is the person's press, saved by the popover. Any agent can run this command, so it only
// starts the check for an answer already given. It doesn't wait for a pass, which may have asked
// before the answer came, and it checks OpenCode alone, so no agent starts twice. Like a pass, it
// saves only into the era it began in. Taking `ask` off the row stops a second footer told the same.
export async function allowOpencode() {
  const usage = shared("usage") ?? {}, now = Date.now(), { ask, ...base } = usage.entries?.[OPENCODE] ?? {};
  if (usageOff() || !ask || shared("usage.opencode") !== true) return;
  const mine = checking(usage, now) ? null : now;
  setShared("usage", { ...usage, startedAt: mine ?? usage.startedAt, entries: { ...usage.entries, [OPENCODE]: base } });
  const found = await checked(base, opencode);
  const current = shared("usage");
  if (usageOff() || current?.era !== usage.era || current.checkedAt > now) return;
  return saveUsage(current, mine, {
    ...current, entries: withOpencode(current.entries, orSaved(found, current.entries?.[OPENCODE])),
  });
}

function saveUsage(current, started, next) {
  const startedAt = current.startedAt === started ? null : current.startedAt;
  setShared("usage", { ...next, startedAt, refreshPending: current.refreshPending });
  warnNear();
  if (current.refreshPending && !checking({ startedAt }, Date.now())) return checkUsage({ force: true });
}

// The pace so far, carried straight on. It's taken at the check, as `used` dates from then, so the
// answer stands still while the clock moves. Early in a window that pace says little, so there's none.
export function runsOut(limit, checkedAt, now) {
  if (!limit.minutes || !limit.resetsAt || !checkedAt || limit.used <= 0 || limit.used >= 100) return null;
  const length = limit.minutes * 60_000, spent = length - (limit.resetsAt - checkedAt);
  if (spent < length * SETTLING) return null;
  const at = checkedAt + ((100 - limit.used) * spent) / limit.used;
  return at > now && at < limit.resetsAt ? at : null;
}

export function subscriptions(entries, now) {
  const rows = new Map();
  for (const entry of Object.values(entries ?? {})) {
    const key = entry.who ?? entryId(entry.agent, entry.machine), place = entry.machine ?? HERE, had = rows.get(key);
    if (!had) rows.set(key, { ...entry, machines: [place] });
    else {
      const age = (entry.checkedAt ?? 0) - (had.checkedAt ?? 0);
      const latest = age > 0 || (age === 0 && had.failed && !entry.failed) ? entry : had;
      rows.set(key, { ...latest, machines: [...had.machines, place] });
    }
  }
  const all = [...rows.values()];
  return all.map((row) => {
    const named = row.machines.length > 1 || row.machines[0] !== HERE || all.some((other) => other !== row && other.agent === row.agent);
    const recent = !row.failed || now - row.checkedAt < STALE;
    const limits = recent ? row.limits.filter((limit) => !limit.resetsAt || limit.resetsAt > now) : [];
    return { ...row, limits, expired: limits.length < row.limits.length, place: named ? row.machines.join(", ") : null };
  });
}

export const nearLimit = (entries, now) => subscriptions(entries, now).some((row) => row.limits.some((limit) => limit.used >= NEAR));
