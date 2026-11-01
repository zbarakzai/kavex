// How each agent is read: docs/adr/0001-usage-through-agents-own-commands.md. The footer runs the
// checks and the popover shows them, so each keeps a copy, as mods can't import each other's files;
// scripts/look.test.ts keeps them equal.

import { createHash } from "crypto";
import { exec as execute, home, knownAgents, machines, readTextFile, setShared, shared, window } from "herdr";

export const EVERY = 15 * 60_000;
export const NEAR = 90;
export const POPOVER_WIDTH = 340;

const REUSE = 60_000;
const BUSY = 60_000;
const DAY = 24 * 3600_000;
const WEEK_MINUTES = 7 * 1440;
const HERE = "This computer";

const entryId = (agent, machine) => `${agent}|${machine ?? ""}`;
const OPENCODE = entryId("opencode");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CODEX_PLANS = {
  pro: "Pro 200", prolite: "Pro 100", promax: "Pro 500", team: "Business", self_serve_business_usage_based: "Business", self_serve_business_prolite: "Business Premium",
  ent26: "Enterprise", enterprise_cbp_automation: "Enterprise", enterprise_cbp_usage_based: "Enterprise", edu_plus: "Edu Plus", edu_pro: "Edu Pro", unknown: "",
};
const GO_WINDOWS = [["weekly", "This week"], ["rolling", "5 hours"], ["monthly", "This month"]];

const titled = (word) => word.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
const fingerprint = (...parts) => (parts[0] ? createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16) : undefined);

export const usageOff = () => shared("usage.enabled") === false;

async function exec(...call) {
  if (usageOff() || !shared("usage")?.era) throw new Error("usage was turned off");
  return execute(...call);
}

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

function claudeLimits(text, now) {
  const week = [], other = [], session = [];
  for (const line of text.split("\n")) {
    const m = /^Current (session|week \((.+?)\)): (\d+)% used(?:\W+resets (.+))?$/.exec(line.trim());
    if (!m) continue;
    const scope = m[2], limit = { used: Number(m[3]), resetsAt: m[4] ? resetTime(m[4], now) : null };
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
  const buckets = Object.entries(rates?.rateLimitsByLimitId ?? {});
  const limits = (buckets.length ? buckets : [["codex", rates?.rateLimits]]).flatMap(([id, bucket]) => {
    const model = id === "codex" ? null : bucket?.limitName ?? titled(id);
    return [bucket?.primary, bucket?.secondary].filter(Boolean).map((period) => {
      const minutes = period.windowDurationMins ?? 0, name = minutes ? periodName(minutes) : null;
      const label = !model ? name ?? "Limit" : !name || minutes === WEEK_MINUTES ? model : `${model} · ${name}`;
      return { minutes, model, label, used: Math.round(period.usedPercent ?? 0), resetsAt: period.resetsAt ? period.resetsAt * 1000 : null };
    });
  });
  limits.sort((a, b) => rank(a) - rank(b) || b.minutes - a.minutes || Boolean(a.model) - Boolean(b.model));
  return limits.map(({ label, used, resetsAt }) => ({ label, used, resetsAt }));
}

function codexReport(output) {
  const answers = {};
  for (const line of output.split("\n")) {
    try {
      const message = JSON.parse(line);
      if (message.id && !message.method) answers[message.id] = message.result;
    } catch {}
  }
  const account = answers[2]?.account, limits = codexLimits(answers[3]);
  if (!answers[2]) throw new Error("no answer from codex");
  // account/read has come back empty beside real limits (one real run in eight): that isn't signed out.
  if (!account && limits.length) throw new Error("no account from codex");
  if (account?.type !== "chatgpt") return null;
  if (!limits.length) throw new Error("no limits from codex");
  return { plan: CODEX_PLANS[account.planType] ?? titled(account.planType ?? ""), who: fingerprint(account.email, account.planType), limits };
}

// Go's answer nests the windows under "usage"; another deployment spells them "<window>Usage".
function goLimits(answer) {
  const usage = answer?.usage ?? answer ?? {};
  return GO_WINDOWS.flatMap(([name, label]) => {
    const window = usage[name] ?? answer?.[`${name}Usage`];
    const percent = window?.percent ?? window?.usagePercent;
    if (!Number.isFinite(percent)) return [];
    const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : window.resetInSec ? Date.now() + window.resetInSec * 1000 : null;
    return [{ label, used: window.status === "rate-limited" ? 100 : Math.round(percent), resetsAt: Number.isFinite(resetsAt) ? resetsAt : null }];
  });
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

const HAS = "zaki-has:", ASKED = "zaki-asked";

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
const CLAUDE_USAGE = "-p /usage --output-format json --no-session-persistence --strict-mcp-config --setting-sources=";

async function claude(where, now) {
  const posix = posixWords([where.program]), powershell = powershellCall(where.program);
  const auth = JSON.parse((await inShell(where, `${posix} auth status`, `${powershell} auth status`)).stdout);
  if (!auth.loggedIn || auth.authMethod !== "claude.ai") return null;
  const usage = await inShell(where, `env TZ=UTC ${posix} ${CLAUDE_USAGE}`, `$env:TZ='UTC'; ${powershell} ${CLAUDE_USAGE}`);
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
const codexPosix = (program) => `out=$(mktemp) || exit 1
{ printf '%s\\n' ${CODEX_REQUESTS.map((line) => `'${line}'`).join(" ")}
  i=0; while [ $i -lt 75 ] && ! grep -q '"id":3' "$out"; do sleep 0.2; i=$((i+1)); done
} | ${posixWords([program])} -s read-only -a never app-server >"$out" 2>/dev/null
cat "$out"; rm -f "$out"`;
// This pipe can't watch the output for the last answer, so the input stays open for a fixed wait.
// Six seconds is a guess: it has never run on Windows.
const codexPowershell = (program) => `& { ${CODEX_REQUESTS.map((line) => `'${line}'`).join("; ")}; Start-Sleep 6 } | ${powershellCall(program)} -s read-only -a never app-server 2>$null`;

async function codex(where) {
  return codexReport((await inShell(where, codexPosix(where.program), codexPowershell(where.program))).stdout);
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
  try {
    const rows = await exec("sqlite3", ["-readonly", `${data}/opencode.db`, "SELECT value FROM credential WHERE active = 1 AND integration_id IN ('opencode-go', 'opencode') ORDER BY integration_id = 'opencode-go' DESC"]);
    for (const row of rows.stdout.split("\n").filter(Boolean)) add(JSON.parse(row));
  } catch {}
  if (!opencodeAllowed()) return [];
  try {
    const auth = JSON.parse((await readTextFile(`${data}/auth.json`)) ?? "{}");
    add(auth["opencode-go"]);
    add(auth.opencode);
  } catch {}
  return keys;
}

async function opencode() {
  let unreachable = false;
  for (const key of await opencodeKeys()) {
    if (!opencodeAllowed()) return null;
    try {
      const answer = await fetch("https://opencode.ai/zen/go/v1/usage", { headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "zaki-usage/1.0" } });
      if (answer.status === 401 || answer.status === 403) continue;
      const limits = answer.ok ? goLimits(await answer.json()) : [];
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
    return report && { ...base, ...report, checkedAt: Date.now() };
  } catch {
    return { ...base, limits: [], failed: true };
  }
}

async function checkMachine(on, last, now) {
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
    const entry = await checked(base, () => read({ on, path, program: agent.program }, now));
    return entry?.failed ? kept(id) ?? [id, entry] : entry && [id, entry];
  }));
  return Object.fromEntries(found.filter(Boolean));
}

