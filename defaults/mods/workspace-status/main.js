import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, openOverlay, props, run, settings, shared, spaces, theme, window } from "herdr";

const ROSTER_WIDTH = 400;
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
    // The popup fits its contents. Leave room above the button for the roster up to its cap.
    const rowHeight = rows.reduce((height, row) =>
      height + 53 + (detailed ? 23 * Math.ceil(row.limits.length / 3) : 0), 0);
    const popupHeight = Math.min(ROSTER_HEIGHT, 92 + (rowHeight || 46));
    const highest = rows.map((row) => ({ row, limit: reading(row, now) })).filter(({ limit }) => limit)
      .sort((a, b) => b.limit.used - a.limit.used)[0];
    const used = highest && Math.min(100, Math.max(0, Math.round(highest.limit.used)));
    const value = highest && (remaining ? 100 - used : used);
    const label = highest ? `Usage, ${highest.row.name} ${value}% ${remaining ? "left" : "used"}${highest.row.failed ? ", cached" : ""}` : "Usage limits";
    const color = used >= 90 ? t.blocked : t.muted;
    const strip = h_flex().id("usage-status").h(21).gap(6).items_center().flex_none().px(7)
      .rounded(6).accessibility_label(label).cursor_pointer()
      .hover((el) => el.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (e) => { this.pressed = { at: Date.now(), bounds: e.bounds }; })
      .on_click(() => this.open(machine, popupHeight))
      .child(svg("mods/workspace-chrome/icons/gauge.svg").size(16).text_color(color))
      .child(div().whitespace_nowrap().child("Usage"))
      .when(Boolean(highest), (el) => el.child(div().font_family("Geist Mono").text_size(11)
        .text_color(used >= 90 ? t.blocked : t.foreground).child(`${value}%${highest.row.failed ? "*" : ""}`)));

    return h_flex().size_full().px(9).gap(8).items_center().bg(t.chrome)
      .border_t(1).border_color(t.border).text_size(11).text_color(t.muted)
      .on_size_change((size, cx) => {
        const width = Math.round(size.width / (settings().zoom || 1));
        if (this.width !== width) { this.width = width; cx.notify(); }
      })
      .child(div().min_w(0).truncate().child(machine ?? "This computer"))
      .when((this.width ?? 550) > 260, (el) => el.child(div().flex_none().child(`· ${agents().length} agents`)))
      .child(div().flex_1())
      .when(shared("usage.enabled") !== false, (el) => el.child(strip));
  }
}
