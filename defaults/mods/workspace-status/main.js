import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, HoverCard } from "gpui-base";
import { agents, closeOverlay, openOverlay, props, run, settings, setShared, shared, spaces, theme, window as appWindow } from "herdr";

const ROSTER_WIDTH = 400;
const ROSTER_HEIGHT = 540;
const SOURCE = "usage-status";
const AWAKE_SOURCE = "keep-awake";
const AWAKE_WIDTH = 264;
const AWAKE_ROW = 42;
const AWAKE_HEADER = 34;
const AWAKE_PAD = 5;
const AWAKE_HEIGHT = AWAKE_HEADER + 3 * AWAKE_ROW + 2 * (AWAKE_PAD + 1);
const AWAKE_MODE = "awake.mode";
const TITLE = "Keep computer awake";
const MODES = [
  { mode: "on", label: "On", detail: "Stay awake whenever Kavex is open" },
  { mode: "auto", label: "Agent", detail: "Stay awake while local agents work" },
  { mode: "off", label: "Off", detail: "Follow your normal sleep settings" },
];
const ICONS = "mods/workspace-chrome/icons";
const CUP = "mods/workspace-status/coffee.svg";

const selectedMode = () => MODES.find(({ mode }) => mode === shared(AWAKE_MODE)) ?? MODES[2];

function activity(mode) {
  const status = appWindow()?.awake;
  return status?.mode === mode && status.active ? "Active" : "Inactive";
}

