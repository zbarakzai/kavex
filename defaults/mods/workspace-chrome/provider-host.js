// Process, filesystem and network access for a single execution owner.
import { exec as execute, home, readTextFile, shared, window } from "herdr";

export const usageOff = () => shared("usage.enabled") === false;

async function exec(...call) {
  if (usageOff() || !shared("usage")?.era) throw new Error("usage was turned off");
  return execute(...call);
}

// Dock-started apps miss what shell startup files add (nvm, most of all), so each machine's PATH
// comes from the shell agents start in, and only that: the checks themselves run in `sh`.
const PATH_LINE = `"\${SHELL:-sh}" -ic 'printenv PATH' 2>/dev/null </dev/null | tail -n 1`;
const usesPowershell = (on) => !on && window()?.platform === "windows";

async function shellPath(on) {
  // Windows apps get the person's PATH from the system, not from shell startup files, and there's no `sh`.
  if (usesPowershell(on)) return "";
  try {
    return (await exec("sh", ["-c", PATH_LINE], { on })).stdout.trim();
  } catch {
    return "";
  }
}

function inShell({ on, path }, posix, powershell) {
  if (usesPowershell(on)) return exec("powershell", ["-NoLogo", "-NoProfile", "-Command", powershell]);
  return exec("sh", ["-c", `[ -n "$1" ] && PATH="$1" && export PATH; ${posix}`, "sh", path], { on });
}

// programs.json's `run` is the person's, so it reaches a shell as words and never as script. PowerShell
// also ends a quoted string at a curly quote.
const posixWords = (run) => run.map((word) => (/^[\w@%+:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)).join(" ");
const powershellWord = (word) => `'${word.replace(/['‘’‚‛]/g, "$&$&")}'`;
const powershellCall = (program) => `& ${powershellWord(program)}`;

const HAS = "kavex-has:", ASKED = "kavex-asked";

// knownAgents also says "not installed" when it couldn't ask, and on an added machine it looks in
// another PATH than the agents', so the machine's own shell settles it. Null: it can't be asked.
async function shellFinds(where, programs) {
  if (!programs.length) return new Set();
  if (!where.path && !usesPowershell(where.on)) return null;
  try {
    const { stdout } = await inShell(where,
      `for c in ${posixWords(programs)}; do command -v "$c" >/dev/null 2>&1 && echo "${HAS}$c"; done; echo ${ASKED}`,
      `foreach ($c in @(${programs.map(powershellWord).join(",")})) { if (Get-Command $c -ErrorAction SilentlyContinue) { "${HAS}$c" } }; "${ASKED}"`);
    if (!stdout.includes(ASKED)) return null;
    return new Set(stdout.split(/\r?\n/).filter((line) => line.startsWith(HAS)).map((line) => line.slice(HAS.length)));
  } catch {
    return null;
  }
}

// File reads, subprocesses and HTTP share the same pass and consent guard. Sensor
// output stays on its machine for CLI probes; only sanitized reports are stored.
function hostFor(where, provider, allowed) {
  const requireActive = () => {
    if (!allowed()) throw new Error("usage source changed");
  };
  const on = where.on;
  const windows = usesPowershell(on);
  const platform = on ? "linux" : window()?.platform;
  const run = (args, env = {}, { program = where.program, timeoutMs } = {}) => {
    requireActive();
    const environment = Object.entries(env);
    const assignments = environment.map(([name, value]) => `${name}=${value}`);
    const words = [program, ...args];
    const command = posixWords(environment.length ? ["env", ...assignments, ...words] : words);
    const ps = `${environment.map(([name, value]) => `$env:${name}=${powershellWord(String(value))}; `).join("")}${powershellCall(program)} ${args.map(powershellWord).join(" ")}`;
    if (!timeoutMs || windows) return inShell(where, command, ps);
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    const perl = posixWords(["perl", "-e", "alarm shift; exec @ARGV or exit 127", String(secs)]);
    return inShell(where, `if command -v timeout >/dev/null 2>&1; then timeout ${secs} ${command}; elif command -v perl >/dev/null 2>&1; then ${perl} ${command}; else ${command}; fi`, ps);
  };
  return {
    run,
    platform,
    home: on ? where.home : home(),
    target: on,
    now: Date.now,
    runScript(posix, powershell) {
      requireActive();
      const program = where.program;
      return inShell(where, posix(posixWords([program])), powershell(powershellWord(program)));
    },
    async exec(executable, argv = []) {
      requireActive();
      return inShell(where, posixWords([executable, ...argv]), `${powershellCall(executable)} ${argv.map(powershellWord).join(" ")}`);
    },
    async locate(program = where.program) {
      requireActive();
      const found = await inShell(where, `command -v ${posixWords([program])}`,
        `(Get-Command -Name ${powershellWord(program)} -ErrorAction SilentlyContinue).Source`);
      return found.code === 0 ? found.stdout.trim() || null : null;
    },
    async read(path) {
      requireActive();
      return readTextFile(path, { on });
    },
    async env(name) {
      requireActive();
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) return null;
      const result = await inShell(where, `printenv ${name}`, `[Environment]::GetEnvironmentVariable('${name}')`);
      return result.code === 0 ? result.stdout.trim() || null : null;
    },
    async request(url, { method, headers, body } = {}) {
      requireActive();
      if (on) throw new Error("network usage needs the local execution owner");
      const host = String(url).match(/^https:\/\/([^/:?#]+)(?:[/?#]|$)/i)?.[1].toLowerCase();
      if (!host || !provider.hosts?.includes(host)) throw new Error("invalid usage origin");
      return fetch(url, {
        ...(method && { method }),
        ...(headers && { headers }),
        ...(body !== undefined && { body }),
      });
    },
  };
}

async function hasCursorDesktop(where) {
  if (where.on) {
    try {
      const check = await inShell(where, 'test -d "$HOME/.config/Cursor" || test -d "$HOME/Library/Application Support/Cursor"', "");
      return check.code === 0;
    } catch { return false; }
  }
  const path = `${home()}/${window()?.platform === "macos" ? "Library/Application Support" : ".config"}/Cursor`;
  try {
    const result = await inShell(where, `test -d ${posixWords([path])}`,
      `if (Test-Path -LiteralPath (Join-Path $env:APPDATA 'Cursor') -PathType Container) { exit 0 }; exit 1`);
    return result.code === 0;
  } catch {
    return false;
  }
}

export { exec, shellPath, inShell, shellFinds, hostFor, hasCursorDesktop, posixWords, powershellWord, powershellCall };
