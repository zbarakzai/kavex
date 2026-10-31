// The changed files as a folder tree, and which little icon each one wears.

const name = (a) => a.toLowerCase();
const byName = (a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0);

export function buildTree(files) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/"), leaf = parts.pop();
    let node = root, path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path, dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push({ name: leaf, file });
  }
  return root;
}

// A folder holding only one folder shares a row with it, as `apps / web`.
function joined(dir) {
  let node = dir, label = dir.name;
  while (node.dirs.size === 1 && !node.files.length) {
    node = [...node.dirs.values()][0];
    label += ` / ${node.name}`;
  }
  return { node, label };
}

export function treeRows(node, shut = new Set(), depth = 0, out = []) {
  for (const dir of [...node.dirs.values()].sort((a, b) => byName(a.name, b.name))) {
    const { node: shown, label } = joined(dir), open = !shut.has(shown.path);
    out.push({ kind: "dir", id: `d:${shown.path}`, path: shown.path, name: label, depth, open });
    if (open) treeRows(shown, shut, depth + 1, out);
  }
  for (const { name: leaf, file } of [...node.files].sort((a, b) => byName(a.name, b.name)))
    out.push({ kind: "file", id: `f:${file.path}`, name: leaf, depth, file });
  return out;
}

export const inTreeOrder = (files) => treeRows(buildTree(files)).filter((row) => row.kind === "file").map((row) => row.file);

export function filtered(files, filter) {
  const wanted = filter.trim().toLowerCase();
  return wanted ? files.filter((file) => file.path.toLowerCase().includes(wanted)) : files;
}

const inOrder = (text, wanted) => {
  let at = 0;
  for (const letter of wanted) {
    at = text.indexOf(letter, at) + 1;
    if (!at) return false;
  }
  return true;
};

// The files a jump can reach, by name. Typed text matching the name comes first,
// then matching the path, then letters found in order along the path.
export function jumpList(files, query) {
  const wanted = query.trim().toLowerCase(), found = [];
  for (const { path } of files) {
    const parts = path.split("/"), leaf = parts.pop(), lower = path.toLowerCase();
    const rank = leaf.toLowerCase().includes(wanted) ? 0 : lower.includes(wanted) ? 1 : inOrder(lower, wanted) ? 2 : -1;
    if (rank >= 0) found.push({ path, name: leaf, folder: parts.join("/"), rank });
  }
  return found.sort((a, b) => a.rank - b.rank || byName(a.name, b.name) || byName(a.path, b.path));
}

// Too long for `room` characters: both ends stay, as the end says which folder it is.
export function middle(text, room) {
  if (text.length <= room) return text;
  const keep = room - 1, tail = Math.floor(keep / 2);
  return `${text.slice(0, keep - tail)}…${text.slice(text.length - tail)}`;
}

const ICONS = {
  tsx: ["react", "ansi6"], jsx: ["react", "ansi6"], ts: ["ts", "ansi4"], mts: ["ts", "ansi4"], cts: ["ts", "ansi4"],
  js: ["js", "ansi3"], mjs: ["js", "ansi3"], cjs: ["js", "ansi3"], json: ["json", "ansi3"], jsonc: ["json", "ansi3"],
  yml: ["yaml", "ansi1"], yaml: ["yaml", "ansi1"], toml: ["config", "ansi3"], ini: ["config", "ansi3"], env: ["config", "ansi3"],
  md: ["markdown", "ansi4"], mdx: ["markdown", "ansi4"], rs: ["rust", "ansi3"], py: ["python", "ansi4"], go: ["go", "ansi6"],
  css: ["css", "ansi5"], scss: ["css", "ansi5"], html: ["html", "ansi3"], sh: ["shell", "ansi2"], bash: ["shell", "ansi2"], zsh: ["shell", "ansi2"],
  png: ["image", "ansi5"], jpg: ["image", "ansi5"], jpeg: ["image", "ansi5"], gif: ["image", "ansi5"], svg: ["image", "ansi5"], webp: ["image", "ansi5"],
  lock: ["lock", null],
};

export function iconOf(path) {
  const leaf = path.split("/").pop().toLowerCase();
  if (leaf === "dockerfile" || leaf === "justfile" || leaf === "makefile") return ["shell", "ansi2"];
  if (leaf.endsWith("-lock.yaml") || leaf.endsWith(".lock") || leaf === "package-lock.json") return ["lock", null];
  return ICONS[leaf.split(".").pop()] ?? ["file", null];
}
