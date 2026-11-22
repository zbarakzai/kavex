// Reference: Orca b342cee0ff07f7d702db5c09543d7506a9424a48, src/main/rate-limits/providers.
// The caller authorizes the provider before entering a probe. Results carry only
// percentages, reset times, display text and a one-way account identifier.
import { Buffer } from "buffer";
import { createHash } from "crypto";
import { URL, URLSearchParams } from "url";

const WEEK = 10_080;
const MONTH = 43_200;
const DAY_MS = 86_400_000;
const REQUEST_MS = 10_000;
const present = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const number = (value) => {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
};
const timestamp = (value) => typeof value === "string" ? number(Date.parse(value)) : null;
const clamp = (used) => Math.min(100, Math.max(0, used));
const metric = (label, used, minutes, resetsAt, key, scoped = false) => ({
  label, used: clamp(used), minutes, resetsAt, key, ...(scoped ? { scoped } : {}),
});
const failed = (error, extra = {}) => ({ state: "error", error, limits: [], ...extra });
const unavailable = (error, extra = {}) => ({ state: "unavailable", error, limits: [], ...extra });
const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const fingerprint = (value) => present(value) ? hash(value) : undefined;

const isWindows = (ctx) => ctx.platform === "windows" || ctx.platform === "win32";
const isMac = (ctx) => ctx.platform === "macos" || ctx.platform === "darwin";

function join(ctx, first, ...parts) {
  const separator = isWindows(ctx) ? "\\" : "/";
  return [first.replace(/[\\/]+$/, ""), ...parts].join(separator).replaceAll(isWindows(ctx) ? "/" : "\\", separator);
}

function dirname(path) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

async function readJson(ctx, path) {
  const raw = await ctx.read(path);
  if (raw == null) return null;
  const parsed = object(JSON.parse(raw));
  if (!parsed) throw new Error("Invalid credential file");
  return parsed;
}

async function getenv(ctx, name) {
  return present(await ctx.env(name));
}

function retryAt(response, now) {
  const raw = present(response.headers?.get("retry-after"));
  if (!raw) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(raw) ? number(raw) : null;
  const delay = seconds === null ? (timestamp(raw) ?? now) - now : seconds * 1000;
  return delay > 0 ? now + Math.min(delay, DAY_MS) : undefined;
}

async function requestJson(ctx, url, options, name) {
  try {
    const response = await ctx.request(url, { method: "GET", redirect: "manual", credentials: "omit", timeout: REQUEST_MS, ...options });
    if (response.status === 429) {
      return { failure: failed(`${name} usage is rate limited`, { retryAt: retryAt(response, ctx.now()) }), status: 429 };
    }
    if (!response.ok) {
      return { failure: failed(`${name} usage request failed (HTTP ${response.status})`), status: response.status };
    }
    try {
      return { data: await response.json() };
    } catch {
      return { failure: failed(`${name} usage response could not be read`), invalid: true };
    }
  } catch {
    return { failure: failed(`${name} usage request failed`) };
  }
}

