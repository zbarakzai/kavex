import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, terminals, machines, run, openOverlay, closeOverlay, theme, window, shared, setShared, layout, settings, nextCommand, home as homeFolder } from "herdr";
import { GAP, HUES, INNER, away, clicked, columnOrder, failed, gathered, groupOf, home, labeled, landed, moves, nearest, nextColor, pruned, reopening, runs, shows, slotKey, slots, stepped } from "./groups.js";
import { look, groupHue, tabHue, spaced, MONO } from "./look.js";
import { loader } from "./loader.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const tabState = () => ({ groups: shared("tab.groups") ?? {}, colors: shared("tab.colors") ?? {} });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const machineOf = (id) => (id.includes("/") ? id.split("/")[0] : null);
const TOP = 5, CHIP = 34; // the bar's top padding, which levels it with the window buttons, and a chip's height
// How a dragged tab moves. Native springs: `response` in ms, 1 `damping` has no overshoot.
const SLIDE = { response: 150, damping: 1 }; // room opening and shutting: slower, and rooms pile up on a quick back and forth
const HELD = { response: 0 }; // stuck to the pointer: any spring here trails it, by 47 px on a fast whip
const SETTLE = { response: 170, damping: 0.82 }; // lifting, and down into its place
const SETTLE_MS = 170; // until it's there from across the bar, and the order can change under it
const START = 4; // px of travel before a press is a drag
const FAR = 90; // px off the bar where a drag lets go of its target and heads home
const EDGE = 16; // px from the strip's ends that mean its first and last place: it can't be scrolled mid-drag

export default class Tabs extends View {
  init(_props, cx) {
    this.press = null; // a press that may turn into a drag
    this.drag = null;
    this.drags = 0;
    this.widths = {}; // measured, so a drag can lay the bar out ahead of the pointer
    this.placed = new Set(JSON.parse(localStorage.getItem("labeled") ?? "[]")); // terminals a label has already put in a group
    this.away = new Set(); // the tabs a fold put away at the last look
    this.hold = 0; // until our own moves land, a split group isn't one to mend
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    cx.spawn(async (cx) => {
      for (;;) {
        this.command(await nextCommand(), cx);
        cx.notify();
      }
    });
  }

  command(name, cx) {
    const place = () => name.split(":")[1].split(",").map((n) => Number(n) / settings().zoom);
    if (name.startsWith("drag:")) {
      this.follow(...place());
      // Only while the layer's there: an answer to one that's gone shows as an error.
      return this.drag && !this.drag.landing ? run("tab-drag.ready") : null;
    }
    if (name.startsWith("drop:")) {
      this.follow(...place());
      return this.land(cx);
    }
    const space = spaces().find((p) => p.active), shown = space?.tabs.find((c) => c.active);
    if (!shown) return;
    const { groups, colors } = tabState(), own = groupOf(groups, shown.id), picked = this.picked(space);
    if (name === "group") {
      if (own && picked.length === 1) this.menu({ group: own }, "dialog");
      else this.group(picked, "dialog");
    } else if (name === "fold" && own) this.fold(own, groups);
    else if (name === "ungroup" && own) {
      const { [own]: _, ...rest } = groups;
      setShared("tab.groups", rest);
    } else if (name === "color") setShared("tab.colors", nextColor(colors, shown.id, groups[own]?.fill));
  }

