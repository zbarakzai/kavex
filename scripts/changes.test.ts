import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buttonAt, fileRows, hunkPatch, lineCount, newFile, parseDiff, signature, splitRows, stackedRows, stepped, wrapSpans } from "../defaults/mods/changes/diff.js";
import { languageOf, paint } from "../defaults/mods/changes/tokens.js";
import { buildTree, filtered, inTreeOrder, jumpList, middle, treeRows } from "../defaults/mods/changes/tree.js";
import { SNAPSHOT, chooseBase, parseCounts, parseLog, parseNumstat, parseRefs, planAction, reviewMessage, untrackedPaths } from "../defaults/mods/changes/git.js";

const edited = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -18,5 +18,6 @@ function main() {
 one
 two
-old
+new
+more
 three
 four
@@ -40,2 +41,2 @@ later
 five
-six
+seven
`;

const kinds = (rows: { kind: string }[]) => rows.map((row) => row.kind).join(" ");

test("a diff reads into files and hunks", () => {
  const [file] = parseDiff(edited);
  expect(file.path).toBe("src/app.ts");
  expect(file.hunks.map((h) => [h.oldStart, h.newStart, h.lines.length])).toEqual([[18, 18, 7], [40, 41, 3]]);
});

test("a path with spaces survives", () => {
  const [file] = parseDiff("diff --git a/my dir/b c.txt b/my dir/b c.txt\nindex 1..2 100644\nBinary files a/my dir/b c.txt and b/my dir/b c.txt differ\n");
  expect(file.path).toBe("my dir/b c.txt");
  expect(file.binary).toBe(true);
});

test("new and deleted files are marked, with no gaps around them", () => {
  const [added, gone] = parseDiff(`diff --git a/n b/n
new file mode 100644
--- /dev/null
+++ b/n
@@ -0,0 +1,2 @@
+a
+b
diff --git a/d b/d
deleted file mode 100644
--- a/d
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
`);
  expect([added.isNew, gone.isDeleted]).toEqual([true, true]);
  expect(kinds(fileRows(added, { total: 2 }))).toBe("add add");
  expect(kinds(fileRows(gone))).toBe("del del");
});

test("unchanged stretches fold into gaps with their real size", () => {
  const rows = fileRows(parseDiff(edited)[0], { total: 50 });
  expect(rows.filter((r) => r.kind === "gap").map((r) => [r.from, r.to, r.count])).toEqual([[1, 17, 17], [24, 40, 17], [43, 50, 8]]);
});

test("only the gap after the last hunk opens downward", () => {
  const rows = fileRows(parseDiff(edited)[0], { total: 50 }).filter((r) => r.kind === "gap");
  expect(rows.map((r) => r.tail)).toEqual([false, false, true]);
});

test("the last gap waits until the file's length is known", () => {
  const rows = fileRows(parseDiff(edited)[0]);
  expect(rows.filter((r) => r.kind === "gap").length).toBe(2);
});

test("an opened gap shows the lines with both numbers", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const rows = fileRows(parseDiff(edited)[0], { text, open: new Set([24]) });
  const opened = rows.filter((r) => r.kind === "ctx" && r.new >= 24 && r.new <= 40);
  expect(opened.length).toBe(17);
  expect([opened[0].old, opened[0].new, opened[0].text]).toEqual([23, 24, "line 24"]);
  expect(rows.filter((r) => r.kind === "gap").length).toBe(2);
});

test("the whole file opens every gap, the one after the last hunk too", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const rows = fileRows(parseDiff(edited)[0], { text, all: true });
  expect(rows.some((r) => r.kind === "gap")).toBe(false);
  expect(rows[rows.length - 1].new).toBe(50);
  expect(rows[rows.length - 1].old).toBe(49);
});

test("rows have unique ids", () => {
  const rows = fileRows(parseDiff(edited)[0], { total: 50 });
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
});

test("a comment sits under its line, on the right side of a change", () => {
  const comments = [{ id: "a", side: "new", line: 21, text: "why" }, { id: "b", side: "old", line: 20, text: "gone" }];
  const rows = fileRows(parseDiff(edited)[0], { comments });
  const at = rows.findIndex((r) => r.kind === "del");
  expect(rows[at + 1].comment.id).toBe("b");
  const added = rows.findIndex((r) => r.new === 21);
  expect(rows[added + 1].comment.id).toBe("a");
});

test("binary, conflicted and empty files say so", () => {
  expect(fileRows({ path: "a", hunks: [], binary: true, head: [] })[0].text).toBe("Binary file");
  expect(fileRows(parseDiff("diff --cc a\nindex 1,2..3\n--- a/a\n+++ b/a\n@@@ -1,1 -1,1 +1,1 @@@\n")[0])[0].text).toContain("conflicts");
  expect(fileRows({ path: "a", hunks: [], head: [] })[0].text).toBe("No text changes");
});

test("an untracked file is all new", () => {
  const file = newFile("a.txt", "one\ntwo\n");
  expect(file.fresh).toBe(true);
  expect(kinds(fileRows(file))).toBe("add add");
  expect(fileRows(newFile("empty", ""))[0].text).toBe("No text changes");
});

test("side by side pairs removed lines with the added ones after them", () => {
  const pairs = splitRows(fileRows(parseDiff(edited)[0]));
  const change = pairs.find((p) => p.left?.kind === "del");
  expect([change.left.text, change.right.text]).toEqual(["old", "new"]);
  const alone = pairs[pairs.indexOf(change) + 1];
  expect([alone.left, alone.right.text]).toEqual([null, "more"]);
  expect(new Set(pairs.map((p) => p.id)).size).toBe(pairs.length);
});

test("wrapping cuts painted text at the column and keeps its colors", () => {
  expect(wrapSpans([["abcd", "keyword"], ["efg", null]], 3)).toEqual([[["abc", "keyword"]], [["d", "keyword"], ["ef", null]], [["g", null]]]);
  expect(wrapSpans([], 3)).toEqual([[]]);
  expect(lineCount("abcdefg", 3)).toBe(3);
  expect(lineCount("", 3)).toBe(1);
});

test("tabs show as spaces and a huge line is cut", () => {
  const file = newFile("a", `\tx\n${"y".repeat(5000)}\n`);
  const rows = fileRows(file);
  expect(rows[0].text).toBe("    x");
  expect(rows[1].text.length).toBe(4001);
});

test("a huge file stops at a note instead of drawing every row", () => {
  const rows = fileRows(newFile("a", Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n")));
  expect(rows.length).toBe(8001);
  expect(rows[rows.length - 1].text).toContain("too long");
});

test("stepping through files wraps round", () => {
  expect(stepped(0, -1, 3)).toBe(2);
  expect(stepped(2, 1, 3)).toBe(0);
  expect(stepped(0, 1, 0)).toBe(-1);
});

test("a signature changes with the diff", () => {
  const before = parseDiff(edited)[0];
  const after = parseDiff(edited.replace("+more", "+other"))[0];
  expect(signature(before)).toBe(signature(parseDiff(edited)[0]));
  expect(signature(before)).not.toBe(signature(after));
});

test("languages come from the file's name", () => {
  expect(["a/b.tsx", "x.rs", ".github/x.yml", "Justfile", "a.unknown"].map(languageOf)).toEqual(["js", "rust", "yaml", "shell", null]);
});

const joined = (spans: [string, string | null][]) => spans.map(([text]) => text).join("");

test("painting keeps every character", () => {
  const lines = ['const a = "b"; // c', "  return foo(1) + Bar;", "a ' b", ""];
  paint(lines, "js").forEach((spans, i) => expect(joined(spans)).toBe(lines[i]));
});

test("code gets its kinds", () => {
  const [spans] = paint(['const x = foo(42, "s"); // no'], "js");
  const of = (text: string) => spans.find(([t]) => t === text)?.[1];
  expect(of("const")).toBe("keyword");
  expect(of("foo")).toBe("function");
  expect(of("42")).toBe("number");
  expect(of('"s"')).toBe("string");
  expect(of("// no")).toBe("comment");
});

test("a comment or a long string carries across lines", () => {
  expect(paint(["/* a", "b", "c */ let"], "js").map((s) => s[0][1])).toEqual(["comment", "comment", "comment"]);
  expect(paint(["x = `a", "b` + 1"], "js")[1][0]).toEqual(["b`", "string"]);
  expect(paint(['"""doc', 'text"""'], "python")[1][0]).toEqual(['text"""', "string"]);
});

