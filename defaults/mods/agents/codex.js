// Codex's session: the hook that says which one a terminal holds, and the numbers in its lines.

import { PRICES, priced } from "./prices.js";

const SESSION_FILE = /^(.+[\\/]sessions)[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/]rollout-[^\\/]*?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/;

// Codex keeps this much out of both sides of the sum in its "% context left".
const BASE = 12000;

function context(used, total) {
  if (!total || total <= BASE || used > total) return { used };
  const room = total - BASE;
  return { used, total, percent: 100 - Math.round((100 * (room - Math.max(0, used - BASE))) / room) };
}

// "gpt-6.1-sol" reads "GPT-6.1 Sol"; anything else stays as Codex wrote it.
function modelName(id) {
  const [, version, name] = id.match(/^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?$/) ?? [];
  if (!version) return id;
  return `GPT-${version}${name ? ` ${name[0].toUpperCase()}${name.slice(1)}` : ""}`;
}

// What each service tier reads from a model's prices. A missing tier is the default one.
const TIERS = { default: (listed) => listed, fast: (listed) => listed?.fast, priority: (listed) => listed?.fast };

// One response at API prices, or null if any part of it has no exact price.
function dollars(model, tier, prompt, tokens) {
  const rates = TIERS[tier ?? "default"]?.(PRICES[model]);
  return priced(prompt > rates?.over?.tokens ? rates.over : rates, tokens);
}

// The hook runs these. Codex's trust covers the hook's definition, not what it runs, so what they
// do can change without asking the person again; the definition below can't. They print nothing,
// as Codex would pass it to the model, and they end well whatever happens: never in Codex's way.
const SCRIPT = `#!/bin/sh
# Zaki's Codex hook: labels this terminal with its session file, so Zaki shows the right numbers.
# Zaki writes this file. It does nothing outside a Zaki terminal.
[ -n "$HC_TERMINAL_ID" ] || exit 0
IFS= read -r hook
case "$hook" in *'"transcript_path":"'*) ;; *) exit 0 ;; esac
file=\${hook#*\\"transcript_path\\":\\"}
file=\${file%%\\"*}
for hc in hc "$HOME/.local/bin/hc" /opt/homebrew/bin/hc /usr/local/bin/hc "$HOME/.local/share/mise/shims/hc" "$HOME/.nix-profile/bin/hc" /run/current-system/sw/bin/hc "$HOME/.cargo/bin/hc"; do
  if command -v "$hc" >/dev/null 2>&1; then
    "$hc" label "$HC_TERMINAL_ID" "zaki.session=$file" >/dev/null 2>&1
    exit 0
  fi
done
exit 0
`;

const WINDOWS_SCRIPT = `# Zaki's Codex hook: labels this terminal with its session file, so Zaki shows the right numbers.
# Zaki writes this file. It does nothing outside a Zaki terminal.
if (-not $env:HC_TERMINAL_ID) { exit 0 }
try {
  $hook = New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
  $file = ($hook.ReadToEnd() | ConvertFrom-Json).transcript_path
  if (-not $file) { exit 0 }
  $hc = (Get-Command hc -ErrorAction SilentlyContinue).Source
  foreach ($usual in @("$env:LOCALAPPDATA\\Programs\\herdr-core\\hc.exe", "$env:USERPROFILE\\.cargo\\bin\\hc.exe")) {
    if (-not $hc -and (Test-Path $usual)) { $hc = $usual }
  }
  if ($hc) { & $hc label $env:HC_TERMINAL_ID "zaki.session=$file" *> $null }
} catch {}
exit 0
`;

