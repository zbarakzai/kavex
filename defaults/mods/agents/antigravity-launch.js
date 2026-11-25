// How agy's title command starts on each kind of machine: the one place in the Antigravity adapter
// that knows Windows runs it through `cmd` and everything else through `sh`. A launcher runs the
// bridge with the runtime Kavex checked, found again through PATH so an upgraded one keeps working.
// With no runtime left it runs the person's own title command, exactly as the bridge would.

import { quoted } from "./machine.js";

export const MARK = "--kavex-antigravity";

// What agy's title reads when the person had no title command: without one, agy leaves the title
// alone, which a command can't do, and an empty title isn't promised to mean the same.
export const DEFAULT_TITLE = "agy";

const unix = {
  programs: ["node", "bun"],
  file: "title.sh",
  // Sourced rather than run with `sh -c`, so no program but `sh` is needed when the runtime is gone.
  launcher: (program) => [
    "# Kavex's Antigravity title launcher. Kavex writes this file.",
    'here=${0%/*}',
    `if command -v ${program} >/dev/null 2>&1; then exec ${program} "$here/title.cjs"; fi`,
    "set --",
    `[ -s "$here/title-original.txt" ] || { printf '%s\\n' ${DEFAULT_TITLE}; exit 0; }`,
    '. "$here/title-original.txt"',
    "",
  ].join("\n"),
  command: (launcher) => `sh ${quoted(launcher)} ${MARK}`,
  // `sh` expands a leading ~ itself, as agy does.
  original: (command) => command,
  unsafe: () => false,
};

// cmd's usual lookup also searches the current project folder, so the runtime is found through
// PATH alone. The person's command runs as `cmd /d /s /c "<command>"`, the way Node.js runs a
// shell command for the bridge, and `for /f` hands it over without cmd reading it a second time.
// https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/for
const windows = {
  // The exact names the launcher will search, including npm shims.
  programs: ["node.exe", "node.cmd", "node.bat", "bun.exe", "bun.cmd", "bun.bat"],
  file: "title.cmd",
  launcher: (program) => [
    "@echo off", "setlocal EnableExtensions DisableDelayedExpansion",
    `for %%R in (${program}) do (`,
    '  if not "%%~$PATH:R"=="" (', '    "%%~$PATH:R" "%~dp0title.cjs"', "    exit /b", "  )", ")",
    'if exist "%~dp0title-original.txt" (',
    '  for /f usebackq^ delims^=^ eol^= %%C in ("%~dp0title-original.txt") do (',
    '    "%ComSpec%" /d /s /c "%%C"', "    exit /b", "  )", ")",
    `echo ${DEFAULT_TITLE}`, "exit /b 0", "",
  ].join("\r\n"),
  command: (launcher) => `"${launcher}" ${MARK}`,
  // agy expands a leading ~ on every system and cmd doesn't, so it's done once, here. The path is
  // quoted up to an argument or a shell operator.
  original: (command, home) => command.replace(/^~([\\/][^\s&|<>]*)/, (_match, rest) => `"${home}${rest}"`),
  // cmd expands these even inside quotes; leave unusual paths alone rather than run them.
  unsafe: (path) => /[%!"\r\n]/.test(path),
};

export const launchOn = (machine) => (machine.windows ? windows : unix);