test("data files color their keys", () => {
  expect(paint(["  name: Run Biome"], "yaml")[0][0]).toEqual(["  name", "key"]);
  expect(paint(["  - uses: actions/checkout@v4"], "yaml")[0][0]).toEqual(["  - uses", "key"]);
  expect(paint(['  "a": 1'], "json")[0][0]).toEqual(['  "a"', "key"]);
  expect(paint(["# only a note"], "yaml")[0][0]).toEqual(["# only a note", "comment"]);
});

test("an unknown language or a huge line stays plain", () => {
  expect(paint(["const x"], null)[0]).toEqual([["const x", null]]);
  expect(paint(["x".repeat(700)], "js")[0][0][1]).toBeNull();
});

const paths = (...list: string[]) => list.map((path) => ({ path }));

test("folders with one folder share a row, folders come first", () => {
  const rows = treeRows(buildTree(paths("apps/web/a.ts", "apps/web/lib/b.ts", ".github/workflows/x.yml", "README.md")));
  expect(rows.map((r) => [r.depth, r.name])).toEqual([[0, ".github / workflows"], [1, "x.yml"], [0, "apps / web"], [1, "lib"], [2, "b.ts"], [1, "a.ts"], [0, "README.md"]]);
});

test("a shut folder hides what's in it", () => {
  const rows = treeRows(buildTree(paths("a/b/c.ts", "d.ts")), new Set(["a/b"]));
  expect(rows.map((r) => r.name)).toEqual(["a / b", "d.ts"]);
  expect(rows[0].open).toBe(false);
});

