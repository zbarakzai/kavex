// Skills: one copy of each skill in ~/.config/kavex/skills, linked into the folders every agent reads
// (~/.agents/skills: Codex, Pi, Gemini CLI, OpenCode, Cursor, Amp; ~/.claude/skills: Claude Code), so
// an update reaches all of them at once. Customize > Skills draws it and the sidebar footer looks for
// updates, so each keeps a copy of this file, as mods can't import each other's files;
// scripts/look.test.ts keeps them equal.
//
// Mods may only write under the app's folder, so links, moves and downloads go through `sh`
// (PowerShell on Windows) and `curl`. Nothing outside the store is ever deleted: a link is removed
// only when it points at Kavex's copy, and a folder in the way is moved to skills-backup.

import { createHash } from "crypto";
import { appHome, exec, home, notify, readTextFile, setShared, shared, window, writeTextFile } from "herdr";

export const CATALOG = "https://raw.githubusercontent.com/zbarakzai/zaki-skills/main/catalog.json";
export const CATALOG_REPO = "https://github.com/zbarakzai/zaki-skills";
const FILES = (repo) => `https://raw.githubusercontent.com/zbarakzai/zaki-skills/main/files/${repo}.json`;
const RAW = "https://raw.githubusercontent.com";
const API = "https://api.github.com";
export const EVERY = 6 * 3600_000;
const STALE = 3 * 60_000; // a busy mark this old is from a copy that went midway
const CHECK_STALE = 90_000; // the same for a check: closing Customize mid-check stops it there
const BATCH = 100; // files per curl, 16 at once: well inside exec's 30 seconds

export const TARGETS = [
  { id: "claude", path: [".claude", "skills"], label: "~/.claude/skills", agents: "Claude Code" },
  { id: "agents", path: [".agents", "skills"], label: "~/.agents/skills", agents: "Codex, Pi, Gemini CLI, OpenCode, Cursor and Amp" },
];

const windows = () => window()?.platform === "windows";
const join = (...parts) => parts.filter((p) => p !== "").join(windows() ? "\\" : "/");
export const places = () => ({
  store: join(appHome(), "skills"),
  lock: join(appHome(), "skills.json"),
  cache: join(appHome(), "skills-catalog.json"),
  backup: join(appHome(), "skills-backup"),
});
export const targetDir = (t) => join(home(), ...t.path);
export const checksOn = () => shared("skills.checks") !== false;
export const autoOn = () => shared("skills.auto") === true;

// The frontmatter fields skills use: plain, quoted, and folded or literal block values.
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? "");
  if (!m) return {};
  const out = {}, lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")) block.push(lines[++i].trim());
      value = value.startsWith("|") ? block.join("\n").trim() : block.join(" ").replace(/\s+/g, " ").trim();
    } else if (/^["']/.test(value)) {
      const q = value[0], end = value.lastIndexOf(q);
      value = value.slice(1, end > 0 ? end : undefined);
      value = q === '"' ? value.replace(/\\"/g, '"') : value.replace(/''/g, "'");
    }
    out[kv[1]] = value;
  }
  return out;
}

