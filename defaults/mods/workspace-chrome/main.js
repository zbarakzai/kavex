import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex, HoverCard } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, agents, spaces, openOverlay, closeOverlay, settings, nextCommand } from "herdr";
import { allowOpencode, checkUsage, EVERY, nearLimit, POPOVER_HEIGHT, POPOVER_WIDTH, usageOff } from "./checks.js";
import { look, MONO } from "./look.js";
import { SETTLE_MS, SIDEBAR_MIN, SIDEBAR_RAIL, snapTarget } from "./snap.js";
import { checkSkills, EVERY as SKILLS_EVERY } from "./skills.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const FOOTER_MENU = "workspace-actions";
const MENU_WIDTH = 184, MENU_ROW = 30, MENU_PAD = 4;
const FOOTER_ACTIONS = [
  { id: "usage", label: "Usage limits", icon: "gauge" },
  { id: "machine", label: "Add machine", icon: "machine", mod: "machine-add" },
  { id: "customize", label: "Customize", icon: "layers", mod: "customize" },
];
function hasUsageButton(node) {
  if (!node || node.hidden) return false;
  if (node.content?.mod === "workspace-status" && node.content.props?.usage) return true;
  const children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter((child) => !child.hidden);
    return hasUsageButton(visible.find((child) => child.id === node.active) ?? visible[0]);
  }
  return children.some(hasUsageButton);
}

const menuShowsUsage = () => !usageOff() && !hasUsageButton(layout());
const footerActions = () => menuShowsUsage() ? FOOTER_ACTIONS : FOOTER_ACTIONS.slice(1);
const FIRST_CHECK = 1000;
const WATCH = 30_000;
const FIRST_SKILLS_CHECK = 20_000;

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

const warning = () => nearLimit(shared("usage")?.entries, Date.now());
const skillUpdates = () => Boolean(shared("skills.updates")?.length);

