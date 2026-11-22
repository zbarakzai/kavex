// How notifications look. Anything can post one with notify({ title, body,
// level, icon, action }); replace this mod to restyle them all. Click to
// run its action (e.g. go to the agent) and dismiss it.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme } from "herdr";

const LEVEL = {
  __proto__: null,
  error: ["error", "blocked"],
  warning: ["warning", "working"],
  success: ["success", "done"],
  info: ["info", "accent"],
};

export default class Toast extends View {
  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const [icon, color] = LEVEL[p.level] ?? LEVEL.info;
    return h_flex()
      .id("toast")
      .size_full()
      .px(18)
      .gap(12)
      .items_center()
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(p.icon ? image(p.icon).w(18).h(18).flex_none() : svg(`mods/workspace-chrome/icons/${icon}.svg`).size(16).flex_none().text_color(t[color]))
      .child(
        v_flex()
          .flex_1()
          .overflow_hidden()
          .child(div().truncate().font_semibold().text_size(13).text_color(t.foreground).child(p.title ?? ""))
          .when(Boolean(p.body), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(p.body ?? ""))),
      );
  }
}
