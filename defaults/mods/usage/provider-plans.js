// Account-provider protocols follow Orca's Claude OAuth and Codex backend
// adapters. Callers resolve local consent and execution ownership first.
import { createHash } from "crypto";

const FIVE_HOURS = 300;
const WEEK = 10080;
const MONTH = 43200;
const DAY_MS = 86_400_000;

function resetTime(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const epoch = Date.parse(raw);
  return Number.isFinite(epoch) ? epoch : null;
}

function meter(key, label, used, resetsAt, minutes, scoped = false) {
  if (!Number.isFinite(used)) return [];
  return [{ key, label, used: Math.min(100, Math.max(0, used)), resetsAt: resetTime(resetsAt), minutes, scoped }];
}

function retryAt(response, now) {
  const value = response.headers?.get("retry-after");
  if (!value) return now + 5 * 60_000;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? now + Math.min(DAY_MS, delay) : now + 5 * 60_000;
}

function failure(error, retryAt, kind) {
  return { state: "error", error, retryAt, kind, limits: [] };
}

function claudeMeter(raw, key, label, minutes, scoped) {
  return meter(key, label, raw?.utilization ?? raw?.used_percentage, raw?.resets_at, minutes, scoped);
}

async function claudeCredentials(host) {
  const configured = await host.env("CLAUDE_CONFIG_DIR");
  const folder = configured || `${host.home}/.claude`;
  if (host.platform === "macos") {
    const service = "Claude Code-credentials";
    const suffix = createHash("sha256").update(folder.normalize("NFC")).digest("hex").slice(0, 8);
    const user = await host.env("USER") || await host.env("USERNAME");
    const account = /^[a-zA-Z0-9._-]+$/.test(user ?? "") ? user : "claude-code-user";
    for (const name of [`${service}-${suffix}`, ...(!configured ? [service] : [])]) {
      const result = await host.exec("security", ["find-generic-password", "-s", name, "-a", account, "-w"]);
      if (result.code !== 0 || !result.stdout.trim()) continue;
      const credential = JSON.parse(result.stdout)?.claudeAiOauth;
      if (credential?.accessToken) return credential;
    }
  }
  const bytes = await host.read(`${folder}/.credentials.json`);
  return bytes ? JSON.parse(bytes)?.claudeAiOauth : null;
}

function claudePlan(type, tier) {
  if (typeof type !== "string" || !type.trim()) return undefined;
  const multiplier = typeof tier === "string" && /(?:^|_)max_(\d+x)$/i.exec(tier)?.[1];
  return type.toLowerCase() === "max" && multiplier ? `Max ${multiplier}` : type;
}

function money(value) {
  if (Number.isFinite(value)) return value;
  const exponent = value?.exponent ?? 2;
  return Number.isFinite(value?.amount_minor) && Number.isInteger(exponent) && exponent >= 0 && exponent <= 6
    ? value.amount_minor / (10 ** exponent) : null;
}

export async function readClaudePlan(host) {
  const oauth = await claudeCredentials(host);
  if (!oauth?.accessToken) return null;
  const response = await host.request("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${oauth.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.0",
    },
  });
  if (response.status === 429) return failure("Claude usage is rate-limited.", retryAt(response, host.now()), "rate-limited");
  if (response.status === 401) {
    const renewable = oauth.refreshToken && (!oauth.refreshTokenExpiresAt || oauth.refreshTokenExpiresAt > host.now());
    return renewable
      ? failure("Claude usage updates the next time Claude runs.", undefined, "stale-token")
      : { state: "unavailable", error: "Sign in again to use this account.", limits: [] };
  }
  if (!response.ok) return failure("Claude usage is unavailable.");
  const value = await response.json();
  const limits = [
    ...claudeMeter(value?.five_hour, "session", "5 hours", FIVE_HOURS),
    ...claudeMeter(value?.seven_day, "weekly", "This week", WEEK),
  ];
  const scoped = Array.isArray(value?.limits) ? value.limits.find((item) =>
    item?.kind === "weekly_scoped" && Number.isFinite(item.percent) && item.scope?.model?.display_name?.trim().toLowerCase() === "fable") : null;
  const fable = scoped ? { used_percentage: scoped.percent, resets_at: scoped.resets_at }
    : value?.fable_weekly ?? value?.fable_seven_day ?? value?.seven_day_fable;
  limits.push(...claudeMeter(fable, "fable", "Fable", WEEK, true));
  const spend = value?.spend, old = value?.extra_usage;
  const used = money(spend?.used), cap = money(spend?.limit);
  const spent = spend?.percent ?? (cap > 0 && used !== null ? used / cap * 100 : old?.utilization);
  if (!limits.some((limit) => !limit.scoped) && (cap > 0 || old?.monthly_limit > 0)) {
    limits.push(...meter("monthly", "This month", spent, null, MONTH));
  }
  const amount = money(spend?.balance);
  const currency = spend?.balance?.currency ?? spend?.limit?.currency;
  const balances = amount === null ? [] : [{ label: "Extra usage", amount, currency: typeof currency === "string" ? currency : "USD" }];
  if (!limits.length && !balances.length) return failure("Claude returned no usage windows.");
  return { plan: claudePlan(oauth.subscriptionType, oauth.rateLimitTier), limits, balances };
}

function codexBackendWindows(value) {
  const rate = value?.rate_limit;
  const source = [rate?.primary_window, rate?.secondary_window].filter((window) => Number.isFinite(window?.used_percent));
  const limits = source.flatMap((window, i) => {
    const duration = window.limit_window_seconds / 60;
    const minutes = Number.isFinite(duration) && duration > 0 ? Math.ceil(duration) : i ? WEEK : FIVE_HOURS;
    return meter(minutes >= WEEK ? "weekly" : "session", minutes >= WEEK ? "This week" : "5 hours", window.used_percent, window.reset_at, minutes);
  });
  const monthly = value?.spend_control?.individual_limit;
  return limits.length ? limits : meter("monthly", "This month",
    Number.isFinite(monthly?.remaining_percent) ? 100 - monthly.remaining_percent : NaN, monthly?.reset_at, MONTH);
}

export function codexAccountRef(id) {
  return typeof id === "string" && id.trim() ? createHash("sha256").update(`codex-owner|${id}`).digest("hex").slice(0, 16) : undefined;
}

export async function readCodexBackend(host) {
  const folder = await host.env("CODEX_HOME") || `${host.home}/.codex`;
  const text = await host.read(`${folder}/auth.json`);
  if (!text) return null;
  const config = JSON.parse(text);
  const tokens = config?.tokens;
  if (!tokens?.access_token || config.auth_mode === "apikey") return null;
  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    "User-Agent": "codex-cli",
    "OpenAI-Beta": "codex-1",
    originator: "Codex Desktop",
  };
  if (tokens.account_id) headers["ChatGPT-Account-Id"] = tokens.account_id;
  const response = await host.request("https://chatgpt.com/backend-api/wham/usage", { headers });
  if (response.status === 429) return failure("Codex usage is rate-limited.", retryAt(response, host.now()), "rate-limited");
  const accountRef = codexAccountRef(tokens.account_id);
  if (!response.ok) return { ...failure(response.status === 401 ? "Sign in again to use this account." : "Codex usage is unavailable."), accountRef };
  const value = await response.json();
  const limits = codexBackendWindows(value);
  if (!limits.length) return failure("Codex returned no usage windows.");
  return { plan: typeof value.plan_type === "string" ? value.plan_type : undefined, accountRef, limits };
}
