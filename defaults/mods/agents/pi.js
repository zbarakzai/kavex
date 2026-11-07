import { HC_PLACES } from "./machine.js";

const place = (path) => (path.startsWith("~/") ? `join(home, ${JSON.stringify(path.slice(2))})` : JSON.stringify(path));

// Pi started by a tool in this terminal (`pi -p`) isn't this terminal's agent, hence `ctx.mode`.
const EXTENSION = `// Kavex's Pi extension: labels this terminal with its session file and its context's total, so Kavex
// shows the right numbers. Kavex writes this file. It does nothing outside a Kavex terminal.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const places = [
  "hc",
  ${HC_PLACES.map(place).join(",\n  ")},
  join(process.env.LOCALAPPDATA ?? home, "Programs/herdr-core/hc.exe"),
];

function label(args, tries = places) {
  if (!tries.length) return;
  execFile(tries[0], args, { windowsHide: true }, (failed) => {
    if (failed?.code === "ENOENT") label(args, tries.slice(1));
  });
}

export default function (pi) {
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal) return;
  const report = (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    if (ctx.mode !== "tui" || !file) return;
    label(["label", terminal, "kavex.session=" + file, "kavex.total=" + (ctx.getContextUsage()?.contextWindow ?? "")]);
  };
  pi.on("session_start", report);
  pi.on("model_select", report);
}
`;

const SESSION_FILE = /^((?:[A-Za-z]:)?[\\/].*)[\\/]([^\\/]+)\.jsonl$/;

// Pi's own rule for a usage it trusts as the size of the context.
function contextOf({ stopReason, usage }) {
  if (stopReason === "aborted" || stopReason === "error" || !usage) return 0;
  return usage.totalTokens || (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

// A usage with tokens and no cost is a model Pi has no price for, which it stores as 0.
function count(facts, usage) {
  if (!usage) return;
  const input = usage.input ?? 0, output = usage.output ?? 0, cached = (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  if (!(input + output + cached)) return;
  facts.tokens.input += input;
  facts.tokens.output += output;
  facts.tokens.cached += cached;
  facts.counted = true;
  if (usage.cost?.total > 0) facts.cost += usage.cost.total;
  else facts.unpriced = true;
}

export const pi = {
  // Goes up when what `install` puts on a machine changes.
  setup: 1,

  async install({ home, keep }) {
    await keep(`${home}/.pi/agent/extensions/kavex-session.ts`, EXTENSION);
    return true;
  },

  filter: ['"cacheRead":', '"type":"compaction"', '"type":"model_change"'].join("\n"),

  reports: true,

  // The extension runs at launch, so past this a Pi with no label isn't just still starting.
  patience: 6000,
  waiting: { state: "waiting", say: "Run `/reload` in Pi to load Kavex's extension." },

  // Any folder can hold a session, with `--session-dir`, so all a path has to be is one.
  locate({ label, total }) {
    const [, folder, id] = label?.match(SESSION_FILE) ?? [];
    return id ? { id, folder, file: label, total: Number(total) > 0 ? Number(total) : undefined } : null;
  },

  // `seen` is because a window reads lines twice.
  facts: () => ({ seen: new Set(), model: null, used: null, counted: false, tokens: { input: 0, output: 0, cached: 0 }, cost: 0, unpriced: false }),

  add(facts, line) {
    if (!line.id || facts.seen.has(line.id)) return;
    facts.seen.add(line.id);
    const { type, usage, message } = line;
    if (type === "model_change") facts.model = line.modelId ?? facts.model;
    if (type === "compaction") facts.used = null;
    if (type === "compaction" || type === "branch_summary" || type === "usage") count(facts, usage);
    if (type !== "message" || !message) return;
    count(facts, message.usage);
    if (message.role !== "assistant") return;
    facts.model = message.responseModel ?? message.model ?? facts.model;
    facts.used = contextOf(message) || facts.used;
  },

  numbers: (facts, { total, torn }) => (facts.counted || torn.size > 0) && { model: facts.model ?? "Pi", context: { used: torn.size ? null : facts.used, total }, tokens: { ...facts.tokens }, cost: facts.unpriced || torn.size ? undefined : facts.cost },
};
