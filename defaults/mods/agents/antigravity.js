import { sessionReport } from "./antigravity-state.js";
import { BRIDGE } from "./antigravity-bridge.js";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const quoted = (path) => `'${path.replace(/'/g, `'\\''`)}'`;

async function runtimeOn(machine) {
  for (const program of ["node", "bun"]) {
    try {
      const { code, stdout } = await machine.run(program, ["-p", "JSON.stringify([process.versions.node,process.execPath])"]);
      const [version, path] = JSON.parse(stdout);
      if (code === 0 && Number(version.split(".")[0]) >= 18 && typeof path === "string" && /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path) && !/[\x00-\x1f]/.test(path)) return path;
    } catch {}
  }
  return null;
}

export const antigravity = {
  setup: 1,

  async install({ home, read, write, keep }, machine) {
    const path = `${home}/.gemini/antigravity-cli/settings.json`;
    const before = await read(path);
    let settings;
    try { settings = before?.trim() ? JSON.parse(before) : {}; } catch { return false; }
    if (!object(settings)) return false;
    const title = settings.title;
    if (title === false || (title !== undefined && title !== true && !object(title))) return false;
    if (title?.enabled === false || (title?.type !== undefined && title.type !== "command") || (title?.command !== undefined && typeof title.command !== "string")) return false;
    const runtime = await runtimeOn(machine);
    if (!runtime) return false;
    const folder = `${home}/.kavex/antigravity`;
    const script = `${folder}/title.cjs`;
    const windows = /^(?:[a-z]:[\\/]|\\\\)/i.test(runtime);
    // cmd expands these even inside quotes; leave unusual paths alone rather than run them.
    if (windows && /[%!"\r\n]/.test(runtime + script)) return false;
    const word = windows ? (path) => `"${path}"` : quoted;
    const command = `${word(runtime)} ${word(script)} --kavex-antigravity`;
    const ours = typeof title?.command === "string" && title.command.endsWith(" --kavex-antigravity");
    const original = `${folder}/title-original.json`;
    if (ours && await read(original) === null) return false;
    await keep(script, BRIDGE);
    if (!ours) await keep(original, `${JSON.stringify(title ?? null, null, 2)}\n`);
    const edited = { ...settings, title: { ...(object(title) ? title : {}), type: "command", command } };
    const text = `${JSON.stringify(edited, null, 2)}\n`;
    if (text !== before) await write(path, text, before);
    return true;
  },

  reports: true,
  snapshot: true,
  patience: 6000,
  waiting: { state: "waiting", say: "Antigravity session reporting needs Node.js or Bun and Kavex's title bridge. Enable titles with `/title on`, then restart agy." },

  locate({ label, term }) {
    if (!label?.startsWith("antigravity:") || label.length > 4096) return null;
    let value;
    try { value = JSON.parse(label.slice("antigravity:".length)); } catch { return null; }
    const report = sessionReport(value, term.address.split("/").at(-1));
    if (!report) return null;
    const { session: id, model, percent, total, input, output, cost, estimated } = report;
    const ready = [percent, input, output, cost].some((value) => value !== undefined);
    const result = ready ? { state: "ready", model, context: { percent, total }, tokens: { input, output }, cost, estimated } : { state: "empty", say: "No usage yet" };
    return { id, result };
  },
};
