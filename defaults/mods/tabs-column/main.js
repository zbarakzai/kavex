// The Tabs column: the shown space's tabs when they sit on the right. Groups and folds are the
// ones the tab bar keeps in shared state, and the drag rules are groups.js's, as the bar's.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, terminals, theme, run, openOverlay, closeOverlay, shared, setShared, settings, nextCommand, window } from "herdr";
import { look, badge, duration, groupHue, tabHue, tile, MONO } from "./look.js";
import { COLUMN, clicked, columnHome, columnRuns, columnSlots, columnStops, failed, groupOf, groupStop, landed, moves, nearestY, reopening, sectionHeight, shownIn, shows, slotKey, stepped, stoppedGroup } from "./groups.js";

const SLIDE = { response: 150, damping: 1 }; // room opening and shutting
const HELD = { response: 0 }; // stuck to the pointer
const SETTLE = { response: 170, damping: 0.82 }; // down into its place
const SETTLE_MS = 170;
const EASE = 120; // ms a row's background takes to change
const FOCUS_POLL = 300; // ms between asks whether the keyboard is still here
const START = 4; // px of travel before a press is a drag
const FAR = 90; // px off the column where a drag lets go of its target and heads home
const EDGE = 16; // px from the list's ends that mean its first and last place
const HEADER = 56, INSET = 8; // the column's header; the list's side padding

const activeSpace = () => spaces().find((p) => p.active);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// GPUI has no inset ring or outline: a border drawn over the row paints the same pixels.
const ring = (color, width, radius) => div().absolute().inset_0().rounded(radius).border(width).border_color(color);

// Only opacity can ease, so each background is a sheet of its own and one shows at a time.
const sheet = (id, color, on) => div().id(id).absolute().inset_0().rounded(10).bg(color).opacity(on ? 1 : 0).transition("opacity", EASE);

export default class TabsColumn extends View {
  init(_props, cx) {
    this.press = null; // a press that may turn into a drag
    this.drag = null;
    this.drags = 0;
    this.over = null; // the row under the pointer
    this.cursor = null; // the stop the keyboard is on, while it's here
    this.keys = cx.focus_handle();
    cx.timer.every(30000, (cx) => cx.notify());
    cx.spawn(async (cx) => {
      for (;;) {
        this.command(await nextCommand(), cx);
        cx.notify();
      }
    });
  }

  command(name, cx) {
    const place = () => name.split(":")[1].split(",").map((n) => Number(n) / settings().zoom);
    if (name === "focus") return this.enter(cx);
    if (name.startsWith("drag:")) {
      this.follow(...place());
      // Only while the layer's there: an answer to one that's gone shows as an error.
      return this.drag && !this.drag.landing ? run("tab-drag.ready") : null;
    }
    if (name.startsWith("drop:")) {
      this.follow(...place());
      this.land(cx);
    }
  }

  enter(cx) {
    const list = activeSpace()?.tabs ?? [], watching = Boolean(this.cursor);
    this.cursor = list.find((c) => c.active)?.id ?? columnStops(list, shared("tab.groups") ?? {})[0] ?? null;
    if (!this.cursor) return;
    this.keys.focus();
    if (!watching) this.watch(cx);
  }

  // Nothing says when the keyboard goes (a click on a terminal, a panel opening), so ask, and
  // only while it's here.
  watch(cx) {
    cx.timer.after(FOCUS_POLL, (cx) => {
      if (!this.cursor) return;
      if (this.keys.is_focused()) return this.watch(cx);
      this.cursor = null;
      cx.notify();
    });
  }

  leave(tab) {
    const ps = panes(), id = tab ?? activeSpace()?.tabs.find((c) => c.active)?.id;
    const pane = ps.find((p) => p.tab === id && p.focused) ?? ps.find((p) => p.tab === id);
    this.cursor = null;
    if (tab) run("tab.select", { id: tab });
    if (pane) run("pane.focus", { pane: pane.pane });
  }

  key(e, v, cx) {
    const stops = columnStops(v.list, v.groups), at = Math.max(0, stops.indexOf(this.cursor)), stop = stops[at];
    const id = stoppedGroup(stop), g = v.groups[id];
    const fold = (folded) => setShared("tab.groups", { ...v.groups, [id]: { ...g, folded } });
    if (e.key === "escape") this.leave();
    else if (e.key === "up") this.cursor = stops[Math.max(0, at - 1)];
    else if (e.key === "down") this.cursor = stops[Math.min(stops.length - 1, at + 1)];
    else if (e.key === "left" && g) fold(true);
    else if (e.key === "right" && g) fold(false);
    else if (e.key === "enter" && g) fold(!g.folded);
    else if (e.key === "enter" && stop) this.leave(stop);
    else return;
    cx.notify();
  }

