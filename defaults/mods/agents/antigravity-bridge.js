import { liveReport, sessionReport } from "./antigravity-state.js";
import { DEFAULT_TITLE } from "./antigravity-launch.js";
import { HC_PLACES, hcPrograms } from "./machine.js";

// Runs under Node.js or Bun on the agent's machine. Title stdout belongs to the person;
// the small allowlisted snapshot goes straight to that terminal's existing session label.
export const BRIDGE = `// Kavex's Antigravity title bridge. Kavex writes this file.
const sessionReport = ${sessionReport.toString()};
const liveReport = ${liveReport.toString()};
const hcPrograms = ${hcPrograms.toString()};
const places = ${JSON.stringify(HC_PLACES)};
const DEFAULT_TITLE = ${JSON.stringify(DEFAULT_TITLE)};
` + String.raw`
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

// Whatever stops the input being read, the person's own title still runs.
let raw = "";
try { raw = readFileSync(0, "utf8"); } catch {}

// The original command, saved ready for this system's shell, still gets the unmodified input, in
// the same working directory. agy stops a title command after five seconds; the label below needs
// well under one of them.
try {
  const command = readFileSync(join(__dirname, "title-original.txt"), "utf8");
  if (command.trim()) {
    const child = spawnSync(command, { shell: true, input: raw, encoding: "utf8", windowsHide: true, timeout: 4000, maxBuffer: 65536 });
    if (child.stdout) process.stdout.write(child.stdout);
  } else process.stdout.write(DEFAULT_TITLE);
} catch {}

try {
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal) process.exit(0);
  const state = JSON.parse(raw);
  if (state?.product !== "antigravity") process.exit(0);
  const report = liveReport(state, terminal);
  if (!report) process.exit(0);
  // An empty conversation reports only its identity marker, clearing the previous numbers.
  const label = "antigravity:" + JSON.stringify(report);
  // From Kavex's own folder, not the project: Windows looks for a bare name in the current folder
  // before PATH, unless NoDefaultCurrentDirectoryInExePath is set.
  for (const program of hcPrograms(places, process.platform === "win32", homedir(), process.env.LOCALAPPDATA)) {
    const child = spawnSync(program, ["label", terminal, "kavex.session=" + label], { cwd: __dirname, windowsHide: true, timeout: 750, stdio: "ignore" });
    if (child.error?.code !== "ENOENT") break;
  }
} catch {}
`;
