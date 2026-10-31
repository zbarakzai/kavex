// Right-click on a tab or a group's tag: color, group and name in one list.
// Opened as a popup with props { tabs, space, machine, color, cwd } (a tab, with any
// selected beside it), { group } (a group), or { tabs, make: true } (groups them first).
// A color applies as it's clicked and the menu stays, to try another. All of it
// edits what's shared; the tab bar keeps the tabs in line with that.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, spaces, shared, setShared } from "herdr";

// The space avatars' hues, by the names they're stored under.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const NAMES = { ansi6: "Teal", ansi3: "Orange", ansi4: "Blue", ansi5: "Violet", ansi2: "Green", ansi1: "Pink" };

const groups = () => shared("tab.groups") ?? {};
const folders = () => shared("tab.folders") ?? [];
const base = (path) => path.replace(/[/\\]+$/, "").split(/[/\\]/).pop();
const edit = (id, change) => setShared("tab.groups", { ...groups(), [id]: { ...groups()[id], ...change } });

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
    this.color = p.color ?? null;
    this.closing = false;
    this.handle = cx.focus_handle();
    if (p.group) this.name(p.group, cx);
    else if (p.make) this.make(cx);
    else this.handle.focus();
  }

  // A new group, in the color least used so it stands apart. Naming it comes next.
  make(cx) {
    const { tabs } = props(), all = groups();
    const uses = (c) => Object.values(all).filter((g) => g.color === c).length;
    const color = Object.keys(MARK).reduce((best, c) => (uses(c) < uses(best) ? c : best));
    const id = `g${Date.now().toString(36)}`;
    setShared("tab.groups", { ...without(tabs), [id]: { name: "", color, folded: false, tabs } });
    this.name(id, cx);
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

  paint(color) {
    this.color = color;
    const colors = { ...(shared("tab.colors") ?? {}) };
    for (const id of props().tabs ?? []) colors[id] = color ?? "none";
    setShared("tab.colors", colors);
  }

  folder() {
    const { cwd, machine = null } = props(), list = folders();
    const rule = list.find((f) => f.machine === machine && f.folder === cwd);
    setShared("tab.folders", rule ? list.filter((f) => f !== rule) : [...list, { machine, folder: cwd, color: this.color }]);
  }

  // A tab's rows. `keep`: the menu stays open.
  tabRows() {
    const p = props() ?? {}, tabs = p.tabs ?? [], all = groups(), one = tabs.length === 1;
    const inGroup = tabs.some((id) => Object.values(all).some((g) => g.tabs.includes(id)));
    const here = (spaces().find((s) => s.id === p.space)?.tabs ?? []).map((c) => c.id);
    const others = Object.entries(all).filter(([, g]) => g.tabs.some((id) => here.includes(id)) && !tabs.every((id) => g.tabs.includes(id)));
    const rule = folders().find((f) => f.machine === (p.machine ?? null) && f.folder === p.cwd);
    return [
      ...(one ? [{ icon: "square-pen", label: "Rename", act: () => run("tab.rename", { id: tabs[0] }), key: "tab.rename" }] : []),
      { icon: "layers", label: one ? "New group" : `Group ${tabs.length} tabs`, keep: true, act: (cx) => this.make(cx), key: "tabs.group" },
      ...others.map(([id, g]) => ({ dot: MARK[g.color] ?? g.color, label: `Add to ${g.name || "group"}`, act: () => this.join(id) })),
      ...(inGroup ? [{ icon: "minus", label: one ? "Remove from group" : "Remove from groups", act: () => setShared("tab.groups", without(tabs)) }] : []),
      ...(one && !inGroup && p.cwd && (rule || this.color)
        ? [{ icon: "folder", label: rule ? `Stop coloring ${base(p.cwd)}` : `Color all of ${base(p.cwd)}`, keep: true, act: () => this.folder() }]
        : []),
      { line: true, icon: "plus", label: "New tab", act: () => run("tab.new", { space: p.space }), key: "tab.new" },
      { icon: "x", label: one ? "Close" : `Close ${tabs.length} tabs`, act: () => tabs.forEach((id) => run("tab.close", { id })), key: "tab.close" },
    ];
  }

  groupRows(g) {
    const count = g.tabs.length, id = this.group;
    return [
      { icon: "plus", label: "New tab in group", act: () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512, props: { group: id } }) },
      { icon: g.folded ? "chevron-right" : "chevron-left", label: g.folded ? "Unfold" : "Fold", act: () => edit(id, { folded: !g.folded }), key: "tabs.fold" },
      { icon: "minus", label: "Ungroup", act: () => { const { [id]: _, ...rest } = groups(); setShared("tab.groups", rest); } },
      this.closing
        ? { icon: "x", label: `Close ${count === 1 ? "this tab" : `all ${count} tabs`}`, danger: true, act: () => g.tabs.forEach((tab) => run("tab.close", { id: tab })) }
        : { icon: "x", label: "Close group", keep: true, act: () => { this.closing = true; } },
    ];
  }

  choose(row, cx) {
    if (!row.keep) closeOverlay(props().overlay);
    row.act(cx);
    cx.notify();
  }

  swatches(t, now, pick, clear) {
    const dot = (id, name, on, fill, action, child) => h_flex().id(id).size(24).flex_none().items_center().justify_center().rounded(12)
      .border(2).border_color(on ? fill : "#00000000").tooltip(name).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { action(); cx.notify(); }).child(child);
    return h_flex().h(34).px(5).gap(4).items_center()
      .children(Object.keys(MARK).map((c) => dot(`color-${c}`, NAMES[c], now === c, MARK[c], () => pick(c), div().size(14).rounded(7).bg(MARK[c]))))
      .when(clear, (el) => el.child(dot("color-none", "No color", !now, t.dim, () => pick(null),
        h_flex().size(14).items_center().justify_center().rounded(7).border(1).border_color(t.dim).text_color(t.dim).child(svg("mods/workspace-chrome/x.svg").size(9)))));
  }

  row(row, i, list, t) {
    return v_flex()
      .when(row.line && i > 0, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
      .child(h_flex().id(`tm-${i}`).h(31).px(8).gap(9).rounded(7).items_center().justify_between()
        .text_color(row.danger ? t.blocked : t.foreground)
        .when(i === this.at && !this.group, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.choose(row, cx))
        .child(row.dot
          ? h_flex().size(14).flex_none().items_center().justify_center().child(div().size(10).rounded(5).bg(row.dot))
          : svg(`mods/workspace-chrome/${row.icon}.svg`).size(14).flex_none().text_color(row.danger ? t.blocked : t.muted))
        .child(div().flex_1().truncate().child(row.label))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(row.key ? shortcut(row.key) : "")));
  }

  render(cx) {
    const t = theme();
    const g = this.group ? groups()[this.group] : null;
    const list = this.group ? (g ? this.groupRows(g) : []) : this.tabRows();
    const divider = div().mx(7).my(4).h(1).bg(t.border);
    return v_flex().id("tab-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(props().overlay);
        else if (this.group) return;
        else if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (Math.max(this.at, 0) + list.length - 1) % list.length;
        else if (e.key === "enter" && list[this.at]) this.choose(list[this.at], cx);
        else return;
        cx.notify();
      })
      .when(Boolean(g), (el) => el
        .child(div().p(3).child(Input.new(this.input).h(32).px(9).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground)))
        .child(this.swatches(t, g.color, (c) => edit(this.group, { color: c }), false))
        .child(divider))
      .when(!this.group, (el) => el.child(this.swatches(t, this.color, (c) => this.paint(c), true)).child(divider))
      .children(list.map((row, i) => this.row(row, i, list, t)));
  }
}
