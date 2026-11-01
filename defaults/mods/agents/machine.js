// The machine an agent runs on, and the one place that knows how machines differ: this computer or
// an added one, and Windows, which has no `sh`. The rest of the mod asks a machine for what it
// wants: `home`, `read` and `write` a text file, `run` a program, `lines` of a session, the `sizes`
// of files or of those `inside` a folder, `find` files by name, and the `processes` to try for a
// terminal's agent. `machineOn(on)` finds out what's there.

import { exec, home, readTextFile, window, writeTextFile } from "herdr";

export const BLOCK = 1048576;
export const NO_FILE = 3;

// A session is read in windows that fit exec's 8 MiB with a long line on top, each its own script
// step. An added machine's output comes back as base64 inside that same 8 MiB.
const HERE = 7;
const AWAY = 4;

// `dd` because BSD `head -c` takes five times as long. A window reads on to the end of its last
// line, or a line longer than the one block windows overlap by would never be seen whole. `known`,
// a size already read, saves sending the same lines again.
const NEW_LINES = `[ -f "$1" ] || exit ${NO_FILE}
size=$(($(wc -c < "$1")))
echo "$size"
[ "$size" != "$4" ] || exit 0
{ dd if="$1" bs=${BLOCK} skip="$2" count="$5"; dd if="$1" bs=${BLOCK} skip=$(($2 + $5)) | head -n 1; } 2>/dev/null | LC_ALL=C grep -aF -- "$3"`;

// What `wc -c` said about some session files, or Windows' same thing: `[{ file, size }]`.
const sizesFrom = (stdout) => stdout.split("\n").flatMap((line) => {
  const [, size, file] = line.match(/^\s*(\d+)\s(.+\.jsonl)$/) ?? [];
  return file ? [{ file, size: Number(size) }] : [];
});

// Only the system's own words mean a file isn't there: a folder that can't be entered hides a file
// from `test -e` just as a missing one would.
const ABSENT = `LC_ALL=C cat -- "$1" 2>&1 >/dev/null | grep -q 'No such file or directory$' && exit ${NO_FILE}`;
const ABSENT_WINDOWS = `try { [IO.File]::OpenRead($a).Dispose() } catch { $why = $_.Exception.GetBaseException(); if ($why -is [IO.FileNotFoundException] -or $why -is [IO.DirectoryNotFoundException]) { exit ${NO_FILE} } throw }`;

function unix(on) {
  return {
    absent: async (path) => (await exec("sh", ["-c", ABSENT, "sh", path], { on })).code === NO_FILE,
    run: (program, args) => exec(program, args, { on }),
    lines: (file, block, count, filter, known = "") => exec("sh", ["-c", NEW_LINES, "sh", file, String(block), filter, String(known), String(count)], { on }),
    sizes: async (files) => sizesFrom((await exec("sh", ["-c", 'wc -c "$@" 2>/dev/null', "sh", ...files], { on })).stdout),
    inside: async (folder) => sizesFrom((await exec("sh", ["-c", 'wc -c "$1"/*.jsonl 2>/dev/null', "sh", folder], { on })).stdout),
    find: async (folder, names) => (await exec("find", [folder, ...names.flatMap((name, i) => [...(i ? ["-o"] : []), "-name", `*${name}`])], { on })).stdout.split("\n").filter(Boolean),
    processes: async (pid) => [pid],
  };
}

// PowerShell treats smart single quotes as quotes too, and a label is anyone's text.
const single = (text) => `'${String(text).replace(/['‘’‚‛]/g, "$&$&")}'`;
const FAILED = 4;

// `say` writes bytes: Windows PowerShell's own output goes through the system's old code page,
// which would turn any other letter in a path into something else.
function powershell(on, script, ...args) {
  const say = "$out = [Console]::OpenStandardOutput(); function say($text) { $bytes = [Text.Encoding]::UTF8.GetBytes($text + [char]10); $out.Write($bytes, 0, $bytes.Length) };";
  const command = `& { param($a, $b, $c, $d, $e) $ErrorActionPreference = 'Stop'; ${say} try { ${script} } catch { exit ${FAILED} } } ${args.map(single).join(" ")}`;
  return exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { on });
}

