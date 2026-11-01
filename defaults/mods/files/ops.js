// What the Files panel changes on disk, here or on a space's machine. Windows has no `sh`.
import { exec, hc, window } from "herdr";

const windows = (on) => !on && window()?.platform === "windows";
const single = (text) => `'${text.replaceAll("'", "''")}'`;
const sh = (on, script, ...args) => exec("sh", ["-c", script, "files", ...args], { on });
const powershell = (script, ...args) => exec("powershell", ["-NoProfile", "-Command", `& { param($a, $b) $ErrorActionPreference = 'Stop'; ${script} } ${args.map(single).join(" ")}`]);

const EXISTS = 3;
function checked(r) {
  if (r.code === EXISTS) throw new Error("That name is already taken");
  if (r.code !== 0) throw new Error(r.stderr?.trim() || "That didn't work");
}

export const baseName = (path) => path.split("/").pop();
export const parentOf = (path) => path.split("/").slice(0, -1).join("/");
export const native = (path, on) => (windows(on) ? path.replaceAll("/", "\\") : path);
export const quoted = (path, on) => (windows(on) ? single(path) : `'${path.replaceAll("'", `'\\''`)}'`);

// Why this can't be a name, or null. `nested`: a new file may name folders on the way to it.
export function badName(name, nested) {
  if (!name) return "Give it a name";
  const parts = name.split(/[/\\]/);
  if (!nested && parts.length > 1) return "A name can't hold a slash";
  if (parts.some((part) => !part || part === "." || part === "..")) return "That isn't a usable name";
  return null;
}

export async function create(path, on) {
  checked(windows(on)
    ? await powershell(`if (Test-Path -LiteralPath $a) { exit ${EXISTS} }; [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($a)) | Out-Null; [IO.File]::Open($a, 'CreateNew').Close()`, native(path, on))
    : await sh(on, `[ -e "$1" ] && exit ${EXISTS}; mkdir -p "$(dirname "$1")" && : > "$1"`, path));
}

// -ef: on a disk that ignores case, foo and Foo are one file and the rename is still wanted.
export async function move(from, to, on) {
  checked(windows(on)
    ? await powershell(`if ((Test-Path -LiteralPath $b) -and ($a -ine $b)) { exit ${EXISTS} }; Move-Item -LiteralPath $a -Destination $b`, native(from, on), native(to, on))
    : await sh(on, `if [ -e "$2" ] && ! [ "$1" -ef "$2" ]; then exit ${EXISTS}; fi; mv -- "$1" "$2"`, from, to));
}

export const WASTE = () => (window()?.platform === "windows" ? "Recycle Bin" : "Trash");

// Here it goes to the system's trash, and fails rather than delete for good; a machine has none.
export async function trash(path, on) {
  if (on) return checked(await sh(on, `rm -rf -- "$1"`, path));
  const platform = window()?.platform;
  if (platform === "windows") return checked(await powershell(`Add-Type -AssemblyName Microsoft.VisualBasic; $kind = if (Test-Path -LiteralPath $a -PathType Container) { 'DeleteDirectory' } else { 'DeleteFile' }; [Microsoft.VisualBasic.FileIO.FileSystem]::$kind($a, 'OnlyErrorDialogs', 'SendToRecycleBin')`, native(path)));
  if (platform === "macos") return checked(await sh(null, `if [ -x /usr/bin/trash ]; then /usr/bin/trash "$1"; else osascript -e 'on run argv' -e 'tell application "Finder" to delete POSIX file (item 1 of argv)' -e 'end run' "$1" > /dev/null; fi`, path));
  checked(await sh(null, `gio trash -- "$1"`, path));
}

export async function reveal(path) {
  const platform = window()?.platform;
  // Explorer exits 1 even when it worked.
  if (platform === "windows") return void await exec("explorer", [`/select,${native(path)}`]);
  checked(platform === "macos" ? await exec("open", ["-R", path]) : await exec("xdg-open", [parentOf(path) || "/"]));
}

// A half-typed line would run with it: `rm -rf ` then a cd is `rm -rf cd '…'`.
export async function cd(terminal, folder, on) {
  checked(await hc(["keys", terminal, ...(windows(on) ? ["esc"] : ["ctrl+e", "ctrl+u"])]));
  checked(await hc(["send", terminal, `cd ${quoted(folder, on)}`]));
}
