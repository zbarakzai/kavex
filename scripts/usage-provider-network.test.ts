import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { networkProviders } from "../defaults/mods/usage/provider-network.js";

const now = Date.parse("2026-11-15T00:00:00Z");
const end = "2026-11-22T00:00:00Z";
const home = "/synthetic";
const windowsHome = "C:\\Users\\Synthetic";
const cliToken = (subject: string, expiry = now + 60 * 60_000) =>
  "fake." + Buffer.from(JSON.stringify({ sub: subject, exp: expiry / 1000 })).toString("base64url") + ".signature";
const command = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr });

type Request = { url: string; options: RequestInit };
function scenario({
  files = {} as Record<string, unknown>,
  vars = {} as Record<string, string>,
  platform = "linux",
  execute = (_program: string, _args: string[]) => command("", 127),
  reply = (_url: string, _options: RequestInit) => new Response(null, { status: 404 }),
} = {}) {
  const requests: Request[] = [];
  const commands: [string, string[]][] = [];
  const reads: string[] = [];
  const ctx = {
    now: () => now,
    home: platform === "windows" ? windowsHome : home,
    platform,
    env: async (name: string) => vars[name],
    read: async (path: string) => {
      reads.push(path);
      return !Object.hasOwn(files, path) ? null : typeof files[path] === "string" ? files[path] as string : JSON.stringify(files[path]);
    },
    exec: async (program: string, args: string[]) => {
      commands.push([program, args]);
      return execute(program, args);
    },
    request: async (url: string, options: RequestInit) => {
      requests.push({ url, options });
      return reply(url, options);
    },
  };
  return { ctx, requests, commands, reads };
}

test("Cursor selects a live CLI keyring session and reconciles the current billing period", async () => {
  const token = cliToken("auth0|fixture-subject");
  const s = scenario({
    files: { "/synthetic/.config/cursor/auth.json": { storedIn: "os-secret-store" } },
    execute: (program) => program === "secret-tool" ? command("secret = " + JSON.stringify({ accessToken: token })) : command("", 127),
    reply: (url) => Response.json(url.endsWith("/api/usage-summary")
      ? { membershipType: "unified_pro", individualUsage: { plan: { totalPercentUsed: 0, autoPercentUsed: 0 }, onDemand: { enabled: true, limit: 10, used: 2 } } }
      : { billingCycleStart: new Date(now).toISOString(), billingCycleEnd: end, planUsage: { totalPercentUsed: 42, autoPercentUsed: 60, apiPercentUsed: 35 } }),
  });
  const result = await networkProviders.cursor.read(s.ctx);
  expect(result?.plan).toBe("unified_pro");
  expect(result?.limits.map(({label, used}) => [label, used])).toEqual([["This week", 42], ["Cursor Models", 60], ["Other Models", 35], ["On-demand", 20]]);
  expect(s.commands[0]).toEqual(["secret-tool", ["search", "service", "cursor-credentials", "account", "cursor-user"]]);
  expect(s.requests.map(({url, options}) => [url, options.method])).toEqual([
    ["https://cursor.com/api/usage-summary", "GET"],
    ["https://cursor.com/api/dashboard/get-current-period-usage", "POST"],
  ]);
  expect(new Headers(s.requests[0].options.headers).get("Cookie")).toBe("WorkosCursorSessionToken=auth0%7Cfixture-subject%3A%3A" + token);
  expect(JSON.stringify(result)).not.toContain("fixture-subject");
});

test("Cursor falls back to read-only desktop SQLite and honors Retry-After", async () => {
  const token = cliToken("active-desktop");
  const s = scenario({
    platform: "windows",
    vars: { APPDATA: windowsHome + "\\AppData\\Roaming" },
    files: { [windowsHome + "\\AppData\\Roaming\\Cursor\\auth.json"]: { accessToken: cliToken("expired-cli", now) } },
    execute: (program) => program === "sqlite3" ? command(JSON.stringify([{ key: "cursorAuth/accessToken", value: token }])) : command("", 127),
    reply: () => new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
  });
  const result = await networkProviders.cursor.read(s.ctx);
  expect(s.commands[0][1]).toContain("-readonly");
  expect(s.commands[0][1]).toContain(windowsHome + "\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb");
  expect(new Headers(s.requests[0].options.headers).get("Cookie")).toContain(token);
  expect(result).toMatchObject({ state: "error", retryAt: now + 120_000 });
});

