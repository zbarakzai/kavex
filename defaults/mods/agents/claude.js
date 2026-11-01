// Claude Code's session: where it is, and the numbers in its lines.

import { exec, home, readTextFile } from "herdr";
import { PRICES, REGIONS, priced } from "./prices.js";

const folderName = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

// "claude-opus-5-5" reads "Claude Opus 5.5"; anything else stays as Claude wrote it.
function modelName(id) {
  const [, name, major, minor] = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/) ?? [];
  return name ? `Claude ${name[0].toUpperCase()}${name.slice(1)} ${major}${minor ? `.${minor}` : ""}` : id;
}

// One message at API prices, or null if any part of it has no exact price.
function dollars(model, speed, region, tokens) {
  const listed = PRICES[model];
  const prompt = tokens.input + tokens.read + tokens.write5m + tokens.write1h;
  const sized = prompt > listed?.over?.tokens ? listed.over : listed;
  const spent = priced(speed === "standard" ? sized : sized?.[speed], tokens);
  return spent === null || REGIONS[region] === undefined ? null : spent * REGIONS[region];
}

export const claude = {
  // What keeps a line worth parsing, cheaply: the rest of a session is most of its size.
  filter: '"type":"assistant"',

  // Claude keeps a record per process, so agents in one folder never mix.
  async locate(term) {
    const pid = term.foreground?.pid;
    if (!pid) return null;
    const record = await readTextFile(`${home()}/.claude/sessions/${pid}.json`);
    if (!record) return null;
    const { sessionId, cwd } = JSON.parse(record);
    if (!sessionId || !cwd) return null;
    const folder = `${home()}/.claude/projects/${folderName(cwd)}`;
    return { id: sessionId, folder, file: `${folder}/${sessionId}.jsonl` };
  },

  // A helper has a file of its own beside the session. One `wc` says how big they all are.
  async helpers({ folder, id }) {
    const { stdout } = await exec("sh", ["-c", 'wc -c "$1"/*.jsonl 2>/dev/null', "sh", `${folder}/${id}/subagents`]);
    return stdout.split("\n").flatMap((line) => {
      const [, size, file] = line.match(/^\s*(\d+)\s(.+\.jsonl)$/) ?? [];
      return file ? [{ file, size: Number(size) }] : [];
    });
  },

  // Running totals: reading a session comes down to `add`, so `numbers` stays cheap however long
  // it gets. `messages` holds what each one has added so far.
  facts: () => ({ newest: null, messages: new Map(), tokens: { input: 0, output: 0, cached: 0 }, cost: 0, unpriced: false }),

  // A message comes on several lines, one per block, and counts once. A helper's early lines
  // hold a part-way output count, so the biggest is the real one. "<synthetic>" lines are
  // Claude's own notices, with no usage to speak of.
  add(facts, line, helper) {
    const message = line.message, usage = message?.usage;
    if (line.type !== "assistant" || !usage || message.model === "<synthetic>") return;
    const input = usage.input_tokens ?? 0, output = usage.output_tokens ?? 0;
    const read = usage.cache_read_input_tokens ?? 0, write = usage.cache_creation_input_tokens ?? 0;
    if (!helper && !line.isSidechain) facts.newest = { model: message.model, asked: line.requestedModel ?? message.model, used: input + read + write };
    const kept = facts.messages.get(message.id);
    if (kept?.output >= output) return;
    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const spent = dollars(message.model, usage.speed ?? "standard", usage.inference_geo ?? "global", { input, output, read, write5m: write - write1h, write1h });
    facts.messages.set(message.id, { output, spent });
    facts.tokens.output += output - (kept?.output ?? 0);
    facts.cost += (spent ?? 0) - (kept?.spent ?? 0);
    if (spent === null) facts.unpriced = true;
    if (kept) return;
    facts.tokens.input += input;
    facts.tokens.cached += read + write;
  },

  numbers: (facts) => facts.newest && { model: modelName(facts.newest.model), asked: facts.newest.asked, used: facts.newest.used, tokens: { ...facts.tokens }, cost: facts.unpriced ? undefined : facts.cost },

  // Claude's files don't say how big a model's context is, but `/context` does, at no tokens.
  async limit(model) {
    const { stdout } = await exec("claude", ["-p", "/context", "--output-format", "json", "--model", model, "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""]);
    const [, amount, unit] = stdout.match(/\*\*Tokens:\*\*\s*\S+\s*\/\s*([\d.]+)([km]?)/i) ?? [];
    return amount ? Math.round(Number(amount) * ({ k: 1e3, m: 1e6 }[unit.toLowerCase()] ?? 1)) : null;
  },
};