// What `NEW_LINES` does, on the same terms: the size, then the matching lines of one window, in
// order and as the file has them. `findstr` and `Select-String` can't start at an offset, so a whole
// file's lines would run into exec's 8 MiB, where it cuts them off and says nothing: usage would go
// missing and the numbers would read low. So it's the file itself: shared, as an agent is writing
// it, and each byte is one letter of Latin-1, which leaves the session's own text alone.
const NEW_LINES_WINDOWS = `if (-not [IO.File]::Exists($a)) { exit ${NO_FILE} }
$file = [IO.File]::Open($a, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete')
$size = [string]$file.Length
say $size
if ($size -eq $d) { exit 0 }
[void]$file.Seek([long]$b * ${BLOCK}, [IO.SeekOrigin]::Begin)
$bytes = New-Object byte[] ([int]$e * ${BLOCK})
$got = 0
while ($got -lt $bytes.Length) {
  $read = $file.Read($bytes, $got, $bytes.Length - $got)
  if ($read -le 0) { break }
  $got += $read
}
if ($got -eq $bytes.Length) {
  $rest = New-Object IO.MemoryStream
  $chunk = New-Object byte[] 65536
  do {
    $read = $file.Read($chunk, 0, 65536)
    $cut = [Array]::IndexOf($chunk, [byte]10, 0, $read)
    $rest.Write($chunk, 0, $(if ($cut -ge 0) { $cut + 1 } else { $read }))
  } while ($read -gt 0 -and $cut -lt 0)
  $whole = New-Object byte[] ($got + [int]$rest.Length)
  [Array]::Copy($bytes, $whole, $got)
  [Array]::Copy($rest.ToArray(), 0, $whole, $got, [int]$rest.Length)
  $bytes = $whole
  $got = $whole.Length
}
$text = [Text.Encoding]::GetEncoding(28591).GetString($bytes, 0, $got)
$find = ($c.Split([char]10) | ForEach-Object { [regex]::Escape($_) }) -join '|'
$end = -1
foreach ($hit in [regex]::Matches($text, $find)) {
  if ($hit.Index -le $end) { continue }
  $start = $text.LastIndexOf([char]10, $hit.Index) + 1
  $end = $text.IndexOf([char]10, $hit.Index)
  if ($end -lt 0) { $end = $got - 1 }
  $out.Write($bytes, $start, $end - $start + 1)
}`;

const SIZES = "$a.Split([char]10) | ForEach-Object { $one = Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue; if ($one) { say ([string]$one.Length + ' ' + $_) } }";
const SIZES_INSIDE = "if (Test-Path -LiteralPath $a) { Get-ChildItem -LiteralPath $a -Filter *.jsonl -File | ForEach-Object { say ([string]$_.Length + ' ' + $_.FullName) } }";
const ALL_SESSIONS = "Get-ChildItem -LiteralPath $a -Filter *.jsonl -File -Recurse | ForEach-Object { say $_.FullName }";
const PROCESSES = "Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId | ForEach-Object { say ([string]$_.ProcessId + ' ' + $_.ParentProcessId) }";

// A pseudo console has no foreground group, so a terminal's foreground is the program it started,
// usually a shell, and the agent is somewhere under it: parents first, as an agent's own
// tools are under it.
function underneath(root, table) {
  const kids = new Map();
  for (const line of table.split("\n")) {
    const [pid, parent] = line.trim().split(" ").map(Number);
    if (pid) kids.set(parent, [...(kids.get(parent) ?? []), pid]);
  }
  const found = [root];
  for (const pid of found) found.push(...(kids.get(pid) ?? []).filter((kid) => !found.includes(kid)));
  return found;
}

const WALKED = 30000;