  pressed(e, moving, anchor, cx) {
    if (this.cursor) this.leave();
    this.press = { moving, anchor, from: e.position, top: e.bounds?.y ?? e.position.y };
    cx.notify();
  }

  hovered(id, on, cx) {
    const next = on ? id : this.over === id ? null : this.over;
    if (next === this.over) return;
    this.over = next;
    cx.notify();
  }

  moved(e, v, cx) {
    const z = settings().zoom;
    this.rootY = e.bounds.y / z;
    if (this.drag) {
      this.follow(e.position.x / z, e.position.y / z);
      cx.notify();
    } else if (this.press && Math.hypot(e.position.x - this.press.from.x, e.position.y - this.press.from.y) > START * z) {
      this.lift(v);
      cx.notify();
    }
  }

  held(moving, v) {
    if (moving.group) return { size: sectionHeight(v.groups[moving.group], v.list.filter((c) => v.groups[moving.group].tabs.includes(c.id))), gap: COLUMN.gap };
    const { sections } = columnRuns(v.list, v.groups), inSection = (id) => sections.some((c) => c.tabs.some((x) => x.id === id));
    const size = moving.tabs.reduce((sum, id) => sum + (inSection(id) ? COLUMN.inRow : COLUMN.row) + COLUMN.rowGap, 0);
    return { size: size - COLUMN.rowGap, gap: COLUMN.rowGap };
  }

  // Picks a press up: it leaves the list for a room its own size, so nothing shifts, and a
  // clear layer takes over the pointer. The press ends here: under the layer this mod hears
  // neither the release nor the pointer leaving.
  lift(v) {
    const { moving, anchor, top, from } = this.press, z = settings().zoom, { list, groups } = v;
    const places = columnSlots(list, groups, moving);
    if (places.length < 2) return;
    this.press = null;
    this.over = null;
    const { size, gap } = this.held(moving, v), start = columnHome(places, list, groups, moving);
    const order = list.filter((c) => (moving.tabs ?? []).includes(c.id)).map((c) => c.id);
    const held = this.held({ tabs: order.slice(0, Math.max(0, order.indexOf(anchor))) }, v).size;
    this.drag = {
      n: ++this.drags, moving, slots: places, slot: start, home: start, size, room: size + gap,
      startX: from.x / z, x: from.x / z, y: from.y / z, grab: (from.y - top) / z + (held > 0 ? held + gap : 0),
      listY: top / z - columnSlots(list, groups, {}).find((p) => p.key === anchor).y,
    };
    this.overlay = openOverlay({ mod: "tab-drag", kind: "window", frame: "none", width: 1, height: 1, at: { x: 0, y: 0 }, props: { to: "tabs-column" } });
  }

  follow(x, y) {
    const d = this.drag;
    if (!d || d.landing) return;
    const top = this.rootY + HEADER, bottom = this.rootY + this.rootH;
    d.x = x; d.y = y;
    d.lifted = true;
    d.far = Math.abs(x - d.startX) > FAR;
    d.slot = d.far ? d.home : y < top + EDGE ? d.slots[0] : y > bottom - EDGE ? d.slots.at(-1) : nearestY(d.slots, y - d.grab - d.listY);
  }

  // Sets it down, then commits: the order changes under a row that's already in place.
  land(cx) {
    const d = this.drag;
    if (!d || d.landing) return;
    closeOverlay(this.overlay);
    d.landing = true;
    const order = activeSpace()?.tabs.map((c) => c.id) ?? [], groups = shared("tab.groups") ?? {};
    const result = d.slot === d.home ? null : landed(order, groups, d.moving, d.slot);
    cx.timer.after(SETTLE_MS, (cx) => {
      if (this.drag !== d) return;
      if (result) {
        setShared("tabs.hold", Date.now() + 1000);
        d.next = result.order;
        setShared("tab.groups", result.groups);
        for (const m of moves(order, result.order)) run("tab.move", m);
        cx.timer.after(800, (cx) => { if (this.drag === d) this.drag = null; cx.notify(); });
      } else this.drag = null;
      cx.notify();
    });
    cx.notify();
  }

  up(cx, click) {
    const press = this.press;
    this.press = null;
    if (this.drag) this.land(cx);
    else if (press) click?.();
    cx.notify();
  }

