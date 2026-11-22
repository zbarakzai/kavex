// The side panel's header. Files and Changes each keep a copy; scripts/look.test.ts keeps them equal.

import { svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run } from "herdr";

const find = (node, id) => (node?.id === id ? node : (node?.children ?? []).reduce((hit, child) => hit ?? find(child, id), null));

const PANEL_WIDE = 680, PANEL_FULL = 900;

export function panelHeader(k, active) {
  const root = layout(), panel = find(root, "panel"), docked = Boolean(find(panel, active));
  const [label, icon] = active === "changes" ? ["Changes", "branch"] : ["Files", "folder"];
  const full = (panel?.size?.px ?? 0) >= PANEL_FULL - 40;
  const stop = (_e, cx) => cx.stop_propagation();
  const button = (id, name, glyph, click) => h_flex().id(id).size(30).flex_none().items_center().justify_center().rounded(8).cursor_pointer()
    .accessibility_label(name).text_color(k.muted).hover((s) => s.bg(k.hover_strong).text_color(k.foreground))
    .on_mouse_down("left", stop).on_click(click).child(svg(`mods/workspace-chrome/icons/${glyph}.svg`).size(16));
  return h_flex().h(46).flex_none().px(6).gap(6).items_center()
    .child(h_flex().flex_1().min_w(0).pl(8).gap(7).items_center().text_size(13.5).font_medium().text_color(k.foreground)
      .child(svg(`mods/workspace-chrome/icons/${icon}.svg`).size(16).flex_none().text_color(k.label)).child(label))
    .when(docked, (el) => el
      .child(button("panel-expand", full ? "Shrink panel" : "Expand panel", full ? "panel-shrink" : "panel-expand",
        () => run("layout.resize", { id: "panel", px: full ? PANEL_WIDE : PANEL_FULL })))
      .child(button(`panel-close-${active}`, `Close ${label}`, "close", () => run("layout.hide", { id: "panel" }))));
}