  // Shared state says how tabs should stand, whoever changed it; this makes it so.
  reconcile(space, { groups, colors }, ps) {
    const ready = (m) => machines().some((k) => k.name === m && k.layout === "ready");
    const known = new Set(spaces().flatMap((p) => p.tabs.map((c) => c.id)));
    const kept = (id) => known.has(id) || !ready(machineOf(id));
    let next = this.byLabel(pruned(groups, kept), space, ps);
    // A tab opened from a group's menu joins it.
    const fresh = this.seen && space.tabs.find((c) => !this.seen.has(c.id));
    const adopting = fresh && Object.keys(next).find((id) => next[id].adopt);
    if (adopting) {
      const { adopt, ...group } = next[adopting];
      next = { ...next, [adopting]: { ...group, tabs: [...group.tabs, fresh.id] } };
    }
    this.seen = known;
    if (!same(next, groups)) setShared("tab.groups", next);
    const paints = Object.fromEntries(Object.entries(colors).filter(([id]) => kept(id)));
    if (!same(paints, colors)) setShared("tab.colors", paints);
    // In the column, the tabs' order is the one it draws. On the bar a group only stays together.
    const order = space.tabs.map((c) => c.id), want = shared("tabs.placement") === "right" ? columnOrder(space.tabs, next) : gathered(order, next);
    if (ready(space.machine) && !this.drag && Date.now() > Math.max(this.hold, shared("tabs.hold") ?? 0)) for (const m of moves(order, want)) run("tab.move", m);
    // Unfolded or left its group: back. A tab settled for any other reason stays settled.
    const out = away(space.tabs, next);
    for (const c of space.tabs) {
      if (out.has(c.id) && !c.settled) run("tab.settle", { id: c.id });
      else if (!out.has(c.id) && c.settled && this.away.has(c.id)) run("tab.unsettle", { id: c.id });
    }
    this.away = out;
  }

  // A terminal started with the label `zaki.group=<name>` lands in that group, once: after
  // that where its tab sits is the person's to change.
  byLabel(groups, space, ps) {
    let next = groups;
    for (const k of terminals()) {
      const name = k.labels?.["zaki.group"], tab = name && ps.find((p) => p.terminal === k.address)?.tab;
      if (!tab || this.placed.has(k.address) || !space.tabs.some((c) => c.id === tab)) continue;
      next = labeled(next, tab, name, HUES, `g${Date.now().toString(36)}${this.placed.size}`);
      this.placed.add(k.address);
      localStorage.setItem("labeled", JSON.stringify([...this.placed]));
    }
    return next;
  }

  picked(space) {
    const picks = shared("tabs.picked") ?? [];
    return space.tabs.filter((c) => c.active || picks.includes(c.id)).map((c) => c.id);
  }

  menu(p, kind = "popup") {
    openOverlay({ mod: "tab-menu", kind, width: 236, height: 440, props: p });
  }

  group(tabs, kind) {
    this.menu({ tabs, make: true, space: spaces().find((p) => p.active)?.id, from: "group-picked" }, kind);
  }

  // A press on a button that opens a popup: a second one only shuts it (see `reopening`).
  armed(_e, cx) {
    cx.stop_propagation();
    this.armedAt = Date.now();
  }

  unlessShut(id, act) {
    return () => { if (!reopening(shared("popup.closed"), id, this.armedAt)) act(); };
  }

  fold(id, groups) {
    setShared("tab.groups", { ...groups, [id]: { ...groups[id], folded: !groups[id].folded } });
  }

  width(key) {
    return this.widths[key] ?? 0;
  }

  measured(el, key) {
    return el.on_size_change((size) => { this.widths[key] = size.width / settings().zoom; });
  }

  pressed(e, moving, anchor) {
    this.press = { moving, anchor, from: e.position, left: e.bounds?.x ?? e.position.x };
  }

  moved(e, v, cx) {
    this.rootX = e.bounds.x / settings().zoom;
    if (this.drag) {
      this.follow(e.position.x / settings().zoom, e.position.y / settings().zoom);
      cx.notify();
    } else if (this.press && Math.hypot(e.position.x - this.press.from.x, e.position.y - this.press.from.y) > START * settings().zoom) {
      this.lift(v);
      cx.notify();
    }
  }