  click(c, e, v) {
    const { shift, platform, control } = e.modifiers;
    const picks = clicked(v.list, c, { shift, picking: window()?.platform === "macos" ? platform : control }, shared("tabs.picked") ?? []);
    setShared("tabs.picked", picks ?? []);
    if (!picks) run("tab.select", { id: c.id });
  }

  // A mouse wheel's notch steps through the tabs, as on the bar. A trackpad scrolls, and so
  // does a wheel when the list is too long to fit.
  wheel(e, v) {
    const notch = e.delta_lines?.y ?? 0;
    if (Math.abs(notch) < 1 || !v.space) return;
    const end = columnSlots(v.list, v.groups, {}).at(-1).y;
    const next = end <= this.rootH - HEADER && stepped(v.list, notch < 0);
    if (next) run("tab.select", { id: next.id });
  }

  // In a drag, every place it could land is a room, shut but for the one it's over. A tab let
  // go on a fold goes in with the rest, so that room shuts as it fades.
  room(key, extra = 0) {
    const d = this.drag, open = d.landing && d.slot.fold && d.slot !== d.home ? null : d.slot.key;
    return div().id(`room-${d.n}-${key}`).flex_none().w_full().h(open === key ? d.room + extra : 0).spring("height", SLIDE);
  }

  roomed(el, before, after) {
    if (!this.drag) return el;
    return v_flex().flex_none().w_full().when(Boolean(before), (o) => o.child(this.room(before))).child(el).when(Boolean(after), (o) => o.child(this.room(after)));
  }

  menu(p) {
    openOverlay({ mod: "tab-menu", kind: "popup", width: 236, height: 440, props: p });
  }

  // A header button's menu hangs under it, its right edge on the button's. A click doesn't say
  // where its element is, so the press beforehand notes that. Without one (the keyboard), the pointer.
  under(width) {
    const at = this.toolAt, z = settings().zoom;
    return at ? { x: at.x + at.width - width * z, y: at.y + at.height + 6 * z } : "pointer";
  }

  // The header's group button: a tab already alone in a group opens that group, else a new one.
  group(tabs) {
    const groups = shared("tab.groups") ?? {}, own = tabs.length === 1 ? groupOf(groups, tabs[0]) : null;
    const asked = groups[own]?.tabs.length === 1 ? { group: own } : { tabs, make: true, space: activeSpace()?.id };
    openOverlay({ mod: "tab-menu", kind: "popup", at: this.under(236), width: 236, height: 440, props: { ...asked, from: "column-group" } });
  }

