import { PathBuilder, View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, props, setShared, settings, terminals, theme, window as appWindow } from "herdr";
import { readSnapshot } from "./collect.js";
import { measure } from "./measure.js";
import { look, MONO, soft } from "./look.js";

const INTERVAL = 2000, COLS = 36, ROWS = 8;
const GUTTER = 5, INSET = 14;
const PANEL_HEIGHT = 334, MIN_WIDTH = 306;
const CPU_COLUMN = 70, MEMORY_COLUMN = 90;
const NONE = "—";
const number = (size) => div().font_family(MONO).text_size(size);
const secondary = (k, text) => div().text_size(11).line_height("15px").text_color(k.muted).child(text);
const card = (k) => v_flex().w_full().rounded(10).border_1().border_color(k.card_border).bg(k.card);
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

// A chart draws its guides and readings as paths instead of hundreds of elements.
function dots(rowsByColumn) {
  const path = PathBuilder.fill();
  const rx = 26 / COLS, ry = 26 / ROWS;
  const pos = (n) => `${n.toFixed(3)}%`;
  for (let column = 0; column < COLS; column++) {
    const x = (column + 0.5) * 100 / COLS;
    for (const row of rowsByColumn[column]) {
      const y = (ROWS - row - 0.5) * 100 / ROWS;
      path.move_to(pos(x - rx), pos(y))
        .arc_to(pos(rx), pos(ry), 0, false, true, pos(x + rx), pos(y))
        .arc_to(pos(rx), pos(ry), 0, false, true, pos(x - rx), pos(y))
        .close();
    }
  }
  return path.build();
}

const guides = dots(Array(COLS).fill([0, 3, 7]));
const paint = (path, color) => window.paint_path(path, color).absolute().inset_0();

function plot(history, metric) {
  const columns = Array.from({ length: COLS }, () => []);
  const latest = history.at(-1)?.at;
  for (const point of history) {
    const column = COLS - 1 - Math.round((latest - point.at) / INTERVAL);
    const value = point[metric];
    if (column < 0 || !Number.isFinite(value)) continue;
    // The baseline point distinguishes a measured 0% from an unsampled column.
    const height = Math.max(1, Math.ceil(value * ROWS / 100));
    columns[column] = Array.from({ length: height }, (_, row) => row);
  }
  return columns.some((column) => column.length) ? dots(columns) : null;
}

function metric(k, label, value, details, color, path) {
  return h_flex().flex_none().gap(16).items_center()
    .child(v_flex().w(134).flex_none().gap(2)
      .child(h_flex().items_center().gap(8)
        .child(div().w(48).text_size(12).font_medium().text_color(k.text_secondary).child(label))
        .child(number(21).line_height("25px").font_medium().child(whole(value))))
      .children(details.map((detail) => secondary(k, detail))))
    .child(div().id(`history-${label}`).role("image").relative().flex_1().min_w(0).h(38)
      .accessibility_label(`${label} history for the last 70 seconds`)
      .child(paint(guides, soft(k.label, "2b")))
      .when(path !== null, (el) => el.child(paint(path, color))));
}

const column = (width) => div().w(width).flex_none().text_right();

function contribution(k, id, name, data, indent = false) {
  const color = indent ? k.muted : k.row_name;
  return h_flex().id(id).role("row").w_full().h(26).flex_none().gap(8).items_center()
    .child(div().id("process").role("row_header").flex_1().min_w(0).truncate().text_size(12).text_color(color)
      .when(indent, (el) => el.pl(10)).child(name))
    .child(column(CPU_COLUMN).id("cpu").role("cell").font_family(MONO).text_size(12).text_color(color).child(cpuShare(data?.cpu)))
    .child(column(MEMORY_COLUMN).id("memory").role("cell").font_family(MONO).text_size(12).text_color(color).child(bytes(data?.memory)));
}

