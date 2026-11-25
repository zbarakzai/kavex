import { liveReport, sessionReport } from "./antigravity-state.js";
import { HC_PLACES } from "./machine.js";

// Search PATH explicitly: cmd's usual lookup also searches the current project directory.
// The launcher follows runtime upgrades without pinning a version-manager's old executable.
// https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/for
export function windowsLauncher(program) {
  return [
    "@echo off", "setlocal EnableExtensions DisableDelayedExpansion", `for %%R in (${program}) do (`,
    '  if not "%%~$PATH:R"=="" (', '    "%%~$PATH:R" "%~dp0title.cjs"',
    "    exit /b", "  )", ")", "exit /b 0", "",
  ].join("\r\n");
}

// Runs under Node.js or Bun on the agent's machine. Title stdout belongs to the person;
// the small allowlisted snapshot goes straight to that terminal's existing session label.
export const BRIDGE = `// Kavex's Antigravity title bridge. Kavex writes this file.
const sessionReport = ${sessionReport.toString()};
const liveReport = ${liveReport.toString()};
const places = ${JSON.stringify(HC_PLACES)};
` + String.raw`
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");
const { spawnSync } = require("node:child_process");
const raw = readFileSync(0, "utf8");

// The original command still gets the unmodified input, in the same working directory.
// Antigravity expands a leading ~ on Windows as well as on Unix.
try {
  const title = JSON.parse(readFileSync(join(__dirname, "title-original.json"), "utf8"));
  let command = title?.command;
  if (typeof command === "string" && command) {
    // cmd has no tilde expansion. Quote the path up to an argument or shell operator.
    if (process.platform === "win32") command = command.replace(/^~([\\/][^\s&|<>]*)/, (_match, path) => '"' + homedir() + path + '"');
    const child = spawnSync(command, { shell: true, input: raw, encoding: "utf8", windowsHide: true, timeout: 3000, maxBuffer: 65536 });
    if (child.stdout) process.stdout.write(child.stdout);
  }
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
  const usual = places.map((path) => path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
  if (process.platform === "win32") usual.unshift(join(process.env.LOCALAPPDATA || homedir(), "Programs/herdr-core/hc.exe"), join(homedir(), ".cargo/bin/hc.exe"));
  for (const program of ["hc", ...usual]) {
    const child = spawnSync(program, ["label", terminal, "kavex.session=" + label], { windowsHide: true, timeout: 750, stdio: "ignore" });
    if (child.error?.code !== "ENOENT") break;
  }
} catch {}
`;