  // `carried`: "row" when it's what's being dragged, "group" inside a dragged group.
  row(c, v, inGroup, carried) {
    const { k, ps, words, space, picks } = v, { program, cwd, name } = shows(c, ps);
    const status = failed(c, ps, words);
    const since = c.working_since ?? c.changed_at, picked = picks.length > 1 && picks.includes(c.id);
    const over = !this.drag && this.over === c.id, down = !this.drag && this.press?.anchor === c.id;
    const state = down && !c.active ? "pressed" : c.active ? (over ? "active_hover" : "active") : over ? "hover" : "default";
    // A color is a sheet under the others, which deepen it instead of covering it.
    const hue = tabHue(k, v.colors[c.id], v.groups[groupOf(v.groups, c.id)]);
    const shade = hue ? { pressed: hue.tint, hover: hue.tint, active: hue.row, lit: hue.ring } : { pressed: k.row_pressed, hover: k.hover, active: k.row_selected_strong, lit: k.row_active_hover };
    const edge = carried === "row" ? k.row_ring : carried ? null : picked ? k.foreground : state === "active_hover" ? hue?.ring ?? k.row_ring : state === "active" ? hue?.ring ?? k.chip_active_ring : null;
    return h_flex().id(`column-${c.id}`).relative().h(inGroup ? COLUMN.inRow : COLUMN.row).flex_none().pl(inGroup ? 27 : 10).pr(10).gap(9).items_center().rounded(10)
      .when(carried === "row", (el) => el.bg(k.row_dragging).shadow_2xl())
      .child(sheet(`column-paint-${c.id}`, hue?.row ?? k.hover, Boolean(hue)))
      .on_hover((on, cx) => this.hovered(c.id, on, cx))
      .on_mouse_down("left", (e, cx) => {
        this.pressed(e, { tabs: picked ? picks : [c.id] }, c.id, cx);
        if (e.click_count === 2) run("tab.rename", { id: c.id });
      })
      .on_mouse_up("left", (e, cx) => this.up(cx, () => this.click(c, e, v)))
      .on_mouse_down("right", () => this.menu({ tabs: picked ? picks : [c.id], space: space.id, machine: space.machine, cwd }))
      .when(!carried, (el) => el
        .child(sheet(`column-pressed-${c.id}`, shade.pressed, state === "pressed"))
        .child(sheet(`column-hover-${c.id}`, shade.hover, state === "hover"))
        .child(sheet(`column-active-${c.id}`, shade.active, state === "active"))
        .child(sheet(`column-active-hover-${c.id}`, shade.lit, state === "active_hover")))
      .child(tile(program, inGroup ? 20 : 22, k))
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_weight(c.active ? 500 : 400).text_color(state === "default" && !carried ? k.row_name : k.foreground).child(name))
      .when(Boolean(since), (el) => el.child(div().flex_none().font_family(MONO).text_size(10).text_color(k.label).child(duration(v.now - since))))
      .when(Boolean(status), (el) => el.child(badge(k, status)))
      .when(Boolean(edge), (el) => el.child(ring(edge, 1, 10)))
      .when(this.cursor === c.id, (el) => el.child(ring(k.accent, 2, 10)));
  }

  head(id, tabs, v) {
    const { k, groups } = v, g = groups[id], hue = groupHue(k, g.color);
    const needs = tabs.some((c) => failed(c, v.ps, v.words) === "blocked"), done = tabs.filter((c) => c.status === "done").length;
    return h_flex().id(`column-fold-${id}`).relative().h(COLUMN.head).flex_none().pl(8).pr(10).gap(8).items_center().rounded(9)
      .text_color(k.label).hover((s) => s.bg(k.selected).text_color(k.tile_text))
      .on_mouse_down("left", (e, cx) => this.pressed(e, { group: id }, slotKey.before(id), cx))
      .on_mouse_up("left", (_e, cx) => this.up(cx, () => setShared("tab.groups", { ...groups, [id]: { ...g, folded: !g.folded } })))
      .on_mouse_down("right", () => this.menu({ group: id }))
      .child(svg(`mods/workspace-chrome/icons/chevron-${g.folded ? "right" : "down"}.svg`).size(12).flex_none())
      .child(div().min_w(0).truncate().text_size(13.5).font_semibold().text_color(hue.text).child(g.name || "Group"))
      .child(div().flex_none().font_family(MONO).text_size(11).child(String(tabs.length)))
      .child(div().flex_1())
      .when(needs, (el) => el.child(div().size(7).flex_none().rounded(999).bg(k.status.blocked.dot)))
      .child(div().flex_none().font_family(MONO).text_size(10.5).child(`${done}/${tabs.length}`))
      .when(this.cursor === groupStop(id), (el) => el.child(ring(k.accent, 2, 9)));
  }

  // A row under a group's name. It stays mounted when folded, at no height, so a fold slides shut
  // and takes what's below up with it. Its height holds the gap under it: a shut row leaves none.
  tucked(c, open, v) {
    return div().id(`column-tuck-${c.id}`).flex_none().w_full().h(open ? COLUMN.inRow + COLUMN.rowGap : 0).overflow_hidden().spring("height", SLIDE).child(this.row(c, v, true));
  }

  section(id, tabs, v) {
    const { groups } = v, g = groups[id], d = this.drag;
    const moving = d?.moving.tabs ?? [], kept = tabs.filter((c) => !moving.includes(c.id)), rows = shownIn(g, kept), inside = slotKey.inside(id);
    const under = g.folded ? slotKey.fold(id) : rows.length ? null : inside;
    // The last row's gap isn't one: the sections' own gap follows.
    return v_flex().id(`column-group-${id}`).flex_none().mb(-COLUMN.rowGap)
      .child(this.roomed(div().flex_none().w_full().pb(COLUMN.rowGap).child(this.head(id, tabs, v)), null, under))
      .children(kept.map((c) => this.roomed(this.tucked(c, rows.includes(c), v), g.folded ? null : c.id, c === rows.at(-1) && !g.folded ? inside : null)));
  }

  ghost(v) {
    const d = this.drag, { k } = v, top = this.rootY + HEADER, bottom = this.rootY + this.rootH;
    const y = d.landing ? d.slot.y + d.listY : Math.max(top, Math.min(d.y - d.grab, bottom - d.size));
    const carried = v.list.filter((c) => d.moving.tabs?.includes(c.id)), { sections } = columnRuns(v.list, v.groups);
    const inGroup = (c) => sections.some((x) => x.tabs.includes(c));
    const group = d.moving.group, tabs = group ? v.list.filter((c) => v.groups[group].tabs.includes(c.id)) : [];
    return v_flex().id(`ghost-${d.n}`).absolute().left(INSET).right(INSET).top(y - this.rootY).gap(COLUMN.rowGap).rounded(10)
      .opacity(d.landing && d.slot.fold ? 0 : d.far ? 0.5 : 1)
      .spring("top", d.landing ? SETTLE : HELD).transition("opacity", 140)
      .when(Boolean(group), (el) => el.bg(k.row_dragging).shadow_2xl()
        .child(this.head(group, tabs, v))
        .children(shownIn(v.groups[group] ?? {}, tabs).map((c) => this.row(c, v, true, "group")))
        .child(ring(k.row_ring, 1, 10)))
      .when(Boolean(d.moving.tabs), (el) => el.children(carried.map((c) => this.row(c, v, inGroup(c), "row"))));
  }

  render() {
    const k = look(theme()), space = activeSpace(), list = space?.tabs ?? [];
    const groups = shared("tab.groups") ?? {}, order = list.map((c) => c.id), active = list.find((c) => c.active);
    if (this.drag?.next && same(order, this.drag.next)) this.drag = null;
    const d = this.drag, picks = list.filter((c) => c.active || (shared("tabs.picked") ?? []).includes(c.id)).map((c) => c.id);
    const v = { k, groups, colors: shared("tab.colors") ?? {}, space, list, picks, ps: panes(), words: new Map(terminals().map((x) => [x.address, x.status])), now: Date.now() };
    const { loose, sections } = columnRuns(list, groups), going = d?.moving.tabs ?? [];
    const stay = loose.filter((c) => !going.includes(c.id)), shown = sections.filter((c) => c.group !== d?.moving.group);
    const tool = (id, icon, action, on = false) => h_flex().id(id).size(32).flex_none().items_center().justify_center().rounded(9).text_color(on ? k.foreground : k.muted).hover((s) => s.bg(k.hover_strong).text_color(k.foreground)).on_mouse_down("left", (e) => { this.toolAt = e.bounds; this.toolDown = Date.now(); }).on_click(() => { if (!reopening(shared("popup.closed"), id, this.toolDown)) action(); }).child(svg(icon).size(16));
    return v_flex().id("tabs-column").relative().size_full().min_h(0).rounded(14).overflow_hidden().bg(k.surface).text_color(k.foreground).text_size(13)
      .on_size_change((size) => { this.rootH = size.height / settings().zoom; })
      .on_mouse_move((e, cx) => this.moved(e, v, cx))
      .on_mouse_up("left", (_e, cx) => this.up(cx))
      .on_hover((on, cx) => { if (!on) { this.press = null; this.over = null; cx.notify(); } })
      .on_scroll_wheel((e) => this.wheel(e, v))
      // Holds the keyboard without being a thing to click: a click here must leave it with the terminal.
      .child(div().id("column-keys").absolute().size(0).track_focus(this.keys).on_key_down((e, cx) => this.key(e, v, cx)))
      .child(h_flex().h(HEADER).flex_none().pl(18).pr(10).gap(8).items_center()
        .child(div().flex_none().text_size(15).font_medium().child("Tabs"))
        .child(div().flex_none().font_family(MONO).text_size(11).text_color(k.label).child(String(list.length)))
        .child(div().flex_1())
        .child(h_flex().flex_none().gap(2).items_center()
          .child(tool("column-group", "mods/workspace-chrome/icons/layers.svg", () => active && this.group(picks), picks.length > 1))
          .child(tool("column-new", "mods/workspace-chrome/icons/plus.svg", () => openOverlay({ mod: "new-menu", kind: "popup", at: this.under(250), width: 250, height: 512, props: { from: "column-new" } })))))
      .child(v_flex().id("column-list").flex_1().min_h(0).gap(COLUMN.gap).px(INSET).pb(12).overflow_y_scrollbar()
        .when(stay.length > 0 || Boolean(d?.moving.tabs), (el) => el.child(v_flex().flex_none().gap(COLUMN.rowGap)
          // With no loose tabs there's no section yet: nothing shifts until a row heads here.
          .when(!loose.length, (o) => o.mb(-COLUMN.gap))
          .children(stay.map((c, i) => this.roomed(this.row(c, v, false), c.id, i === stay.length - 1 ? "loose-end" : null)))
          .when(!stay.length && Boolean(d), (el) => el.child(this.room("loose-end", loose.length ? 0 : COLUMN.gap - COLUMN.rowGap)))))
        .children(shown.map((c, i) => this.roomed(this.section(c.group, c.tabs, v), slotKey.before(c.group), i === shown.length - 1 ? "end" : null))))
      .when(Boolean(d), (el) => el.child(this.ghost(v)));
  }
}
