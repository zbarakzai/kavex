import { sessionReport } from "./antigravity-state.js";
import { BRIDGE } from "./antigravity-bridge.js";
import { MARK, launchOn } from "./antigravity-launch.js";
import { isObject, settingsIn } from "./machine.js";

// What a row says when setup couldn't finish on its machine, by cause. Setup tries again every
// ten minutes, and after Kavex restarts.
const WHY = {
  unreadable: "Kavex can't read agy's ~/.gemini/antigravity-cli/settings.json, so it left it alone.",
  off: "agy's titles are off. Turn them on with `/title on`; Kavex sets up within ten minutes, then restart agy.",
  other: "agy's title setting isn't a command Kavex can wrap, so it left it alone.",
  runtime: "Antigravity session reporting needs Node.js 18+ or Bun on this machine.",
  path: "Kavex can't set up agy's title in a home folder whose path has %, ! or \".",
  lost: "Kavex's saved copy of agy's title setting is gone, so it left agy's settings alone.",
};

// The first runtime that answers through the exact name the launcher will look for, at version 18
// or later, from a real path.
async function runtimeOn(machine, programs) {
  for (const program of programs) {
    try {
      const { code, stdout } = await machine.run(program, ["-p", "JSON.stringify([process.versions.node,process.execPath])"]);
      const [version, path] = JSON.parse(stdout);
      if (code === 0 && Number(version.split(".")[0]) >= 18 && typeof path === "string" && /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path) && !/[\x00-\x1f]/.test(path)) return program;
    } catch {}
  }
  return null;
}

// A title Kavex can wrap: none, `true` (which agy reads as one without a command), or a command.
const wrappable = (title) => title === undefined || title === true
  || (isObject(title) && (title.type === undefined || title.type === "command") && (title.command === undefined || typeof title.command === "string"));

export const antigravity = {
  // Goes up when what `install` puts on a machine changes.
  setup: 2,

  // True once set up, or what the row says when it can't be.
  async install({ home, read, write, keep }, machine) {
    const path = `${home}/.gemini/antigravity-cli/settings.json`;
    const before = await read(path);
    const settings = settingsIn(before);
    if (!settings) return WHY.unreadable;
    const { title } = settings;
    if (title === false || title?.enabled === false) return WHY.off;
    if (!wrappable(title)) return WHY.other;
    const launch = launchOn(machine);
    const runtime = await runtimeOn(machine, launch.programs);
    if (!runtime) return WHY.runtime;
    const folder = `${home}/.kavex/antigravity`;
    if (launch.unsafe(folder)) return WHY.path;
    // Set up before, the person's own title is the one saved then.
    const backup = `${folder}/title-original.json`;
    const ours = typeof title?.command === "string" && title.command.endsWith(` ${MARK}`);
    let original = title;
    if (ours) {
      const saved = await read(backup);
      if (saved === null) return WHY.lost;
      try { original = JSON.parse(saved); } catch { return WHY.lost; }
    }
    const launcher = `${folder}/${launch.file}`;
    await keep(`${folder}/title.cjs`, BRIDGE);
    await keep(launcher, launch.launcher(runtime));
    if (!ours) await keep(backup, `${JSON.stringify(title ?? null, null, 2)}\n`);
    await keep(`${folder}/title-original.txt`, launch.original(typeof original?.command === "string" ? original.command : "", home));
    const edited = { ...settings, title: { ...(isObject(title) ? title : {}), type: "command", command: launch.command(launcher) } };
    const text = `${JSON.stringify(edited, null, 2)}\n`;
    if (text !== before) await write(path, text, before);
    return true;
  },

  reports: true,
  snapshot: true,
  patience: 6000,
  waiting: { state: "waiting", say: "Antigravity session reporting needs Node.js 18+ or Bun and Kavex's title bridge. Enable titles with `/title on`, then restart agy." },

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
