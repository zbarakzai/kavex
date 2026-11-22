// Schedules provider probes, publishes readings by machine and account, and
// preserves the original observation time for recoverable failures.
import { agents as liveAgents, knownAgents, machines, notify, setShared, shared, spaces } from "herdr";
import { hasCursorDesktop, hostFor, shellFinds, shellPath, usageOff } from "./provider-host.js";
import { CHECKS, fingerprint, readAccountUsage } from "./provider-readers.js";

import { readOnOwner } from "./provider-owner.js";

export { usageOff };
export const EVERY = 15 * 60_000;
export const NEAR = 90;
export const POPOVER_WIDTH = 400;
export const POPOVER_HEIGHT = 540;

const REUSE = 5 * 60_000;
const BUSY = 60_000;
const STALE = 30 * 60_000;
const THROTTLED_STALE = 24 * 60 * 60_000;
const RETRY_FLOOR = 30_000;
const HISTORY_SPAN = 30 * 24 * 60 * 60_000;
const HISTORY_LIMIT = 240;
const HISTORY_KEY = "usage.history";
const HISTORY_STEP = 15 * 60_000;
const HERE = "This computer";

const entryId = (agent, machine) => `${agent}|${machine ?? ""}`;
const OPENCODE = entryId("opencode");

export function timeText(ms) {
  const minutes = Math.floor(ms / 60_000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (days) return `${days}d ${hours % 24}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return minutes ? `${minutes}m` : "<1m";
}

// `run` counts only as the agent's own program at a path of its own. Its flags would land in a
// background check, ahead of `auth status`, where nobody can say what they'd spend.
function programOf({ key, run }) {
  const program = CHECKS[key]?.program ?? key;
  const name = run[0].split(/[\\/]/).pop().replace(/\.(exe|cmd)$/i, "");
  return name === program ? run[0] : program;
}

const UNSUPPORTED = {
  pi: "Pi uses the connected model provider’s subscription.",
  kiro: "Use /usage in an active Kiro CLI session.",
  hermes: "Hermes uses the connected model provider’s subscription.",
  qoder: "Use /usage in an active Qoder session.",
  crush: "Crush uses the connected model provider’s subscription.",
  mastracode: "Mastra Code uses the connected model provider’s subscription.",
  "command-code": "This agent has no supported usage source.",
  "prime-agent": "This agent has no supported usage source.",
};

const EXTRA_AGENTS = {
  muse: { name: "Muse", icon: "icons/muse.svg", tint: true, run: ["muse"] },
  mastracode: { name: "Mastra Code", icon: "icons/mastracode.svg", run: ["mastracode"] },
  "command-code": { name: "Command Code", icon: "icons/command-code.svg", tint: true, run: ["command-code"] },
  "prime-agent": { name: "Prime", icon: "icons/prime-agent.svg", tint: true, run: ["prime-agent"] },
};

function usageConsent(key, on = null) {
  return !on && key === "opencode" ? shared("usage.opencode")
    : shared("usage.consent")?.[on ? entryId(key, on) : key];
}

function withDiscoveredAgents(known, on) {
  const names = new Set(known.map((agent) => agent.key));
  const homes = new Map(spaces().map((space) => [space.id, space.machine ?? null]));
  const running = liveAgents().filter((agent) => homes.get(agent.space) === on);
  const more = [];
  for (const { program } of running) {
    const key = program?.key;
    if (!key || names.has(key) || (!CHECKS[key] && !UNSUPPORTED[key])) continue;
    names.add(key);
    more.push({ ...program, run: [CHECKS[key]?.program ?? key], installed: true });
  }
  for (const [key, preset] of Object.entries(EXTRA_AGENTS)) {
    if (!names.has(key)) more.push({ key, ...preset, installed: false });
  }
  return [...known, ...more];
}

async function checked(base, read) {
  try {
    const report = await read();
    if (!report) return null;
    const { identity, accountRef, ...reading } = report;
    const failed = Boolean(reading.failed || reading.state === "error");
    return {
      ...base, ...reading, failed,
      who: reading.who ?? (identity ? fingerprint(base.agent, identity) : undefined),
      attemptedAt: Date.now(),
      ...(!failed && { checkedAt: Date.now() }),
    };
  } catch {
    return { ...base, limits: [], failed: true, attemptedAt: Date.now() };
  }
}

async function checkMachine(on, last, cycle, publish) {
  const keep = (id) => last[id] && { ...last[id], failed: true };
  const keepAll = () => {
    for (const [id, entry] of Object.entries(last)) {
      if (entry.machine === on) publish(id, keep(id));
    }
  };
  if (on && machines().find((machine) => machine.name === on)?.layout === "unavailable") return keepAll();
  const [known, path] = await Promise.all([knownAgents({ on }).catch(() => []), shellPath(on)]);
  if (!known.length) keepAll();
  const where = { on, path };
  const catalog = withDiscoveredAgents(known, on);
  const providers = catalog.filter(({ key }) => CHECKS[key] || UNSUPPORTED[key])
    .map((agent) => ({ ...agent, program: programOf(agent) }));
  const sure = (agent) => agent.installed && agent.program === agent.run[0];
  const finds = await shellFinds(where, providers.filter((agent) => !sure(agent)).map((agent) => agent.program));
  await Promise.all(providers.map(async (agent) => {
    const key = agent.key, provider = CHECKS[key], id = entryId(key, on), saved = last[id];
    const base = { agent: key, name: agent.name, icon: agent.icon, tint: agent.tint, machine: on,
      ...(provider?.consentDomain && { consentDomain: provider.consentDomain }),
    };
    const discovered = sure(agent) || finds?.has(agent.program) || (provider?.discoverWithoutCli && await hasCursorDesktop(where));
    if (!discovered) {
      if (saved) publish(id, finds ? null : keep(id));
      return;
    }
    if (!provider) return publish(id, { ...base, state: "unavailable", error: UNSUPPORTED[key], limits: [] });
    const answer = usageConsent(key, on);
    if (provider.needsConsent && answer !== true) {
      return publish(id, { ...base, ask: answer !== false, state: answer === false ? "unavailable" : "setup",
        error: answer === false ? "Usage access is off." : undefined, consentDomain: provider.consentDomain, limits: [] });
    }
    if (!probeDue(saved, cycle)) return publish(id, saved, false);
    const allowed = () => cycle.active() && (!provider.needsConsent || usageConsent(key, on) === true);
    const target = { ...where, program: agent.program };
    const source = provider.usesHost ? hostFor(target, provider, allowed) : target;
    const ownerAllowed = () => allowed() && usageConsent(key, on) === true;
    const readOnAccountOwner = async (adapter) => {
      const onOwner = await readOnOwner(target, key, provider, ownerAllowed);
      return onOwner !== undefined ? onOwner : adapter(hostFor(target, provider, ownerAllowed));
    };
    const alternate = provider.alternate && answer === true ? () => readOnAccountOwner(provider.alternate) : null;
    const read = provider.needsConsent && provider.ownerModule
      ? () => readOnAccountOwner(provider.read)
      : () => readAccountUsage(key, provider, source, alternate);
    const report = await checked(base, read);
    if (report && !report.failed && !report.state) report.state = "ok";
    if (!allowed() || (alternate && usageConsent(key, on) !== answer)) return;
    if (report?.failed) {
      if (!report.kind && /rate.limit|throttl/i.test(report.error ?? "")) report.kind = "rate-limited";
      report.failureStreak = Math.min(8, (saved?.failureStreak ?? 0) + 1);
      report.retryAt = report.retryAt ?? report.attemptedAt + Math.min(EVERY, RETRY_FLOOR * 2 ** (report.failureStreak - 1));
    }
    // Retain signed-out state for the roster while preserving legacy subscription rows.
    publish(id, report ?? ({ ...base, state: "signed-out", limits: [], attemptedAt: Date.now() }));
  }));
}

function probeDue(saved, { now, activate, force, within }) {
  if (!saved || saved.ask || !saved.attemptedAt || (saved.state === "unavailable" && !saved.checkedAt)) return true;
  if ((saved.retryAt > now && saved.retryAt !== Number.MAX_SAFE_INTEGER) || (saved.retryAt === Number.MAX_SAFE_INTEGER && !force)) return false;
  if (force) return true;
  if (saved.failed) return now >= (saved.retryAt ?? saved.attemptedAt + RETRY_FLOOR);
  const reset = saved.limits.some((limit) => limit.resetsAt > saved.attemptedAt && limit.resetsAt <= now);
  return reset || now - saved.attemptedAt >= (activate ? REUSE : within);
}

export const checking = (usage, now) => Boolean(usage.startedAt) && now - usage.startedAt < BUSY;

function withOpencode(entries, entry) {
  const { [OPENCODE]: _, ...others } = entries ?? {};
  return entry ? { ...others, [OPENCODE]: entry } : others;
}

// A failed check can keep the latest reading unless the agent identifies a different account.
function orSaved(entry, saved) {
  const identified = entry?.who && entry.who === saved?.who;
  const originalSource = !entry?.who && !entry?.source && !saved?.source;
  if (entry?.failed && saved?.limits.length && (identified || originalSource)) {
    return { ...entry, who: saved.who, plan: saved.plan, limits: saved.limits, checkedAt: saved.checkedAt };
  }
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
export async function checkUsage({ force = false, within = REUSE, activate = false } = {}) {
  const last = shared("usage") ?? {}, now = Date.now();
  if (usageOff()) return;
  const names = new Set([null, ...machines().map((machine) => machine.name)]);
  const keepTarget = ([id]) => !id.includes("|") || names.has(id.slice(id.indexOf("|") + 1) || null);
  const consent = shared("usage.consent") ?? {};
  const currentConsent = Object.entries(consent).filter(keepTarget);
  if (currentConsent.length !== Object.keys(consent).length) setShared("usage.consent", Object.fromEntries(currentConsent));
  if (checking(last, now)) {
    if (force && !last.refreshPending) setShared("usage", { ...last, refreshPending: true });
    return;
  }
  const entries = Object.values(last.entries ?? {});
  const reset = entries.some((entry) => entry.limits.some((limit) => limit.resetsAt > last.checkedAt && limit.resetsAt <= now));
  const retry = entries.some((entry) => entry.failed && entry.retryAt && entry.retryAt <= now);
  if (!force && !last.refreshPending && !reset && !retry && last.checkedAt && now - last.checkedAt < (activate ? REUSE : within)) return;

  const era = last.era ?? Math.random(), generation = (last.generation ?? 0) + 1;
  const roster = Object.fromEntries(Object.entries(last.entries ?? {}).filter(([, entry]) => names.has(entry.machine)));
  const history = shared(HISTORY_KEY) ?? {};
  const timelines = Object.entries(history).filter(keepTarget);
  if (timelines.length !== Object.keys(history).length) setShared(HISTORY_KEY, Object.fromEntries(timelines));
  const sourceGenerations = Object.fromEntries(Object.entries(last.sourceGenerations ?? {}).filter(keepTarget));
  setShared("usage", { ...last, era, generation, startedAt: now, refreshPending: false, entries: roster, sourceGenerations });
  const active = () => {
    const current = shared("usage");
    return !usageOff() && current?.era === era && (current.completedGeneration ?? 0) < generation;
  };
  const answer = usageConsent("opencode");
  const publish = (id, report, updateHistory = true) => {
    if (!active() || (id === OPENCODE && usageConsent("opencode") !== answer)) return;
    const current = shared("usage");
    const index = current.sourceGenerations ?? {};
    if (index[id] > generation) return;
    const saved = current.entries ?? {};
    const previous = saved[id];
    const entry = orSaved(report, previous);
    const next = { ...saved };
    if (entry) next[id] = entry;
    else delete next[id];
    setShared("usage", {
      ...current,
      entries: next,
      sourceGenerations: { ...index, [id]: generation },
    });
    if (updateHistory) recordHistory(id, previous, entry);
  };
  const cycle = { force: force || last.refreshPending, activate, within, now, active };
  await Promise.allSettled([...names].map((on) => checkMachine(on, roster, cycle, publish)));
  if (!active()) return;
  const current = shared("usage");
  return saveUsage(current, now, { ...current, completedGeneration: generation, checkedAt: now });
}

function recordHistory(id, previous, next) {
  // Account switches start a new timeline. No credential or provider identity
  // is copied into a time series.
  const switched = previous && next && (
    (previous.who && next.who && previous.who !== next.who) ||
    (previous.source !== next.source && (!previous.who || !next.who))
  );
  if (!next || !next.checkedAt || next.failed || !next.limits.length) {
    if (!switched && next && !["signed-out", "setup"].includes(next.state)) return;
    const history = shared(HISTORY_KEY) ?? {};
    if (!(id in history)) return;
    const cleared = { ...history };
    delete cleared[id];
    setShared(HISTORY_KEY, cleared);
    return;
  }
  const at = next.checkedAt;
  const history = shared(HISTORY_KEY) ?? {};
  const points = switched ? [] : history[id] ?? [];
  const recent = points.filter((point) => point.at > at - HISTORY_SPAN);
  const last = recent.at(-1);
  if (last && Math.floor(last.at / HISTORY_STEP) === Math.floor(at / HISTORY_STEP)) recent.pop();
  recent.push({ at, limits: next.limits.map(({ label, used, resetsAt, minutes, key }) => ({ label, used, resetsAt, minutes, key })) });
  setShared(HISTORY_KEY, { ...history, [id]: recent.slice(-HISTORY_LIMIT) });
}

// Consent is the person's press, saved by the popover. Any agent can run this command, so it only
// starts the check for an answer already given. It doesn't wait for a pass, which may have asked
// before the answer came, and it checks OpenCode alone, so no agent starts twice. Like a pass, it
// saves only into the era it began in. Taking `ask` off the row stops a second footer told the same.
export async function allowOpencode() {
  const usage = shared("usage") ?? {}, now = Date.now(), { ask, ...base } = usage.entries?.[OPENCODE] ?? {};
  if (usageOff() || !ask || shared("usage.opencode") !== true) return;
  const mine = checking(usage, now) ? null : now;
  setShared("usage", {
    ...usage, startedAt: mine ?? usage.startedAt,
    entries: { ...usage.entries, [OPENCODE]: { ...base, state: "fetching" } },
  });
  const provider = CHECKS.opencode;
  const allowed = () => !usageOff() && shared("usage")?.era === usage.era && usageConsent("opencode") === true;
  const source = hostFor({ on: null, path: "", program: "opencode" }, provider, allowed);
  const found = (await checked(base, async () => {
    const reading = await readOnOwner({ on: null, path: "", program: "opencode" }, "opencode", provider, allowed);
    return reading === undefined ? provider.read(source) : reading;
  })) ??
    { ...base, state: "signed-out", limits: [], attemptedAt: Date.now() };
  const current = shared("usage");
  if (!allowed() || current.checkedAt > now) return;
  recordHistory(OPENCODE, current.entries?.[OPENCODE], found);
  return saveUsage(current, mine, {
    ...current,
    entries: withOpencode(current.entries, orSaved(found, current.entries?.[OPENCODE])),
  });
}

function saveUsage(current, started, next) {
  const startedAt = current.startedAt === started ? null : current.startedAt;
  setShared("usage", { ...next, startedAt, refreshPending: current.refreshPending });
  warnNear();
  if (current.refreshPending && !checking({ startedAt }, Date.now())) return checkUsage({ force: true });
}

export function subscriptions(entries, now, merge = true) {
  const rows = new Map();
  for (const entry of Object.values(entries ?? {})) {
    const key = (merge && entry.who) || entryId(entry.agent, entry.machine), place = entry.machine ?? HERE, had = rows.get(key);
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
    const retention = row.kind === "rate-limited" || (row.agent === "claude" && row.kind === "stale-token") ? THROTTLED_STALE : STALE;
    const recent = !row.failed || now - row.checkedAt < retention;
    const limits = recent ? row.limits.filter((limit) => !limit.resetsAt || limit.resetsAt > now) : [];
    return { ...row, limits, expired: limits.length < row.limits.length, place: named ? row.machines.join(", ") : null };
  });
}

export const nearLimit = (entries, now) => subscriptions(entries, now).some((row) => row.limits.some((limit) => limit.used >= NEAR));
