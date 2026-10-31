// Reads `git diff` text into files and hunks, and lays those out as rows to draw.
import { createHash } from "crypto";

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const LONGEST = 4000;
// Laying rows out is one step, and the runtime stops a step that runs too long.
export const MOST_ROWS = 8000;

function pathOf(line) {
  const combined = /^diff --(?:cc|combined) (.*)$/.exec(line);
  if (combined) return combined[1];
  const plain = /^diff --git a\/(.*) b\/\1$/.exec(line);
  if (plain) return plain[1];
  const quoted = /^diff --git "a\/(.*)" "b\/\1"$/.exec(line);
  if (quoted) { try { return JSON.parse(`"${quoted[1]}"`); } catch { return quoted[1]; } }
  return line.slice(line.lastIndexOf(" b/") + 3);
}

export function parseDiff(text) {
  const files = [];
  let file = null, hunk = null, left = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --")) {
      file = { path: pathOf(line), head: [line], hunks: [], binary: false, isNew: false, isDeleted: false, conflict: !line.startsWith("diff --git") };
      hunk = null; left = 0;
      files.push(file);
      continue;
    }
    if (!file) continue;
    const match = line[0] === "@" && (!hunk || left <= 0) ? HUNK.exec(line) : null;
    if (match) {
      const oldCount = match[2] === undefined ? 1 : +match[2], newCount = match[4] === undefined ? 1 : +match[4];
      hunk = { header: line, oldStart: +match[1], oldCount, newStart: +match[3], newCount, lines: [] };
      left = oldCount + newCount;
      file.hunks.push(hunk);
      continue;
    }
    if (hunk) {
      if (line[0] === "\\") hunk.lines.push(line);
      else if (left > 0) {
        // A blank context line has lost its space under diff.suppressBlankEmpty.
        const body = line === "" ? " " : line;
        left -= body[0] === " " ? 2 : 1;
        hunk.lines.push(body);
      }
      continue;
    }
    file.head.push(line);
    if (line.startsWith("new file mode")) file.isNew = true;
    else if (line.startsWith("deleted file mode")) file.isDeleted = true;
    else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) file.binary = true;
  }
  return files;
}

// A file git doesn't track yet has no diff: all of it is new.
export function newFile(path, text) {
  const lines = text.replace(/\n$/, "").split("\n");
  const count = text ? lines.length : 0;
  return {
    path, fresh: true, isNew: true, isDeleted: false, binary: false, conflict: false, head: [],
    hunks: count ? [{ header: `@@ -0,0 +1,${count} @@`, oldStart: 0, oldCount: 0, newStart: 1, newCount: count, lines: lines.map((l) => `+${l}`) }] : [],
  };
}

export const hunkPatch = (file, index) => {
  const hunk = file.hunks[index];
  return [...file.head, hunk.header, ...hunk.lines].join("\n") + "\n";
};

function clean(text) {
  const shown = text.replaceAll("\t", "    ");
  return shown.length > LONGEST ? `${shown.slice(0, LONGEST)}…` : shown;
}