function processTable(k, reading, desktop, agents, sessions) {
  const measured = sessions.filter((session) => session.memory !== null).length;
  let agentLabel = sessions.length > 1 ? `Agents (${sessions.length})` : "Agents";
  if (measured < sessions.length) agentLabel = `Agents · ${measured}/${sessions.length} measured`;
  const heading = (width, label, description) => column(width).id(label).role("column_header")
    .text_size(11).text_color(k.muted).accessibility_label(`${label}. ${description}`).tooltip(description).child(label);

  return v_flex().id("monitor-processes").role("table").accessibility_label("Local processes").flex_1().min_h(0)
    .child(h_flex().id("monitor-process-head").role("row").h(35).px(INSET).flex_none().gap(8)
      .items_center().border_t(1).border_color(k.border)
      .child(div().id("process").role("column_header").accessibility_label("Process")
        .flex_1().min_w(0).text_size(13).font_medium().child("Local processes"))
      .child(heading(CPU_COLUMN, "CPU", "Share of all logical cores"))
      .child(heading(MEMORY_COLUMN, "Memory", "Resident memory. Shared pages can appear in multiple rows.")))
    .child(v_flex().px(INSET).flex_none()
      .child(contribution(k, "monitor-desktop", "Kavex desktop", desktop))
      .child(contribution(k, "monitor-agents", agentLabel, agents)))
    .child(v_flex().id("monitor-sessions").flex_1().min_h(0).px(INSET).pb(6).overflow_y_scrollbar()
      .children(sessions.map((session) => contribution(k, `monitor-${session.address}`, session.name, session, true)))
      .when(Boolean(reading && !sessions.length), (el) => el.child(div().pl(10).pt(3).child(secondary(k, "No local agents running")))));
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
    const k = look(theme()), reading = this.current;
    const { memory, cpu, cores, desktop, agents, sessions = [] } = reading ?? {};
    let status = reading ? null : "Sampling…";
    if (this.failed) status = reading ? "Last reading shown" : "Readings unavailable";
    const cpuDetails = cores > 0 ? [`${cores} logical ${cores === 1 ? "core" : "cores"}`] : [];
    const memoryDetails = memory
      ? [`${bytes(memory.used)} / ${bytes(memory.total)} used`, `${bytes(memory.available)} available`]
      : [];
    const panel = v_flex().id("system-monitor").w_full().min_w(MIN_WIDTH).h(PANEL_HEIGHT).flex_none()
      .rounded(13).bg(k.canvas).p(GUTTER).text_color(k.foreground)
      .child(h_flex().h(42).flex_none().px(INSET).gap(8).items_center()
        .child(div().flex_1().min_w(0).text_size(14).font_medium().child("System monitor"))
        .when(Boolean(status), (el) => el.child(div().text_size(11)
          .text_color(this.failed ? k.failed_text : k.muted).child(status))))
      .child(card(k).flex_1().min_h(0)
        .child(h_flex().h(35).flex_none().px(INSET).gap(8).items_center()
          .child(div().id("monitor-host").role("heading").flex_1().min_w(0).text_size(13).font_medium().child("This computer"))
          .child(secondary(k, "Last 70 seconds")))
        .child(v_flex().flex_none().px(INSET).pb(13).gap(12)
          .child(metric(k, "CPU", cpu, cpuDetails, k.groups.blue.text, this.cpuPlot ?? null))
          .child(metric(k, "Memory", memory?.percent, memoryDetails, k.groups.violet.text, this.memoryPlot ?? null)))
        .child(processTable(k, Boolean(reading), desktop, agents, sessions)));

    const viewport = window.viewport_size(), zoom = settings().zoom || 1;
    const height = Math.max(1, (viewport.height - 16) / zoom - 2);
    if (height >= PANEL_HEIGHT && (viewport.width - 16) / zoom >= MIN_WIDTH) return panel;
    return div().id("monitor-scroll").w_full().h(Math.min(PANEL_HEIGHT, height))
      .rounded(13).bg(k.canvas).overflow_scrollbar().child(panel);
  }
}
