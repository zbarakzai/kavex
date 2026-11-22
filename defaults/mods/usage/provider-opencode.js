// OpenCode Go's keyed endpoint is shared with Orca's preferred usage source.
const ENDPOINT = "https://opencode.ai/zen/go/v1/usage";
const WINDOWS = [
  ["weekly", "This week", 10080],
  ["rolling", "5 hours", 300],
  ["monthly", "This month", 43200],
];

function goLimits(answer, now) {
  const usage = answer?.usage ?? answer ?? {};
  const windows = WINDOWS.flatMap(([key, label, minutes]) => {
    const meter = usage[key] ?? answer?.[`${key}Usage`];
    const value = meter?.percent ?? meter?.usagePercent;
    if (!Number.isFinite(value) || value < 0) return [];
    const seconds = meter.resetInSec;
    const reset = meter.resetsAt ? Date.parse(meter.resetsAt)
      : Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : NaN;
    return [{
      key, label, minutes, resetsAt: Number.isFinite(reset) ? reset : null,
      used: meter.status === "rate-limited" ? 100 : Math.min(100, Math.round(value)),
    }];
  });
  if (answer?.usage && !windows.some(({ key }) => key === "weekly")) return [];
  if (answer?.usage && !windows.some(({ key }) => key === "rolling")) return [];
  return windows;
}

async function savedKeys(ctx) {
  const xdg = await ctx.env("XDG_DATA_HOME").catch(() => null);
  const dir = `${xdg || `${ctx.home}/.local/share`}/opencode`;
  const keys = new Set();
  const collect = (entry) => {
    const key = String((typeof entry === "string" ? entry : entry?.key) ?? "").trim();
    if (/^[A-Za-z0-9][\w.~+/=-]*$/.test(key)) keys.add(key);
  };
  const sql = "SELECT value FROM credential WHERE active = 1 AND integration_id IN ('opencode-go', 'opencode') ORDER BY integration_id = 'opencode-go' DESC";
  let failed = false;
  try {
    const rows = await ctx.exec("sqlite3", ["-cmd", ".timeout 1000", "-readonly", `${dir}/opencode.db`, sql]);
    if (rows.code === 0) {
      for (const row of rows.stdout.split("\n").filter(Boolean)) collect(JSON.parse(row));
    } else {
      failed = !/unable to open database file|no such table: credential|not recognized|not found/i.test(rows.stderr);
    }
  } catch (error) {
    failed = error instanceof SyntaxError;
  }
  try {
    const auth = JSON.parse((await ctx.read(`${dir}/auth.json`)) ?? "{}");
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw new Error("invalid OpenCode auth file");
    collect(auth["opencode-go"]);
    collect(auth.opencode);
  } catch {
    failed = true;
  }
  if (failed && !keys.size) throw new Error("could not read OpenCode credentials");
  return keys;
}

export async function opencode(ctx) {
  let failed = false;
  for (const key of await savedKeys(ctx)) {
    try {
      const response = await ctx.request(ENDPOINT, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "kavex-usage/1.0" },
      });
      if (response.status === 401 || response.status === 403) continue;
      if (response.status === 429) {
        const header = response.headers?.get("retry-after");
        const now = ctx.now(), seconds = header ? Number(header) : NaN;
        const date = header && !Number.isFinite(seconds) ? Date.parse(header) : NaN;
        const retryAt = Math.min(now + 86_400_000, Number.isFinite(seconds) ? now + seconds * 1000
          : Number.isFinite(date) && date > now ? date : now + 5 * 60_000);
        return { state: "error", kind: "rate-limited", error: "OpenCode Go usage is rate limited.", retryAt, limits: [] };
      }
      const body = await response.json();
      if (!response.ok && ["AuthError", "EntitlementError"].includes(body?.error?.type)) continue;
      const limits = response.ok ? goLimits(body, ctx.now()) : [];
      if (limits.length) return { plan: "Go", limits };
      failed = true;
    } catch {
      failed = true;
    }
  }
  if (failed) return { state: "error", error: "OpenCode Go usage is unavailable.", limits: [] };
  return null;
}