test("files sort as the tree shows them, ignoring case", () => {
  expect(inTreeOrder(paths("b/z.ts", "b.ts", "B/a.ts", "a.ts", "Z.ts", "media-upload.ts", "MediaCard.tsx")).map((f) => f.path)).toEqual(["b/z.ts", "B/a.ts", "a.ts", "b.ts", "media-upload.ts", "MediaCard.tsx", "Z.ts"]);
});

test("the filter matches anywhere in the path", () => {
  expect(filtered(paths("apps/web/a.ts", "b.rs"), "WEB").map((f) => f.path)).toEqual(["apps/web/a.ts"]);
  expect(filtered(paths("a"), "  ").length).toBe(1);
});

test("numstat reads counts, binaries and tabs in a path", () => {
  expect(parseNumstat("1\t2\ta b\0-\t-\timg.png\0003\t0\tx\ty\0")).toEqual([
    { path: "a b", add: 1, del: 2, binary: false }, { path: "img.png", add: 0, del: 0, binary: true }, { path: "x\ty", add: 3, del: 0, binary: false },
  ]);
});

test("only untracked entries come out of status", () => {
  expect(untrackedPaths(" M a\0?? b c\0A  d\0")).toEqual(["b c"]);
});

test("refs lose their prefix and the HEAD pointers", () => {
  expect(parseRefs("refs/heads/main\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/dev\n")).toEqual(["main", "origin/dev"]);
});

test("the base is the kept one, else what origin says, else the usual names", () => {
  const refs = ["feat", "main", "origin/main", "origin/dev"];
  expect(chooseBase("feat", refs, null, "origin/dev")).toBe("origin/dev");
  expect(chooseBase("feat", refs, "refs/remotes/origin/dev", null)).toBe("origin/dev");
  expect(chooseBase("feat", refs, null, null)).toBe("origin/main");
  expect(chooseBase("feat", refs, null, "gone")).toBe("origin/main");
  expect(chooseBase("main", ["main"], null, null)).toBeNull();
  expect(chooseBase("x", ["x", "other"], null, null)).toBe("other");
});

test("log lines split into commits", () => {
  expect(parseLog("abc\0a\0fix it\x002 days ago\n")).toEqual([{ sha: "abc", short: "a", subject: "fix it", when: "2 days ago" }]);
});

test("grep counts lose the revision in front of the path", () => {
  expect(parseCounts("abc:src/a.ts\x0012\nabc:b\x003\n", "abc")).toEqual({ "src/a.ts": 12, b: 3 });
  expect(parseCounts("src/a.ts\x0012\n", null)).toEqual({ "src/a.ts": 12 });
});

test("a review message names each line and quotes it", () => {
  expect(reviewMessage([{ path: "a.ts", line: 3, code: "  x()", text: "why?" }])).toBe("Review comments on these changes:\n\na.ts:3\n> x()\nwhy?");
});

