import { expect, test } from "bun:test";
import { readClaudePlan, readCodexBackend } from "../defaults/mods/usage/provider-plans.js";

const NOW = 1929160800000;

test("Claude maps the signed-in account through provider windows and scoped limits", async () => {
  const requests: unknown[] = [];
  const result = await readClaudePlan({
    platform: "linux",
    home: "/test-home",
    now: () => NOW,
    env: async () => null,
    read: async (path: string) => {
      expect(path).toBe("/test-home/.claude/.credentials.json");
      return JSON.stringify({ claudeAiOauth: { accessToken: "sample-oauth", subscriptionType: "max", rateLimitTier: "default_claude_max_20x" } });
    },
    request: async (url: string, options: any) => {
      requests.push([url, options.headers.Authorization]);
      return Response.json({
        five_hour: { utilization: 18.9, resets_at: NOW + 3600000 },
        limits: [{ kind: "weekly_scoped", percent: 30.5, resets_at: (NOW + 86400000) / 1000, scope: { model: { display_name: "Fable" } } }],
      });
    },
  });
  expect(requests).toEqual([["https://api.anthropic.com/api/oauth/usage", "Bearer sample-oauth"]]);
  expect(result).toMatchObject({ plan: "Max 20x", limits: [
    { key: "session", used: 18.9, resetsAt: NOW + 3600000 },
    { key: "fable", scoped: true, used: 30.5, resetsAt: NOW + 86400000 },
  ] });
  expect(JSON.stringify(result)).not.toContain("sample-oauth");
});

test("Claude treats 429 as a transient result and respects Retry-After", async () => {
  const result = await readClaudePlan({
    platform: "linux", home: "/test-home", now: () => NOW, env: async () => null,
    read: async () => '{"claudeAiOauth":{"accessToken":"sample"}}',
    request: async () => new Response(null, { status: 429, headers: { "Retry-After": "3600" } }),
  });
  expect(result).toMatchObject({ state: "error", kind: "rate-limited", retryAt: NOW + 3600000, limits: [] });
});

test("Codex account fallback sends the request to the documented integration origin", async () => {
  const result = await readCodexBackend({
    platform: "linux",
    home: "/test-home",
    now: () => NOW,
    env: async () => "/configured-codex",
    read: async (path: string) => {
      expect(path).toBe("/configured-codex/auth.json");
      return '{"tokens":{"access_token":"sample-token","account_id":"sample-account"}}';
    },
    request: async (url: string, options: any) => {
      expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
      expect(options.headers).toMatchObject({ Authorization: "Bearer sample-token", "ChatGPT-Account-Id": "sample-account" });
      return Response.json({ plan_type: "enterprise", spend_control: { individual_limit: { remaining_percent: 75, reset_at: NOW / 1000 } } });
    },
  });
  expect(result).toMatchObject({ plan: "enterprise", limits: [{ key: "monthly", used: 25, resetsAt: NOW }] });
  expect(JSON.stringify(result)).not.toContain("sample-account");
});
