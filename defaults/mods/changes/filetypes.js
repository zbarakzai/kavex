// What a file's type looks like in a tree or a diff's header. Files and Changes each keep a copy; scripts/look.test.ts keeps them equal.

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { MONO } from "./look.js";

const TAGS = {
  md: "MD", mdx: "MD", js: "JS", mjs: "JS", cjs: "JS", jsx: "JS", ts: "TS", mts: "TS", cts: "TS", tsx: "TS",
  json: "{ }", jsonc: "{ }", toml: "{ }", yaml: "{ }", yml: "{ }", lock: "{ }", ini: "{ }", env: "{ }",
  sh: ">_", bash: ">_", zsh: ">_", fish: ">_", ps1: ">_", html: "<>", svelte: "<>", vue: "<>",
};
const SCRIPTS = new Set(["justfile", "makefile", "dockerfile"]);

// A file's two-letter type, as the tree and a diff's header show it.
export function tagOf(path) {
  const leaf = path.split("/").pop().toLowerCase(), dot = leaf.lastIndexOf(".");
  if (SCRIPTS.has(leaf)) return ">_";
  if (dot <= 0) return "··";
  const type = leaf.slice(dot + 1);
  return TAGS[type] ?? type.slice(0, 2).toUpperCase();
}

// A file type's logo in `icons/`, drawn in the theme's color. Types without one keep their tag.
const LOGOS = {
  __proto__: null,
  js: "javascript", mjs: "javascript", cjs: "javascript", ts: "tsc", mts: "tsc", cts: "tsc", jsx: "react", tsx: "react",
  py: "python", pyi: "python", rs: "rust", go: "go", rb: "ruby", php: "php", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", c: "c", h: "c", cpp: "cplusplus", cc: "cplusplus", hpp: "cplusplus", lua: "lua", dart: "dart", zig: "zig",
  r: "r", pl: "perl", scala: "scala", ml: "ocaml", jl: "julia", nix: "nix", prisma: "prisma",
  html: "html5", htm: "html5", css: "css", scss: "sass", sass: "sass", vue: "vuedotjs", svelte: "svelte", astro: "astro",
  md: "markdown", mdx: "markdown", json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  sh: "gnubash", bash: "gnubash", zsh: "gnubash", svg: "svg",
};

export function logoOf(path) {
  const leaf = path.split("/").pop().toLowerCase(), dot = leaf.lastIndexOf(".");
  return leaf === "dockerfile" ? "docker" : dot > 0 ? LOGOS[leaf.slice(dot + 1)] ?? null : null;
}

export function typeTag(path, color) {
  const logo = logoOf(path);
  return logo ? h_flex().w(18).flex_none().items_center().child(svg(`icons/${logo}.svg`).size(14).text_color(color))
    : div().w(18).flex_none().font_family(MONO).text_size(9).font_semibold().text_color(color).child(tagOf(path));
}
