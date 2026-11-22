import { View, div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, openOverlay, props, run, settings, shared, spaces, theme, window } from "herdr";

const GAP = 9;
const ROSTER_WIDTH = 440;
const ROSTER_HEIGHT = 540;
const SOURCE = "usage-status";
const STALE_MS = 30 * 60_000;

function reading(row, now) {
  const retention = row.kind === "rate-limited" || (row.agent === "claude" && row.kind === "stale-token") ? 24 * 60 * 60_000 : STALE_MS;
  if (row.failed && now - row.checkedAt >= retention) return null;
  const current = row.limits.filter((limit) => !limit.resetsAt || limit.resetsAt > now);
  const primary = current.filter((limit) => !limit.scoped);
  return (primary.length ? primary : current).reduce((highest, limit) =>
    !highest || limit.used > highest.used ? limit : highest, null);
}

function resetLabel(resetsAt, now) {
  const mins = Math.ceil((resetsAt - now) / 60_000);
  if (!resetsAt || mins <= 0) return "";
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d ${Math.floor(mins % 1440 / 60)}h`;
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${mins}m`;
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    if (props()?.usage) cx.timer.every(30_000, (cx) => cx.notify());
  }

  open(machine, height) {
    const press = this.pressed, closed = shared("popup.closed");
    this.pressed = null;
    if (press && closed?.from === SOURCE && closed.at >= press.at - 100) return;
    const bounds = press?.bounds, zoom = settings().zoom || 1;
    openOverlay({
      mod: "usage",
      kind: "popup",
      width: ROSTER_WIDTH,
      height: ROSTER_HEIGHT,
      ...(bounds ? { at: { x: bounds.x + bounds.width - ROSTER_WIDTH * zoom, y: bounds.y - (height + 8) * zoom } } : {}),
      props: { from: SOURCE, machine },
    });
  }

  meter(theme, used) {
    return div().w(28).h(5).flex_none().rounded_full().bg(theme.border)
      .child(div().h_full().w(28 * used / 100).rounded_full().bg(theme.muted));
  }

  legacy(t, space) {
    const list = agents(), needs = list.filter((agent) => agent.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center()
      .child(svg(`mods/workspace-chrome/icons/${icon}.svg`).size(16)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label("machine", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette"))
        .child(`${window()?.platform === "macos" ? "⌘" : "Ctrl"} Shift P  commands`));
  }

  render(cx) {
    const t = theme(), space = spaces().find((space) => space.active);
    if (!props()?.usage) return this.legacy(t, space);
    const machine = space?.machine ?? null;
    const now = Date.now(), data = shared("usage"), pref = shared("usage.presentation");
    const detailed = pref?.mode === "verbose", remaining = pref?.display === "remaining";
    const rows = Object.values(data?.entries ?? {}).filter((row) => row.machine === machine);
    const rowHeight = rows.reduce((height, row) =>
      height + 40 + (detailed && row.limits.length ? 24 * Math.ceil(row.limits.length / 5) : 0), 0);
    const popupHeight = Math.min(ROSTER_HEIGHT, 151 + (rowHeight || 34));
    const meters = rows.map((row) => ({ row, limit: reading(row, now) })).filter(({ limit }) => limit)
      .sort((a, b) => b.limit.used - a.limit.used);
    const room = this.width ?? 550;
    const showTime = room >= 415;
    const estimateWidth = detailed ? 87 : showTime ? 81 : 54;
    const count = Math.max(0, Math.floor((room - 184) / estimateWidth));
    const hidden = Math.max(0, meters.length - count);
    const strip = h_flex().id("usage-status").h_full().gap(GAP).items_center()
      .accessibility_label("Usage · all agents").cursor_pointer().px(6)
      .on_mouse_down("left", (e) => { this.pressed = { at: Date.now(), bounds: e.bounds }; })
      .on_click(() => this.open(machine, popupHeight));

    if (!meters.length || !count) {
      strip.child(svg("mods/workspace-chrome/icons/gauge.svg").size(16).text_color(t.muted))
        .child(div().whitespace_nowrap().child("Usage"));
    } else {
      strip.child(div().text_size(10).whitespace_nowrap().child(remaining ? "Left" : "Used"));
      for (const { row, limit } of meters.slice(0, count)) {
        const used = Math.min(100, Math.max(0, Math.round(limit.used)));
        const value = remaining ? 100 - used : used;
        const time = showTime ? resetLabel(limit.resetsAt, now) : "";
        strip.child(h_flex().id(`usage-status-${row.agent}`).flex_none().gap(5).items_center()
          .accessibility_label(`${row.name} ${value}% ${remaining ? "left" : "used"}${row.failed ? ", cached" : ""}`)
          .when(Boolean(row.icon), (el) => el.child(row.tint === false
            ? image(row.icon).size(13).flex_none()
            : svg(row.icon).size(13).flex_none().text_color(t.foreground)))
          .when(detailed, (el) => el.child(this.meter(t, value)))
          .child(div().font_family("Geist Mono").text_size(11).text_color(t.foreground).child(`${value}%${row.failed ? "*" : ""}`))
          .when(Boolean(time && !detailed), (el) => el.child(div().child(time))));
      }
    }
    if (hidden) strip.child(div().flex_none().child(`+${hidden}`));
    return h_flex().size_full().px(9).gap(8).items_center().bg(t.chrome)
      .border_t(1).border_color(t.border).text_size(11).text_color(t.muted)
      .on_size_change((size, cx) => {
        const width = Math.round(size.width / (settings().zoom || 1));
        if (this.width !== width) { this.width = width; cx.notify(); }
      })
      .child(div().min_w(0).truncate().child(machine ?? "This computer"))
      .when(room > 260, (el) => el.child(div().flex_none().child(`· ${agents().length} agents`)))
      .child(div().flex_1())
      .when(shared("usage.enabled") !== false, (el) => el.child(strip));
  }
}
