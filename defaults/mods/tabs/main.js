import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, machines, run, openOverlay, closeOverlay, theme, window, shared, setShared, layout, settings, nextCommand } from "herdr";
import { GAP, MARK, away, colorOf, gathered, groupOf, home, hue, landed, moves, nearest, pruned, runs, slots, stepped } from "./groups.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const tabState = () => ({ groups: shared("tab.groups") ?? {}, colors: shared("tab.colors") ?? {}, folders: shared("tab.folders") ?? [] });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const machineOf = (id) => (id.includes("/") ? id.split("/")[0] : null);
const LIGHTS = 8;
// How a dragged tab moves. Native springs: `response` in ms, 1 `damping` has no overshoot.
const SLIDE = { response: 150, damping: 1 }; // room opening and shutting: slower, and rooms pile up on a quick back and forth
const HELD = { response: 0 }; // stuck to the pointer: any spring here trails it, by 47 px on a fast whip
const SETTLE = { response: 170, damping: 0.82 }; // lifting, and down into its place
const SETTLE_MS = 170; // until it's there from across the bar, and the order can change under it
const START = 4; // px of travel before a press is a drag
const FAR = 90; // px off the bar where a drag lets go of its target and heads home
const EDGE = 16; // px from the strip's ends that mean its first and last place: it can't be scrolled mid-drag
// Labels are ink on the hue, like label tape: white is too faint on these at this size.
const TAG_INK = "#0e1116";

// How a tab shows: the agent in it, else its first pane's program.
function shows(c, ps) {
  const mine = ps.filter((p) => p.tab === c.id);
  const program = mine.find((p) => p.program?.agent)?.program ?? mine[0]?.program;
  return { program, cwd: mine.find((p) => p.cwd)?.cwd, name: /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name };
}