test("each action means the right thing in each scope", () => {
  const file = { path: "a" }, fresh = { path: "n", fresh: true };
  expect(planAction("stage", "unstaged")).toEqual({ commands: [["add", "-A"]] });
  expect(planAction("stage", "unstaged", { file })).toEqual({ commands: [["add", "--", "a"]] });
  expect(planAction("stage", "unstaged", { file, hunk: 0 })).toEqual({ patch: "hunk", flags: ["--cached"] });
  expect(planAction("stage", "unstaged", { file: fresh, hunk: 0 })).toEqual({ commands: [["add", "--", "n"]] });
  expect(planAction("unstage", "staged", { file })).toEqual({ commands: [["restore", "--staged", "--", "a"]] });
  expect(planAction("unstage", "staged", { file, hunk: 1 })).toEqual({ patch: "hunk", flags: ["--cached", "-R"] });
  expect(planAction("unstage", "staged", { hasHead: false })).toEqual({ commands: [["rm", "-r", "--cached", "-q", "--", "."]] });
  expect(planAction("revert", "unstaged", { file })).toEqual({ commands: [["restore", "--", "a"]] });
  expect(planAction("revert", "unstaged", { file: fresh })).toEqual({ commands: [["clean", "-f", "--", "n"]] });
  expect(planAction("revert", "unstaged")).toEqual({ commands: [["restore", "."], ["clean", "-fd"]] });
  expect(planAction("revert", "unstaged", { file, hunk: 0 })).toEqual({ patch: "hunk", flags: ["-R"] });
  expect(planAction("revert", "staged", { file })).toEqual({ patch: "file", flags: ["-R", "--index"] });
  expect(planAction("revert", "branch")).toEqual({ patch: "all", flags: ["-R"] });
  expect(planAction("revert", "turn", { file })).toEqual({ patch: "file", flags: ["-R"] });
});

// The real thing: what git does with the patches and the snapshot.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "zaki-changes-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", input: "", stdio: ["pipe", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  writeFileSync(join(dir, "a.txt"), text);
  git("add", "-A");
  git("commit", "-qm", "first");
  writeFileSync(join(dir, "a.txt"), text.replace("line 2\n", "line two\n").replace("line 28\n", "line twenty eight\n"));
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("one hunk's patch stages only that hunk", () => {
  const { dir, git, cleanup } = repo();
  try {
    const [file] = parseDiff(git("diff"));
    expect(file.hunks.length).toBe(2);
    writeFileSync(join(dir, "p.patch"), hunkPatch(file, 0));
    git("apply", "--cached", "p.patch");
    expect(git("diff", "--cached", "--numstat")).toStartWith("1\t1\ta.txt");
    expect(parseDiff(git("diff", "--", "a.txt"))[0].hunks.length).toBe(1);
  } finally { cleanup(); }
});

test("one hunk's patch reverts only that hunk", () => {
  const { dir, git, cleanup } = repo();
  try {
    const [file] = parseDiff(git("diff"));
    writeFileSync(join(dir, "p.patch"), hunkPatch(file, 1));
    git("apply", "-R", "p.patch");
    const text = readFileSync(join(dir, "a.txt"), "utf8");
    expect(text).toContain("line two\n");
    expect(text).toContain("line 28\n");
  } finally { cleanup(); }
});

test("a file with no newline at its end still patches", () => {
  const { dir, git, cleanup } = repo();
  try {
    writeFileSync(join(dir, "b.txt"), "a\nb");
    git("add", "-A");
    git("commit", "-qm", "second");
    writeFileSync(join(dir, "b.txt"), "a\nc");
    const file = parseDiff(git("diff", "--", "b.txt"))[0];
    writeFileSync(join(dir, "p.patch"), hunkPatch(file, 0));
    git("apply", "-R", "p.patch");
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("a\nb");
  } finally { cleanup(); }
});

test("a snapshot sees new files and leaves the index alone", () => {
  const { dir, git, cleanup } = repo();
  try {
    const before = git("status", "--porcelain");
    const start = execFileSync("sh", ["-c", SNAPSHOT], { cwd: dir, encoding: "utf8" }).trim();
    expect(git("status", "--porcelain")).toBe(before);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/new.txt"), "hello\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const end = execFileSync("sh", ["-c", SNAPSHOT], { cwd: dir, encoding: "utf8" }).trim();
    expect(git("status", "--porcelain")).toContain("?? src/");
    const files = parseNumstat(git("diff", "--numstat", "-z", "--no-renames", start, end));
    expect(files.map((f) => f.path).sort()).toEqual(["a.txt", "src/new.txt"]);
    expect(parseNumstat(git("diff", "--numstat", "-z", "--no-renames", start, start))).toEqual([]);
  } finally { cleanup(); }
});

test("a turn's diff reverses from the working files, new files too", () => {
  const { dir, git, cleanup } = repo();
  try {
    const start = execFileSync("sh", ["-c", SNAPSHOT], { cwd: dir, encoding: "utf8" }).trim();
    writeFileSync(join(dir, "fresh.txt"), "hello\n");
    const end = execFileSync("sh", ["-c", SNAPSHOT], { cwd: dir, encoding: "utf8" }).trim();
    writeFileSync(join(dir, "p.patch"), git("diff", "--binary", "--no-renames", start, end));
    git("apply", "-R", "p.patch");
    rmSync(join(dir, "p.patch"));
    expect(git("status", "--porcelain")).toBe(" M a.txt\n");
  } finally { cleanup(); }
});

