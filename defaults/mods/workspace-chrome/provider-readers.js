// Provider adapters decide how to read a single account. They do not schedule or persist readings.
import { createHash } from "crypto";
import { codexPosix, codexPowershell } from "./codex-probe.js";
import { cliProviders } from "./provider-cli.js";
import { networkProviders } from "./provider-network.js";
import { codexAccountRef, readClaudePlan, readCodexBackend } from "./provider-plans.js";
import { opencode } from "./provider-opencode.js";
import { inShell, posixWords, powershellWord, powershellCall } from "./provider-host.js";

const SESSION_MINUTES = 300;
const WEEK_MINUTES = 7 * 1440;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CODEX_PLANS = {
  pro: "Pro 200", prolite: "Pro 100", promax: "Pro 500", team: "Business", self_serve_business_usage_based: "Business", self_serve_business_prolite: "Business Premium",
  ent26: "Enterprise", enterprise_cbp_automation: "Enterprise", enterprise_cbp_usage_based: "Enterprise", edu_plus: "Edu Plus", edu_pro: "Edu Pro", unknown: "",
};

const titled = (word) => word.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
const fingerprint = (...parts) => (parts[0] ? createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16) : undefined);

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
  return limits.map(({ label, used, resetsAt, minutes, model }) => ({ label, used, resetsAt, minutes, scoped: Boolean(model) }));
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
  if (account?.type === "apiKey" || account?.type === "amazonBedrock") {
    return { state: "unavailable", error: "This account uses API billing.", limits: [] };
  }
  if (account?.type !== "chatgpt") throw new Error("no account usage from codex");
  const tier = typeof account.planType === "string" ? account.planType : "";
  const plan = Object.hasOwn(CODEX_PLANS, tier) ? CODEX_PLANS[tier] : titled(tier);
  const accountRef = codexAccountRef(answers[3]?.accountId);
  return { plan, accountRef, who: fingerprint(account.email, tier) ?? accountRef, limits, ...(!limits.length && { failed: true }) };
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

async function claudeIdentity(where) {
  const posix = posixWords([where.program]), powershell = powershellCall(where.program);
  const output = await inShell(where, `${posix} auth status`, `${powershell} auth status`);
  const auth = JSON.parse(output.stdout);
  if (auth.loggedIn === false) return null;
  if (auth.loggedIn !== true || typeof auth.authMethod !== "string") throw new Error("no sign-in status from claude");
  if (auth.authMethod !== "claude.ai") return { state: "unavailable", error: "This account uses API billing.", limits: [] };
  return { plan: titled(auth.subscriptionType ?? ""), who: fingerprint(auth.email, auth.orgId) };
}

async function claude(where, account = undefined) {
  const identity = account === undefined ? await claudeIdentity(where) : account;
  if (!identity || identity.state) return identity;
  const posix = posixWords([where.program]), powershell = powershellCall(where.program);
  try {
    const usage = await inShell(where, `env TZ=UTC ${posix} ${CLAUDE_USAGE}`, `$env:TZ='UTC'; ${powershell} ${CLAUDE_USAGE}`);
    const report = claudeResult(usage.stdout);
    if (usage.code === 0 && report?.is_error === false && typeof report.result === "string") {
      const limits = claudeLimits(report.result, Date.now());
      if (limits.length) return { ...identity, limits };
    }
  } catch {}
  return { ...identity, limits: [], failed: true };
}

async function codex(where) {
  const result = await inShell(where, codexPosix(posixWords([where.program])), codexPowershell(powershellWord(where.program)));
  return codexReport(result.stdout);
}

const PROVIDER_HOSTS = {
  cursor: ["cursor.com", "api2.cursor.sh", "api.cursor.com"],
  gemini: ["cloudcode-pa.googleapis.com", "oauth2.googleapis.com"],
  grok: ["cli-chat-proxy.grok.com"],
  kimi: ["api.kimi.com", "auth.kimi.com"],
};

export const CHECKS = {
  claude: { read: claude, alternate: readClaudePlan, consentDomain: "api.anthropic.com", hosts: ["api.anthropic.com"], ownerModule: "provider-plans.js", ownerExport: "readClaudePlan" },
  codex: { read: codex, alternate: readCodexBackend, consentDomain: "chatgpt.com", hosts: ["chatgpt.com"], ownerModule: "provider-plans.js", ownerExport: "readCodexBackend" },
  opencode: { read: opencode, usesHost: true, needsConsent: true, consentDomain: "opencode.ai", hosts: ["opencode.ai"], ownerModule: "provider-opencode.js", ownerExport: "opencode" },
  ...Object.fromEntries(Object.entries(cliProviders).map(([key, provider]) => [key, { ...provider, usesHost: true }])),
  ...Object.fromEntries(Object.entries(networkProviders).map(([key, provider]) =>
    [key, { ...provider, usesHost: true, needsConsent: true, hosts: PROVIDER_HOSTS[key], ownerModule: "provider-network.js", ownerExport: "networkProviders" }])),
};

// Claude's OAuth read is primary when authorized. Codex prefers App Server and
// asks ChatGPT for absent primary windows or when App Server cannot answer.
async function readAccountUsage(key, provider, source, alternate) {
  if (!alternate) return provider.read(source);
  if (key === "claude") {
    const identity = await claudeIdentity(source);
    if (!identity || identity.state) return identity;
    let web;
    try { web = await alternate(); } catch {}
    if (web && (!web.state || web.kind === "rate-limited" || web.kind === "stale-token")) {
      return { ...identity, ...web, source: "claude-oauth", plan: web.plan || identity.plan };
    }
    return claude(source, identity);
  }
  let reading;
  try { reading = await provider.read(source); } catch {}
  if (reading === null || reading?.state === "unavailable" || reading?.limits.some((limit) => limit.minutes === SESSION_MINUTES && !limit.scoped)) return reading;
  try {
    const fallback = await alternate();
    if (fallback && !fallback.state) {
      const related = fallback.accountRef && fallback.accountRef === reading?.accountRef;
      if (!related) return reading?.limits.length ? reading : { ...fallback, source: "codex-web", who: fallback.accountRef };
      const limits = [...fallback.limits, ...reading.limits.filter((limit) =>
        limit.scoped || !fallback.limits.some((candidate) => candidate.minutes === limit.minutes))];
      return { ...fallback, plan: reading.plan || fallback.plan, who: reading.who, source: "codex-web", limits };
    }
    return reading ?? (fallback && { ...fallback, source: "codex-web", who: fallback.accountRef });
  } catch {
    if (reading) return reading;
    throw new Error("Codex usage is unavailable");
  }
}

export { fingerprint, readAccountUsage };
