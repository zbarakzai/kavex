// Claude Code's session: where it is, and the numbers in its lines.

import { exec, home, readTextFile } from "herdr";

const folderName = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

// "claude-opus-5-5" reads "Claude Opus 5.5"; anything else stays as Claude wrote it.
function modelName(id) {
  const [, name, major, minor] = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/) ?? [];
  return name ? `Claude ${name[0].toUpperCase()}${name.slice(1)} ${major}${minor ? `.${minor}` : ""}` : id;
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

  facts: () => ({ seen: new Set(), newest: null, tokens: { input: 0, output: 0, cached: 0 } }),

  // A message comes on several lines, one per block, each with the same usage. "<synthetic>"
  // lines are Claude's own notices, with no usage to speak of.
  add(facts, line) {
    const message = line.message, usage = message?.usage;
    if (line.type !== "assistant" || line.isSidechain || !usage || message.model === "<synthetic>") return;
    const input = usage.input_tokens ?? 0;
    const cached = (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    facts.newest = { model: message.model, asked: line.requestedModel ?? message.model, used: input + cached };
    if (facts.seen.has(message.id)) return;
    facts.seen.add(message.id);
    facts.tokens.input += input;
    facts.tokens.output += usage.output_tokens ?? 0;
    facts.tokens.cached += cached;
  },

  numbers: (facts) => facts.newest && { model: modelName(facts.newest.model), asked: facts.newest.asked, used: facts.newest.used, tokens: { ...facts.tokens } },

  // Claude's files don't say how big a model's context is, but `/context` does, at no tokens.
  async limit(model) {
    const { stdout } = await exec("claude", ["-p", "/context", "--output-format", "json", "--model", model, "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""]);
    const [, amount, unit] = stdout.match(/\*\*Tokens:\*\*\s*\S+\s*\/\s*([\d.]+)([km]?)/i) ?? [];
    return amount ? Math.round(Number(amount) * ({ k: 1e3, m: 1e6 }[unit.toLowerCase()] ?? 1)) : null;
  },
};
