// Customize: a screen over the whole window, with its own sidebar. Opened by the footer's button
// (`mod.open {name: "customize"}`); Esc or Back closes it, and terminals keep running behind.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, props, theme, window } from "herdr";
import { look } from "./look.js";
import { SkillsPage } from "./skills-page.js";

const I = (name) => `mods/workspace-chrome/icons/${name}.svg`;
const PAGES = [
  { id: "skills", title: "Skills", icon: "layers" },
  { id: "review", title: "Code review", icon: "changes" },
];

export default class Customize extends View {
  init(_props, cx) {
    const asked = props()?.page;
    this.page = PAGES.some((p) => p.id === asked) ? asked : "skills";
    this.skills = new SkillsPage();
    this.handle = cx.focus_handle();
    this.handle.focus();
    if (this.page === "skills") this.skills.open(cx);
  }

  close() {
    this.skills.release();
    closeOverlay(props()?.overlay);
  }

  navRow(t, id, icon, title, on, onClick) {
    return h_flex().id(id).h(32).flex_none().px(10).gap(10).items_center().rounded(9).cursor_pointer()
      .when(on, (el) => el.bg(t.row_selected_strong))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(onClick)
      .child(svg(I(icon)).size(16).flex_none().text_color(on ? t.foreground : t.label))
      .child(div().flex_1().min_w(0).truncate().text_size(13.5).text_color(on ? t.foreground : t.muted).child(title));
  }

  sidebar(t) {
    const mac = window()?.platform === "macos";
    return v_flex().w(240).flex_none().h_full().px(6).pb(8).gap(2)
      // The window's own buttons sit over the top left on macOS.
      .child(div().h(mac ? 34 : 6).flex_none())
      .child(h_flex().id("cz-back").h(30).flex_none().px(10).gap(6).items_center().rounded(9).cursor_pointer().text_color(t.label)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => this.close())
        .child(svg(I("chevron-left")).size(16).flex_none()).child(div().text_size(13).child("Back to Zaki")))
      .child(h_flex().h(44).flex_none().px(10).items_center().text_size(16).font_medium().text_color(t.foreground).child("Customize"))
      .children(PAGES.map((p) => this.navRow(t, `cz-p-${p.id}`, p.icon, p.title, p.id === this.page, (_e, cx) => {
        this.page = p.id;
        if (p.id === "skills") this.skills.open(cx);
        this.handle.focus();
        cx.notify();
      })));
  }

  review(t) {
    return v_flex().w_full().gap(6)
      .child(div().text_size(22).font_medium().text_color(t.foreground).child("Code review"))
      .child(div().text_size(13.5).text_color(t.muted).child("Review changes with your agents."))
      .child(v_flex().w_full().pt(120).gap(12).items_center()
        .child(h_flex().size(40).rounded(20).items_center().justify_center().border_1().border_color(t.card_border).text_color(t.label).child(svg(I("changes")).size(16)))
        .child(div().text_size(13.5).text_color(t.foreground).child("Coming soon"))
        .child(div().text_size(12.5).text_color(t.label).child("Code review settings will be here.")));
  }

  render(cx) {
    const t = look(theme());
    return h_flex().id("customize").track_focus(this.handle).size_full().p(6).gap(6).bg(t.canvas).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        cx.stop_propagation();
        if (this.page === "skills" && this.skills.escape()) cx.notify();
        else this.close();
      })
      .child(this.sidebar(t))
      .child(div().flex_1().min_w(0).h_full().rounded(14).overflow_hidden().bg(t.surface).border_1().border_color(t.panel_border)
        .child(div().id("cz-body").size_full().overflow_y_scrollbar()
          .child(h_flex().w_full().justify_center().px(40).pt(44).pb(48)
            .child(v_flex().w_full().max_w(880).min_w(0)
              .child(this.page === "skills" ? this.skills.render(t, cx) : this.review(t))))));
  }
}