  // Picks a press up: it leaves the bar for a room its own size, so nothing shifts, and
  // a clear layer takes over the pointer, which is free to wander off a 42 px bar. The press
  // ends here: under the layer the bar hears neither the release nor the pointer leaving
  // (an exit is dropped while the pointer is still over the bar), so it must not outlive this.
  lift({ space, s, order }) {
    const { moving, anchor, left, from } = this.press, z = settings().zoom;
    const width = (key) => this.width(key), bar = runs(space.tabs, s.groups);
    const list = slots(bar, moving, width, this.away);
    if (list.length < 2) return;
    this.press = null;
    const ids = moving.tabs ?? [], inset = moving.group ? 3 : 0;
    const size = moving.group ? width(`tray:${moving.group}`) : ids.reduce((sum, id) => sum + width(id) + GAP, -GAP);
    const ahead = ids.slice(0, ids.indexOf(anchor)).reduce((sum, id) => sum + width(id) + GAP, 0);
    const start = home(list, order, s.groups, moving);
    this.drag = {
      n: ++this.drags, moving, slots: list, slot: start, home: start, size, room: size + GAP,
      x: from.x / z, y: from.y / z, grab: (from.x - left) / z + ahead + inset,
      stripX: left / z - inset - slots(bar, {}, width, this.away).find((p) => p.key === anchor).x,
    };
    this.overlay = openOverlay({ mod: "tab-drag", kind: "window", frame: "none", width: 1, height: 1, at: { x: 0, y: 0 } });
  }

  follow(x, y) {
    const d = this.drag;
    if (!d || d.landing) return;
    const left = this.rootX + this.padding, right = left + this.stripW;
    d.x = x;
    d.lifted = true;
    d.far = Math.abs(y - d.y) > FAR;
    d.slot = d.far ? d.home : x < left + EDGE ? d.slots[0] : x > right - EDGE ? d.slots.at(-1) : nearest(d.slots, x - d.grab - d.stripX);
  }

  // Sets it down, then commits: the order changes under a tab that's already in place.
  land(cx) {
    const d = this.drag;
    if (!d || d.landing) return;
    closeOverlay(this.overlay);
    d.landing = true;
    const order = spaces().find((p) => p.active)?.tabs.map((c) => c.id) ?? [], { groups } = tabState();
    const result = landed(order, groups, d.moving, d.slot);
    cx.timer.after(SETTLE_MS, (cx) => {
      if (this.drag !== d) return;
      if (result) {
        this.hold = Date.now() + 1000;
        d.next = result.order;
        setShared("tab.groups", result.groups);
        for (const m of moves(order, result.order)) run("tab.move", m);
        cx.timer.after(800, (cx) => { if (this.drag === d) this.drag = null; cx.notify(); });
      } else this.drag = null;
      cx.notify();
    });
    cx.notify();
  }

  // Ends a press: a landing if it was picked up, else a click.
  up(cx, click) {
    const press = this.press;
    this.press = null;
    if (this.drag) this.land(cx);
    else if (press) click?.();
    cx.notify();
  }

  // A mouse wheel's notch steps through the tabs. A trackpad only scrolls the strip, and so
  // does a wheel when the strip overflows: GPUI hands every event on, and stepping tabs
  // while scrolling changed the strip's width under it, which is what made it flicker.
  wheel(e, { space, s }) {
    const notch = e.delta_lines?.y ?? 0;
    if (Math.abs(notch) < 1 || !space) return;
    const end = slots(runs(space.tabs, s.groups), {}, (key) => this.width(key), this.away).at(-1).x - GAP;
    const next = end <= this.stripW && stepped(space.tabs, notch < 0);
    if (next) run("tab.select", { id: next.id });
  }

  // In a drag, every place it could land is a room, shut but for the one it's over. The layout
  // does the rest: neighbours slide apart and a tray grows to take it in.
  room(key) {
    const d = this.drag;
    return div().id(`room-${d.n}-${key}`).flex_none().h(1).w(d.slot.key === key ? d.room : 0).spring("width", SLIDE);
  }

  roomed(el, before, after) {
    if (!this.drag) return el;
    return h_flex().flex_none().items_center().when(Boolean(before), (o) => o.child(this.room(before))).child(el).when(Boolean(after), (o) => o.child(this.room(after)));
  }