export const body = (text) => (text ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
export const titled = (name) => name.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
export const firstSentence = (text) => {
  const s = (text ?? "").split(/(?<=[.!?])\s/)[0].trim();
  return s.length > 90 ? `${s.slice(0, 87).trimEnd()}…` : s;
};
const validName = (name) => typeof name === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(name) && name.length <= 80;
const validFile = (path) => typeof path === "string" && path !== "" && !path.startsWith("/") && !/\\/.test(path) && path.split("/").every((p) => p && p !== "." && p !== "..");

// The shell side. Each script gets its arguments as $1.. (sh) or param(...) (PowerShell).
const SH = {
  link: 'd=$1 t=$2\nmkdir -p "$(dirname "$d")" || exit 1\nif [ -L "$d" ]; then [ "$(readlink "$d")" = "$t" ] && exit 0; echo "$d holds another skill"; exit 3; fi\nif [ -e "$d" ]; then echo "$d holds another skill"; exit 3; fi\nln -s "$t" "$d"',
  unlink: 'if [ -L "$1" ] && [ "$(readlink "$1")" = "$2" ]; then rm "$1"; fi',
  taken: 'if [ -L "$1" ] && [ "$(readlink "$1")" = "$2" ]; then exit 1; fi\n[ -e "$1" ] || [ -L "$1" ]',
  swap: 'd=$1 s=$2 o="$(dirname "$1")/.old-$(basename "$1")-$$"\nif [ -e "$d" ]; then mv "$d" "$o" || exit 1; fi\nif mv "$s" "$d"; then rm -rf "$o"; else [ -e "$o" ] && mv "$o" "$d"; exit 1; fi',
  remove: 'case "$1" in "$2"/?*) rm -rf "$1" ;; *) echo "$1 is not in $2"; exit 2 ;; esac',
  fingerprint: 'cd "$1" 2>/dev/null || exit 0\nfind . -type f ! -name .DS_Store -exec cksum {} + | LC_ALL=C sort',
  move: 'mkdir -p "$(dirname "$2")" && mv "$1" "$2"',
  scan: 'for d in "$@"; do\n  [ -d "$d" ] || continue\n  for e in "$d"/*; do\n    [ -e "$e" ] || [ -L "$e" ] || continue\n    t=; [ -L "$e" ] && t=$(readlink "$e")\n    s=0; [ -f "$e/SKILL.md" ] && s=1\n    printf \'%s\\t%s\\t%s\\t%s\\n\' "$d" "$(basename "$e")" "$t" "$s"\n  done\ndone',
  tidy: 'for e in "$1"/.staging-* "$1"/.old-*; do [ -e "$e" ] && rm -rf "$e"; done; exit 0',
  open: 'if command -v open >/dev/null 2>&1; then open "$1"; else xdg-open "$1"; fi',
};

// Windows: junctions need no admin rights or Developer Mode. A junction is removed with
// DirectoryInfo.Delete(), which never touches what it points at.
const PS = {
  link: "param($d, $t)\nNew-Item -ItemType Directory -Force -Path (Split-Path -Parent $d) | Out-Null\n$i = Get-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue\nif ($i) { if ($i.LinkType -and (@($i.Target) -contains $t)) { exit 0 }; \"$d holds another skill\"; exit 3 }\nNew-Item -ItemType Junction -Path $d -Target $t -ErrorAction Stop | Out-Null",
  unlink: "param($d, $t)\n$i = Get-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue\nif ($i -and $i.LinkType -and (@($i.Target) -contains $t)) { $i.Delete() }",
  taken: "param($d, $t)\n$i = Get-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue\nif (-not $i) { exit 1 }\nif ($i.LinkType -and (@($i.Target) -contains $t)) { exit 1 }\nexit 0",
  swap: "param($d, $s)\n$o = Join-Path (Split-Path -Parent $d) ('.old-' + (Split-Path -Leaf $d) + '-' + $PID)\nif (Test-Path -LiteralPath $d) { Move-Item -LiteralPath $d -Destination $o -ErrorAction Stop }\ntry { Move-Item -LiteralPath $s -Destination $d -ErrorAction Stop; if (Test-Path -LiteralPath $o) { Remove-Item -LiteralPath $o -Recurse -Force } }\ncatch { if (Test-Path -LiteralPath $o) { Move-Item -LiteralPath $o -Destination $d }; exit 1 }",
  remove: "param($p, $root)\nif (-not $p.StartsWith($root + '\\')) { \"$p is not in $root\"; exit 2 }\nif (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }",
  fingerprint: "param($p)\nif (-not (Test-Path -LiteralPath $p)) { exit 0 }\nGet-ChildItem -LiteralPath $p -Recurse -File -Force | Where-Object Name -ne '.DS_Store' | ForEach-Object { (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash + ' ' + $_.FullName.Substring($p.Length) } | Sort-Object",
  move: "param($a, $b)\nNew-Item -ItemType Directory -Force -Path (Split-Path -Parent $b) | Out-Null\nMove-Item -LiteralPath $a -Destination $b -ErrorAction Stop",
  scan: "foreach ($d in $args) { if (-not (Test-Path -LiteralPath $d)) { continue }\n  Get-ChildItem -LiteralPath $d -Force | ForEach-Object { $t = if ($_.LinkType) { @($_.Target)[0] } else { '' }; $s = if (Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md')) { 1 } else { 0 }; \"$d`t$($_.Name)`t$t`t$s\" } }",
  tidy: "param($p)\nGet-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '.staging-*' -or $_.Name -like '.old-*' } | Remove-Item -Recurse -Force",
  open: "param($p)\nStart-Process explorer.exe $p",
};

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
function op(name, ...args) {
  if (windows()) return exec("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `& { ${PS[name]} } ${args.map(psQuote).join(" ")}`]);
  return exec("sh", ["-c", SH[name], "kavex-skills", ...args]);
}
async function must(name, ...args) {
  const r = await op(name, ...args);
  if (r.code !== 0) throw new Error((r.stdout + r.stderr).trim() || `${name} failed`);
  return r;
}

export const openFolder = (path) => op("open", path);

// skills.json: what Kavex installed, and from where. Written only if nobody changed it meanwhile.
export async function readLock() {
  const raw = await readTextFile(places().lock);
  let lock = { version: 1, skills: {} };
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed.skills === "object") lock = { version: 1, ...parsed };
  } catch {}
  return { raw, lock };
}