const bearer = (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/json" });

function providerBase(base, fallback, origin) {
  try {
    const url = new URL(base ?? fallback);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

const CURSOR_ORIGIN = "https://cursor.com";
const CURSOR_LEGACY = "https://cursor.com/api/usage";
const CURSOR_KEYRING_QUERY = ["search", "service", "cursor-credentials", "account", "cursor-user"];
const CURSOR_QUERY = "SELECT key, value FROM ItemTable WHERE key IN ('cursorAuth/accessToken', 'cursorAuth/stripeMembershipType')";

function cursorSession(raw, plan = undefined) {
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  try {
    const encoded = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const claims = object(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
    const subject = present(claims?.sub);
    return subject ? { token, subject, plan, expires: Number.isFinite(claims.exp) ? claims.exp * 1000 : null } : null;
  } catch {
    return null;
  }
}

async function cursorRoots(ctx) {
  if (isMac(ctx)) return [join(ctx, ctx.home, ".cursor"), join(ctx, ctx.home, "Library", "Application Support", "Cursor")];
  if (isWindows(ctx)) {
    const roaming = await getenv(ctx, "APPDATA") ?? join(ctx, ctx.home, "AppData", "Roaming");
    const root = join(ctx, roaming, "Cursor");
    return [root, root];
  }
  const config = await getenv(ctx, "XDG_CONFIG_HOME") ?? join(ctx, ctx.home, ".config");
  return [join(ctx, config, "cursor"), join(ctx, config, "Cursor")];
}

async function readCursorSession(ctx) {
  const [cliRoot, desktopRoot] = await cursorRoots(ctx);
  let expired = null, error = null;
  function live(candidate) {
    if (!candidate) return null;
    if (candidate.expires === null || candidate.expires > ctx.now()) return candidate;
    expired ??= candidate;
    return null;
  }

  if (isMac(ctx)) {
    try {
      const keychain = await execute(ctx, "security", ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"], 3_000);
      const session = keychain?.code === 0 ? live(cursorSession(keychain.stdout)) : null;
      if (session) return { session };
      if (!keychain || (keychain.code !== 0 && keychain.code !== 44 && !/could not be found|not be found/i.test(keychain.stderr))) {
        error = "Cursor sign-in could not be read from the macOS Keychain";
      }
    } catch {
      error = "Cursor sign-in could not be read from the macOS Keychain";
    }
  }

  try {
    const cli = await readJson(ctx, join(ctx, cliRoot, "auth.json"));
    const session = live(cursorSession(cli?.accessToken));
    if (session) return { session };
    if (!isMac(ctx) && !isWindows(ctx) && cli?.storedIn === "os-secret-store") {
      // search without --unlock leaves locked items alone.
      try {
        const keyring = await execute(ctx, "secret-tool", CURSOR_KEYRING_QUERY, 10_000);
        const raw = keyring?.code === 0 ? /^secret = (.*)$/m.exec(keyring.stdout)?.[1] : undefined;
        const keyringSession = raw ? live(cursorSession(JSON.parse(raw).accessToken)) : null;
        if (keyringSession) return { session: keyringSession };
        if (keyring?.code !== 0 || /^\[/m.test(keyring.stdout)) error ??= "Cursor sign-in could not be read from the Linux keyring";
      } catch {
        error ??= "Cursor sign-in could not be read from the Linux keyring";
      }
    }
  } catch {
    error ??= "Cursor CLI sign-in file could not be read";
  }

  // Only query the Cursor keys in the IDE database, read-only. An IDE lock can
  // be temporary, and the CLI fallback remains usable.
  const db = join(ctx, desktopRoot, "User", "globalStorage", "state.vscdb");
  try {
    const result = await ctx.exec("sqlite3", ["-readonly", "-json", "-cmd", ".timeout 250", db, CURSOR_QUERY]);
    if (result.code === 0 && result.stdout.trim()) {
      const values = Object.fromEntries(JSON.parse(result.stdout).map(({ key, value }) => [key, value]));
      const session = live(cursorSession(values["cursorAuth/accessToken"], present(values["cursorAuth/stripeMembershipType"]) ?? undefined));
      if (session) return { session };
    }
  } catch {}
  return { session: expired, error };
}

function cursorTimestamp(value) {
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value.trim()))) {
    const epoch = number(value);
    return epoch === null ? null : epoch > 1e12 ? epoch : epoch * 1000;
  }
  return timestamp(value);
}

function cursorPoolPercent(pool) {
  const [used, limit] = [number(pool?.used), number(pool?.limit)];
  return used !== null && limit !== null && limit > 0 ? (used / limit) * 100 : number(pool?.totalPercentUsed);
}

function cursorSummary(raw) {
  const data = object(raw) ?? {};
  const start = cursorTimestamp(data.billingCycleStart);
  const end = cursorTimestamp(data.billingCycleEnd);
  const minutes = start !== null && end !== null && end > start ? Math.round((end - start) / 60_000) : MONTH;
  const main = object(data.individualUsage?.plan);
  const overall = object(data.individualUsage?.overall);
  const pool = main?.enabled === false && overall?.enabled === true ? overall : main ?? overall;
  const windows = [];
  if (pool?.enabled !== false) {
    const amount = number(pool?.totalPercentUsed) ?? cursorPoolPercent(pool);
    if (amount !== null) windows.push(metric(minutes === WEEK ? "This week" : "This month", amount, minutes, end, "plan"));
    for (const [name, field, key] of [["Cursor Models", "autoPercentUsed", "auto"], ["Other Models", "apiPercentUsed", "api"]]) {
      const used = number(pool?.[field]);
      if (used !== null) windows.push(metric(name, used, minutes, end, key, true));
    }
  }
  const onDemand = data.individualUsage?.onDemand;
  const onDemandPercent = onDemand?.enabled === true ? cursorPoolPercent(onDemand) : null;
  if (onDemandPercent !== null) windows.push(metric("On-demand", onDemandPercent, minutes, end, "on-demand", true));
  return { windows, plan: present(data.membershipType), unlimited: data.isUnlimited === true, periodMinutes: minutes };
}

function cursorLegacyWindow(raw) {
  const data = object(raw) ?? {};
  const quotas = [];
  for (const [name, entry] of Object.entries(data)) {
    const limit = number(entry?.maxRequestUsage), used = number(entry?.numRequests);
    if (limit !== null && limit > 0 && used !== null) quotas.push({ name, limit, used });
  }
  const quota = quotas.find((entry) => entry.name === "gpt-4") ?? quotas.sort((a, b) => b.limit - a.limit)[0];
  if (!quota) return null;

  let resetsAt = null;
  const start = cursorTimestamp(data.startOfMonth);
  if (start !== null) {
    const date = new Date(start);
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
    resetsAt = number(date.getTime());
  }
  return metric("This month", quota.used / quota.limit * 100, MONTH, resetsAt, "plan");
}

async function cursor(ctx) {
  let auth;
  try { auth = await readCursorSession(ctx); } catch { return failed("Cursor sign-in could not be read"); }
  if (!auth.session) return auth.error ? failed(auth.error) : null;
  const { token, subject, expires, plan: desktopPlan } = auth.session;
  const identity = fingerprint(subject);
  if (expires !== null && expires <= ctx.now()) return failed("Cursor sign-in expired. Run cursor-agent login and refresh.", { identity });
  const headers = {
    Cookie: `WorkosCursorSessionToken=${encodeURIComponent(subject)}%3A%3A${token}`,
    Accept: "application/json",
    Origin: CURSOR_ORIGIN,
    Referer: `${CURSOR_ORIGIN}/dashboard`,
  };
  const ask = (url, options) => requestJson(ctx, url, { headers, ...options }, "Cursor");
  const result = await ask(`${CURSOR_ORIGIN}/api/usage-summary`);
  if (result.failure) return { ...result.failure, identity };
  const { windows, plan: membership, unlimited } = cursorSummary(result.data);
  const plan = membership ?? desktopPlan;
  const unified = membership?.startsWith("unified_") === true;
  const summaryPools = windows.filter((entry) => entry.key === "auto" || entry.key === "api");

  if (unified || (!unlimited && summaryPools.length && summaryPools.every((entry) => entry.used === 0))) {
    const period = await ask(`${CURSOR_ORIGIN}/api/dashboard/get-current-period-usage`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}",
    });
    if (period.failure && unified && !period.invalid && ![404, 405, 501].includes(period.status)) {
      return { ...period.failure, identity };
    }
    const start = cursorTimestamp(period.data?.billingCycleStart);
    const end = cursorTimestamp(period.data?.billingCycleEnd);
    if (start !== null && end !== null && end > start && object(period.data?.planUsage)) {
      const current = cursorSummary({ billingCycleStart: start, billingCycleEnd: end, individualUsage: { plan: period.data.planUsage } });
      if (current.windows.length && (unified || current.periodMinutes < 27 * 1440)) {
        return { plan, identity, limits: [...current.windows, ...windows.filter((window) => window.key === "on-demand")] };
      }
    }
  }
  if (unlimited) return { plan, identity, limits: [] };
  if (windows.length) return { plan, identity, limits: windows };

  const legacy = await ask(`${CURSOR_LEGACY}?user=${encodeURIComponent(subject)}`);
  if (legacy.failure) return { ...legacy.failure, identity };
  const legacyWindow = cursorLegacyWindow(legacy.data);
  return legacyWindow ? { plan, identity, limits: [legacyWindow] } : unavailable("Cursor reports no usage allowance for this account", { plan, identity });
}

const GEMINI_CODE_ASSIST = "https://cloudcode-pa.googleapis.com/v1internal:";
const GEMINI_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GEMINI_OAUTH_MODULE = ["dist", "src", "code_assist", "oauth2.js"];
const GEMINI_NAMES = {
  "gemini-3.1-pro": "3.1 Pro",
  "gemini-3.1-flash": "3.1 Flash",
  "gemini-3.1-flash-lite": "3.1 Flash Lite",
  "gemini-3.0-pro": "3.0 Pro",
  "gemini-3.0-flash": "3.0 Flash",
  "gemini-2.5-pro": "Pro",
  "gemini-2.5-flash": "Flash",
  "gemini-2.5-flash-lite": "Flash Lite",
  "gemini-2.0-pro": "2.0 Pro",
  "gemini-2.0-flash": "2.0 Flash",
  "gemini-2.0-flash-lite": "2.0 Flash Lite",
  "gemini-1.5-pro": "1.5 Pro",
  "gemini-1.5-flash": "1.5 Flash",
  "gemini-exp": "Exp",
  "gemini-experimental": "Exp",
};

async function readGeminiSession(ctx) {
  const [appdata, xdg] = await Promise.all([getenv(ctx, "APPDATA"), getenv(ctx, "XDG_DATA_HOME")]);
  const paths = [
    appdata && join(ctx, appdata, "opencode", "auth.json"),
    xdg && join(ctx, xdg, "opencode", "auth.json"),
    join(ctx, ctx.home, ".local", "share", "opencode", "auth.json"),
    join(ctx, ctx.home, "Library", "Application Support", "opencode", "auth.json"),
  ];
  for (const path of paths.filter(Boolean)) {
    const store = await readJson(ctx, path);
    if (store) {
      const google = object(store.google);
      if (google?.type === "oauth") {
        const [refresh, project, alternateProject] = typeof google.refresh === "string" ? google.refresh.split("|") : [];
        if (present(google.access) || present(refresh)) {
          return { token: present(google.access), refresh: present(refresh), expires: number(google.expires), project: present(project) ?? present(alternateProject) };
        }
      }
      break;
    }
  }
  const creds = await readJson(ctx, join(ctx, ctx.home, ".gemini", "oauth_creds.json"));
  if (!creds) return null;
  const token = present(creds.access_token), refresh = present(creds.refresh_token);
  return token || refresh ? { token, refresh, expires: number(creds.expiry_date), project: null } : null;
}

function geminiClient(source) {
  const id = /OAUTH_CLIENT_ID\s*=\s*["']([^"']+)["']/.exec(source ?? "")?.[1];
  const secret = /OAUTH_CLIENT_SECRET\s*=\s*["']([^"']+)["']/.exec(source ?? "")?.[1];
  return id && secret ? { id, secret } : null;
}

async function execute(ctx, command, args, timeoutMs) {
  try {
    if (timeoutMs && ctx.run) return await ctx.run(args, {}, { program: command, timeoutMs });
    return await ctx.exec(command, args);
  } catch { return null; }
}

async function cliBrowserlessSource(ctx, file) {
  try {
    return geminiClient(await ctx.read(file));
  } catch {
    // A bundled chunk can exceed the mod's normal text-read limit. Extract only
    // the two public-client assignments from that package file.
    const pattern = `OAUTH_CLIENT_(ID|SECRET)[ \t]*=[ \t]*["'][^"']+["']`;
    if (!isWindows(ctx)) {
      const read = await execute(ctx, "grep", ["-Eom", "4", pattern, "--", file]);
      return read?.code === 0 ? geminiClient(read.stdout) : null;
    }
    const literal = (text) => "'" + text.replaceAll("'", "''") + "'";
    const script = `[Regex]::Matches([IO.File]::ReadAllText(${literal(file)}), ${literal(pattern)}) | Select-Object -First 4 | ForEach-Object { $_.Value }`;
    const read = await execute(ctx, "powershell", ["-NoProfile", "-Command", script]);
    return read?.code === 0 ? geminiClient(read.stdout) : null;
  }
}

async function geminiBundleFiles(ctx, root) {
  const bundle = join(ctx, root, "bundle");
  if (!isWindows(ctx)) {
    const command = 'for file in "$1"/*.js; do if [ -f "$file" ]; then printf "%s\\n" "$file"; fi; done';
    const result = await execute(ctx, "sh", ["-c", command, "sh", bundle]);
    return result?.code === 0 ? result.stdout.trim().split(/\r?\n/).filter(Boolean).slice(0, 128) : [];
  }
  const literal = "'" + bundle.replaceAll("'", "''") + "'";
  const script = `Get-ChildItem -LiteralPath ${literal} -Filter '*.js' -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }`;
  const result = await execute(ctx, "powershell", ["-NoProfile", "-Command", script]);
  return result?.code === 0 ? result.stdout.trim().split(/\r?\n/).filter(Boolean).slice(0, 128) : [];
}

async function geminiClientFromInstall(ctx) {
  const configured = await ctx.locate?.();
  const lookup = configured ? null : await execute(ctx, isWindows(ctx) ? "where.exe" : "which", ["gemini"]);
  const candidates = configured ? [configured] : lookup?.code === 0 ? lookup.stdout.trim().split(/\r?\n/).slice(0, 4) : [];
  if (!isWindows(ctx)) candidates.push("/usr/local/bin/gemini", "/opt/homebrew/bin/gemini", join(ctx, ctx.home, ".local", "bin", "gemini"), join(ctx, ctx.home, "bin", "gemini"));

  const visited = new Set();
  for (const candidate of candidates.filter(Boolean)) {
    const resolved = isWindows(ctx) ? null : await execute(ctx, "realpath", [candidate]);
    const path = resolved?.code === 0 ? resolved.stdout.trim() : candidate;
    const bin = dirname(path), prefix = dirname(bin);
    const packages = [
      join(ctx, prefix, "libexec", "lib", "node_modules", "@google", "gemini-cli"),
      join(ctx, prefix, "lib", "node_modules", "@google", "gemini-cli"),
      join(ctx, prefix, "share", "gemini-cli"),
      join(ctx, bin, "node_modules", "@google", "gemini-cli"),
    ];
    let root = bin;
    for (let i = 0; i < 8; i++) {
      if (/(?:^|[\\/])gemini-cli$/.test(root)) packages.push(root);
      const up = dirname(root);
      if (up === root) break;
      root = up;
    }
    for (const pkg of packages) {
      if (visited.has(pkg)) continue;
      visited.add(pkg);
      const files = [
        join(ctx, pkg, "node_modules", "@google", "gemini-cli-core", ...GEMINI_OAUTH_MODULE),
        join(ctx, dirname(pkg), "gemini-cli-core", ...GEMINI_OAUTH_MODULE),
        join(ctx, pkg, ...GEMINI_OAUTH_MODULE),
      ];
      for (const path of files) {
        const credentials = await cliBrowserlessSource(ctx, path);
        if (credentials) return credentials;
      }
      for (const path of await geminiBundleFiles(ctx, pkg)) {
        const credentials = await cliBrowserlessSource(ctx, path);
        if (credentials) return credentials;
      }
    }
  }
  return null;
}

async function refreshGemini(ctx, refreshToken) {
  if (!refreshToken) return null;
  const client = await geminiClientFromInstall(ctx);
  if (!client) return null;
  const result = await requestJson(ctx, GEMINI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.id, client_secret: client.secret, refresh_token: refreshToken, grant_type: "refresh_token",
    }).toString(),
  }, "Gemini");
  return present(result.data?.access_token);
}