test("Gemini uses OAuth from OpenCode, resolves the project, and deduplicates model pools", async () => {
  const s = scenario({
    files: { "/synthetic/.local/share/opencode/auth.json": { google: { type: "oauth", access: "fixture-access", expires: now + 60_000, refresh: "fixture-refresh|fallback-project" } } },
    reply: (url) => Response.json(url.endsWith(":loadCodeAssist")
      ? { cloudaicompanionProject: "fixture-project" }
      : { buckets: [
        { modelId: "gemini-2.5-pro-preview", remainingFraction: 0.25, resetTime: end },
        { modelId: "gemini-2.5-pro", remainingFraction: 0.25, resetTime: end },
        { modelId: "gemini-2.5-flash", remainingFraction: 0.5, resetTime: end },
      ] }),
  });
  const result = await networkProviders.gemini.read(s.ctx);
  expect(result?.limits.map(({label, used}) => [label, used])).toEqual([["1 hour", 75], ["Pro", 75], ["Flash", 50]]);
  expect(s.requests.map(({url, options}) => [url, options.method, options.body])).toEqual([
    ["https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", "POST", '{"metadata":{"ideType":"GEMINI_CLI","pluginType":"GEMINI"}}'],
    ["https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", "POST", '{"project":"fixture-project"}'],
  ]);
});

test("Gemini refresh uses the installed CLI bundle and keeps rotated credentials out of the result", async () => {
  const s = scenario({
    files: {
      "/synthetic/.gemini/oauth_creds.json": { access_token: "expired-fixture", refresh_token: "fixture-refresh", expiry_date: now - 1 },
      "/opt/tool/lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js":
        'const OAUTH_CLIENT_ID = "fixture-client"; const OAUTH_CLIENT_SECRET = "fixture-secret";',
    },
    execute: (program) => program === "which" || program === "realpath" ? command("/opt/tool/bin/gemini\n") : command("", 127),
    reply: (url) => {
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "fresh-fixture", refresh_token: "rotated-fixture" });
      return Response.json(url.endsWith(":loadCodeAssist") ? { cloudaicompanionProject: "fixture-project" } : {
        buckets: [{ modelId: "gemini-2.5-flash", remainingFraction: 0.5, resetTime: end }],
      });
    },
  });
  const result = await networkProviders.gemini.read(s.ctx);
  expect(s.requests[0].url).toBe("https://oauth2.googleapis.com/token");
  expect(String(s.requests[0].options.body)).toContain("refresh_token=fixture-refresh");
  expect(new Headers(s.requests[1].options.headers).get("Authorization")).toBe("Bearer fresh-fixture");
  expect(JSON.stringify(result)).not.toMatch(/fixture-secret|fresh-fixture|rotated-fixture/);
});

test("Grok prioritizes the xAI session and falls back from credits to monthly billing", async () => {
  const s = scenario({
    vars: { GROK_HOME: "/synthetic/custom-grok" },
    files: { "/synthetic/custom-grok/auth.json": {
      "https://alternate.example": { key: "alternate-fixture" },
      "https://auth.x.ai::account": { key: "xai-fixture", user_id: "fixture-user" },
    } },
    reply: (url) => Response.json(url.endsWith("?format=credits")
      ? { config: { subscriptionTier: "SuperGrok", onDemandUsed: { val: "5" }, monthlyLimit: { val: "0" } } }
      : { monthlyLimit: { val: "100" }, used: { val: "35" }, billingPeriodEnd: end }),
  });
  expect(await networkProviders.grok.read(s.ctx)).toMatchObject({ plan: "SuperGrok", limits: [{ label: "This month", used: 35, resetsAt: Date.parse(end) }] });
  expect(s.requests.map(({url}) => url)).toEqual(["https://cli-chat-proxy.grok.com/v1/billing?format=credits", "https://cli-chat-proxy.grok.com/v1/billing"]);
  const headers = new Headers(s.requests[0].options.headers);
  expect(headers.get("Authorization")).toBe("Bearer xai-fixture");
  expect(headers.get("X-XAI-Token-Auth")).toBe("xai-grok-cli");
  expect(headers.get("x-userid")).toBe("fixture-user");
});

test("Grok delegates refresh to the CLI when the default issuer token is nearly expired", async () => {
  const s = scenario({
    files: { "/synthetic/.grok/auth.json": {
      "https://alternate.example": { key: "alternate-fixture" },
      "https://auth.x.ai": { key: "expired-fixture", expires_at: new Date(now + 60_000).toISOString() },
    } },
  });
  expect(await networkProviders.grok.read(s.ctx)).toMatchObject({ state: "error", limits: [] });
  expect(s.requests).toEqual([]);
});