async function changeLock(edit) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { raw, lock } = await readLock();
    edit(lock);
    try {
      await writeTextFile(places().lock, JSON.stringify(lock, null, 2) + "\n", raw ?? null);
      setShared("skills.changed", Date.now());
      return lock;
    } catch {}
  }
  throw new Error("Couldn't save skills.json: something else keeps changing it.");
}

// One action per skill at a time, across every mod: mods share one script thread, so looking and
// marking happen with no wait between them.
const busyMap = () => shared("skills.busy") ?? {};
export function busy(name) {
  const b = busyMap()[name];
  return b && Date.now() - b.at < STALE ? b.action : null;
}
async function working(name, action, run) {
  if (busy(name)) throw new Error(`${name} is ${busy(name)} already.`);
  const mark = () => setShared("skills.busy", { ...busyMap(), [name]: { action, at: Date.now() } });
  mark();
  try {
    return await run(mark);
  } finally {
    const rest = { ...busyMap() };
    delete rest[name];
    setShared("skills.busy", rest);
  }
}

export function check(entry) {
  if (!validName(entry?.name)) throw new Error(`"${entry?.name}" can't be a skill's folder name.`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(entry.repo ?? "") || !/^[0-9a-f]{40}$/.test(entry.commit ?? "")) throw new Error(`${entry.name} doesn't say where it comes from.`);
  if (!Array.isArray(entry.files) || !entry.files.some((f) => f.path === "SKILL.md") || !entry.files.every((f) => validFile(f.path))) throw new Error(`${entry.name}'s files can't be installed safely.`);
  if (entry.path && !validFile(entry.path)) throw new Error(`${entry.name}'s folder can't be installed safely.`);
}

export const rawUrl = (entry, file) => `${RAW}/${entry.repo}/${entry.commit}/${[...(entry.path ? entry.path.split("/") : []), ...file.split("/")].map(encodeURIComponent).join("/")}`;
export const webUrl = (s) => (s.repo ? `https://github.com/${s.repo}/tree/${s.commit ?? s.ref ?? "HEAD"}/${s.path ?? ""}`.replace(/\/$/, "") : null);

// The catalog names each skill's version; its files are in the repo's file list, read only now. A
// list that moved past the entry (a newer catalog than the one shown) is used as it is: it's newer.
async function withFiles(entry) {
  if (Array.isArray(entry.files)) return entry;
  if (!/^[\w.-]+\/[\w.-]+$/.test(entry.repo ?? "")) throw new Error(`${entry.name} doesn't say where it comes from.`);
  const r = await fetch(FILES(entry.repo), { headers: { "User-Agent": "kavex" } });
  if (!r.ok) throw new Error(`The file list for ${entry.repo} answered ${r.status}.`);
  const list = await r.json(), found = list?.skills?.[entry.path];
  if (!found) throw new Error(`${entry.title ?? entry.name} isn't in the list any more.`);
  return { ...entry, commit: found.commit ?? list.commit, tree: found.tree, files: found.files };
}

async function download(entry, beat) {
  const { store } = places();
  const staging = join(store, `.staging-${entry.name}-${Date.now().toString(36)}`);
  for (let i = 0; i < entry.files.length; i += BATCH) {
    const pairs = entry.files.slice(i, i + BATCH).flatMap((f) => ["-o", join(staging, ...f.path.split("/")), rawUrl(entry, f.path)]);
    const curl = (extra) => exec(windows() ? "curl.exe" : "curl", ["-fsSL", "--create-dirs", "--max-time", "25", ...extra, ...pairs]).catch((e) => ({ code: -1, stderr: String(e?.message ?? e) }));
    let r = await curl(["--parallel", "--parallel-max", "16"]);
    // curl before 7.66 has no --parallel (exit 2: an option it doesn't know).
    if (r.code === 2) r = await curl([]);
    if (r.code !== 0) {
      await op("remove", staging, store);
      throw new Error(`Couldn't download ${entry.title ?? entry.name}: ${(r.stderr ?? "").trim() || `curl exited with ${r.code}`}`);
    }
    beat?.();
  }
  return staging;
}

