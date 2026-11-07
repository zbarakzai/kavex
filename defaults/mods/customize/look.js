// The window's design tokens by name, under any theme: the kavex theme has them all, and
// the others stand in with their nearest colors. Each mod that draws the design keeps a
// copy, as mods can't import each other's files; scripts/look.test.ts keeps them equal.

import { div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";

export const MONO = "Geist Mono";

export const soft = (color, alpha) => `${color.slice(0, 7)}${alpha}`;

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
    clear: soft(t.surface, "00"),
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

// How long ago, in a row's few letters.
export function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// An agent's or program's icon on its tile.
export function tile(program, size, k) {
  const inner = size - 8;
  const glyph = !program?.icon ? svg("mods/workspace-chrome/icons/terminal.svg").size(inner).text_color(k.tile_text)
    : program.tint ? svg(program.icon).size(inner).text_color(program.color ?? k.foreground) : image(program.icon).size(inner);
  return h_flex().size(size).flex_none().items_center().justify_center().rounded(6).bg(program?.tile ?? k.tile).child(glyph);
}