function geminiWindows(data) {
  const buckets = new Map();
  for (const row of Array.isArray(data) ? data : Array.isArray(data?.buckets) ? data.buckets : []) {
    const modelId = present(row?.modelId);
    if (!modelId || !Number.isFinite(row?.remainingFraction) || typeof row.resetTime !== "string") continue;
    const label = GEMINI_NAMES[modelId] ?? modelId.replace(/^gemini-/i, "").replaceAll("-", " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
    const window = metric(label, Math.round((1 - row.remainingFraction) * 100), 60, timestamp(row.resetTime), modelId, true);
    const id = `${window.used}|${window.resetsAt}`;
    const previous = buckets.get(id);
    const known = Boolean(GEMINI_NAMES[modelId]);
    if (!previous || (known && !previous.known) || (known === previous.known && label.length < previous.window.label.length)) {
      buckets.set(id, { known, window });
    }
  }
  const windows = [...buckets.values()].map(({ window }) => window);
  if (!windows.length) return windows;
  const headline = windows.reduce((largest, window) => window.used > largest.used ? window : largest);
  return [metric("1 hour", headline.used, 60, headline.resetsAt, "session"), ...windows];
}

async function askGemini(ctx, token, fallbackProject) {
  const headers = { "Content-Type": "application/json", ...bearer(token) };
  const request = (operation, body) => requestJson(ctx, GEMINI_CODE_ASSIST + operation, {
    method: "POST", headers, body: JSON.stringify(body),
  }, "Gemini");
  const loaded = await request("loadCodeAssist", { metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" } });
  const project = present(loaded.data?.cloudaicompanionProject) ?? fallbackProject;
  if (!project) return loaded.failure ? loaded : { failure: failed("Gemini did not return a project") };
  const quota = await request("retrieveUserQuota", { project });
  const limits = geminiWindows(quota.data);
  return quota.failure ? quota : limits.length ? { result: { limits } } : { result: unavailable("Gemini did not report usage windows") };
}

async function gemini(ctx) {
  let session;
  try { session = await readGeminiSession(ctx); } catch { return failed("Gemini sign-in could not be read"); }
  if (!session) return null;
  let token = session.token;
  const refreshed = !token || (session.expires !== null && session.expires < ctx.now());
  if (refreshed) token = await refreshGemini(ctx, session.refresh);
  if (!token) return failed("Gemini sign-in expired. Open Gemini to refresh it.");
  let reading = await askGemini(ctx, token, session.project);
  if (reading.status === 401 && !refreshed) {
    token = await refreshGemini(ctx, session.refresh);
    if (token) reading = await askGemini(ctx, token, session.project);
  }
  return reading.result ?? reading.failure;
}

const GROK_ORIGIN = "https://cli-chat-proxy.grok.com";
const GROK_ISSUER = "https://auth.x.ai";

async function grokSession(ctx) {
  const override = await getenv(ctx, "GROK_HOME");
  const root = override && /^(?:[\\/]|[A-Za-z]:[\\/])/.test(override) ? override : join(ctx, ctx.home, ".grok");
  const auth = await readJson(ctx, join(ctx, root, "auth.json"));
  if (!auth) return null;
  let preferred = false, expired = null, alternate = null;
  for (const [issuer, entry] of Object.entries(auth)) {
    const primary = issuer === GROK_ISSUER || issuer.startsWith(`${GROK_ISSUER}::`);
    preferred ||= primary;
    const token = present(entry?.key);
    if (!token) continue;
    const expires = timestamp(entry?.expires_at);
    const session = { token, id: present(entry.user_id), email: present(entry.email), fresh: expires === null || expires - ctx.now() > 300_000 };
    if (!primary) alternate ??= session;
    else if (session.fresh) return session;
    else expired ??= session;
  }
  return expired ?? (preferred ? null : alternate);
}

const grokMoney = (value) => number(typeof value?.val === "string" ? Number.parseFloat(value.val) : value?.val);
const grokScalars = (config) => [config.onDemandCap, config.onDemandUsed, config.prepaidBalance, config.monthlyLimit, config.used];
const grokPositiveSpend = (config) => (grokMoney(config.onDemandUsed) ?? 0) > 0 || (grokMoney(config.used) ?? 0) > 0;
const grokReset = (config) => timestamp(config.currentPeriod?.end ?? config.billingPeriodEnd);
const GROK_FIELDS = [
  "creditUsagePercent", "currentPeriod", "billingPeriodStart", "billingPeriodEnd", "subscriptionTier",
  "monthlyLimit", "used", "onDemandCap", "onDemandUsed", "prepaidBalance",
];

function grokConfig(data) {
  return object(data?.config) ?? (object(data) && GROK_FIELDS.some((field) => data[field] !== undefined) ? data : null);
}

function grokMonthly(config) {
  const limit = grokMoney(config.monthlyLimit), used = grokMoney(config.used);
  return limit !== null && limit > 0 && used !== null ? metric("This month", used / limit * 100, MONTH, grokReset(config), "monthly") : null;
}

function grokWeekly(config) {
  if (Number.isFinite(config.creditUsagePercent)) return metric("This week", config.creditUsagePercent, WEEK, grokReset(config), "weekly");
  if (config.creditUsagePercent !== undefined || grokMonthly(config)) return null;
  const cap = grokMoney(config.onDemandCap);
  // An omitted percentage with positive unreported spend isn't a healthy 0%.
  const omitted = cap === 0 && Number(config.onDemandCap?.val) === 0
    ? grokPositiveSpend(config)
    : grokScalars(config).some((value) => grokMoney(value) === 0);
  if (omitted) return null;
  const period = config.currentPeriod;
  const starts = timestamp(period?.start), ends = timestamp(period?.end);
  if (period?.type !== "USAGE_PERIOD_TYPE_WEEKLY" || starts === null || ends === null ||
      starts !== timestamp(config.billingPeriodStart) || ends !== timestamp(config.billingPeriodEnd)) return null;
  return metric("This week", 0, WEEK, ends, "weekly");
}

async function grok(ctx) {
  const base = providerBase(await getenv(ctx, "GROK_CLI_CHAT_PROXY_BASE_URL"), GROK_ORIGIN + "/v1", GROK_ORIGIN);
  if (!base) return unavailable("Grok has a custom billing origin");
  let session;
  try { session = await grokSession(ctx); } catch { return failed("Grok sign-in could not be read"); }
  if (!session) return null;
  const identity = fingerprint(session.id ?? session.email);
  if (!session.fresh) return failed("Grok sign-in expired. Open Grok to refresh it.", { identity });

  const headers = { ...bearer(session.token), "X-XAI-Token-Auth": "xai-grok-cli" };
  if (session.id) headers["x-userid"] = session.id;
  const ask = (path) => requestJson(ctx, base + path, { headers }, "Grok");
  const preferred = await ask("/billing?format=credits");
  if (preferred.failure) return { ...preferred.failure, identity };
  const config = grokConfig(preferred.data);
  if (!config) return unavailable("Grok did not report credit usage", { identity });
  const plan = present(config.subscriptionTier) ?? undefined;
  const primary = grokWeekly(config) ?? grokMonthly(config);
  if (primary) return { plan, identity, limits: [primary] };

  const fallback = await ask("/billing");
  if (fallback.failure) return { ...fallback.failure, identity };
  const period = grokConfig(fallback.data) ?? {};
  const monthly = grokMonthly(period);
  const inferredWeekly = !monthly && !grokPositiveSpend(period) ? grokWeekly({ onDemandCap: period.onDemandCap, used: period.used, ...config }) : null;
  const limit = monthly ?? inferredWeekly;
  if (limit) return { plan: plan ?? present(period.subscriptionTier) ?? undefined, identity, limits: [limit] };
  const reported = [...grokScalars(config), ...grokScalars(period)].some((value) => grokMoney(value) !== null);
  return unavailable(reported ? "Grok did not report a usage percentage" : "Grok did not report credit usage", { plan, identity });
}

const KIMI_ORIGIN = "https://api.kimi.com";
const KIMI_CODE = KIMI_ORIGIN + "/coding/v1";
const KIMI_AUTH = "https://auth.kimi.com";

function managedKimiConfig(raw) {
  let table = "", base, oauth;
  for (const original of (raw ?? "").split(/\r?\n/)) {
    const line = original.trim();
    const header = /^\[\s*(.+?)\s*\]\s*(?:#.*)?$/.exec(line)?.[1];
    if (header) {
      table = header.replaceAll('"', "").replaceAll("'", "").replace(/\s+/g, "");
      continue;
    }
    if (table === "providers.managed:kimi-code") {
      base ??= /^(?:base_url)\s*=\s*["']([^"']+)["']/.exec(line)?.[1];
      oauth ??= /^oauth\s*=\s*\{.*\boauth_host\s*=\s*["']([^"']+)["']/.exec(line)?.[1];
    } else if (table === "providers.managed:kimi-code.oauth") {
      oauth ??= /^oauth_host\s*=\s*["']([^"']+)["']/.exec(line)?.[1];
    }
  }
  return { base, oauth };
}

function kimiMinutes(window) {
  const duration = number(window?.duration);
  if (duration === null || duration <= 0) return 300;
  const unit = typeof window.timeUnit === "string" ? window.timeUnit.toUpperCase() : "";
  if (unit.includes("HOUR")) return duration * 60;
  if (unit.includes("DAY")) return duration * 1440;
  if (unit.includes("SECOND")) return Math.max(1, Math.round(duration / 60));
  return duration;
}

function kimiWindow(detail, label, minutes, key) {
  const limit = number(detail?.limit);
  const remaining = number(detail?.remaining);
  const used = number(detail?.used) ?? (remaining === null || limit === null ? null : limit - remaining);
  if (limit === null || limit <= 0 || used === null) return null;
  return metric(label, used / limit * 100, minutes, timestamp(detail.resetTime ?? detail.resetAt), key);
}

function kimiWindows(data) {
  const weekly = kimiWindow(data?.usage, "This week", WEEK, "weekly");
  let session = null;
  for (const item of Array.isArray(data?.limits) ? data.limits : []) {
    const minutes = kimiMinutes(item?.window);
    const label = minutes % 60 === 0 ? `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}` : `${minutes} min`;
    const window = kimiWindow(item?.detail, label, minutes, "session");
    if (window && (!session || Math.abs(minutes - 300) < Math.abs(session.minutes - 300))) session = window;
  }
  const total = data?.usages?.limit_month_total;
  const ratio = number(total?.used_ratio);
  const monthly = ratio === null ? null : metric("This month", ratio * 100, MONTH, timestamp(total.reset_time), "monthly");
  return [weekly, session, monthly].filter(Boolean);
}

async function kimi(ctx) {
  const [dir, envBase, codeHost, oauthHost] = await Promise.all(
    ["KIMI_CODE_HOME", "KIMI_CODE_BASE_URL", "KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST"].map((key) => getenv(ctx, key))
  );
  if (envBase && !providerBase(envBase, KIMI_CODE, KIMI_ORIGIN)) return unavailable("Kimi has a custom billing origin");
  const root = dir ?? join(ctx, ctx.home, ".kimi-code");
  let raw;
  try { raw = await ctx.read(join(ctx, root, "config.toml")); } catch {}
  const config = managedKimiConfig(raw);
  const explicitOAuth = codeHost ?? oauthHost;
  const base = providerBase(envBase ?? config.base, KIMI_CODE, KIMI_ORIGIN);
  if (!base) return unavailable("Kimi has a custom billing origin");
  const host = (explicitOAuth ?? (envBase ? undefined : config.oauth) ?? KIMI_AUTH).replace(/\/+$/, "");
  const name = base === KIMI_CODE && host === KIMI_AUTH
    ? "kimi-code"
    : `kimi-code-env-${hash(JSON.stringify({ oauthHost: host, baseUrl: base }))}`;
  let creds;
  try { creds = await readJson(ctx, join(ctx, root, "credentials", name + ".json")); } catch { return failed("Kimi sign-in could not be read"); }
  if (!creds) return null;
  const token = present(creds.access_token);
  if (!token) return failed("Kimi sign-in did not include an access token");
  if (!Number.isFinite(creds.expires_at) || creds.expires_at - Math.floor(ctx.now() / 1000) <= 5) {
    return failed("Kimi sign-in expired. Open Kimi to refresh it.");
  }
  const outcome = await requestJson(ctx, base + "/usages", { headers: bearer(token) }, "Kimi");
  if (outcome.failure) return outcome.failure;
  const limits = kimiWindows(outcome.data);
  return limits.length ? { limits } : failed("Kimi did not report quota windows");
}

export const networkProviders = {
  cursor: { program: "cursor-agent", consentDomain: "cursor.com", discoverWithoutCli: true, read: cursor },
  gemini: { program: "gemini", consentDomain: "cloudcode-pa.googleapis.com and oauth2.googleapis.com", read: gemini },
  grok: { program: "grok", consentDomain: "cli-chat-proxy.grok.com", read: grok },
  kimi: { program: "kimi", consentDomain: "api.kimi.com", read: kimi },
};
