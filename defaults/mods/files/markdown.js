// What the Markdown reader knows, apart from drawing: which files it reads and where a document's
// links go.

export const isMarkdown = (path) => /\.(md|markdown|mdown|mkd|mdx)$/i.test(path ?? "");
export const isAbsolute = (path) => /^(\/|[A-Za-z]:[\\/])/.test(path ?? "");

// Windows paths come from a terminal with backslashes; everything here splits on `/`.
export const forwardSlashes = (path) => (/^[A-Za-z]:\\/.test(path ?? "") ? path.replaceAll("\\", "/") : path);

// Geist ships in one weight with no italics, and a document's emphasis must show. The system's
// font has them on every platform.
export const READER_FONT = ".SystemUIFont";

// A path without its `.` and `..`, which a file's own name can't be compared against.
export function tidy(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "..") {
      if (parts.length > 1 || (parts.length === 1 && parts[0] !== "")) parts.pop();
    } else if (part !== "." && (part !== "" || !parts.length)) parts.push(part);
  }
  return parts.join("/");
}

function decoded(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

// Where a link goes: `web`, `anchor` (a heading here), `file` (with its own `anchor`, if any),
// or `other`, a scheme nothing here opens.
export function linkTarget(url, folder) {
  if (url.startsWith("#")) return { anchor: decoded(url.slice(1)) };
  if (/^https?:\/\//i.test(url)) return { web: url };
  const local = url.replace(/^file:\/\/(localhost)?/i, "");
  if (/^[a-z][a-z0-9+.-]+:/i.test(local)) return { other: url };
  const [path, anchor] = local.split("#"), file = decoded(path.split("?")[0]);
  return { file: tidy(isAbsolute(file) ? file : `${folder}/${file}`), anchor: anchor ? decoded(anchor) : undefined };
}

// GitHub's anchors: lowercase, no punctuation, spaces as dashes, repeats numbered from 1.
const slug = (text) => text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

export function headingFor(outline, anchor) {
  const want = anchor.toLowerCase(), seen = new Map();
  for (const heading of outline) {
    const name = slug(heading.text), repeat = seen.get(name) ?? 0;
    seen.set(name, repeat + 1);
    if ((repeat ? `${name}-${repeat}` : name) === want) return heading;
  }
  return null;
}
