import { PRICES, REGIONS, priced } from "./prices.js";

const folderName = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

function modelName(id) {
  const [, name, major, minor] = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/) ?? [];
  return name ? `Claude ${name[0].toUpperCase()}${name.slice(1)} ${major}${minor ? `.${minor}` : ""}` : id;
}

function dollars(model, speed, region, tokens) {
  const listed = PRICES[model];
  const prompt = tokens.input + tokens.read + tokens.write5m + tokens.write1h;
  const sized = prompt > listed?.over?.tokens ? listed.over : listed;
  const cost = priced(speed === "standard" ? sized : sized?.[speed], tokens);
  return cost === null || REGIONS[region] === undefined ? null : cost * REGIONS[region];
}

export const claude = {
  filter: '"type":"assistant"',

  async locate({ term, machine }) {
    const pid = term.foreground?.pid;
    if (!pid) return null;
    const configs = await machine.configs();
    for (const { pid: candidate, started } of await machine.processes(pid)) {
      for (const config of configs) {
        const record = await machine.read(`${config}/sessions/${candidate}.json`);
        if (!record) continue;
        const { sessionId, cwd, startedAt } = JSON.parse(record);
        // A crash leaves its record, and Windows hands pids on fast: a process can't be newer than
        // its own record, so one that is, or that can't be shown not to be, is someone else's.
        if (started !== undefined && !(started <= startedAt)) continue;
        if (!sessionId || !cwd) return null;
        const folder = `${config}/projects/${folderName(cwd)}`;
        return { id: sessionId, folder, file: `${folder}/${sessionId}.jsonl` };
      }
    }
    return null;
  },

  helpers: ({ folder, id }, machine) => machine.inside(`${folder}/${id}/subagents`),

  facts: () => ({ newest: null, messages: new Map(), tokens: { input: 0, output: 0, cached: 0 }, cost: 0, unpriced: false }),

  // A message comes on several lines, one per block, and counts once. A helper's early lines
  // hold a part-way output count, so the biggest is the real one. "<synthetic>" lines are
  // Claude's own notices, with no usage to speak of.
  add(facts, line, helper) {
    const message = line.message, usage = message?.usage;
    if (line.type !== "assistant" || !usage || message.model === "<synthetic>") return;
    const input = usage.input_tokens ?? 0, output = usage.output_tokens ?? 0;
    const read = usage.cache_read_input_tokens ?? 0, write = usage.cache_creation_input_tokens ?? 0;
    if (!helper && !line.isSidechain) facts.newest = { model: message.model, asks: line.requestedModel ?? message.model, used: input + read + write };
    const kept = facts.messages.get(message.id);
    if (kept?.output >= output) return;
    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const cost = dollars(message.model, usage.speed ?? "standard", usage.inference_geo ?? "global", { input, output, read, write5m: write - write1h, write1h });
    facts.messages.set(message.id, { output, cost });
    facts.tokens.output += output - (kept?.output ?? 0);
    facts.cost += (cost ?? 0) - (kept?.cost ?? 0);
    if (cost === null) facts.unpriced = true;
    if (kept) return;
    facts.tokens.input += input;
    facts.tokens.cached += read + write;
  },

  numbers: (facts) => facts.newest && { model: modelName(facts.newest.model), asks: facts.newest.asks, context: { used: facts.newest.used }, tokens: { ...facts.tokens }, cost: facts.unpriced ? undefined : facts.cost },

  // Claude's files don't say how big a model's context is, but `/context` does, at no tokens.
  async total(model, machine) {
    const { stdout } = await machine.run("claude", ["-p", "/context", "--output-format", "json", "--model", model, "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""]);
    const [, amount, unit] = stdout.match(/\*\*Tokens:\*\*\s*\S+\s*\/\s*([\d.]+)([km]?)/i) ?? [];
    return amount ? Math.round(Number(amount) * ({ k: 1e3, m: 1e6 }[unit.toLowerCase()] ?? 1)) : null;
  },
};
