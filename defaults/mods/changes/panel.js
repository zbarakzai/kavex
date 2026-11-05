// The side panel's header. Files and Changes each keep a copy; scripts/look.test.ts keeps them equal.

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run, shared } from "herdr";

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