test("grep counts every changed file's lines in one go", () => {
  const { git, cleanup } = repo();
  try {
    expect(parseCounts(git("grep", "-I", "-c", "--null", "-e", "", "--", "a.txt"), null)).toEqual({ "a.txt": 30 });
    expect(parseCounts(git("grep", "-I", "-c", "--null", "-e", "", "--cached", "--", "a.txt"), null)).toEqual({ "a.txt": 30 });
    const head = git("rev-parse", "HEAD").trim();
    expect(parseCounts(git("grep", "-I", "-c", "--null", "-e", "", head, "--", "a.txt"), head)).toEqual({ "a.txt": 30 });
  } finally { cleanup(); }
});

const jumpFiles = ["packages/api/tests/preset-generation.test.ts", ".vscode/settings.json", "apps/web/Dockerfile", "packages/schemas/lib/studio-preset.ts"].map((path) => ({ path }));

test("jump lists files by name, ignoring case, with their folder beside them", () => {
  const rows = jumpList(jumpFiles, "");
  expect(rows.map((row) => row.name)).toEqual(["Dockerfile", "preset-generation.test.ts", "settings.json", "studio-preset.ts"]);
  expect(rows[0].folder).toBe("apps/web");
  expect(jumpList([{ path: "README.md" }], "")[0].folder).toBe("");
});

test("a typed match in the name beats one in the folder, and letters in order still count", () => {
  const files = [{ path: "src/web/app.ts" }, { path: "lib/web.ts" }];
  expect(jumpList(files, " WEB ").map((row) => row.path)).toEqual(["lib/web.ts", "src/web/app.ts"]);
  expect(jumpList(jumpFiles, "pgen").map((row) => row.name)).toEqual(["preset-generation.test.ts"]);
  expect(jumpList(jumpFiles, "zzz")).toEqual([]);
});

test("a long folder loses its middle, and one that fits is left alone", () => {
  expect(middle("packages/api", 12)).toBe("packages/api");
  const short = middle("packages/api/modules/brand-model/lib", 31);
  expect(short).toBe("packages/api/mo…brand-model/lib");
  expect(short.length).toBe(31);
});

test("every file stacks under its own header, and a folded file keeps only the header", () => {
  const files = ["a.ts", "b.ts"].map((path) => newFile(path, "one\ntwo\n"));
  const kinds = (rows) => rows.map((row) => `${row.kind}:${row.path}`);
  const all = stackedRows(files, new Set(), () => ({}));
  expect(kinds(all)).toEqual(["file:a.ts", "add:a.ts", "add:a.ts", "file:b.ts", "add:b.ts", "add:b.ts"]);
  expect(all.filter((row) => row.first).map((row) => row.path)).toEqual(["a.ts"]);
  expect(new Set(all.map((row) => row.id)).size).toBe(all.length);
  expect(kinds(stackedRows(files, new Set(["a.ts"]), () => ({})))).toEqual(["file:a.ts", "file:b.ts", "add:b.ts", "add:b.ts"]);
  expect(splitRows(all).filter((row) => row.kind === "file").length).toBe(2);
});

test("a press on a file's header finds its button from the right edge", () => {
  expect(buttonAt(100, 100, 3, 26, 2)).toBe(0);
  expect(buttonAt(74, 100, 3, 26, 2)).toBe(0);
  expect(buttonAt(73, 100, 3, 26, 2)).toBe(-1);
  expect(buttonAt(72, 100, 3, 26, 2)).toBe(1);
  expect(buttonAt(30, 100, 3, 26, 2)).toBe(2);
  expect(buttonAt(10, 100, 3, 26, 2)).toBe(-1);
  expect(buttonAt(101, 100, 3, 26, 2)).toBe(-1);
});

test("the whole diff parses into each file's own hunks, which patch alone", () => {
  const { dir, git, cleanup } = repo();
  try {
    writeFileSync(join(dir, "b.txt"), "b\n");
    git("add", "b.txt");
    git("commit", "-qm", "second");
    writeFileSync(join(dir, "b.txt"), "changed\n");
    const files = parseDiff(git("diff"));
    expect(files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    const only = files.find((file) => file.path === "b.txt");
    writeFileSync(join(dir, "p.patch"), hunkPatch(only, 0));
    git("apply", "--cached", "p.patch");
    expect(git("diff", "--cached", "--name-only").trim()).toBe("b.txt");
  } finally { cleanup(); }
});
