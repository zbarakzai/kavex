// Colors a diff's lines. Native highlighting belongs to the editor element and
// can't paint separate rows, so this is a small line scanner of the same kinds:
// keyword, string, comment, function, type, number, literal, key.

const words = (list) => new Set(list.split(" "));

const LITERALS = words("true false null undefined nil None True False NaN Infinity self this super");
const C = { line: ["//"], block: ["/*", "*/"], quotes: ["\"", "'"], code: true };
const LANGUAGES = {
  js: { ...C, quotes: ["\"", "'"], long: ["`"], words: words("abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function if implements import in instanceof interface let namespace new of private protected public readonly return satisfies static switch throw try type typeof var void while yield") },
  rust: { ...C, quotes: ["\""], words: words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct trait type unsafe use where while") },
  go: { ...C, long: ["`"], words: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var") },
  c: { ...C, words: words("auto break case catch char class const continue default delete do double else enum extern float for friend goto if inline int long namespace new operator private protected public register return short signed sizeof static struct switch template throw try typedef union unsigned using virtual void volatile while") },
  java: { ...C, words: words("abstract as assert async await boolean break byte case catch char class const continue data def default do double else enum extends extension false final finally float for fun func guard if implements import in init instanceof int interface internal is let long native new object open override package private protected public return short static struct super switch synchronized throw throws transient try typealias val var void volatile when where while") },
  python: { line: ["#"], quotes: ["\"", "'"], long: ["\"\"\"", "'''"], code: true, words: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield") },
  ruby: { line: ["#"], quotes: ["\"", "'"], code: true, words: words("alias and begin break case class def defined do else elsif end ensure for if in module next not or redo require rescue retry return unless until when while yield") },
  shell: { line: ["#"], quotes: ["\"", "'"], variables: true, words: words("case do done elif else esac exit export fi for function if in local readonly return set then unset until while") },
  sql: { line: ["--"], block: ["/*", "*/"], quotes: ["'"], words: words("add all alter and as asc begin between by case column commit constraint create delete desc distinct drop else end exists foreign from group having if in index inner insert into is join key left like limit not null on or order outer primary references right rollback select set table then transaction union unique update values view when where with") },
  css: { block: ["/*", "*/"], quotes: ["\"", "'"], keys: /^\s*[\w-]+(?=\s*:)/ },
  json: { line: ["//"], quotes: ["\""], keys: /^\s*"(?:[^"\\]|\\.)*"(?=\s*:)/ },
  yaml: { line: ["#"], quotes: ["\"", "'"], keys: /^\s*(?:- +)*[\w./-]+(?=:(?:\s|$))/ },
  toml: { line: ["#"], quotes: ["\"", "'"], long: ["\"\"\""], keys: /^\s*(?:\[[^\]]*\]+|[\w.-]+(?=\s*=))/ },
  markup: { block: ["<!--", "-->"], quotes: ["\"", "'"], tags: /<\/?[\w:.-]+|\/?>/y },
  markdown: { fences: true },
};
const EXTENSIONS = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", mts: "js", cts: "js", rs: "rust", go: "go",
  c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", cs: "c", java: "java", kt: "java", kts: "java", swift: "java", scala: "java",
  py: "python", pyi: "python", rb: "ruby", sh: "shell", bash: "shell", zsh: "shell", fish: "shell", env: "shell",
  sql: "sql", css: "css", scss: "css", less: "css", json: "json", jsonc: "json", json5: "json", yml: "yaml", yaml: "yaml",
  toml: "toml", html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", svelte: "markup", md: "markdown", mdx: "markdown",
};
const NAMES = { justfile: "shell", makefile: "shell", dockerfile: "shell", ".gitignore": "shell", ".zshrc": "shell", ".bashrc": "shell" };

export function languageOf(path) {
  const name = path.split("/").pop().toLowerCase();
  return NAMES[name] ?? EXTENSIONS[name.split(".").pop()] ?? null;
}