async function fingerprint(dir) {
  const r = await op("fingerprint", dir);
  return r.code === 0 && r.stdout.trim() ? createHash("sha256").update(r.stdout).digest("hex").slice(0, 16) : null;
}

async function linkAll(name, folder) {
  const made = [];
  for (const t of TARGETS) {
    const d = join(targetDir(t), name), r = await op("link", d, folder);
    if (r.code !== 0) {
      for (const m of made) await op("unlink", m, folder);
      throw new Error((r.stdout + r.stderr).trim() || `Couldn't link ${name} into ${t.label}.`);
    }
    made.push(d);
  }
}

async function unlinkAll(name, folder) {
  for (const t of TARGETS) await op("unlink", join(targetDir(t), name), folder);
}

// Where something that isn't Kavex's already has this name.
async function takenIn(name, folder) {
  const found = [];
  for (const t of TARGETS) if ((await op("taken", join(targetDir(t), name), folder)).code === 0) found.push(t);
  return found;
}

// Out of the way, never deleted: skills-backup/<name>-<time>/<target>.
async function moveAside(name, folder) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const t of await takenIn(name, folder)) await must("move", join(targetDir(t), name), join(places().backup, `${name}-${stamp}`, t.id));
}

const record = (entry) => ({
  name: entry.name,
  id: entry.id ?? null,
  title: entry.title ?? titled(entry.name),
  short: entry.short ?? "",
  description: entry.description ?? "",
  source: entry.source ?? "catalog",
  repo: entry.repo ?? null,
  path: entry.path ?? "",
  ref: entry.ref ?? null,
  commit: entry.commit ?? null,
  tree: entry.tree ?? null,
  seen: entry.seen ?? null,
});

// From the catalog or a GitHub link. `replace` moves what's in the way to skills-backup first.
export async function install(listed, { replace = false } = {}) {
  if (!validName(listed?.name)) throw new Error(`"${listed?.name}" can't be a skill's folder name.`);
  return working(listed.name, "installing", async (beat) => {
    const entry = await withFiles(listed);
    check(entry);
    const { lock } = await readLock();
    if (lock.skills[entry.name]) throw new Error(`A skill named ${entry.name} is installed already.`);
    const { store } = places(), folder = join(store, entry.name);
    const taken = await takenIn(entry.name, folder);
    if (taken.length && !replace) throw new Error(`${taken.map((t) => t.label).join(" and ")} already ${taken.length > 1 ? "have" : "has"} a skill named ${entry.name}.`);
    const staging = await download(entry, beat);
    await must("swap", folder, staging);
    const hash = await fingerprint(folder);
    try {
      if (replace) await moveAside(entry.name, folder);
      await linkAll(entry.name, folder);
    } catch (e) {
      await op("remove", folder, store);
      throw e;
    }
    const now = Date.now();
    await changeLock((l) => (l.skills[entry.name] = { ...record(entry), folder, hash, enabled: true, installed: now, updated: now }));
  });
}

// A folder of the person's own: linked where it is, never copied, never deleted.
export async function addFolder(path) {
  const text = await readTextFile(join(path, "SKILL.md"));
  if (text === null) throw new Error("That folder has no SKILL.md.");
  const meta = frontmatter(text), name = meta.name || path.split(/[\\/]/).filter(Boolean).pop();
  if (!validName(name)) throw new Error(`"${name}" can't be a skill's folder name.`);
  return working(name, "adding", async () => {
    const { lock } = await readLock();
    if (lock.skills[name]) throw new Error(`A skill named ${name} is installed already.`);
    const taken = await takenIn(name, path);
    if (taken.length) throw new Error(`${taken.map((t) => t.label).join(" and ")} already ${taken.length > 1 ? "have" : "has"} a skill named ${name}.`);
    await linkAll(name, path);
    const now = Date.now();
    await changeLock((l) => (l.skills[name] = { ...record({ name, description: meta.description, short: firstSentence(meta.description), source: "folder" }), folder: path, hash: null, enabled: true, installed: now, updated: now }));
    return name;
  });
}