// Every line of one file in the order it's drawn, with the unchanged stretches
// folded into gap rows. `text` (the file's newer side) lets a gap open; `total`
// sizes the gap after the last hunk before the text has been read.
export function fileRows(file, { text = null, total = null, open = new Set(), all = false, comments = [] } = {}) {
  const rows = [], path = file.path;
  const plain = text === null ? null : text.replace(/\n$/, "").split("\n");
  const count = plain?.length ?? total;
  const notes = new Map();
  for (const comment of comments) {
    const at = `${comment.side}:${comment.line}`;
    notes.set(at, [...(notes.get(at) ?? []), comment]);
  }
  const line = (kind, old, next, body, hunk) => {
    const row = { id: `${path}\0${kind}${old ?? ""}:${next ?? ""}`, kind, path, old, new: next, text: clean(body), hunk, spans: null };
    rows.push(row);
    for (const comment of notes.get(kind === "del" ? `old:${old}` : `new:${next}`) ?? [])
      rows.push({ id: `${path}\0c${comment.id}`, kind: "comment", path, comment });
  };
  const gap = (from, to, shift, tail = false) => {
    if (to < from) return;
    if ((all || open.has(from)) && plain) for (let n = from; n <= to; n++) line("ctx", n - shift, n, plain[n - 1] ?? "", null);
    else rows.push({ id: `${path}\0g${from}`, kind: "gap", path, from, to, count: to - from + 1, tail });
  };

  let next = 1, shift = 0;
  file.hunks.forEach((hunk, index) => {
    let o = hunk.oldCount ? hunk.oldStart : hunk.oldStart + 1;
    let n = hunk.newCount ? hunk.newStart : hunk.newStart + 1;
    if (!file.isNew && !file.isDeleted) gap(next, n - 1, n - o);
    for (const raw of hunk.lines) {
      if (rows.length >= MOST_ROWS) break;
      const body = raw.slice(1);
      if (raw[0] === "+") line("add", null, n++, body, index);
      else if (raw[0] === "-") line("del", o++, null, body, index);
      else if (raw[0] === " ") line("ctx", o++, n++, body, index);
    }
    next = n; shift = n - o;
  });
  if (rows.length >= MOST_ROWS) rows.push({ id: `${path}\0more`, kind: "note", path, text: "The rest of this diff is too long to show here" });
  else if (file.hunks.length && count !== null && !file.isNew && !file.isDeleted) gap(next, count, shift, true);
  if (!file.hunks.length) {
    const text = file.note ?? (file.binary ? "Binary file" : file.conflict ? "This file has conflicts: fix them to see its diff" : "No text changes");
    rows.push({ id: `${path}\0note`, kind: "note", path, text });
  }
  return rows;
}

// Every file in one scroll: a header row each, then its lines unless it's folded.
export function stackedRows(files, shut, optionsOf) {
  const rows = [];
  for (const file of files) {
    rows.push({ id: `${file.path}\0file`, kind: "file", path: file.path, file, first: !rows.length });
    if (!shut.has(file.path)) rows.push(...fileRows(file, optionsOf(file)));
  }
  return rows;
}

// Which of a row's right-aligned buttons a press landed on, counted from the right.
export function buttonAt(x, end, count, size, gap) {
  const from = end - x, at = Math.floor(from / (size + gap));
  return from >= 0 && at < count && from - at * (size + gap) <= size ? at : -1;
}

// The two sides next to each other: removed lines pair off with the added ones after them.
export function splitRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    if (row.kind === "ctx") { out.push({ id: row.id, kind: "pair", path: row.path, left: row, right: row }); i++; continue; }
    if (row.kind !== "add" && row.kind !== "del") { out.push(row); i++; continue; }
    const removed = [], added = [];
    while (rows[i]?.kind === "del") removed.push(rows[i++]);
    while (rows[i]?.kind === "add") added.push(rows[i++]);
    for (let n = 0; n < Math.max(removed.length, added.length); n++) {
      const left = removed[n] ?? null, right = added[n] ?? null;
      out.push({ id: `${left?.id ?? ""}|${right?.id ?? ""}`, kind: "pair", path: row.path, left, right });
    }
  }
  return out;
}

// Painted text cut into screen lines, keeping each piece's color.
export function wrapSpans(spans, columns) {
  const lines = [[]];
  let room = columns;
  for (const [text, kind] of spans) {
    let at = 0;
    while (at < text.length) {
      if (room === 0) { lines.push([]); room = columns; }
      const piece = text.slice(at, at + room);
      lines[lines.length - 1].push([piece, kind]);
      at += piece.length; room -= piece.length;
    }
  }
  return lines;
}

export const lineCount = (text, columns) => Math.max(1, Math.ceil(text.length / Math.max(1, columns)));

// The next index in `list` a step away from `at`, wrapping round.
export const stepped = (at, step, length) => (length ? (at + step + length) % length : -1);

// Natively: a whole file's characters are too many to walk in script.
export function signature(file) {
  const hash = createHash("sha1");
  for (const hunk of file.hunks) hash.update(`${hunk.header}\n${hunk.lines.join("\n")}\n`);
  return `${file.hunks.length}.${hash.digest("hex").slice(0, 16)}`;
}
