// Also shipped in Agents and Spaces, since each mod loads its own files.
import { div, svg } from "gpui-kit";
import { h_flex, HoverCard } from "gpui-base";

export function railTooltip(id, label, button, k) {
  // The anchor is the edge of the tooltip that meets the trigger.
  return HoverCard.new(`kavex-chrome-tooltip-${id}`).anchor("left_center").open_delay(300).close_delay(0).trigger(button)
    .content(h_flex().role("tooltip").ml(4).items_center()
      .child(svg("mods/workspace-chrome/icons/tooltip-left.svg").w(5).h(10).flex_none().text_color(k.foreground))
      .child(div().max_w(240).px(8).py(4).rounded(6).bg(k.foreground)
        .text_color(k.canvas).text_size(12).truncate().child(label)));
}