export async function setEnabled(name, on) {
  return working(name, on ? "turning on" : "turning off", async () => {
    const s = (await readLock()).lock.skills[name];
    if (!s) throw new Error(`${name} isn't installed.`);
    if (on) await linkAll(name, s.folder);
    else await unlinkAll(name, s.folder);
    await changeLock((l) => l.skills[name] && (l.skills[name].enabled = on));
  });
}

export async function remove(name) {
  return working(name, "removing", async () => {
    const s = (await readLock()).lock.skills[name];
    if (!s) throw new Error(`${name} isn't installed.`);
    await unlinkAll(name, s.folder);
    if (s.source !== "folder") await must("remove", s.folder, places().store);
    await changeLock((l) => delete l.skills[name]);
    dropUpdate(name);
  });
}

// Updates replace the one copy in place, so every agent's link shows the new version at once.
// A copy the person changed is never replaced unless they say so (`force`).
export async function update(name, { entry, force = false } = {}) {
  return working(name, "updating", async (beat) => {
    const s = (await readLock()).lock.skills[name];
    if (!s) throw new Error(`${name} isn't installed.`);
    if (s.source === "folder") throw new Error(`${name} is a folder of yours: it changes when you change it.`);
    const offered = entry ?? (shared("skills.updates") ?? []).find((u) => u.name === name)?.entry;
    if (!offered) throw new Error(`There's no newer ${name}.`);
    const next = await withFiles(offered);
    check({ ...next, name });
    if (!force && s.hash && (await fingerprint(s.folder)) !== s.hash) {
      const e = new Error(`You changed ${s.title ?? name} since it was installed.`);
      e.edited = true;
      throw e;
    }
    const staging = await download({ ...next, name }, beat);
    await must("swap", s.folder, staging);
    const hash = await fingerprint(s.folder);
    if (s.enabled) await linkAll(name, s.folder);
    await changeLock((l) => l.skills[name] && Object.assign(l.skills[name], { ...record({ ...next, name, source: s.source }), hash, held: null, updated: Date.now() }));
    dropUpdate(name);
  });
}

// Keep the person's changes: this version isn't offered again; a later one is.
export async function hold(name) {
  const u = (shared("skills.updates") ?? []).find((x) => x.name === name);
  await changeLock((l) => l.skills[name] && (l.skills[name].held = u?.tree ?? null));
  dropUpdate(name);
}

function dropUpdate(name) {
  setShared("skills.updates", (shared("skills.updates") ?? []).filter((u) => u.name !== name));
}

// The catalog ---------------------------------------------------------------

function parseCatalog(raw) {
  try {
    const c = JSON.parse(raw ?? "");
    if (c?.version === 1 && Array.isArray(c.skills)) return c;
  } catch {}
  return null;
}

export async function cachedCatalog() {
  return parseCatalog(await readTextFile(places().cache));
}

export async function fetchCatalog() {
  const r = await fetch(CATALOG, { headers: { "User-Agent": "kavex" } });
  if (!r.ok) throw new Error(`The skill list answered ${r.status}.`);
  const text = await r.text(), catalog = parseCatalog(text);
  if (!catalog) throw new Error("The skill list couldn't be read.");
  const old = await readTextFile(places().cache);
  if (old !== text) await writeTextFile(places().cache, text, old).catch(() => {});
  return catalog;
}

// Catalog skills whose folder changed since they were installed, newest catalog only.
export function catalogUpdates(catalog, lock) {
  const byId = new Map(catalog.skills.map((e) => [e.id, e]));
  const out = [];
  for (const s of Object.values(lock.skills)) {
    const e = s.source === "catalog" && byId.get(s.id);
    if (!e || e.tree === s.tree || e.tree === s.held) continue;
    if (s.seen && catalog.generated && catalog.generated < s.seen) continue;
    out.push({ name: s.name, title: s.title, tree: e.tree, entry: { ...e, seen: catalog.generated } });
  }
  return out;
}

// GitHub ----------------------------------------------------------------------

const github = (path, accept = "application/vnd.github+json") => fetch(`${API}${path}`, { headers: { "User-Agent": "kavex", Accept: accept } });