function windows(on) {
  const output = async (...call) => {
    const { code, stdout } = await powershell(on, ...call);
    if (code !== 0) throw new Error("PowerShell failed.");
    return stdout;
  };
  const walked = new Map();
  return {
    absent: async (path) => (await powershell(on, ABSENT_WINDOWS, path)).code === NO_FILE,
    // Through `cmd`, which finds an npm `claude.cmd` as well as a `claude.exe`, and which is why
    // nothing it could take for one of its own gets through.
    async run(program, args) {
      if (args.some((arg) => /[&|<>^%!"\r\n]/.test(arg))) throw new Error("Not safe for cmd.");
      return exec("cmd", ["/d", "/c", program, ...args], { on });
    },
    // A read that stops part way mustn't count as a read: exit 3 is "no file", and any other
    // failure throws, however much it printed first.
    async lines(file, block, count, filter, known = "") {
      const result = await powershell(on, NEW_LINES_WINDOWS, file, block, filter, known, count);
      if (result.code !== 0 && result.code !== NO_FILE) throw new Error("PowerShell failed.");
      return result;
    },
    sizes: async (files) => sizesFrom(await output(SIZES, files.join("\n"))),
    inside: async (folder) => sizesFrom(await output(SIZES_INSIDE, folder)),
    find: async (folder, names) => (await output(ALL_SESSIONS, folder)).split("\n").filter((path) => names.some((name) => path.endsWith(name))),
    async processes(pid) {
      const kept = walked.get(pid);
      if (Date.now() - (kept?.at ?? -WALKED) < WALKED) return kept.pids;
      const pids = underneath(pid, await output(PROCESSES).catch(() => ""));
      walked.set(pid, { at: Date.now(), pids });
      return pids;
    },
  };
}

// exec has no stdin, and `hc file write` takes the file from it: with none it writes an empty file,
// so a shell here feeds it. Windows PowerShell ends what it pipes with a line break of its own, which
// none of these files minds.
const feed = (on, path, text) => (window()?.platform === "windows"
  ? powershell(null, "$OutputEncoding = New-Object Text.UTF8Encoding $false; $a | & hc file write --on $b $c; exit $LASTEXITCODE", text, on, path)
  : exec("sh", ["-c", 'printf %s "$1" | hc file write --on "$2" "$3"', "sh", text, on, path]));

// A person's file on an added machine, to change. `readTextFile` says null there for any failed
// `cat` and decodes what it can't with U+FFFD: that text must never be taken for the file, or for
// no file, and written back.
const readToChange = (on, absent) => async (path) => {
  const text = await readTextFile(path, { on });
  if (text === null ? !(await absent(path)) : text.includes("�")) throw new Error("Couldn't read the file.");
  return text;
};

// `hc file write` isn't compare-and-swap, so `expected` is checked just before it.
const writeOn = (on, read) => async (path, text, expected) => {
  if ((await read(path)) !== expected) throw new Error("The file changed while saving.");
  const { code } = await feed(on, path, text);
  if (code !== 0) throw new Error("Couldn't write the file.");
};

// Git for Windows has an `sh`, but its `uname` says so, and its paths aren't the ones agents write.
async function homeAway(on) {
  const there = await exec("sh", ["-c", 'uname -s; printf %s "$HOME"'], { on }).catch((e) => {
    if (!/cannot start/.test(e)) throw e;
    return null;
  });
  if (there?.code === 0 && !/^(MINGW|MSYS|CYGWIN)/.test(there.stdout)) return { windows: false, home: there.stdout.slice(there.stdout.indexOf("\n") + 1) };
  const { code, stdout } = await powershell(on, "say $HOME");
  return { windows: code === 0, home: code === 0 ? stdout.trim() : "" };
}

// Null is this computer. Rejects while a machine can't be asked, for the next pass to retry.
export async function machineOn(on) {
  if (!on) {
    const seen = window();
    if (!seen) throw new Error("No window yet.");
    const read = (path) => readTextFile(path);
    return { ...(seen.platform === "windows" ? windows(null) : unix(null)), on, window: HERE, home: home(), read, files: { home: home(), read, write: writeTextFile } };
  }
  const { windows: isWindows, home: there } = await homeAway(on);
  if (!there) throw new Error("No home there.");
  const kind = isWindows ? windows(on) : unix(on);
  const read = readToChange(on, kind.absent);
  return { ...kind, on, window: AWAY, home: there, read: (path) => readTextFile(path, { on }), files: { home: there, read, write: writeOn(on, read) } };
}