function lidNote() {
  const platform = appWindow()?.platform;
  if (platform === "macos") return "Closing the Mac's lid still allows sleep.";
  if (platform === "windows") return "Closing the lid follows your Windows power settings.";
  return "Kavex also asks the system to stay awake when the lid closes.";
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    if (!props()?.awakeMenu) return;
    this.menuFocus = cx.focus_handle();
    this.menuFocus.focus();
    this.menuIndex = MODES.indexOf(selectedMode());
  }

  close() {
    if (props()?.awakeMenu) setShared("popup.closed", { from: AWAKE_SOURCE, at: Date.now() });
  }

  openAwake(cx) {
    const press = this.awakePress, closed = shared("popup.closed");
    this.awakePress = null;
    if (press && closed?.from === AWAKE_SOURCE && closed.at >= press.at - 100) return;
    const bounds = press?.bounds, zoom = settings().zoom || 1;
    const viewport = bounds ? null : window.viewport_size();
    const right = bounds ? bounds.x + bounds.width : viewport.width - 15 * zoom;
    const top = bounds ? bounds.y : viewport.height - 30 * zoom;
    this.awakeOpenedAt = Date.now();
    openOverlay({
      mod: "workspace-status", kind: "popup", width: AWAKE_WIDTH, height: AWAKE_HEIGHT,
      at: { x: right - AWAKE_WIDTH * zoom, y: top - (AWAKE_HEIGHT + 6) * zoom },
      props: { awakeMenu: true },
    });
    cx?.notify();
  }

  choose(mode) {
    setShared(AWAKE_MODE, mode);
    closeOverlay(props().overlay);
  }

  awakeMenu(t) {
    const current = selectedMode();
    return v_flex().id("awake-menu").p(AWAKE_PAD).track_focus(this.menuFocus)
      .role("list_box").accessibility_label(TITLE)
      .on_key_down((e, cx) => {
        if (e.key === "enter" || e.key === "space") this.choose(MODES[this.menuIndex].mode);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else if (e.key === "up" || e.key === "down") {
          this.menuIndex = (this.menuIndex + MODES.length + (e.key === "up" ? -1 : 1)) % MODES.length;
          cx.notify();
        } else return;
        cx.stop_propagation();
      })
      .child(h_flex().h(AWAKE_HEADER).px(8).gap(8).items_center().justify_between()
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child(TITLE))
        .child(div().text_size(11).text_color(t.muted).child(activity(current.mode))))
      .children(MODES.map(({ mode, label, detail }, index) => {
        const selected = mode === current.mode;
        return h_flex().id(`awake-${mode}`).h(AWAKE_ROW).px(8).gap(8).rounded(7).items_center().cursor_pointer()
          .role("list_box_option").aria_selected(selected).accessibility_label(`${label}. ${detail}`)
          .when(index === this.menuIndex, (el) => el.bg(t.selected).aria_active_descendant())
          .hover((el) => el.bg(t.hover_strong ?? t.hover))
          .on_click(() => this.choose(mode))
          .child(div().size(14).flex_none()
            .when(selected, (el) => el.child(svg(`${ICONS}/check.svg`).size(14).text_color(t.accent))))
          .child(v_flex().min_w(0).gap(2)
            .child(div().text_size(12).text_color(t.foreground).child(label))
            .child(div().text_size(11).text_color(t.muted).child(detail)));
      }));
  }

  awakeButton(t) {
    const { mode, label } = selectedMode();
    const state = activity(mode);
    const name = `${TITLE}, ${label} · ${state}`;
    const button = h_flex().id("keep-awake").h(24).px(7).gap(5).items_center().flex_none()
      .rounded(7).role("button").accessibility_label(name).tab_index(0).cursor_pointer()
      .hover((el) => el.bg(t.hover_strong ?? t.hover).text_color(t.foreground))
      .on_mouse_down("left", (e) => { this.awakePress = { at: Date.now(), bounds: e.bounds }; })
      .on_click((_e, cx) => this.openAwake(cx))
      .child(svg(CUP).size(15).flex_none().text_color(state === "Active" ? t.foreground : t.muted))
      .child(label)
      .child(div().size(5).rounded_full().bg(state === "Active" ? t.accent : t.dim));
    const closed = shared("popup.closed");
    if (this.awakeOpenedAt && closed?.from === AWAKE_SOURCE && closed.at >= this.awakeOpenedAt) {
      this.awakeOpenedAt = null;
    }
    // An open hover card would overlap the menu's last options.
    if (this.awakeOpenedAt) return button;
    return HoverCard.new("keep-awake-tip").anchor("bottom_center").open_delay(300).close_delay(0)
      .trigger(button)
      .content(v_flex().w(232).mb(6).px(9).py(5).gap(3).rounded(8).bg(t.raised)
        .border_1().border_color(t.border).shadow_md()
        .child(div().text_size(12).text_color(t.foreground).child(name))
        .child(div().text_size(11).text_color(t.muted).child(lidNote())));
  }

  open(machine) {
    const press = this.pressed, closed = shared("popup.closed");
    this.pressed = null;
    if (press && closed?.from === SOURCE && closed.at >= press.at - 100) return;
    const bounds = press?.bounds, zoom = settings().zoom || 1;
    const entries = Object.values(shared("usage")?.entries ?? {});
    // Leave room for the roster above the button, up to the popup's height cap.
    const rowsHeight = entries.filter((row) => row.machine === machine).reduce((height, row) =>
      height + 53 + 23 * Math.ceil(row.limits.length / 3), 0);
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
        .child(`${appWindow()?.platform === "macos" ? "⌘" : "Ctrl"} Shift P  commands`));
  }

  render() {
    const t = theme(), p = props();
    if (p?.awakeMenu) return this.awakeMenu(t);
    const space = spaces().find((space) => space.active);
    if (!p?.usage) return this.legacy(t, space);

    return h_flex().size_full().px(9).gap(3).items_center().justify_end().text_size(11.8).text_color(t.muted)
      .when(shared("usage.enabled") !== false, (el) => el.child(h_flex().id("usage-status").h(24).px(7).gap(6).items_center().flex_none()
        .rounded(7).accessibility_label("Usage limits").cursor_pointer()
        .hover((el) => el.bg(t.hover_strong ?? t.hover).text_color(t.foreground))
        .on_mouse_down("left", (e) => { this.pressed = { at: Date.now(), bounds: e.bounds }; })
        .on_click(() => this.open(space?.machine ?? null))
        .child(svg("mods/workspace-chrome/icons/gauge.svg").size(16).flex_none())
        .child("Usage")))
      .child(this.awakeButton(t));
  }
}