export const checking = (usage, now) => Boolean(usage.startedAt) && now - usage.startedAt < BUSY;

function withOpencode(entries, entry) {
  const { [OPENCODE]: _, ...others } = entries ?? {};
  return entry ? { ...others, [OPENCODE]: entry } : others;
}

// A failure knows only what was saved when its check began. A check hung past a minute has another
// beside it, which may have saved numbers since, and those mustn't turn into "Could not check".
const orSaved = (entry, saved) => (entry?.failed && saved?.limits.length ? { ...saved, failed: true } : entry);

// `era` names one stretch of Usage being on, and goes with the numbers when it's turned off. A pass
// saves only into the era it started in, so one from before can't bring cleared numbers back, even
// with Usage on again. It isn't one mark per pass: a pass over a minute long has another start beside
// it, and if that took away its right to save, checks that slow would never save at all.
export async function checkUsage({ force = false, within = REUSE } = {}) {
  const last = shared("usage") ?? {}, now = Date.now(), era = last.era ?? Math.random(), answer = shared("usage.opencode");
  if (usageOff()) return;
  if (checking(last, now)) return;
  if (!force && last.checkedAt && now - last.checkedAt < within) return;
  setShared("usage", { ...last, era, startedAt: now });
  const names = [...new Set([null, ...machines().map((machine) => machine.name)])];
  const results = await Promise.all(names.map((on) => checkMachine(on, last.entries ?? {}, now)));
  if (usageOff() || shared("usage")?.era !== era) return;
  const saved = shared("usage").entries ?? {}, found = Object.assign({}, ...results);
  for (const id in found) found[id] = orSaved(found[id], saved[id]);
  // Answered midway, OpenCode's entry is no longer this pass's to save: Allow runs its own check.
  setShared("usage", { era, checkedAt: now, entries: shared("usage.opencode") === answer ? found : withOpencode(found, saved[OPENCODE]) });
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
  if (usageOff() || current?.era !== usage.era) return;
  setShared("usage", { ...current, startedAt: current.startedAt === mine ? null : current.startedAt, entries: withOpencode(current.entries, orSaved(found, current.entries?.[OPENCODE])) });
}

export const usedNow = (limit, now) => (limit.resetsAt && limit.resetsAt <= now ? 0 : limit.used);

export function subscriptions(entries) {
  const rows = new Map();
  for (const entry of Object.values(entries ?? {})) {
    const key = entry.who ?? entryId(entry.agent, entry.machine), place = entry.machine ?? HERE, had = rows.get(key);
    if (!had) rows.set(key, { ...entry, machines: [place] });
    else rows.set(key, { ...((entry.checkedAt ?? 0) > (had.checkedAt ?? 0) ? entry : had), machines: [...had.machines, place] });
  }
  const all = [...rows.values()];
  return all.map((row) => {
    const named = row.machines.length > 1 || row.machines[0] !== HERE || all.some((other) => other !== row && other.agent === row.agent);
    return { ...row, place: named ? row.machines.join(", ") : null };
  });
}

export const nearLimit = (entries, now) => subscriptions(entries).some((row) => row.limits.some((limit) => usedNow(limit, now) >= NEAR));
