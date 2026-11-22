import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, HoverCard } from "gpui-base";
import { agents, closeOverlay, openOverlay, props, run, settings, setShared, shared, spaces, theme, window as appWindow } from "herdr";

const ROSTER_WIDTH = 400;
const ROSTER_HEIGHT = 540;
const SOURCE = "usage-status";
const MONITOR = "system-monitor-status";
const MONITOR_WIDTH = 442;
const MONITOR_HEIGHT = 336;
const AWAKE_SOURCE = "keep-awake";
const AWAKE_WIDTH = 264;
const AWAKE_ROW = 44;
const AWAKE_HEADER = 38;
const AWAKE_PAD = 8;
const AWAKE_INSET = 10;
const ROW_GAP = 4;
const DIVIDER_SPACE = 5;
const STATUS_HEIGHT = 24;
const STATUS_ICON = 16;
const CLEAR = "#00000000";
const AWAKE_MODE = "awake.mode";
const TITLE = "Keep computer awake";
const MODES = [
  { mode: "on", label: "On", detail: "While Kavex is open" },
  { mode: "auto", label: "Agent", detail: "While local agents work" },
  { mode: "off", label: "Off", detail: "Use system sleep settings" },
];
const AWAKE_HEIGHT = AWAKE_HEADER + DIVIDER_SPACE + MODES.length * AWAKE_ROW
  + (MODES.length - 1) * ROW_GAP + 2 * (AWAKE_PAD + 1);
const ICONS = "mods/workspace-chrome/icons";
const CUP = "mods/workspace-status/coffee.svg";

const selectedMode = () => MODES.find(({ mode }) => mode === shared(AWAKE_MODE)) ?? MODES[2];

function isActive(mode) {
  const status = appWindow()?.awake;
  return status?.mode === mode && status.active === true;
}

const activityLabel = (active) => active ? "Active" : "Inactive";
const activityDot = (t, active) => div().size(6).flex_none().rounded_full().bg(active ? (t.added ?? t.accent) : t.dim);

const footerButton = (id, label, t) => h_flex().id(id).h(STATUS_HEIGHT).px(7).gap(6).items_center().flex_none()
  .rounded(7).role("button").accessibility_label(label).cursor_pointer()
  .hover((el) => el.bg(t.hover_strong ?? t.hover).text_color(t.foreground));