const quoted = (path) => `'${path.replace(/'/g, `'\\''`)}'`;

// Fixed for good: any change to it asks every person to approve it again. No matcher, so it runs
// for every way a session starts, and `timeout` leaves room for a slow login shell.
const hook = (home) => ({
  type: "command",
  command: `sh ${quoted(`${home}/.zaki/codex-session.sh`)}`,
  commandWindows: `powershell -NoProfile -ExecutionPolicy Bypass -File "${home}/.zaki/codex-session.ps1"`,
  timeout: 10,
});

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// A hook file with Zaki's hook in it, the same text if it has it, or null for one Zaki can't
// understand. Codex keys each hook's approval on its position, so a new group goes last.
function withHook(text, ours) {
  let file;
  try {
    file = text?.trim() ? JSON.parse(text) : {};
  } catch {
    return null;
  }
  const groups = file?.hooks?.SessionStart;
  if (!isObject(file) || (file.hooks !== undefined && !isObject(file.hooks)) || (groups !== undefined && !Array.isArray(groups))) return null;
  if (groups?.some((group) => group?.hooks?.some?.((one) => one?.command === ours.command))) return text;
  const hooks = { ...file.hooks, SessionStart: [...(groups ?? []), { hooks: [ours] }] };
  return `${JSON.stringify({ ...file, hooks }, null, 2)}\n`;
}

// Leaves a file that already says this alone.
async function keep({ read, write }, path, text) {
  const now = await read(path);
  if (now !== text) await write(path, text, now);
}

// Older Codex names a helper only in the reply to its spawn. Only a reply that is that JSON counts:
// a tool's output can quote the same words anywhere.
const SPAWN_REPLY = /"\{\\"agent_id\\":\\"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\\"/g;

// A helper that wasn't read would leave its tokens out of the cost. A /review's helper is named in
// no line of its parent, and only searching every session file could find it.
const helpersMissing = ({ kids, reviewed }, { id, files }) => reviewed || [...kids].some(([kid, file]) => kid !== id && !files.has(file));

export const codex = {
  // Goes up when what `install` puts on a machine changes.
  setup: 1,

  // `files` reads and writes on the machine being set up. Script first, so the hook never points
  // at nothing. This is all of Codex's that Zaki touches: approving the hook is the person's.
  async install(files) {
    const { home, read, write } = files;
    await keep(files, `${home}/.zaki/codex-session.sh`, SCRIPT);
    await keep(files, `${home}/.zaki/codex-session.ps1`, WINDOWS_SCRIPT);
    const path = `${home}/.codex/hooks.json`;
    const text = await read(path);
    const edited = withHook(text, hook(home));
    if (edited === null) return false;
    if (edited !== text) await write(path, edited, text);
    return true;
  },

  // What keeps a line worth parsing. Fixed strings, and more than one is a line each.
  filter: ['"type":"token_count"', '"type":"turn_context"', '"type":"thread_settings_applied"', '"type":"SubAgentActivity"', '"type":"EnteredReviewMode"', '"{\\"agent_id\\":\\"'].join("\n"),

  reports: true,
  waiting: { state: "waiting", say: "Run `/hooks` in Codex, trust Zaki's hook, then restart this Codex." },

  // Nothing on disk ties a Codex process to a session, so its hook labels the terminal.
  locate(_term, label) {
    const [, folder, id] = label?.match(SESSION_FILE) ?? [];
    return id ? { id, folder, file: label } : null;
  },

  // A helper is a session of its own, on whatever day it started. Its parent's lines name it,
  // so only a name not yet matched to a file costs a search, and no helpers cost nothing.
  async helpers({ id, folder, facts }, machine) {
    const { kids } = facts;
    const lost = [...kids.keys()].filter((kid) => kid !== id && !kids.get(kid));
    if (lost.length) {
      for (const file of await machine.find(folder, lost.map((kid) => `${kid}.jsonl`))) {
        const kid = lost.find((one) => file.endsWith(`${one}.jsonl`));
        if (kid) kids.set(kid, file);
      }
    }
    const files = [...kids.values()].filter(Boolean);
    return files.length ? machine.sizes(files) : [];
  },

  // Running totals, as for Claude. `files` holds each file's model, tier and what it has counted,
  // and `kids` the helpers named so far, with their files once found.
  facts: () => ({ newest: null, model: null, files: new Map(), kids: new Map(), reviewed: false, tokens: { input: 0, output: 0, cached: 0 }, cost: 0, unpriced: false }),

  // A file's totals can fall back to zero mid-session and don't say which model used what, so
  // the cost is each response's own usage. Codex repeats a record when only rate limits changed,
  // and a window reads lines twice: a record's figures say which it was.
  add(facts, line, helper, file) {
    const { payload } = line;
    let kept = facts.files.get(file);
    if (!kept) facts.files.set(file, (kept = { model: null, tier: null, counted: new Set() }));
    if (line.type === "turn_context") {
      kept.model = payload?.model;
      if (!helper) facts.model = payload?.model;
      return;
    }
    const named = (kid) => facts.kids.has(kid) || facts.kids.set(kid, null);
    if (line.type === "response_item") {
      for (const [, kid] of JSON.stringify(payload?.output ?? "").matchAll(SPAWN_REPLY)) named(kid);
      return;
    }
    if (line.type !== "event_msg") return;
    if (payload?.type === "thread_settings_applied") kept.tier = payload.thread_settings?.service_tier;
    if (payload?.item?.type === "SubAgentActivity" && payload.item.agent_thread_id) named(payload.item.agent_thread_id);
    if (payload?.item?.type === "EnteredReviewMode") facts.reviewed = true;
    if (payload?.type !== "token_count") return;
    const last = payload.info?.last_token_usage, total = payload.info?.total_token_usage;
    if (!last) return;
    const record = `${total?.total_tokens} ${last.total_tokens} ${last.output_tokens}`;
    if (kept.counted.has(record)) return;
    kept.counted.add(record);
    if (!helper) facts.newest = { used: last.total_tokens, total: payload.info.model_context_window };
    const cached = last.cached_input_tokens ?? 0;
    const input = Math.max(0, (last.input_tokens ?? 0) - cached), output = last.output_tokens ?? 0;
    const cost = dollars(kept.model, kept.tier, last.input_tokens, { input, read: cached, write: last.cache_write_input_tokens ?? 0, output });
    facts.tokens.input += input;
    facts.tokens.output += output;
    facts.tokens.cached += cached;
    facts.cost += cost ?? 0;
    if (cost === null) facts.unpriced = true;
  },

  numbers: (facts, session) => facts.newest && { model: modelName(facts.model ?? "Codex"), context: context(facts.newest.used, facts.newest.total), tokens: { ...facts.tokens }, cost: facts.unpriced || helpersMissing(facts, session) ? undefined : facts.cost },
};
