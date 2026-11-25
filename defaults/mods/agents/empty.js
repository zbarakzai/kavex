import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

// The illustration, caption, gap, and vertical padding at their full size.
export const EMPTY_ART_MIN_HEIGHT = 136;

export function emptyState(k, showArt) {
  return v_flex().id("agents-empty").w_full().px(10).py(showArt ? 18 : 8).gap(8).flex_none().items_center()
    .when(showArt, (el) => el.child(div().relative().w(128).h(72).flex_none()
      .child(div().absolute().left(24).right(24).top(43).h(1).bg(k.border))
      .child(h_flex().absolute().left(0).top(27).size(34).items_center().justify_center()
        .rounded(11).border_1().border_color(k.border).bg(k.canvas)
        // Full-color image() SVGs are decoded at their intrinsic size.
        .child(image("mods/agents/icons/codex.svg").size(20).opacity(0.65)))
      .child(h_flex().absolute().right(0).top(27).size(34).items_center().justify_center()
        .rounded(11).border_1().border_color(k.border).bg(k.canvas)
        .child(svg("icons/opencode.svg").size(20).text_color(k.label)))
      .child(h_flex().absolute().left(38).top(9).size(52).items_center().justify_center()
        .rounded(14).border_1().border_color(k.row_ring).bg(k.tile)
        .child(svg("icons/claude.svg").size(32).text_color("#D97757")))))
    .child(div().text_size(12).text_color(k.label).child("No agents yet"));
}
