import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, openOverlay, props, run, settings, shared, spaces, theme, window } from "herdr";

const ROSTER_WIDTH = 400;
const ROSTER_HEIGHT = 540;
const SOURCE = "usage-status";

export default class WorkspaceStatus extends View {
  open(machine) {
    const press = this.pressed, closed = shared("popup.closed");
    this.pressed = null;
    if (press && closed?.from === SOURCE && closed.at >= press.at - 100) return;
    const bounds = press?.bounds, zoom = settings().zoom || 1;
    const entries = Object.values(shared("usage")?.entries ?? {});
    const detailed = shared("usage.presentation")?.mode === "verbose";
    // Leave room for the roster above the button, up to the popup's height cap.
    const rowsHeight = entries.filter((row) => row.machine === machine).reduce((height, row) =>
      height + 53 + (detailed ? 23 * Math.ceil(row.limits.length / 3) : 0), 0);
    const height = Math.min(ROSTER_HEIGHT, 92 + (rowsHeight || 46));
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

  render() {
    const t = theme(), space = spaces().find((space) => space.active);
    if (!props()?.usage) return this.legacy(t, space);
    if (shared("usage.enabled") === false) return div();

    return h_flex().size_full().px(9).items_center().justify_end().text_size(11.8).text_color(t.muted)
      .child(h_flex().id("usage-status").h(24).px(7).gap(6).items_center().flex_none()
        .rounded(7).accessibility_label("Usage limits").cursor_pointer()
        .hover((el) => el.bg(t.hover_strong ?? t.hover).text_color(t.foreground))
        .on_mouse_down("left", (e) => { this.pressed = { at: Date.now(), bounds: e.bounds }; })
        .on_click(() => this.open(space?.machine ?? null))
        .child(svg("mods/workspace-chrome/icons/gauge.svg").size(16).flex_none())
        .child("Usage"));
  }
}
