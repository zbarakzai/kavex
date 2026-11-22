import { PathBuilder, View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, props, setShared, settings, terminals, theme, window as appWindow } from "herdr";
import { readSnapshot } from "./collect.js";
import { measure } from "./measure.js";

const INTERVAL = 2000, COLS = 36, ROWS = 8;
const MONO = "Geist Mono";
const CELL = 82;
const PANEL_HEIGHT = 398;
const MIN_WIDTH = 306;
const ICON = "mods/workspace-chrome/icons/activity.svg";
const NONE = "—";
const number = (size) => div().font_family(MONO).text_size(size);
const dim = (t, text) => div().text_size(11).text_color(t.muted).child(text);
const alpha = (color, value) => `${color.slice(0, 7)}${value}`;
const card = (t) => v_flex().w_full().rounded(11).border_1().border_color(t.panel_border ?? t.border).bg(t.panel ?? t.canvas);
const whole = (n) => Number.isFinite(n) ? `${Math.round(n)}%` : NONE;

function bytes(n) {
  if (!Number.isFinite(n)) return NONE;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MiB`;
  if (n > 0) return `${Math.max(1, Math.round(n / 1024))} KiB`;
  return "0 B";
}

function cpuShare(n) {
  if (!Number.isFinite(n)) return NONE;
  if (n > 0 && n < 0.1) return "<0.1%";
  return `${n.toFixed(1)}%`;
}

// Two native paths per chart keep the hundred-dot grid out of the view tree.
function dots(levels) {
  const path = PathBuilder.fill();
  const rx = 26 / COLS, ry = 26 / ROWS;
  const pos = (n) => `${n.toFixed(3)}%`;
  for (let column = 0; column < COLS; column++) {
    const x = (column + 0.5) * 100 / COLS;
    for (let row = 0; row < levels[column]; row++) {
      const y = (ROWS - row - 0.5) * 100 / ROWS;
      path.move_to(pos(x - rx), pos(y))
        .arc_to(pos(rx), pos(ry), 0, false, true, pos(x + rx), pos(y))
        .arc_to(pos(rx), pos(ry), 0, false, true, pos(x - rx), pos(y))
        .close();
    }
  }
  return path.build();
}

const grid = dots(Array(COLS).fill(ROWS));
const paint = (path, color) => window.paint_path(path, color).absolute().inset_0();

function plot(history, metric) {
  const levels = Array(COLS).fill(0);
  const latest = history.at(-1)?.at;
  for (const point of history) {
    const column = COLS - 1 - Math.round((latest - point.at) / INTERVAL);
    const value = point[metric];
    if (column >= 0 && Number.isFinite(value)) levels[column] = Math.ceil(value * ROWS / 100);
  }
  return levels.some(Boolean) ? dots(levels) : null;
}

function metric(t, label, value, detail, color, path) {
  return h_flex().h(65).flex_none().px(13).gap(12).items_center()
    .child(v_flex().w(128).flex_none().gap(2)
      .child(dim(t, label))
      .child(number(18).font_medium().child(whole(value)))
      .child(number(10).text_color(t.muted).child(detail)))
    .child(div().relative().flex_1().min_w(0).h(43)
      .child(paint(grid, t.row_ring ?? t.border))
      .when(path !== null, (el) => el.child(paint(path, color))));
}

function cell(t, value, share, color) {
  return h_flex().relative().w(CELL).h(22).flex_none().overflow_hidden()
    .rounded(5).bg(alpha(color, "19")).items_center().justify_end().px(7)
    .child(number(11).text_color(t.foreground).child(value))
    .when(share > 0, (el) => el.child(div().absolute().bottom(0).left(0).h(2)
      .w(Math.min(CELL, Math.max(2, CELL * share / 100))).bg(color)));
}

function contribution(t, id, name, data, memory, colors, indent = false) {
  return h_flex().id(id).w_full().h(27).flex_none().gap(5).items_center()
    .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(indent ? t.muted : t.foreground)
      .when(indent, (el) => el.pl(12)).child(name))
    .child(cell(t, bytes(data?.memory), data?.memory / memory?.total * 100, colors.memory))
    .child(cell(t, cpuShare(data?.cpu), data?.cpu, colors.cpu));
}

export default class SystemMonitor extends View {
  init(_props, cx) {
    this.source = props()?.from;
    this.history = [];
    this.bindings = new Map();
    this.sample(cx);
    cx.timer.every(INTERVAL, (cx) => this.sample(cx));
  }

  close() {
    this.closed = true;
    if (this.source) setShared("popup.closed", { from: this.source, at: Date.now() });
  }

  sample(cx) {
    if (this.closed) return;
    if (!window.is_window_active()) {
      this.previous = null;
      return;
    }
    const host = appWindow();
    if (!host || this.pending) return;
    this.pending = true;
    cx.spawn(async (cx) => {
      try {
        const snapshot = await readSnapshot(host.platform, exec);
        if (this.closed || !window.is_window_active()) return;
        const at = Date.now();
        const previous = at - this.history.at(-1)?.at < INTERVAL * 3 ? this.previous : null;
        this.current = measure(previous, snapshot, terminals(), this.bindings);
        this.previous = snapshot;
        this.history = this.history.filter((point) => at - point.at <= (COLS - 1) * INTERVAL);
        this.history.push({ at, memory: this.current.memory?.percent, cpu: this.current.cpu });
        this.memoryPlot = plot(this.history, "memory");
        this.cpuPlot = plot(this.history, "cpu");
        this.failed = false;
      } catch {
        if (!this.closed && window.is_window_active()) this.failed = true;
      } finally {
        this.pending = false;
        if (!this.closed && window.is_window_active()) cx.notify();
        else this.previous = null;
      }
    });
  }

  render() {
    const t = theme(), reading = this.current;
    const colors = { memory: t.group_violet ?? t.ansi5, cpu: t.group_blue ?? t.ansi4 };
    const { memory, cpu, cores, desktop, agents, sessions = [] } = reading ?? {};
    let state = reading ? "Live" : "Sampling";
    if (this.failed) state = reading ? "Stale" : "Unavailable";
    const stateColor = this.failed ? t.blocked : reading ? t.done : t.dim;
    const memoryDetail = memory ? `${bytes(memory.used)} / ${bytes(memory.total)}` : NONE;
    const cpuDetail = cores > 0 ? `${cores} logical ${cores === 1 ? "core" : "cores"}` : NONE;
    const knownAgents = sessions.filter((session) => session.memory !== null).length;
    const agentLabel = knownAgents < sessions.length ? `Agents · ${knownAgents}/${sessions.length} measured` : "Agents";
    const column = (label, color) => h_flex().w(CELL).flex_none().gap(5).items_center().justify_end().pr(7)
      .child(div().size(5).rounded(1).bg(color)).child(dim(t, label));

    const panel = v_flex().id("system-monitor").w_full().min_w(MIN_WIDTH).h(PANEL_HEIGHT).flex_none()
      .p(5).gap(6).text_color(t.foreground)
      .child(card(t).flex_none()
        .child(h_flex().h(52).flex_none().px(13).gap(9).items_center().border_b(1).border_color(t.border)
          .child(h_flex().size(29).flex_none().items_center().justify_center().rounded(6)
            .border_1().border_color(t.border).bg(t.tile ?? t.raised).child(svg(ICON).size(17)))
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(div().text_size(14).font_semibold().child("System monitor"))
            .child(dim(t, "This computer")))
          .child(h_flex().h(20).px(6).gap(5).flex_none().items_center().rounded(5).bg(t.raised)
            .child(div().size(4).rounded_full().bg(stateColor))
            .child(number(10).text_color(t.muted).child(state))))
        .child(metric(t, "CPU", cpu, cpuDetail, colors.cpu, this.cpuPlot ?? null))
        .child(metric(t, "Memory", memory?.percent, memoryDetail, colors.memory, this.memoryPlot ?? null))
        .child(h_flex().h(22).pb(5).px(13).gap(12).items_center()
          .child(number(10).w(128).flex_none().text_color(t.muted).child(memory ? `${bytes(memory.available)} available` : NONE))
          .child(h_flex().flex_1().justify_between().text_color(t.dim)
            .child(number(10).child("−70s")).child(number(10).child("Now")))))
      .child(card(t).flex_1().min_h(0)
        .child(h_flex().h(33).px(13).flex_none().items_center().border_b(1).border_color(t.border)
          .child(div().text_size(12.5).font_semibold().child("Local processes")))
        .child(h_flex().h(21).px(13).flex_none().gap(5).items_center()
          .child(div().flex_1()).child(column("Resident", colors.memory)).child(column("CPU", colors.cpu)))
        .child(v_flex().px(13).flex_none()
          .child(contribution(t, "monitor-desktop", "Kavex desktop", desktop, memory, colors))
          .child(contribution(t, "monitor-agents", agentLabel, agents, memory, colors)))
        .child(v_flex().id("monitor-sessions").flex_1().min_h(0).px(13).overflow_y_scrollbar()
          .children(sessions.map((session) => contribution(t, `monitor-${session.address}`, session.name, session, memory, colors, true)))
          .when(Boolean(reading && !sessions.length), (el) => el.child(div().pl(12).child(dim(t, "No local agent sessions")))))
        .child(h_flex().h(21).px(13).flex_none().items_center().border_t(1).border_color(t.border)
          .child(dim(t, "CPU across all cores · Resident memory may overlap"))));

    const viewport = window.viewport_size(), zoom = settings().zoom || 1;
    const height = Math.max(1, (viewport.height - 16) / zoom - 2);
    if (height >= PANEL_HEIGHT && (viewport.width - 16) / zoom >= MIN_WIDTH) return panel;
    return div().id("monitor-scroll").w_full().h(Math.min(PANEL_HEIGHT, height)).overflow_scrollbar().child(panel);
  }
}