const WORD = /[A-Za-z_$][\w$]*/y, NUMBER = /0[xXbB][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/y, VARIABLE = /\$\{?\w+\}?/y;

function closing(line, from, quote) {
  for (let at = from; at < line.length; at++) {
    if (line[at] === "\\") { at++; continue; }
    if (line.startsWith(quote, at)) return at + quote.length;
  }
  return -1;
}

const match = (pattern, line, at) => {
  pattern.lastIndex = at;
  return pattern.exec(line)?.[0] ?? null;
};

function scan(line, lang, state) {
  const spans = [];
  const push = (text, kind) => {
    const last = spans[spans.length - 1];
    if (last && last[1] === kind) last[0] += text;
    else spans.push([text, kind]);
  };

  if (lang.fences) {
    if (/^\s*```/.test(line)) { state.fenced = !state.fenced; return [[line, "string"]]; }
    if (state.fenced) return [[line, "string"]];
    if (/^#{1,6}\s/.test(line)) return [[line, "keyword"]];
    return [[line, null]];
  }

  let at = 0;
  if (lang.keys && !state.until) {
    const key = lang.keys.exec(line)?.[0];
    if (key) { push(key, "key"); at = key.length; }
  }
  while (at < line.length) {
    if (state.until) {
      const end = state.string ? closing(line, at, state.until) : line.indexOf(state.until, at);
      const stop = end < 0 ? line.length : state.string ? end : end + state.until.length;
      push(line.slice(at, stop), state.string ? "string" : "comment");
      if (end >= 0) { state.until = null; state.string = false; }
      at = stop;
      continue;
    }
    const ahead = line.startsWith.bind(line);
    if (lang.line?.some((mark) => ahead(mark, at))) { push(line.slice(at), "comment"); break; }
    if (lang.block && ahead(lang.block[0], at)) { state.until = lang.block[1]; push(lang.block[0], "comment"); at += lang.block[0].length; continue; }
    const long = lang.long?.find((quote) => ahead(quote, at));
    if (long) { state.until = long; state.string = true; push(long, "string"); at += long.length; continue; }
    const quote = lang.quotes?.find((q) => ahead(q, at));
    if (quote) {
      const end = closing(line, at + 1, quote);
      if (end < 0) { push(line[at], null); at++; continue; }
      push(line.slice(at, end), "string"); at = end;
      continue;
    }
    if (lang.variables) {
      const variable = match(VARIABLE, line, at);
      if (variable) { push(variable, "literal"); at += variable.length; continue; }
    }
    if (lang.tags) {
      const tag = match(lang.tags, line, at);
      if (tag) { push(tag, "keyword"); at += tag.length; continue; }
    }
    const word = match(WORD, line, at);
    if (word) {
      const lower = lang === LANGUAGES.sql ? word.toLowerCase() : word;
      at += word.length;
      if (lang.words?.has(lower)) push(word, "keyword");
      else if (LITERALS.has(word)) push(word, "literal");
      else if (lang.code && /^[A-Z]/.test(word)) push(word, "type");
      else if (lang.code && line[at] === "(") push(word, "function");
      else push(word, null);
      continue;
    }
    const number = match(NUMBER, line, at);
    if (number) { push(number, "number"); at += number.length; continue; }
    push(line[at], null); at++;
  }
  return spans;
}

const PAINTS_UP_TO = 600;

// Paints lines in order, one call each, so a comment or a long string that spans
// lines keeps its color. Each returns its pieces as [text, kind].
export function painter(language) {
  const lang = LANGUAGES[language];
  const state = { until: null, string: false, fenced: false };
  return (line) => {
    if (!line) return [];
    if (!lang || line.length > PAINTS_UP_TO) return [[line, null]];
    return scan(line, lang, state);
  };
}

export function paint(lines, language) {
  const next = painter(language);
  return lines.map((line) => next(line));
}