export default class Tabs extends View {
  init(_props, cx) {
    this.press = null; // a press that may turn into a drag
    this.drag = null;
    this.drags = 0;
    this.widths = {}; // measured, so a drag can lay the bar out ahead of the pointer
    this.selected = new Set();
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
    } else if (name === "color") {
      const hues = Object.keys(MARK);
      setShared("tab.colors", { ...colors, [shown.id]: hues[hues.indexOf(colors[shown.id]) + 1] ?? "none" });
    }
  }

  // Shared state says how tabs should stand, whoever changed it; this makes it so.
  reconcile(space, { groups, colors }) {
    const ready = (m) => machines().some((k) => k.name === m && k.layout === "ready");
    const known = new Set(spaces().flatMap((p) => p.tabs.map((c) => c.id)));
    const kept = (id) => known.has(id) || !ready(machineOf(id));
    let next = pruned(groups, kept);
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
    const order = space.tabs.map((c) => c.id);
    if (ready(space.machine) && !this.drag && Date.now() > this.hold) for (const m of moves(order, gathered(order, next))) run("tab.move", m);
    // Unfolded or left its group: back. A tab settled for any other reason stays settled.
    const out = away(space.tabs, next);
    for (const c of space.tabs) {
      if (out.has(c.id) && !c.settled) run("tab.settle", { id: c.id });
      else if (!out.has(c.id) && c.settled && this.away.has(c.id)) run("tab.unsettle", { id: c.id });
    }
    this.away = out;
  }

  // What an action is for: the selected tabs and the shown one, or just the shown one.
  picked(space) {
    return space.tabs.filter((c) => c.active || this.selected.has(c.id)).map((c) => c.id);
  }

  menu(p, kind = "popup") {
    openOverlay({ mod: "tab-menu", kind, width: 236, height: 440, props: p });
  }

  group(tabs, kind) {
    this.selected.clear();
    this.menu({ tabs, make: true, space: spaces().find((p) => p.active)?.id }, kind);
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
    const ids = moving.tabs ?? [], inset = moving.group ? 6 : 0;
    const size = moving.group ? width(`tray:${moving.group}`) + 4 : ids.reduce((sum, id) => sum + width(id) + GAP, -GAP);
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
    const d = this.drag, { space, s, t } = v;
    const height = d.moving.group ? 35 : 29, rest = ((this.barH ?? 41) - height) / 2;
    const left = this.rootX + this.padding, right = left + this.stripW;
    const x = d.landing ? d.slot.x + d.stripX : Math.max(left, Math.min(d.x - d.grab, right - d.size));
    return h_flex().id(`ghost-${d.n}`).absolute().left(x - this.rootX).top(d.lifted && !d.landing ? rest - 2 : rest).gap(GAP).rounded(9).shadow_md()
      .opacity(d.landing && d.slot.fold ? 0 : d.far ? 0.5 : 1)
      .spring("left", d.landing ? SETTLE : HELD).spring("top", SETTLE).transition("opacity", 140)
      .when(Boolean(d.moving.group), (el) => el.child(this.tray(runs(space.tabs, s.groups).find((r) => r.group === d.moving.group), v)))
      .when(Boolean(d.moving.tabs), (el) => el.children(space.tabs.filter((c) => d.moving.tabs.includes(c.id)).map((c) => this.pill(c, v, null, t.raised))));
  }

  // Command-click (Ctrl elsewhere) picks tabs one by one, Shift-click a range from the shown one.
  click(c, e, v) {
    const { shift, platform, control } = e.modifiers;
    const tabs = v.space.tabs, at = tabs.findIndex((x) => x.active), to = tabs.indexOf(c);
    if (shift) for (const x of tabs.slice(Math.min(at, to), Math.max(at, to) + 1)) this.selected.add(x.id);
    else if (window()?.platform === "macos" ? platform : control) this.selected.delete(c.id) || this.selected.add(c.id);
    else {
      this.selected.clear();
      run("tab.select", { id: c.id });
    }
  }

  pill(c, v, tray, lifted) {
    const { t, space, s } = v;
    const { program, cwd, name } = shows(c, v.ps);
    const color = colorOf(c.id, s, cwd, space.machine);
    const mine = s.colors[c.id] === "none" ? null : s.colors[c.id];
    const tint = hue(mine) ?? tray ?? hue(color), wash = tray ? hue(mine) : tint;
    const picked = v.picked.length > 1 && v.picked.includes(c.id);
    const stop = (_e, cx) => cx.stop_propagation();
    return this.measured(h_flex().id(`tab-${c.id}`), c.id).relative().h(tray ? 27 : 29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
      .border(1).border_color(picked ? t.accent : c.active || lifted ? (tint ? `${tint}99` : t.border) : "#00000000")
      .bg(lifted ?? (c.active ? (wash ? `${wash}40` : t.raised) : wash ? `${wash}24` : tray ? "#00000000" : t.chrome))
      .text_color(c.active || lifted ? t.foreground : t.muted)
      .hover(el => el.bg(tint ? `${tint}38` : t.hover))
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.pressed(e, { tabs: picked ? v.picked : [c.id] }, c.id);
        if (e.click_count === 2) run("tab.rename", { id: c.id });
      })
      .on_mouse_up("left", (e, cx) => this.up(cx, () => this.click(c, e, v)))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.menu({ tabs: picked ? v.picked : [c.id], space: space.id, machine: space.machine, color: tray ? mine : color, cwd });
      })
      .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
      .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
      .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
      .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
  }

  // A group's label: click folds, drag moves the whole group, right-click edits it.
  tag(id, g, tint, count, v) {
    const { t, s } = v;
    const joining = this.drag?.slot.fold && this.drag.slot.group === id;
    return this.measured(h_flex().id(`tag-${id}`), `tag:${id}`).h(27).px(9).flex_none().items_center().rounded(7).text_size(12).font_semibold()
      .border(1).border_color(joining ? t.foreground : tint).bg(tint).text_color(TAG_INK)
      .hover(el => el.opacity(0.88)).tooltip(g.folded ? "Unfold" : "Fold")
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed(e, { group: id }, `before:${id}`); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu({ group: id }); })
      .on_mouse_up("left", (_e, cx) => this.up(cx, () => this.fold(id, s.groups)))
      .child(div().max_w(150).truncate().child(g.name || String(count)));
  }

  // One light for each tab in the fold, a rack's worth of what's going on inside.
  lights(id, hidden, tint, v) {
    const { t, s, ps } = v;
    const more = hidden.length - LIGHTS;
    const joining = this.drag?.slot.fold && this.drag.slot.group === id;
    return this.measured(h_flex().id(`lights-${id}`), `lights:${id}`).h_full().px(6).gap(4).flex_none().items_center().rounded(6).text_size(11).text_color(t.muted)
      .tooltip(hidden.map((c) => shows(c, ps).name).join(", "))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => this.fold(id, s.groups))
      .children(hidden.slice(0, LIGHTS).map((c) => div().size(6).rounded(3).flex_none().bg(c.status === "working" ? t.working : `${hue(s.colors[c.id]) ?? tint}80`)
        .when(c.status === "working", el => el.loop("opacity", { from: 0.3, to: 1, period: 1400 }))))
      .when(more > 0, el => el.child(`+${more}`))
      .when(joining, el => el.child(div().size(6).rounded(3).flex_none().bg(tint)));
  }

  tray({ group: id, tabs }, v) {
    const { t, s } = v;
    const g = s.groups[id], tint = hue(g.color) ?? t.accent;
    const hidden = tabs.filter((c) => this.away.has(c.id));
    const out = tabs.filter((c) => !this.away.has(c.id) && !this.drag?.moving.tabs?.includes(c.id)), inside = `in:${id}`;
    return this.measured(h_flex().id(`group-${id}`), `tray:${id}`).h(35).mx(2).p(3).gap(3).flex_none().items_center().rounded(10)
      .bg(`${tint}14`).border(1).border_color(`${tint}38`)
      .child(this.roomed(this.tag(id, g, tint, tabs.length, v), null, !hidden.length && !out.length ? inside : null))
      .when(hidden.length > 0, el => el.child(this.roomed(this.lights(id, hidden, tint, v), null, !out.length ? inside : null)))
      .children(out.map((c) => this.roomed(this.pill(c, v, tint), c.id, c === out.at(-1) ? inside : null)));
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
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const s = tabState();
    if (space) this.reconcile(space, s);
    const v = { t, s, ps: panes(), space, order: shown.map((c) => c.id), picked: space ? this.picked(space) : [] };
    if (this.drag?.next && same(v.order, this.drag.next)) this.drag = null;
    const d = this.drag;
    const bar = runs(shown, s.groups).filter((r) => !d || (r.group ? r.group !== d.moving.group : !d.moving.tabs?.includes(r.tab.id)));
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    this.padding = lightsPadding;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().id("tabs").relative().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_size_change((size) => { this.barH = size.height / settings().zoom; })
      .on_mouse_move((e, cx) => this.moved(e, v, cx))
      .on_mouse_up("left", (_e, cx) => this.up(cx))
      .on_hover((on) => { if (!on) this.press = null; })
      .on_scroll_wheel((e) => this.wheel(e, v))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar()
        .on_size_change((size) => { this.stripW = size.width / settings().zoom; })
        .children(bar.map((r, i) => this.roomed(r.group ? this.tray(r, v) : this.pill(r.tab, v), r.group ? `before:${r.group}` : r.tab.id, i === bar.length - 1 ? "end" : null))))
      .when(v.picked.length > 1, el => el.child(h_flex().id("group-picked").h(26).px(9).flex_none().items_center().rounded(6)
        .border(1).border_color(t.accent).text_size(12).text_color(t.foreground).hover(s => s.bg(t.hover))
        .on_mouse_down("left", stop).on_click(() => this.group(v.picked)).child(`Group ${v.picked.length} tabs`)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))))
      .when(Boolean(d), el => el.child(this.ghost(v)));
  }
}
