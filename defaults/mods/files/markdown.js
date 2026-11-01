// What the Markdown reader knows, apart from drawing: which files it reads, where a document's
// links go and how it looks in the theme shown.

export const isMarkdown = (path) => /\.(md|markdown|mdown|mkd|mdx)$/i.test(path ?? "");
export const isAbsolute = (path) => /^(\/|[A-Za-z]:[\\/])/.test(path ?? "");

// Windows paths come from a terminal with backslashes; everything here splits on `/`.
export const forward = (path) => (/^[A-Za-z]:\\/.test(path ?? "") ? path.replaceAll("\\", "/") : path);

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

export const syntaxColors = (t) => ({ keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 });

const tint = (color, alpha) => `${color.slice(0, 7)}${alpha}`;

export const readerLook = (t) => ({
  foreground: t.text_secondary,
  heading: t.foreground,
  muted: t.muted,
  // Blue, as links are: orange means "you" here. Task boxes take this color too.
  link: t.ansi4,
  code: t.well,
  inline_code: t.hover,
  border: t.card_border,
  hover: t.hover_strong,
  // Selections paint over the glyphs, so a solid color hides what's selected.
  selection: tint(t.foreground, "26"),
  alerts: [t.ansi4, t.ansi2, t.ansi5, t.ansi3, t.failed],
  mark: tint(t.ansi3, "40"),
  mark_active: tint(t.accent, "80"),
  syntax: syntaxColors(t),
  copy_icon: "mods/workspace-chrome/icons/copy.svg",
  copied_icon: "mods/workspace-chrome/icons/check.svg",
});