function lidNote() {
  const platform = appWindow()?.platform;
  if (platform === "macos") return "Closing the Mac's lid still allows sleep.";
  if (platform === "windows") return "Closing the lid follows your Windows power settings.";
  return "Kavex also asks the system to stay awake when the lid closes.";
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    const config = props();
    if (config?.monitor) this.monitorFocus = cx.focus_handle();
    if (!config?.awakeMenu) return;
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

  pointAt(index, inside, cx) {
    if (inside) {
      this.pointedIndex = index;
      this.navigatedByKey = false;
    } else if (this.pointedIndex === index) {
      this.pointedIndex = null;
      this.menuIndex = MODES.indexOf(selectedMode());
    } else return;
    cx.notify();
  }

  awakeMenu(t) {
    const current = selectedMode();
    const active = isActive(current.mode);
    const highlighted = this.pointedIndex ?? this.menuIndex;
    const pointerFill = `${t.foreground.slice(0, 7)}24`;
    return v_flex().id("awake-menu").w_full().p(AWAKE_PAD).track_focus(this.menuFocus)
      .role("list_box").accessibility_label(TITLE)
      .on_key_down((e, cx) => {
        const index = this.pointedIndex ?? this.menuIndex;
        if (e.key === "enter" || e.key === "space") this.choose(MODES[index].mode);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else if (e.key === "up" || e.key === "down") {
          this.navigatedByKey = true;
          this.pointedIndex = null;
          this.menuIndex = (index + MODES.length + (e.key === "up" ? -1 : 1)) % MODES.length;
          cx.notify();
        } else return;
        cx.stop_propagation();
      })
      .child(h_flex().h(AWAKE_HEADER).px(AWAKE_INSET).gap(12).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_medium().text_color(t.foreground).child(TITLE))
        .child(h_flex().gap(5).flex_none().items_center().text_size(11.5).text_color(t.muted)
          .child(activityDot(t, active)).child(activityLabel(active))))
      .child(div().h(1).mb(DIVIDER_SPACE - 1).mx(AWAKE_INSET).flex_none().bg(t.row_ring ?? t.border))
      .child(v_flex().id("awake-options").gap(ROW_GAP).children(MODES.map(({ mode, label, detail }, index) => {
        const selected = mode === current.mode;
        const pointed = index === this.pointedIndex;
        const focused = index === highlighted && this.navigatedByKey;
        // The check stays on the saved mode. Only one row gets a highlight as input moves.
        const fill = pointed ? pointerFill : selected && this.pointedIndex == null && !this.navigatedByKey ? t.selected : null;
        return h_flex().id(`awake-${mode}`).h(AWAKE_ROW).px(AWAKE_INSET - 1).gap(12).items_center()
          .rounded(8).border_1().border_color(focused ? t.accent : CLEAR).cursor_pointer()
          .role("list_box_option").aria_selected(selected).accessibility_label(`${label}. ${detail}`)
          .when(Boolean(fill), (el) => el.bg(fill))
          .when(index === highlighted, (el) => el.aria_active_descendant())
          .on_hover((inside, cx) => this.pointAt(index, inside, cx))
          .on_click(() => this.choose(mode))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().text_size(13.5).line_height("16px").font_medium().text_color(t.foreground).child(label))
            .child(div().truncate().text_size(12).line_height("16px").text_color(t.muted).child(detail)))
          .when(selected, (el) => el.child(svg(`${ICONS}/check.svg`).size(14).flex_none().text_color(t.accent)));
      })));
  }

  awakeButton(t) {
    const { mode, label } = selectedMode();
    const active = isActive(mode);
    const name = `${TITLE}, ${label} · ${activityLabel(active)}`;
    const button = footerButton("keep-awake", name, t).w(84).px(6).justify_center()
      .border_1().border_color(CLEAR).tab_index(0)
      .text_color(active ? t.foreground : t.muted)
      .focus((el) => el.border_color(t.accent).text_color(t.foreground))
      .on_mouse_down("left", (e) => { this.awakePress = { at: Date.now(), bounds: e.bounds }; })
      .on_click((_e, cx) => this.openAwake(cx))
      .child(svg(CUP).size(STATUS_ICON).flex_none())
      .child(div().min_w(0).max_w(36).truncate().child(label))
      .child(activityDot(t, active));
    const closed = shared("popup.closed");
    if (this.awakeOpenedAt && closed?.from === AWAKE_SOURCE && closed.at >= this.awakeOpenedAt) {
      this.awakeOpenedAt = null;
    }
    // An open hover card would overlap the menu's last options.
    if (this.awakeOpenedAt) return button;
    return HoverCard.new("kavex-chrome-tooltip-keep-awake").anchor("bottom_center").open_delay(300).close_delay(0)
      .trigger(button)
      .content(v_flex().role("tooltip").w(236).mb(6).px(10).py(7).gap(3).rounded(6).bg(t.canvas)
        .border_1().border_color(t.input)
        .child(div().text_size(12).font_medium().text_color(t.foreground).child(TITLE))
        .child(div().text_size(11.5).line_height("15px").text_color(t.muted).child(lidNote())));
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

  openMonitor() {
    const press = this.monitorPressed, closed = shared("popup.closed");
    this.monitorPressed = null;
    if (press && closed?.from === MONITOR && closed.at >= press.at - 100) return;
    const bounds = press?.bounds, zoom = settings().zoom || 1;
    const viewport = globalThis.window?.viewport_size();
    const width = viewport?.width > 16 ? Math.min(MONITOR_WIDTH, (viewport.width - 16) / zoom) : MONITOR_WIDTH;
    const height = viewport?.height > 16 ? Math.min(MONITOR_HEIGHT, (viewport.height - 16) / zoom) : MONITOR_HEIGHT;
    const at = bounds
      ? { x: bounds.x + bounds.width - width * zoom, y: bounds.y - height * zoom - 8 }
      : viewport && { x: viewport.width - width * zoom - 12, y: viewport.height - (height + 24) * zoom - 14 };
    openOverlay({
      mod: "system-monitor", kind: "popup", width, height,
      ...(at ? { at } : {}),
      props: { from: MONITOR },
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
    const t = theme(), config = props();
    if (config?.awakeMenu) return this.awakeMenu(t);
    const space = spaces().find((space) => space.active);
    if (!config?.usage && !config?.monitor) return this.legacy(t, space);

    return h_flex().size_full().px(9).gap(4).items_center().justify_end().text_size(11.8).text_color(t.muted)
      .when(config.monitor, (el) => el.child(footerButton(MONITOR, "System monitor", t).tooltip("System monitor")
        .when(Boolean(this.monitorFocus), (el) => el.track_focus(this.monitorFocus).tab_stop(true)
          .border_1().border_color(`${t.surface.slice(0, 7)}00`).focus((el) => el.border_color(t.accent)))
        .on_key_down((event, cx) => {
          if (event.key !== "enter" && event.key !== "space") return;
          cx.stop_propagation();
          this.openMonitor();
        })
        .on_mouse_down("left", (e) => { this.monitorPressed = { at: Date.now(), bounds: e.bounds }; })
        .on_click(() => this.openMonitor())
        .child(svg(`${ICONS}/heroicons/cpu-chip.svg`).size(STATUS_ICON).flex_none())))
      .when(config.usage && shared("usage.enabled") !== false, (el) => el.child(footerButton(SOURCE, "Usage limits", t)
        .on_mouse_down("left", (e) => { this.pressed = { at: Date.now(), bounds: e.bounds }; })
        .on_click(() => this.open(space?.machine ?? null))
        .child(svg(`${ICONS}/gauge.svg`).size(STATUS_ICON).flex_none())
        .child("Usage")))
      .when(config.usage, (el) => el.child(this.awakeButton(t)));
  }
}
