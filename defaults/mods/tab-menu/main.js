// Right-click on a tab or a group's name: its color, group and name in one list.
// Opened as a popup with props { tabs, space, machine, cwd } (a tab, with any selected
// beside it), { group } (a group), or { tabs, make: true } (a new group for them). A color
// fills that tab's or group's own background, applies as it's clicked and moves nothing; the
// menu stays, to try another. A new group changes nothing until it's created. All of it edits
// what's shared; the tab bar keeps the tabs in line with that. `from` names the button that
// opened the menu, so a second press on it shuts it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, spaces, shared, setShared } from "herdr";
import { look, groupHue, tabHue } from "./look.js";

const COLORS = ["blue", "violet", "teal"];

const groups = () => shared("tab.groups") ?? {};
const edit = (id, change) => setShared("tab.groups", { ...groups(), [id]: { ...groups()[id], ...change } });
const painted = () => shared("tab.colors") ?? {};

const home = (tab) => Object.values(groups()).find((g) => g.tabs.includes(tab));

// Sets or clears the tabs' own color. Clear in a filled group has to say so, or the group's shows.
function paint(tabs, color) {
  const next = { ...painted() };
  for (const id of tabs) {
    if (color || home(id)?.fill) next[id] = color ?? "none";
    else delete next[id];
  }
  setShared("tab.colors", next);
}

// Groups with these tabs out of them; one left empty goes.
function without(tabs) {
  const left = Object.entries(groups()).map(([id, g]) => [id, { ...g, tabs: g.tabs.filter((t) => !tabs.includes(t)) }]);
  return Object.fromEntries(left.filter(([, g]) => g.tabs.length));
}

// The key bound to a command, for the hint on the right.
const shortcut = (name) => keys().find((k) => k.section === "global" && k.action === name)?.keys ?? "";

