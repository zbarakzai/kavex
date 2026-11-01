// The window's design tokens by name, under any theme: the zaki theme has them all, and
// the others stand in with their nearest colors. Each mod that draws the design keeps a
// copy, as mods can't import each other's files; scripts/look.test.ts keeps them equal.

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run, shared } from "herdr";

export const MONO = "Geist Mono";

const soft = (color, alpha) => `${color.slice(0, 7)}${alpha}`;

export function look(t) {
  const status = (name, label, color, bg = soft(color, "1f"), dot = color) => ({
    label,
    bg: t[`status_${name}_bg`] ?? bg,
    fg: t[`status_${name}_fg`] ?? color,
    dot: t[`status_${name}_dot`] ?? dot,
  });
  const group = (name, color) => ({
    text: t[`group_${name}`] ?? color,
    tint: t[`group_${name}_tint`] ?? soft(color, "12"),
    row: t[`group_${name}_row`] ?? soft(color, "29"),
    ring: t[`group_${name}_ring`] ?? soft(color, "38"),
    card: t[`group_${name}_card`] ?? t.raised,
  });
  const added = t.added ?? t.ansi2, removed = t.removed ?? t.ansi1;
  return {
    ...t,
    panel: t.panel ?? t.canvas,
    panel_border: t.panel_border ?? t.border,
    card: t.card ?? t.background,
    card_border: t.card_border ?? t.border,
    well: t.well ?? t.canvas,
    hover_strong: t.hover_strong ?? t.hover,
    row_selected_strong: t.row_selected_strong ?? t.raised,
    row_active_hover: t.row_active_hover ?? t.raised,
    row_pressed: t.row_pressed ?? t.selected,
    row_dragging: t.row_dragging ?? t.raised,
    row_ring: t.row_ring ?? t.border,
    row_name: t.row_name ?? t.foreground,
    chip_active: t.chip_active ?? t.raised,
    chip_active_ring: t.chip_active_ring ?? t.border,
    pill: t.pill ?? t.background,
    pill_ring: t.pill_ring ?? t.border,
    pill_selected: t.pill_selected ?? t.selected,
    tile: t.tile ?? t.raised,
    tile_text: t.tile_text ?? t.muted,
    text_secondary: t.text_secondary ?? t.foreground,
    text_faint: t.text_faint ?? t.dim,
    label: t.label ?? t.dim,
    line_number: t.line_number ?? t.dim,
    accent_text: t.accent_text ?? t.accent,
    accent_text_soft: t.accent_text_soft ?? t.accent,
    added,
    removed,
    failed: t.failed ?? t.blocked,
    failed_text: t.failed_text ?? t.blocked,
    diff_text: t.diff_text ?? t.foreground,
    diff_added_row: t.diff_added_row ?? soft(added, "12"),
    diff_added_gutter: t.diff_added_gutter ?? soft(added, "24"),
    diff_removed_row: t.diff_removed_row ?? soft(removed, "12"),
    diff_removed_gutter: t.diff_removed_gutter ?? soft(removed, "24"),
    diff_collapsed_row: t.diff_collapsed_row ?? t.hover,
    diff_collapsed_gutter: t.diff_collapsed_gutter ?? t.selected,
    status: {
      done: status("done", "DONE", t.done),
      working: status("working", "WORKING", t.working),
      blocked: status("needs", "NEEDS YOU", t.blocked),
      failed: status("failed", "FAILED", t.failed ?? t.blocked),
      idle: status("idle", "IDLE", t.muted, soft(t.dim, "1f"), t.idle),
      queued: status("queued", "QUEUED", t.dim, soft(t.dim, "1f"), t.idle),
    },
    groups: { blue: group("blue", t.ansi4), violet: group("violet", t.ansi5), teal: group("teal", t.ansi6) },
  };
}

// Groups saved before there were three colors keep the nearest one. Never orange: that's "you".
const NEAREST = { ansi4: "blue", ansi5: "violet", ansi6: "teal", ansi2: "teal" };
export const groupHue = (k, color) => k.groups[color] ?? k.groups[NEAREST[color]] ?? k.groups.blue;