  // What's being carried, lifted off the bar. It heads for its place when let go.
  ghost(v) {
    const d = this.drag, { space, s, k } = v;
    const rest = TOP;
    const left = this.rootX + this.padding, right = left + this.stripW;
    const x = d.landing ? d.slot.x + d.stripX : Math.max(left, Math.min(d.x - d.grab, right - d.size));
    return h_flex().id(`ghost-${d.n}`).absolute().left(x - this.rootX).top(d.lifted && !d.landing ? rest - 2 : rest).gap(GAP).rounded(11).shadow_md()
      .opacity(d.landing && d.slot.fold ? 0 : d.far ? 0.5 : 1)
      .spring("left", d.landing ? SETTLE : HELD).spring("top", SETTLE).transition("opacity", 140)
      .when(Boolean(d.moving.group), (el) => el.child(this.tray(runs(space.tabs, s.groups).find((r) => r.group === d.moving.group), v)))
      .when(Boolean(d.moving.tabs), (el) => el.children(space.tabs.filter((c) => d.moving.tabs.includes(c.id)).map((c) => this.pill(c, v, false, k.raised))));
  }

  click(c, e, v) {
    const { shift, platform, control } = e.modifiers;
    const picks = clicked(v.space.tabs, c, { shift, picking: window()?.platform === "macos" ? platform : control }, shared("tabs.picked") ?? []);
    setShared("tabs.picked", picks ?? []);
    if (!picks) run("tab.select", { id: c.id });
  }

  glyph(program, k, on) {
    if (program?.agent && program.icon) return program.tint ? svg(program.icon).size(14).flex_none().text_color(k.muted) : image(program.icon).size(14).flex_none();
    return svg("mods/workspace-chrome/icons/terminal.svg").size(16).flex_none().text_color(on ? k.accent : k.label);
  }