test("Kimi maps weekly, nearest five-hour, and total monthly windows via usages", async () => {
  const s = scenario({
    vars: { KIMI_CODE_HOME: "/synthetic/custom-kimi" },
    files: { "/synthetic/custom-kimi/credentials/kimi-code.json": { access_token: "fixture-kimi", expires_at: now / 1000 + 60 } },
    reply: () => Response.json({
      usage: { limit: "100", remaining: "75", resetTime: end },
      limits: [
        { window: { duration: 60, timeUnit: "MINUTE" }, detail: { limit: 10, used: 7 } },
        { window: { duration: 5, timeUnit: "HOUR" }, detail: { limit: 10, used: 3 } },
      ],
      usages: { limit_month_total: { used_ratio: "0.4", reset_time: end }, limit_month_code: { used_ratio: "0.9" } },
    }),
  });
  expect((await networkProviders.kimi.read(s.ctx))?.limits.map(({label, used}) => [label, used])).toEqual([["This week", 25], ["5 hours", 30], ["This month", 40]]);
  expect(s.requests.map(({url, options}) => [url, options.method])).toEqual([["https://api.kimi.com/coding/v1/usages", "GET"]]);
});

test("Kimi and Grok refuse billing endpoints outside the provider origin", async () => {
  const s = scenario({ vars: { KIMI_CODE_BASE_URL: "https://elsewhere.example/fake", GROK_CLI_CHAT_PROXY_BASE_URL: "https://elsewhere.example/v1" } });
  expect(await networkProviders.kimi.read(s.ctx)).toMatchObject({ state: "unavailable" });
  expect(await networkProviders.grok.read(s.ctx)).toMatchObject({ state: "unavailable" });
  expect(s.requests).toEqual([]);
});

test("Cursor falls back to legacy GPT-4 request quota and clamps month-end", async () => {
  const token = cliToken("legacy-cursor");
  const s = scenario({
    platform: "macos",
    files: { "/synthetic/.cursor/auth.json": { accessToken: token } },
    execute: (program) => program === "security" ? command("", 44) : command("", 127),
    reply: (url) => Response.json(url.endsWith("/api/usage-summary")
      ? { membershipType: "pro" }
      : { startOfMonth: "2026-01-31T08:00:00Z", "gpt-4": { maxRequestUsage: 10, numRequests: 7 }, other: { maxRequestUsage: 100, numRequests: 25 } }),
  });
  expect(await networkProviders.cursor.read(s.ctx)).toMatchObject({
    plan: "pro", limits: [{ used: 70, resetsAt: Date.parse("2026-02-28T08:00:00Z") }],
  });
  expect(s.requests[1].url).toBe("https://cursor.com/api/usage?user=legacy-cursor");
});

test("Grok does not turn omitted percentage and positive spending into 0% usage", async () => {
  const period = { start: new Date(now).toISOString(), end, type: "USAGE_PERIOD_TYPE_WEEKLY" };
  const s = scenario({
    files: { "/synthetic/.grok/auth.json": { "https://auth.x.ai": { key: "fake-grok" } } },
    reply: () => Response.json({
      currentPeriod: period, billingPeriodStart: period.start, billingPeriodEnd: end,
      onDemandCap: { val: "0" }, onDemandUsed: { val: "3.50" },
    }),
  });
  expect(await networkProviders.grok.read(s.ctx)).toMatchObject({
    state: "unavailable", error: "Grok did not report a usage percentage", limits: [],
  });
  expect(s.requests).toHaveLength(2);
});

test("Kimi selects the managed credential slot from its effective config URL and OAuth host", async () => {
  const baseUrl = "https://api.kimi.com/coding/custom";
  const oauthHost = "https://auth.kimi.com/alternate";
  const key = createHash("sha256").update(JSON.stringify({ oauthHost, baseUrl })).digest("hex").slice(0, 16);
  const s = scenario({
    files: {
      "/synthetic/.kimi-code/config.toml": [
        '[providers."managed:kimi-code"] # provider configuration',
        'base_url = "' + baseUrl + '/"',
        '[providers."managed:kimi-code".oauth]',
        'key = "ignored-key"',
        'oauth_host = "' + oauthHost + '/"',
      ].join("\n"),
      ["/synthetic/.kimi-code/credentials/kimi-code-env-" + key + ".json"]: { access_token: "fixture-kimi", expires_at: now / 1000 + 60 },
    },
    reply: () => Response.json({ usage: { limit: 100, used: 20 } }),
  });
  expect(await networkProviders.kimi.read(s.ctx)).toMatchObject({ limits: [{ used: 20 }] });
  expect(s.requests[0].url).toBe(baseUrl + "/usages");
});