export function parseLink(link) {
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*?))?)?\/?$/.exec(link.trim());
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, ref: m[3] ?? "HEAD", path: (m[4] ?? "").replace(/\/SKILL\.md$/, "") };
}

// Every skill folder at or under a link's folder, as catalog entries.
export async function fromGitHub(link) {
  const where = parseLink(link);
  if (!where) throw new Error("That isn't a GitHub link to a repo or a folder in one.");
  const c = await github(`/repos/${where.repo}/commits/${encodeURIComponent(where.ref)}`);
  if (!c.ok) throw new Error(c.status === 404 ? "GitHub has no such repo or branch (private repos aren't supported)." : `GitHub answered ${c.status}${c.status === 403 ? ": too many requests, try again within the hour" : ""}.`);
  const commit = (await c.json()).sha;
  return skillsAt({ ...where, commit });
}

async function skillsAt({ repo, ref, path, commit }) {
  const r = await github(`/repos/${repo}/git/trees/${commit}?recursive=1`);
  if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
  const tree = (await r.json()).tree ?? [];
  const folders = new Map(tree.filter((e) => e.type === "tree").map((e) => [e.path, e.sha]));
  const inside = (p) => !path || p === path || p.startsWith(`${path}/`);
  const dirs = tree.filter((e) => e.type === "blob" && (e.path === "SKILL.md" || e.path.endsWith("/SKILL.md"))).map((e) => e.path.slice(0, -"SKILL.md".length).replace(/\/$/, "")).filter(inside);
  if (!dirs.length) throw new Error("No SKILL.md there.");
  const out = [];
  for (const dir of dirs.slice(0, 50)) {
    const files = tree.filter((e) => e.type === "blob" && e.mode !== "120000" && (dir ? e.path.startsWith(`${dir}/`) : true)).map((e) => ({ path: dir ? e.path.slice(dir.length + 1) : e.path, size: e.size, sha: e.sha }));
    if (!dir && dirs.length > 1) continue; // a repo of skills: its root SKILL.md would take them all
    const text = await (await fetch(rawUrl({ repo, commit, path: dir }, "SKILL.md"))).text();
    const meta = frontmatter(text), name = meta.name || dir.split("/").pop() || repo.split("/")[1];
    if (!validName(name)) continue;
    out.push({ id: `${repo}/${dir}`, name, title: titled(name), short: firstSentence(meta.description), description: meta.description ?? "", source: "github", repo, path: dir, ref, commit, tree: dir ? folders.get(dir) : commit, files });
  }
  return out;
}

// GitHub-link skills, one request per repo while nothing changed.
async function githubUpdates(lock) {
  const groups = new Map();
  for (const s of Object.values(lock.skills)) if (s.source === "github" && s.repo) groups.set(`${s.repo}@${s.ref}`, [...(groups.get(`${s.repo}@${s.ref}`) ?? []), s]);
  const out = [];
  for (const skills of groups.values()) {
    const { repo, ref } = skills[0];
    const r = await github(`/repos/${repo}/commits/${encodeURIComponent(ref ?? "HEAD")}`, "application/vnd.github.sha");
    if (!r.ok) continue;
    const commit = (await r.text()).trim();
    if (skills.every((s) => s.commit === commit)) continue;
    for (const s of skills) {
      const found = (await skillsAt({ repo, ref, path: s.path, commit }).catch(() => [])).find((e) => e.path === s.path);
      if (found && found.tree !== s.tree && found.tree !== s.held) out.push({ name: s.name, title: s.title, tree: found.tree, entry: found });
    }
  }
  return out;
}

// Checking ----------------------------------------------------------------------

// The footer calls this every minute with `within: EVERY`, Customize on opening and on its refresh
// button. Whichever copy finds a check due first runs it; the mark keeps a second one out.
export async function checkSkills({ within = 0, force = false } = {}) {
  if (!checksOn() && !force) return;
  const last = shared("skills.check") ?? {};
  if (last.running && Date.now() - last.running < CHECK_STALE) return;
  if (!force && last.at && Date.now() - last.at < within) return;
  setShared("skills.check", { ...last, running: Date.now() });
  let error = null, found = [];
  try {
    await op("tidy", places().store).catch(() => {});
    const { lock } = await readLock();
    try {
      found = catalogUpdates(await fetchCatalog(), lock);
    } catch (e) {
      error = String(e?.message ?? e);
    }
    found.push(...(await githubUpdates(lock).catch(() => [])));
    setShared("skills.updates", found);
    if (autoOn()) found = await updateAll(found, () => setShared("skills.check", { ...last, running: Date.now() }));
    announce(found);
  } finally {
    setShared("skills.check", { at: Date.now(), error });
  }
}

