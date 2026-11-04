// The side panel's header. Files and Changes each keep a copy; scripts/look.test.ts keeps them equal.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { layout, run, shared } from "herdr";
import { holdsButtons, windowButtons } from "./window-buttons.js";

const find = (node, id) => (node?.id === id ? node : (node?.children ?? []).reduce((hit, child) => hit ?? find(child, id), null));

const PANELS = [["changes", "Changes", "mods/workspace-chrome/icons/changes.svg"], ["files", "Files", "mods/workspace-chrome/icons/folder.svg"]];
const PANEL_WIDE = 680, PANEL_FULL = 900;
const BUTTONS_ROOM = 370; // the narrowest panel with room for both tabs, the expand button and the window buttons in one row
const ABOVE = 34; // the row the window buttons get above the tabs in a narrower panel

// The side panel's header, the same in each of its mods: its tabs and the expand button, and
// the window buttons while it holds the window's corner, above the rest if it's too narrow.
export function panelHeader(k, active) {
  const root = layout(), panel = find(root, "panel"), docked = Boolean(find(panel, active));
  const enabled = shared("workspace.panels") ?? PANELS.map(([id]) => id);
  const full = (panel?.size?.px ?? 0) >= PANEL_FULL - 40;
  const corner = docked && holdsButtons("panel"), above = corner && (panel?.size?.px ?? PANEL_WIDE) < BUTTONS_ROOM;
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
  const row = h_flex().h(46).flex_none().px(6).gap(6).items_center()
    .child(h_flex().flex_1().min_w(0).gap(2).items_center()
      .children(PANELS.filter(([id]) => id === active || (docked && enabled.includes(id))).map((p) => (p[0] === active ? chip(p) : other(p)))))
    .when(docked, (el) => el.child(h_flex().id("panel-expand").size(30).flex_none().items_center().justify_center().rounded(8).text_color(k.muted).hover((s) => s.bg(k.hover_strong).text_color(k.foreground))
      .on_click(() => run("layout.resize", { id: "panel", px: full ? PANEL_WIDE : PANEL_FULL }))
      .child(svg(`mods/workspace-chrome/icons/panel-${full ? "shrink" : "expand"}.svg`).size(16))))
    .when(corner && !above, (el) => el.child(windowButtons(k)));
  return above ? v_flex().flex_none().child(h_flex().h(ABOVE).flex_none().px(6).items_end().justify_end().child(windowButtons(k))).child(row) : row;
}
