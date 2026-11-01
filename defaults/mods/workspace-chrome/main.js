import { View, div, image, svg } from "gpui-kit";
import { h_flex, HoverCard } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, agents, spaces, openOverlay, settings, nextCommand } from "herdr";
import { allowOpencode, checkUsage, EVERY, nearLimit, POPOVER_HEIGHT, POPOVER_WIDTH, usageOff } from "./checks.js";
import { look, spaced } from "./look.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const LINE = 25; // letters that fit beside Add machine and Settings
const GAUGE_LETTERS = 4;
const PAST_BUTTONS = 72;
const FIRST_CHECK = 5000;
const WATCH = 60_000;

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

const warning = () => nearLimit(shared("usage")?.entries, Date.now());

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 230) : window()?.platform === "macos" ? 76 : 44 });
}

export default class WorkspaceChrome extends View {
  // Usage checks run here and not in the popover, which stops when it closes: one closed midway
  // would leave its check cut off, and keep the next from starting.
  //
  // No footer owns the timer: a copy can go at any moment (a layout switch, a reload), and one left
  // owning it would end the checks, with nothing to tell the others. So each one only looks, and
  // whichever finds a check due first starts it. That's safe with any number of them: mods share
  // one script thread and `checkUsage` marks a pass as started with no wait after looking, so a
  // second footer always sees the mark.
  init(_props, cx) {
    if (!props()?.footer) return;
    cx.timer.after(FIRST_CHECK, (cx) => cx.spawn(() => checkUsage()));
    cx.timer.every(WATCH, (cx) => {
      cx.spawn(() => checkUsage({ within: EVERY }));
      // A limit passing its reset time changes no data, so nothing else would redraw the dot.
      const warned = this.warned;
      this.warned = warning();
      if (this.warned !== warned) cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "check-usage") cx.spawn(() => checkUsage());
        if (command === "refresh-usage") cx.spawn(() => checkUsage({ force: true }));
        if (command === "allow-opencode") cx.spawn(() => allowOpencode());
      }
    });
  }

  button(id, label, action, t) {
    return div().id(id).size(30).flex_none().flex().items_center().justify_center().rounded(8).text_color(t.muted).hover(s => s.bg(t.raised).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  // One line: where this is and how many agents, then Add machine and Settings as icons. Their
  // names show on hover, above the button: there's no room below the window's last line.
  action(id, icon, name, run, k, mark = null) {
    const button = div().id(id).relative().size(22).flex_none().flex().items_center().justify_center().rounded(7).text_color(k.muted).cursor_pointer()
      .hover(s => s.bg(k.hover_strong).text_color(k.foreground)).on_mouse_down("left", (e) => { this.pressed = { at: Date.now(), bounds: e.bounds }; })
      .on_click(run).child(svg(`mods/workspace-chrome/icons/${icon}.svg`).size(16))
      .when(Boolean(mark), el => el.child(div().absolute().top(2).right(2).size(6).rounded_full().bg(mark)));
    return HoverCard.new(`tip-${id}`).anchor("bottom_center").open_delay(300).close_delay(0).trigger(button)
      .content(div().mb(6).px(9).py(5).rounded(8).bg(k.raised).border_1().border_color(k.border).shadow_md().text_size(12).text_color(k.foreground).whitespace_nowrap().child(name));
  }

  // A press outside a popup closes it and still lands here, so a popup shut by this press stays shut
  // (`reopening` in tabs/groups.js). It opens beside the buttons, as over them the next press would
  // miss the gauge; from there the window's edge pushes it up to fit.
  usage() {
    const shut = shared("popup.closed"), { at, bounds } = this.pressed;
    if (shut?.from === "usage" && shut.at >= at - 100) return;
    openOverlay({ mod: "usage", kind: "popup", width: POPOVER_WIDTH, height: POPOVER_HEIGHT, at: { x: bounds.x + PAST_BUTTONS * settings().zoom, y: bounds.y }, props: { from: "usage" } });
  }

  footer(t) {
    const k = look(t), collapsed = narrow();
    this.warned = warning();
    const settings = this.action("settings", "settings", "Settings", () => run("app.settings"), k, updates().app.ready ? k.accent : null);
    if (collapsed) return h_flex().size_full().pb(4).items_center().justify_center().child(settings);
    const list = agents().length, tail = ` · ${list} ${list === 1 ? "AGENT" : "AGENTS"}`;
    const machine = (spaces().find(s => s.active)?.machine ?? "This computer").toUpperCase();
    const usage = !usageOff(), room = LINE - (usage ? GAUGE_LETTERS : 0) - tail.length;
    const name = machine.length > room ? `${machine.slice(0, room - 1)}…` : machine;
    return h_flex().size_full().pl(4).pb(4).items_center()
      .child(h_flex().flex_1().min_w(0).gap(5).items_center().overflow_hidden()
        .child(div().size(6).rounded(3).flex_none().bg(k.added))
        .child(spaced(`${name}${tail}`, 9.5, 0.05).text_color(k.label)))
      .when(usage, el => el.child(this.action("usage", "gauge", "Usage limits", () => this.usage(), k, this.warned ? k.blocked : null)))
      .child(this.action("machine", "machine", "Add machine", () => run("mod.open", { name: "machine-add" }), k))
      .child(settings);
  }
  render() {
    const t = theme();
    if (props()?.footer) return this.footer(t);
    const collapsed = narrow(), mac = window()?.platform === "macos";
    return h_flex().size_full().pl(mac && !collapsed ? 76 : 8).gap(8).items_center()
      .when(!collapsed, el => el.child(image("mods/workspace-chrome/logo.png").size(22).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_size(16).font_medium().text_color(t.foreground).child("Zaki"))
        .child(this.button("search", svg("mods/workspace-chrome/icons/search.svg").size(16), () => run("mod.open", { name: "picker" }), t)))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(collapsed && !mac, el => el.child(this.button("sidebar-toggle", svg("mods/workspace-chrome/icons/sidebar.svg").size(16), toggleSidebar, t)));
  }
}