// Every update whose copy wasn't changed; returns the ones left.
export async function updateAll(found = shared("skills.updates") ?? [], beat) {
  const done = [], left = [];
  for (const u of found) {
    beat?.();
    try {
      await update(u.name, { entry: u.entry });
      done.push(u);
    } catch {
      left.push(u);
    }
  }
  if (done.length && autoOn()) notify({ title: done.length === 1 ? `${done[0].title} was updated` : `${done.length} skills were updated`, body: "Every agent has the new version.", level: "success" });
  return left;
}

const names = (list) => (list.length <= 2 ? list.map((u) => u.title).join(" and ") : `${list[0].title}, ${list[1].title} and ${list.length - 2} more`);

// One toast per new version, however many checks see it.
function announce(found) {
  const told = shared("skills.notified") ?? {};
  const fresh = found.filter((u) => told[u.name] !== u.tree);
  if (fresh.length) {
    notify({
      title: fresh.length === 1 ? `${fresh[0].title} has an update` : `${fresh.length} skill updates`,
      body: fresh.length === 1 ? "Open Customize → Skills to update it." : `${names(fresh)}: update them in Customize → Skills.`,
      level: "info",
      action: { name: "mod.open", args: { name: "customize" } },
    });
  }
  setShared("skills.notified", Object.fromEntries(found.map((u) => [u.name, u.tree])));
}

// What's on this computer ---------------------------------------------------------

// Every skill the agents can see. Kavex's own, the person's own (in a skills folder, not from Kavex),
// and the agents' own: Codex's built-in ones and Claude Code plugins'. Plugin skills are read-only.
export async function scan() {
  const { lock } = await readLock();
  const codex = join(home(), ".codex", "skills"), system = join(codex, ".system");
  const plugins = [];
  try {
    const installed = JSON.parse((await readTextFile(join(home(), ".claude", "plugins", "installed_plugins.json"))) ?? "{}").plugins ?? {};
    for (const [key, copies] of Object.entries(installed)) {
      const copy = [...(Array.isArray(copies) ? copies : [copies])].pop();
      if (copy?.installPath) plugins.push({ dir: join(copy.installPath, "skills"), plugin: key.split("@")[0] });
    }
  } catch {}
  const dirs = [...TARGETS.map(targetDir), codex, system, ...plugins.map((p) => p.dir)];
  const r = await op("scan", ...dirs);
  const rows = r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split("\t")) : [];
  const personal = new Map(), systemSkills = [], linked = {};
  for (const [dir, name, target, isSkill] of rows) {
    const s = lock.skills[name];
    const where = TARGETS.find((t) => targetDir(t) === dir);
    if (s && target === s.folder && where) {
      (linked[name] ??= []).push(where.id);
      continue;
    }
    if (isSkill !== "1") continue;
    const folder = target ? (/^([a-z]:)?[\\/]/i.test(target) ? target : join(dir, target)) : join(dir, name);
    if (dir === system) systemSkills.push({ name, folder, from: "Codex" });
    else if (dir === codex || where) {
      const p = personal.get(name) ?? { name, folder, places: [] };
      p.places.push(where ? where.label : "~/.codex/skills");
      if (!target) p.folder = folder;
      personal.set(name, p);
    } else {
      const plugin = plugins.find((x) => x.dir === dir);
      systemSkills.push({ name, folder, from: plugin ? `${plugin.plugin} plugin` : "a plugin" });
    }
  }
  const described = async (s) => {
    const meta = frontmatter(await readTextFile(join(s.folder, "SKILL.md")).catch(() => null));
    return { ...s, title: titled(meta.name || s.name), short: firstSentence(meta.description), description: meta.description ?? "" };
  };
  return {
    lock,
    linked,
    personal: await Promise.all([...personal.values()].map(described)),
    system: await Promise.all(systemSkills.map(described)),
  };
}

export async function readSkill(s) {
  if (s.folder) return readTextFile(join(s.folder, "SKILL.md")).catch(() => null);
  if (s.repo && s.commit) {
    const r = await fetch(rawUrl(s, "SKILL.md"));
    return r.ok ? r.text() : null;
  }
  return null;
}
