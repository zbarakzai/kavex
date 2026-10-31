// What the panel asks of git, and how to read the answers. Nothing here runs git.

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
export const READ = ["--literal-pathspecs", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "core.quotePath=false"];
export const DIFF = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];

// Saves the working files as a tree without touching the index or any ref.
export const SNAPSHOT = 'd=$(mktemp -d) || exit 1; i="$d/index"; cp "$(git rev-parse --git-path index)" "$i" 2>/dev/null; GIT_INDEX_FILE="$i" git -c core.fsmonitor=false add -A . && GIT_INDEX_FILE="$i" git write-tree; s=$?; rm -rf "$d"; exit $s';

export function parseNumstat(text) {
  const files = [];
  for (const entry of text.split("\0")) {
    const [add, del, ...parts] = entry.split("\t");
    if (!parts.length) continue;
    files.push({ path: parts.join("\t"), add: Number(add) || 0, del: Number(del) || 0, binary: add === "-" });
  }
  return files;
}

export const untrackedPaths = (status) => status.split("\0").filter((entry) => entry.startsWith("?? ")).map((entry) => entry.slice(3));

export function parseRefs(text) {
  const out = [];
  for (const ref of text.split("\n")) {
    if (!ref || ref.endsWith("/HEAD")) continue;
    out.push(ref.replace(/^refs\/(heads|remotes)\//, ""));
  }
  return out;
}

export function chooseBase(branch, refs, originHead, kept) {
  const wanted = [kept, originHead?.replace(/^refs\/remotes\//, ""), "origin/main", "origin/master", "main", "master", "upstream/main"];
  return wanted.find((ref) => ref && ref !== branch && refs.includes(ref)) ?? refs.find((ref) => ref !== branch) ?? null;
}

export function parseLog(text) {
  return text.split("\n").filter(Boolean).map((line) => {
    const [sha, short, subject, when] = line.split("\0");
    return { sha, short, subject, when };
  });
}

// `git grep -c --null` lines: `<rev>:<path>\0<count>` (no rev for the index or the working files).
export function parseCounts(text, rev) {
  const counts = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("\0");
    if (at < 0) continue;
    const path = line.slice(0, at);
    counts[rev && path.startsWith(`${rev}:`) ? path.slice(rev.length + 1) : path] = Number(line.slice(at + 1));
  }
  return counts;
}

// One message for an agent. A person's words stay exactly as written.
export function reviewMessage(comments) {
  const notes = comments.map(({ path, line, code, text }) => `${path}:${line}\n> ${(code ?? "").trim()}\n${text}`);
  return `Review comments on these changes:\n\n${notes.join("\n\n")}`;
}

// What `stage`, `unstage` or `revert` means in a scope, for the whole diff (no
// target), a file or one hunk. Commands run in order; `patch` applies a diff.
// A revert outside Unstaged undoes what's shown, so it works from the diff itself.
export function planAction(action, scope, { file = null, hunk = null, hasHead = true } = {}) {
  const path = file?.path, partial = hunk !== null && !file?.fresh;
  if (action === "stage") {
    if (partial) return { patch: "hunk", flags: ["--cached"] };
    return { commands: [file ? ["add", "--", path] : ["add", "-A"]] };
  }
  if (action === "unstage") {
    if (partial) return { patch: "hunk", flags: ["--cached", "-R"] };
    if (!hasHead) return { commands: [["rm", "-r", "--cached", "-q", "--", path ?? "."]] };
    return { commands: [["restore", "--staged", "--", path ?? "."]] };
  }
  if (file?.fresh) return { commands: [["clean", "-f", "--", path]] };
  if (partial) return { patch: "hunk", flags: scope === "staged" ? ["-R", "--index"] : ["-R"] };
  if (scope === "unstaged") return { commands: file ? [["restore", "--", path]] : [["restore", "."], ["clean", "-fd"]] };
  return { patch: file ? "file" : "all", flags: scope === "staged" ? ["-R", "--index"] : ["-R"] };
}