// What fills a tab: its own color from "tab.colors", else its group's, if one was picked for the
// group (`fill`): the color every group has by itself is only its name's. "none" keeps a tab clear.
export function tabHue(k, color, group) {
  if (color) return color === "none" ? null : groupHue(k, color);
  return group?.fill ? groupHue(k, group.color) : null;
}

// GPUI has no letter spacing. Geist Mono is one width, so a gap between letters is exact.
export function spaced(text, size, em) {
  return h_flex().flex_none().font_family(MONO).text_size(size).gap(size * em)
    .children([...text].map((letter) => div().flex_none().child(letter === " " ? " " : letter)));
}

export const sectionLabel = (k, text) => spaced(text, 10.5, 0.1).font_medium().text_color(k.label);

export function badge(k, status) {
  const s = k.status[status] ?? k.status.idle;
  return h_flex().h(17).px(6).flex_none().items_center().rounded(5).bg(s.bg).text_color(s.fg).font_medium().child(spaced(s.label, 9, 0.08));
}

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

const find = (node, id) => (node?.id === id ? node : (node?.children ?? []).reduce((hit, child) => hit ?? find(child, id), null));

const PANELS = [["changes", "Changes", "mods/workspace-chrome/icons/changes.svg"], ["files", "Files", "mods/workspace-chrome/icons/folder.svg"]];
const PANEL_WIDE = 680, PANEL_FULL = 900;

// The side panel's header, the same in each of its mods: its tabs and the expand button.
export function panelHeader(k, active) {
  const root = layout(), panel = find(root, "panel"), docked = Boolean(find(panel, active));
  const enabled = shared("workspace.panels") ?? PANELS.map(([id]) => id);
  const full = (panel?.size?.px ?? 0) >= PANEL_FULL - 40;
  const stop = (_e, cx) => cx.stop_propagation();
  const chip = ([id, label, icon]) => h_flex().id(`panel-${id}`).h(34).min_w(118).pl(11).pr(6).gap(7).flex_none().items_center().rounded(11).bg(k.selected).border_1().border_color(k.pill_ring)
    .text_size(13.5).text_color(k.foreground)
    .child(svg(icon).size(16).flex_none())
    .child(div().flex_1().child(label))
    .when(docked, (el) => el.child(h_flex().id(`panel-close-${id}`).size(20).flex_none().items_center().justify_center().rounded(6).text_color(k.label).hover((s) => s.bg(k.hover_strong).text_color(k.foreground))
      .on_mouse_down("left", stop).on_click(() => run("layout.hide", { id: "panel" })).child(svg("mods/workspace-chrome/icons/close.svg").size(16))));
  const other = ([id, label, icon]) => h_flex().id(`panel-${id}`).h(34).pl(11).pr(12).gap(7).flex_none().items_center().rounded(11).text_size(13.5).text_color(k.muted).hover((s) => s.bg(k.hover))
    .on_click(() => run("layout.select", { stack: "panel-body", child: id }))
    .child(svg(icon).size(16).flex_none()).child(label);
  return h_flex().h(46).flex_none().px(6).gap(6).items_center()
    .child(h_flex().flex_1().min_w(0).gap(2).items_center()
      .children(PANELS.filter(([id]) => id === active || (docked && enabled.includes(id))).map((p) => (p[0] === active ? chip(p) : other(p)))))
    .when(docked, (el) => el.child(h_flex().id("panel-expand").size(30).flex_none().items_center().justify_center().rounded(8).text_color(k.muted).hover((s) => s.bg(k.hover_strong).text_color(k.foreground))
      .on_click(() => run("layout.resize", { id: "panel", px: full ? PANEL_WIDE : PANEL_FULL }))
      .child(svg(`mods/workspace-chrome/icons/panel-${full ? "shrink" : "expand"}.svg`).size(16))));
}