  pill(c, v, tray, lifted) {
    const { k, space } = v;
    const { program, cwd, name } = shows(c, v.ps);
    const picked = v.picked.length > 1 && v.picked.includes(c.id);
    const stop = (_e, cx) => cx.stop_propagation(), shown = c.active || lifted;
    const status = failed(c, v.ps, v.words), dot = k.status[status]?.dot, hue = tabHue(k, v.s.colors[c.id]);
    return this.measured(h_flex().id(`tab-${c.id}`), c.id).relative().h(tray ? 28 : CHIP).flex_none().items_center().rounded(tray ? 9 : 11).text_size(13.5)
      .when(c.active, (el) => el.pl(11).pr(6).gap(7)).when(!c.active, (el) => el.px(tray ? 8 : 10).gap(6))
      .when(/^\d+$/.test(name), (el) => el.font_family(MONO).text_size(12))
      .border(1).border_color(picked ? k.foreground : shown ? hue?.ring ?? k.chip_active_ring : k.clear)
      .when(Boolean(shown), (el) => el.bg(lifted ?? hue?.row ?? k.chip_active))
      .when(!shown && Boolean(hue), (el) => el.bg(hue.row))
      .text_color(shown ? k.foreground : k.muted)
      .when(!shown, (el) => el.hover((s) => s.bg(hue?.ring ?? k.hover)))
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.pressed(e, { tabs: picked ? v.picked : [c.id] }, c.id);
        if (e.click_count === 2) run("tab.rename", { id: c.id });
      })
      .on_mouse_up("left", (e, cx) => this.up(cx, () => this.click(c, e, v)))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.menu({ tabs: picked ? v.picked : [c.id], space: space.id, machine: space.machine, cwd });
      })
      .child(this.glyph(program, k, c.active))
      .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
      .when(Boolean(dot), (el) => el.child(status === "working" ? loader(k.accent, 2) : div().size(6).rounded(3).flex_none().bg(dot)))
      .when(c.active, (el) => el.child(h_flex().id(`close-${c.id}`).size(20).flex_none().items_center().justify_center().rounded(6).text_color(k.label).hover((s) => s.bg(k.hover_strong).text_color(k.foreground))
        .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/workspace-chrome/icons/close.svg").size(16))));
  }

  tag(id, g, hue, tabs, v) {
    const { k, s } = v;
    const joining = this.drag?.slot.fold && this.drag.slot.group === id;
    const needs = tabs.some((c) => failed(c, v.ps, v.words) === "blocked");
    return this.measured(h_flex().id(`tag-${id}`), `tag:${id}`).h(28).pl(9).pr(8).gap(6).flex_none().items_center().rounded(9).text_size(13).font_semibold()
      .border(1).border_color(joining ? k.foreground : k.clear).text_color(hue.text)
      .hover((el) => el.opacity(0.88))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed(e, { group: id }, slotKey.before(id)); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu({ group: id }); })
      .on_mouse_up("left", (_e, cx) => this.up(cx, () => this.fold(id, s.groups)))
      .child(div().max_w(150).truncate().child(g.name || String(tabs.length)))
      .when(Boolean(g.folded), (el) => el.child(div().font_family(MONO).text_size(11).font_normal().text_color(k.text_faint).child(String(tabs.length)))
        .when(needs, (el) => el.child(div().size(7).rounded(4).flex_none().bg(k.accent))));
  }

  tray({ group: id, tabs }, v) {
    const { k, s } = v;
    const g = s.groups[id], hue = groupHue(k, g.color);
    const hidden = tabs.filter((c) => this.away.has(c.id));
    const out = tabs.filter((c) => !this.away.has(c.id) && !this.drag?.moving.tabs?.includes(c.id)), inside = slotKey.inside(id);
    return this.measured(h_flex().id(`group-${id}`), `tray:${id}`).h(CHIP).p(2).gap(INNER).flex_none().items_center().rounded(13)
      .bg(hue.tint).border(1).border_color(hue.ring)
      .child(this.roomed(this.tag(id, g, hue, tabs, v), null, !out.length && !hidden.length ? inside : null))
      .children(out.map((c) => this.roomed(this.pill(c, v, true), c.id, c === out.at(-1) ? inside : null)));
  }

  placement(k) {
    const now = shared("tabs.placement") === "right" ? "right" : "top";
    const radio = (value, icon) => h_flex().id(`place-${value}`).size(26).flex_none().items_center().justify_center().rounded(13)
      .text_color(now === value ? k.foreground : k.label).when(now === value, (el) => el.bg(k.pill_selected))
      .when(now !== value, (el) => el.hover((s) => s.bg(k.hover_strong).text_color(k.foreground)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => setShared("tabs.placement", value))
      .child(svg(`mods/workspace-chrome/icons/${icon}.svg`).size(16));
    return h_flex().id("placement").flex_none().gap(2).p(3).items_center().rounded(999).bg(k.pill).border_1().border_color(k.pill_ring)
      .child(radio("top", "tabs-top")).child(radio("right", "tabs-right"));
  }

  current(shown, v) {
    const { k } = v, c = shown.find((x) => x.active);
    if (!c) return div().flex_1();
    const { program, cwd, name } = shows(c, v.ps), home = homeFolder();
    const path = cwd ? (cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd).toUpperCase() : "";
    return h_flex().flex_1().min_w(0).items_center().child(h_flex().id("tab-current").h(CHIP).pl(11).pr(12).gap(7).min_w(0).items_center().rounded(11).overflow_hidden()
      .bg(k.chip_active).border_1().border_color(k.chip_active_ring).text_size(13.5).text_color(k.foreground)
      .child(this.glyph(program, k, true)).child(div().flex_none().child(name))
      .when(Boolean(path), (el) => el.child(spaced(path.slice(-46), 10.5, 0.06).text_color(k.label))));
  }

  syncColumn(root, panel) {
    const column = find(root, "tabs-column");
    if (!column) return;
    const want = shared("tabs.placement") === "right" && (!panel || Boolean(panel.hidden));
    if (want === this.column || want !== Boolean(column.hidden)) { this.column = want; return; }
    this.column = want;
    run(want ? "layout.show" : "layout.hide", { id: "tabs-column" });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme(), k = look(t);
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const s = tabState();
    const ps = panes();
    if (space) this.reconcile(space, s, ps);
    const v = { k, s, ps, words: new Map(terminals().map((x) => [x.address, x.status])), space, order: shown.map((c) => c.id), picked: space ? this.picked(space) : [] };
    if (this.drag?.next && same(v.order, this.drag.next)) this.drag = null;
    const d = this.drag;
    const bar = runs(shown, s.groups).filter((r) => !d || (r.group ? r.group !== d.moving.group : !d.moving.tabs?.includes(r.tab.id)));
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(8).text_color(k.muted).hover(s => s.bg(k.hover_strong).text_color(k.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(6, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 6;
    this.padding = lightsPadding;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    this.syncColumn(root, panel);
    const right = shared("tabs.placement") === "right";
    const open = panel && !panel.hidden;
    // A panel turned off (Settings) doesn't stay open, or come back by its key.
    if (open && body && !enabled.includes(body.active)) run(...(enabled.length ? ["layout.select", { stack: "panel-body", child: enabled[0] }] : ["layout.hide", { id: "panel" }]));
    const folder = h_flex().id("panel-toggle").size(CHIP).flex_none().items_center().justify_center().rounded(10)
      .text_color(open ? k.foreground : k.muted).when(open, (el) => el.bg(k.card_border)).when(!open, (el) => el.hover((s) => s.bg(k.hover_strong).text_color(k.foreground)))
      .on_mouse_down("left", stop)
      .on_click(() => {
        if (open) return run("layout.hide", { id: "panel" });
        if (!enabled.includes(body?.active)) run("layout.select", { stack: "panel-body", child: enabled[0] });
        run("layout.show", { id: "panel" });
      }).child(svg("mods/workspace-chrome/icons/folder.svg").size(16));
    const strip = h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(GAP).overflow_x_scroll()
      .on_size_change((size) => { this.stripW = size.width / settings().zoom; })
      .children(bar.map((r, i) => this.roomed(r.group ? this.tray(r, v) : this.pill(r.tab, v), r.group ? slotKey.before(r.group) : r.tab.id, i === bar.length - 1 ? "end" : null)));
    return h_flex().id("tabs").relative().size_full().min_w(0).pl(lightsPadding).pr(6).pt(TOP).gap(GAP).items_center()
      .on_mouse_move((e, cx) => this.moved(e, v, cx))
      .on_mouse_up("left", (_e, cx) => this.up(cx))
      .on_hover((on) => { if (!on) this.press = null; })
      .on_scroll_wheel((e) => this.wheel(e, v))
      .child(right ? this.current(shown, v) : strip)
      .when(!right && v.picked.length > 1, el => el.child(h_flex().id("group-picked").h(CHIP).px(10).flex_none().items_center().rounded(11)
        .border(1).border_color(k.foreground).text_size(13.5).text_color(k.foreground).hover(s => s.bg(k.hover))
        .on_mouse_down("left", (e, cx) => this.armed(e, cx)).on_click(this.unlessShut("group-picked", () => this.group(v.picked))).child(`Group ${v.picked.length} tabs`)))
      .when(!right, (el) => el.child(h_flex().id("tab-new").size(28).flex_none().items_center().justify_center().rounded(8).text_color(k.muted).hover(s => s.bg(k.hover_strong).text_color(k.foreground))
        .on_mouse_down("left", (e, cx) => this.armed(e, cx)).on_click(this.unlessShut("tab-new", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512, props: { from: "tab-new" } }))).child(svg("mods/workspace-chrome/icons/plus.svg").size(16))))
      .child(this.placement(k))
      .when(enabled.length > 0, (el) => el.child(folder))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/workspace-chrome/icons/win-minimize.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/workspace-chrome/icons/${w.maximized ? "win-restore" : "win-maximize"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/workspace-chrome/icons/win-close.svg").size(16) : svg("mods/workspace-chrome/icons/close.svg").size(16), () => run("window.close"))))
      .when(Boolean(d), el => el.child(this.ghost(v)));
  }
}