const sidebarPx = () => find(layout(), "sidebar")?.size?.px;
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
    if (props()?.footerMenu) {
      this.menuFocus = cx.focus_handle();
      this.menuFocus.focus();
      this.menuIndex = 0;
      return;
    }
    if (!props()?.footer) return;
    this.wasActive = window()?.active !== false;
    cx.timer.after(FIRST_CHECK, (cx) => {
      if (window()?.active !== false) cx.spawn(() => checkUsage({ activate: true }));
    });
    // Skills follow the same rule: any footer may run a due check (skills.js).
    cx.timer.after(FIRST_SKILLS_CHECK, (cx) => cx.spawn(() => checkSkills({ within: SKILLS_EVERY })));
    cx.timer.every(WATCH, (cx) => {
      if (window()?.active !== false) cx.spawn(() => checkUsage({ within: EVERY }));
      cx.spawn(() => checkSkills({ within: SKILLS_EVERY }));
      // A limit passing its reset time changes no data, so nothing else would redraw the dot.
      const warned = this.warned;
      this.warned = menuShowsUsage() && warning();
      if (this.warned !== warned) cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "check-usage") cx.spawn(() => checkUsage());
        if (command === "refresh-usage") cx.spawn(() => checkUsage({ force: true }));
        if (command === "allow-opencode") cx.spawn(() => allowOpencode());
        if (command === "check-skills") cx.spawn(() => checkSkills({ force: true }));
      }
    });
  }

  close() {
    if (props()?.footerMenu) setShared("popup.closed", { from: FOOTER_MENU, at: Date.now() });
  }

  button(id, label, action, t) {
    return div().id(id).size(30).flex_none().flex().items_center().justify_center().rounded(8).text_color(t.muted).hover(s => s.bg(t.raised).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  action(id, icon, name, click, k, width, mark) {
    const button = div().id(id).relative().w(width).h(width).flex_none().flex().items_center().justify_center().rounded(7)
      .text_color(k.muted).accessibility_label(name).cursor_pointer().hover(s => s.bg(k.hover_strong).text_color(k.foreground))
      .when(id === "footer-more", el => el.on_mouse_down("left", (e) => { this.pressed = { at: Date.now(), bounds: e.bounds }; }))
      .on_click(click).child(svg(`mods/workspace-chrome/icons/${icon}.svg`).size(16))
      .when(Boolean(mark), el => el.child(div().absolute().top(2).right(2).size(6).rounded_full().bg(mark)));
    return HoverCard.new(`tip-${id}`).anchor("bottom_center").open_delay(300).close_delay(0).trigger(button)
      .content(div().mb(6).px(9).py(5).rounded(8).bg(k.raised).border_1().border_color(k.border).shadow_md().text_size(12).text_color(k.foreground).whitespace_nowrap().child(name));
  }

  openActions() {
    const press = this.pressed;
    this.pressed = null;
    const shut = shared("popup.closed");
    // The press that dismissed the popup also reaches the trigger.
    if (press && shut?.from === FOOTER_MENU && shut.at >= press.at - 100) return;
    const height = footerActions().length * MENU_ROW + 2 * (MENU_PAD + 1);
    const zoom = settings().zoom;
    const bounds = press?.bounds;
    const right = bounds && bounds.x + bounds.width;
    openOverlay({
      mod: "workspace-chrome", kind: "popup", width: MENU_WIDTH, height,
      ...(bounds ? { at: { x: right - MENU_WIDTH * zoom, y: bounds.y - (height + 6) * zoom } } : {}),
      props: {
        footerMenu: true,
        ...(bounds ? { usageAt: { x: right + 30 * zoom, y: bounds.y } } : {}),
      },
    });
  }

  chooseAction(action) {
    const { overlay, usageAt } = props();
    closeOverlay(overlay);
    if (action.mod) run("mod.open", { name: action.mod });
    else openOverlay({ mod: "usage", kind: "popup", width: POPOVER_WIDTH, height: POPOVER_HEIGHT,
      ...(usageAt ? { at: usageAt } : {}), props: { from: "usage" } });
  }

  actionsMenu(k) {
    const actions = footerActions(), selected = Math.min(this.menuIndex, actions.length - 1);
    const marks = { usage: warning() ? k.blocked : null, customize: skillUpdates() ? k.accent : null };
    return v_flex().id("footer-actions").w_full().min_h(0).p(MENU_PAD).track_focus(this.menuFocus)
      .accessibility_label("More actions")
      .on_key_down((e, cx) => {
        const index = Math.min(this.menuIndex, actions.length - 1);
        if (e.key === "escape") closeOverlay(props().overlay);
        else if (e.key === "enter") this.chooseAction(actions[index]);
        else if (e.key === "up" || e.key === "down") {
          this.menuIndex = (index + actions.length + (e.key === "up" ? -1 : 1)) % actions.length;
          cx.notify();
        } else return;
        cx.stop_propagation();
      })
      .children(actions.map((action, index) => h_flex().id(`footer-action-${action.id}`).h(MENU_ROW).w_full()
        .px(8).gap(9).items_center().flex_none().rounded(6).cursor_pointer()
        .when(index === selected, (el) => el.bg(k.selected))
        .hover(s => s.bg(k.hover_strong))
        .on_click(() => this.chooseAction(action))
        .child(svg(`mods/workspace-chrome/icons/${action.icon}.svg`).size(16).flex_none().text_color(k.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(k.foreground).child(action.label))
        .when(Boolean(marks[action.id]), el => el.child(div().size(6).flex_none().rounded_full().bg(marks[action.id])))));
  }

  footer(t) {
    const k = look(t), collapsed = narrow();
    this.warned = menuShowsUsage() && warning();
    const settings = this.action("settings", "settings", "Settings", () => run("app.settings"), k, collapsed ? 30 : 24, updates().app.ready ? k.accent : null);
    const bar = h_flex().size_full().pb(4).items_center();
    if (collapsed) return bar.justify_center().child(settings);

    const mark = this.warned ? k.blocked : skillUpdates() ? k.accent : null;
    const more = this.action("footer-more", "more", "More actions", () => this.openActions(), k, 24, mark);
    const list = agents().length, tail = `· ${list} ${list === 1 ? "AGENT" : "AGENTS"}`;
    const machine = (spaces().find(s => s.active)?.machine ?? "This computer").toUpperCase();
    return bar.gap(2).pl(4).child(h_flex().flex_1().min_w(0).items_center()
      .font_family(MONO).text_size(10).text_color(k.label)
      .child(div().size(6).mr(5).rounded(3).flex_none().bg(k.added))
      .child(div().min_w(0).truncate().child(machine))
      .child(div().ml(4).flex_none().whitespace_nowrap().child(tail)))
      .child(more).child(settings);
  }
  // Saved widths or resize commands can still land between the rail and the labeled sidebar.
  settle(cx) {
    const px = sidebarPx();
    if (px === SIDEBAR_RAIL || px >= SIDEBAR_MIN) {
      const collapsed = px === SIDEBAR_RAIL;
      if (Boolean(shared("sidebar.collapsed")) !== collapsed) setShared("sidebar.collapsed", collapsed);
      return;
    }
    if (snapTarget(px) === null || this.settling === px) return;
    this.settling = px;
    cx.timer.after(SETTLE_MS, () => {
      if (this.settling !== px) return;
      this.settling = null;
      const to = sidebarPx() === px ? snapTarget(px) : null;
      if (to === null) return;
      setShared("sidebar.collapsed", to === SIDEBAR_RAIL);
      run("layout.resize", { id: "sidebar", px: to });
    });
  }

  render(cx) {
    const t = theme();
    if (props()?.footerMenu) return this.actionsMenu(look(t));
    if (props()?.footer) {
      const active = window()?.active !== false;
      if (active && this.wasActive === false) cx.spawn(() => checkUsage({ activate: true }));
      this.wasActive = active;
      return this.footer(t);
    }
    this.settle(cx);
    const collapsed = narrow(), mac = window()?.platform === "macos";
    return h_flex().size_full().pl(mac && !collapsed ? 76 : 8).gap(8).items_center()
      .when(!collapsed, el => el.child(image("mods/workspace-chrome/logo.png").size(22).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_size(16).font_medium().text_color(t.foreground).child("Kavex"))
        .child(this.button("search", svg("mods/workspace-chrome/icons/search.svg").size(16), () => run("mod.open", { name: "picker" }), t)));
  }
}