export default class TabMenu extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.at = -1; // the row the arrow keys are on: none until they're used
    this.closing = false;
    this.from = p.from;
    this.handle = cx.focus_handle();
    if (p.group) this.name(p.group, cx);
    else if (p.make) this.draft(cx);
    else this.handle.focus();
  }

  async close() {
    if (this.from) setShared("popup.closed", { from: this.from, at: Date.now() });
  }

  // A new group: until it's created it's only this menu's, so picking a name and a color moves
  // nothing. Its name starts in the color least used, to stand apart, and its tabs stay clear
  // unless a color is picked.
  draft(cx) {
    const { tabs } = props(), all = Object.values(groups());
    const uses = (c) => all.filter((g) => g.color === c).length;
    this.making = { tabs, color: COLORS.reduce((best, c) => (uses(c) < uses(best) ? c : best)), fill: false };
    this.input = InputState.new({ value: "", placeholder: "Name this group" });
    this.input.on("submit", () => this.create());
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
  }

  create() {
    const { tabs, color, fill } = this.making, id = `g${Date.now().toString(36)}`;
    setShared("tab.groups", { ...without(tabs), [id]: { name: this.input.value().trim(), color, fill, folded: false, tabs } });
    setShared("tabs.picked", []);
    closeOverlay(props().overlay);
  }

  name(id, cx) {
    this.group = id;
    const value = groups()[id]?.name ?? "";
    this.input = InputState.new({ value, placeholder: "Name this group" });
    if (value) this.input.set_selected_range({ start: 0, end: value.length });
    this.input.on("change", () => edit(id, { name: this.input.value() }));
    this.input.on("submit", () => closeOverlay(props().overlay));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
  }

  join(id) {
    const { tabs } = props(), left = without(tabs);
    setShared("tab.groups", { ...left, [id]: { ...groups()[id], tabs: [...(left[id]?.tabs ?? []), ...tabs] } });
  }

  // A tab's rows. `keep`: the menu stays open.
  tabRows() {
    const p = props() ?? {}, tabs = p.tabs ?? [], all = groups(), one = tabs.length === 1;
    const inGroup = tabs.some((id) => Object.values(all).some((g) => g.tabs.includes(id)));
    const here = (spaces().find((s) => s.id === p.space)?.tabs ?? []).map((c) => c.id);
    const others = Object.entries(all).filter(([, g]) => g.tabs.some((id) => here.includes(id)) && !tabs.every((id) => g.tabs.includes(id)));
    return [
      ...(one ? [{ icon: "rename", label: "Rename", act: () => run("tab.rename", { id: tabs[0] }), key: "tab.rename" }] : []),
      { icon: "layers", label: one ? "New group" : `Group ${tabs.length} tabs`, keep: true, act: (cx) => this.draft(cx), key: "tabs.group" },
      ...others.map(([id, g]) => ({ dot: groupHue(look(theme()), g.color).text, label: `Add to ${g.name || "group"}`, act: () => this.join(id) })),
      ...(inGroup ? [{ icon: "minus", label: one ? "Remove from group" : "Remove from groups", act: () => setShared("tab.groups", without(tabs)) }] : []),
      { line: true, icon: "plus", label: "New tab", act: () => run("tab.new", { space: p.space }), key: "tab.new" },
      { icon: "close", label: one ? "Close" : `Close ${tabs.length} tabs`, act: () => tabs.forEach((id) => run("tab.close", { id })), key: "tab.close" },
    ];
  }

  groupRows(g) {
    const count = g.tabs.length, id = this.group;
    return [
      { icon: "plus", label: "New tab in group", act: () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512, props: { group: id } }) },
      { icon: g.folded ? "chevron-down" : "chevron-right", label: g.folded ? "Unfold" : "Fold", act: () => edit(id, { folded: !g.folded }), key: "tabs.fold" },
      { icon: "minus", label: "Ungroup", act: () => { const { [id]: _, ...rest } = groups(); setShared("tab.groups", rest); } },
      this.closing
        ? { icon: "close", label: `Close ${count === 1 ? "this tab" : `all ${count} tabs`}`, danger: true, act: () => g.tabs.forEach((tab) => run("tab.close", { id: tab })) }
        : { icon: "close", label: "Close group", keep: true, act: () => { this.closing = true; } },
    ];
  }

  // A draft's one row: the input's Enter does the same.
  draftRows() {
    const { tabs } = this.making;
    return [{ icon: "layers", label: tabs.length === 1 ? "Create group" : `Group ${tabs.length} tabs`, hint: "Enter", keep: true, act: () => this.create() }];
  }

  choose(row, cx) {
    if (!row.keep) closeOverlay(props().overlay);
    row.act(cx);
    cx.notify();
  }

  // `on`: the color shown as chosen, null for none.
  swatches(k, on, pick, label) {
    const swatch = (id, color, ring, mark) => h_flex().id(`color-${id}`).size(24).flex_none().items_center().justify_center().rounded(12).border(2).border_color(ring).hover((s) => s.bg(k.hover))
      .on_click((_e, cx) => { pick(color); cx.notify(); }).child(mark);
    return h_flex().h(34).pl(5).pr(8).gap(4).items_center()
      .children(COLORS.map((c) => swatch(c, c, on === k.groups[c] ? k.groups[c].text : "#00000000", div().size(14).rounded(7).bg(k.groups[c].text))))
      .child(swatch("none", null, on === null ? k.muted : "#00000000", div().relative().size(14).rounded(7).bg(k.background)
        // The icon's art has a margin: at this size its ring is the dot's edge.
        .child(svg("mods/workspace-chrome/icons/no-color.svg").absolute().left(-2).top(-2).size(18).text_color(on === null ? k.foreground : k.muted))))
      .child(div().flex_1())
      .child(div().flex_none().text_size(11).text_color(k.dim).child(label));
  }

  // The tabs' color: null when they have none, undefined when they differ.
  tabColor(k, tabs) {
    const hues = tabs.map((id) => tabHue(k, painted()[id], home(id)));
    return hues.every((hue) => hue === hues[0]) ? hues[0] : undefined;
  }

  row(row, i, list, t) {
    return v_flex()
      .when(row.line && i > 0, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
      .child(h_flex().id(`tm-${i}`).h(31).px(8).gap(9).rounded(7).items_center().justify_between()
        .text_color(row.danger ? (t.failed ?? t.blocked) : t.foreground)
        .when(i === this.at && !this.group && !this.making, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.choose(row, cx))
        .child(row.dot
          ? h_flex().size(16).flex_none().items_center().justify_center().child(div().size(10).rounded(5).bg(row.dot))
          : svg(`mods/workspace-chrome/icons/${row.icon}.svg`).size(16).flex_none().text_color(row.danger ? (t.failed ?? t.blocked) : t.muted))
        .child(div().flex_1().truncate().child(row.label))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(row.hint ?? (row.key ? shortcut(row.key) : ""))));
  }

  render(cx) {
    const t = theme(), k = look(t), tabs = props()?.tabs ?? [];
    const g = this.group ? groups()[this.group] : null, naming = g ?? this.making;
    const list = this.group ? (g ? this.groupRows(g) : []) : this.making ? this.draftRows() : this.tabRows();
    const divider = div().mx(7).my(4).h(1).bg(t.border);
    // A pick colors the name and fills the tabs. None clears the tabs; a name always has a color.
    const pick = (c) => {
      const change = c ? { color: c, fill: true } : { fill: false };
      if (this.making) Object.assign(this.making, change);
      else edit(this.group, change);
    };
    return v_flex().id("tab-menu").track_focus(this.handle).w_full().min_h(0).p(5).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(props().overlay);
        else if (this.group || this.making) return;
        else if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (Math.max(this.at, 0) + list.length - 1) % list.length;
        else if (e.key === "enter" && list[this.at]) this.choose(list[this.at], cx);
        else return;
        cx.notify();
      })
      .when(Boolean(naming), (el) => el
        .child(div().p(3).child(Input.new(this.input).h(32).px(9).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground)))
        .child(this.swatches(k, naming.fill ? groupHue(k, naming.color) : null, pick, "Group color"))
        .child(divider))
      .when(!naming && !this.group, (el) => el
        .child(this.swatches(k, this.tabColor(k, tabs), (c) => paint(tabs, c), tabs.length === 1 ? "Tab color" : "Tab colors"))
        .child(divider))
      .children(list.map((row, i) => this.row(row, i, list, t)));
  }
}
