// App-owned settings mod. Writes changes immediately; no Save step.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { hc, run, theme, themes, fonts, updates, telemetry, settings, layouts, shared, setShared, appHome, readTextFile, writeTextFile, playSound, props, closeOverlay } from "herdr";
import { look, sectionLabel, MONO } from "./look.js";
import { loader } from "./loader.js";

const I = (name) => `mods/workspace-chrome/icons/${name}.svg`;

const SECTIONS = [
  { id: "look", title: "Look", icon: "look" },
  { id: "machines", title: "Machines", icon: "machine" },
  { id: "alerts", title: "Alerts", icon: "alerts" },
  { id: "updates", title: "Updates", icon: "updates" },
  { id: "privacy", title: "Privacy", icon: "privacy" },
];

const LOOKS = { main: "Kavex", terminals: "Terminals", win98: "Kavex 98" };
const APPEARANCES = [
  [null, "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

// The panels a person can turn off, the same list the welcome offers ("workspace.panels").
const PANELS = [
  ["files", "Files panel", "Browse this space's files beside your terminals."],
  ["changes", "Changes panel", "Review and commit your work beside your terminals."],
];

const CHOICE = 118; // a layout or theme card: five fit a line
const KNOB = { duration: 140, easing: "ease-out" };

// What the app uses when settings.json names no font (settings.rs).
const DEFAULT_FONT = "Geist Mono";
const DEFAULT_UI_FONT = "Geist";

export default class Settings extends View {
  init(_props, cx) {
    const asked = props()?.section;
    this.section = SECTIONS.some((s) => s.id === asked) ? asked : "look";
    this.picking = null; // "font" | "ui_font" while its list is open
    this.filter = "";
    this.fontInput = InputState.new({ placeholder: "Type to search fonts" });
    this.fontInput.on("change", (_e, cx) => { this.filter = this.fontInput.value(); cx.notify(); });
    this.renameInput = InputState.new();
    this.renameInput.on("focus", (_e, cx) => { this.renameFocused = true; cx.notify(); });
    this.renameInput.on("blur", (_e, cx) => { this.renameFocused = false; cx.notify(); });
    this.renameInput.on("change", (_e, cx) => { if (this.machineEdit?.action === "rename") this.machineEdit.name = this.renameInput.value(); cx.notify(); });
    this.renameInput.on("submit", (_e, cx) => {
      const edit = this.machineEdit;
      if (edit?.action === "rename") this.machineAction(edit.machine, "rename", cx, edit.name);
    });
    this.person = {};
    this.raw = null;
    this.previews = {}; // layout name -> its "preview" picture
    this.previewsOf = "";
    this.showData = false;
    this.machineList = null;
    this.machineLoading = false;
    this.machineError = null;
    this.machineBusy = {};
    this.machineResults = {};
    this.machineEdit = null;
    this.machineNotice = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      await this.load();
      if (this.section === "machines") await this.loadMachines();
      cx.notify();
    });
    // After "Check now": follow the look (the answer comes from the app), then
    // "Up to date" for a moment.
    cx.timer.every(300, (cx) => {
      if (!this.asked) return;
      if (updates().checking) this.asked = Date.now();
      else if (Date.now() - this.asked >= 3000) this.asked = null;
      cx.notify();
    });
    cx.timer.every(3000, (cx) => {
      if (this.section !== "machines") return;
      cx.spawn(async (cx) => {
        await this.loadMachines();
        cx.notify();
      });
    });
  }

  file() {
    return `${appHome()}/settings.json`;
  }

  // Each layout file may name a picture of itself (`"preview"` on its root).
  loadPreviews(names, cx) {
    this.previewsOf = names.join("\n");
    cx.spawn(async (cx) => {
      const found = {};
      for (const name of names) {
        try {
          const preview = JSON.parse((await readTextFile(`${appHome()}/layouts/${name}.json`)) ?? "{}").preview;
          if (typeof preview === "string" && preview) found[name] = preview;
        } catch {}
      }
      this.previews = found;
      cx.notify();
    });
  }

  async load() {
    this.raw = await readTextFile(this.file());
    try {
      this.person = this.raw ? JSON.parse(this.raw) : {};
    } catch {
      this.person = {};
    }
  }

  // Changes settings.json the way an agent would: read, change, write back
  // only if nobody changed it meanwhile (else read again and redo).
  change(edit, cx) {
    cx.spawn(async (cx) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.load();
        const next = JSON.parse(JSON.stringify(this.person));
        edit(next);
        try {
          await writeTextFile(this.file(), JSON.stringify(next, null, 2) + "\n", this.raw);
          this.person = next;
          break;
        } catch {}
      }
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  // Pieces ---------------------------------------------------------------

  heading(t, text) {
    return div().px(2).pb(10).child(sectionLabel(t, text.toUpperCase()));
  }

  group(t, title, ...body) {
    return v_flex().w_full().pb(22).child(this.heading(t, title)).children(body.filter(Boolean));
  }

  card(t, ...rows) {
    return v_flex().w_full().px(14).py(3).rounded(14).bg(t.card).border_1().border_color(t.card_border).children(rows.filter(Boolean));
  }

  note(t, text) {
    return div().px(2).pt(10).text_size(12).line_height("17px").text_color(t.label).child(text);
  }

  // One setting: what it is on the left, the control on the right.
  row(t, title, about, control) {
    return h_flex()
      .w_full()
      .min_h(52)
      .gap(16)
      .py(9)
      .items_center()
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(div().text_size(13.5).text_color(t.foreground).child(title))
          .when(Boolean(about), (el) => el.child(div().text_size(12).line_height("17px").text_color(t.label).child(about))),
      )
      .child(div().flex_none().child(control));
  }

  named(t, name, version) {
    return h_flex().gap(7).items_center().child(name).child(div().font_family(MONO).text_size(11).text_color(t.label).child(version ?? ""));
  }

  button(t, id, label, onClick) {
    return h_flex()
      .id(id)
      .h(34)
      .px(14)
      .flex_none()
      .items_center()
      .rounded(999)
      .border_1()
      .border_color(t.pill_ring)
      .bg(t.pill)
      .cursor_pointer()
      .text_size(13)
      .text_color(t.foreground)
      .hover((s) => s.bg(t.hover_strong))
      .on_click(onClick)
      .child(label);
  }

  segments(t, id, options, now, pick) {
    return h_flex()
      .flex_none()
      .p(3)
      .gap(2)
      .items_center()
      .rounded(999)
      .border_1()
      .border_color(t.pill_ring)
      .bg(t.pill)
      .children(
        options.map(([value, label]) =>
          h_flex()
            .id(`${id}-${label}`)
            .h(26)
            .px(12)
            .items_center()
            .rounded(13)
            .text_size(13)
            .cursor_pointer()
            .when(now === value, (el) => el.bg(t.pill_selected).text_color(t.foreground))
            .when(now !== value, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover_strong).text_color(t.foreground)))
            .on_click((_e, cx) => pick(value, cx))
            .child(label),
        ),
      );
  }

  // − value +
  stepper(t, id, value, onMinus, onPlus) {
    const b = (k, f) =>
      h_flex()
        .id(`${id}-${k}`)
        .size(26)
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(13)
        .cursor_pointer()
        .text_color(t.muted)
        .hover((s) => s.bg(t.hover_strong).text_color(t.foreground))
        .on_click(f)
        .child(svg(I(k)).size(16));
    return h_flex()
      .flex_none()
      .p(3)
      .gap(2)
      .items_center()
      .rounded(999)
      .border_1()
      .border_color(t.pill_ring)
      .bg(t.pill)
      .child(b("minus", onMinus))
      .child(h_flex().w(44).justify_center().font_family(MONO).text_size(12).text_color(t.foreground).child(value))
      .child(b("plus", onPlus));
  }

  // Not orange: that color means "you", and a switch being on doesn't.
  toggle(t, id, on, onClick) {
    return div()
      .id(id)
      .relative()
      .w(36)
      .h(20)
      .flex_none()
      .rounded(10)
      .cursor_pointer()
      .bg(on ? t.foreground : t.pill_selected)
      .on_click(onClick)
      .child(div().id(`${id}-knob`).absolute().top(2).left(on ? 18 : 2).size(16).rounded(8).bg(on ? t.surface : t.muted).transition("left", KNOB));
  }

  choice(t, id, on, onClick, picture, label) {
    return v_flex()
      .id(id)
      .w(CHOICE)
      .flex_none()
      .gap(7)
      .p(6)
      .rounded(12)
      .border_1()
      .border_color(on ? t.chip_active_ring : t.card_border)
      .bg(on ? t.row_selected_strong : t.card)
      .cursor_pointer()
      .hover((s) => s.bg(on ? t.row_active_hover : t.hover))
      .on_click(onClick)
      .child(picture)
      .child(
        h_flex()
          .h(16)
          .px(2)
          .gap(5)
          .items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(on ? t.foreground : t.muted).child(label))
          .when(on, (el) => el.child(svg(I("check")).size(16).flex_none().text_color(t.accent))),
      );
  }

  // Look -----------------------------------------------------------------

  // A small drawing of each layout, in the theme's colors (as the welcome draws them).
  preview(t, name) {
    const row = () => div().flex().flex_row();
    const col = () => div().flex().flex_col();
    const term = (bg = t.background, edge = t.border) => div().flex_1().rounded(2).bg(bg).border_1().border_color(edge);
    const line = (w, c = t.dim) => div().h(3).w(w).flex_none().rounded(2).bg(c);
    const lines = (n, c) => col().gap(4).p(5).children([...Array(n)].map((_, i) => line(i % 2 ? 22 : 32, c)));
    const frame = (el) => el.size_full().rounded(8).overflow_hidden().border_1().border_color(t.border).bg(t.surface);
    if (name === "main")
      return frame(row())
        .child(col().w(42).border_r(1).border_color(t.border).child(lines(4)))
        .child(
          col()
            .flex_1()
            .child(row().h(11).gap(2).p(2).border_b(1).border_color(t.border).child(div().w(20).rounded(2).bg(t.accent)).child(div().w(16).rounded(2).bg(t.raised)).child(div().w(16).rounded(2).bg(t.raised)))
            .child(row().flex_1().p(4).gap(3).child(term()).child(term())),
        );
    if (name === "terminals") {
      const card = () => col().flex_1().rounded(4).border_1().border_color("#2c2f34").bg("#17191c").child(row().h(7).px(3).items_center().border_b(1).border_color("#25282c").child(line(14, "#5d6168")));
      return frame(col())
        .bg("#131619")
        .p(4)
        .gap(4)
        .child(row().h(10).gap(3).p(1).rounded(4).bg("#1d1f22").child(div().w(30).rounded(3).bg("#34373c").border_1().border_color("#4a4d53")).child(div().w(30)))
        .child(row().flex_1().gap(4).child(card()).child(card()));
    }
    // A layout of the person's own: a plain frame.
    return frame(col()).child(row().h(11).border_b(1).border_color(t.border)).child(row().flex_1().p(4).child(term()));
  }

  layoutPicker(t, cx) {
    const current = shared("layout") ?? "main";
    // Shipped looks in the welcome's order, then the person's own; new files show up by themselves.
    const shipped = Object.keys(LOOKS);
    const rank = (n) => (shipped.includes(n) ? shipped.indexOf(n) : shipped.length);
    const names = [...layouts()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    if (names.join("\n") !== this.previewsOf) this.loadPreviews(names, cx);
    return h_flex()
      .w_full()
      .flex_wrap()
      .gap(8)
      .children(
        names.map((name) => {
          const pick = (_e, cx) => {
            run("layout.switch", { name });
            cx.notify();
          };
          const picture = div()
            .h(62)
            .w_full()
            .child(this.previews[name] ? image(this.previews[name]).size_full().rounded(8).border_1().border_color(t.border) : this.preview(t, name));
          return this.choice(t, `st-l-${name}`, name === current, pick, picture, LOOKS[name] ?? name);
        }),
      );
  }

  // The same value as the tab bar's switch: each shows what the other sets.
  tabsPicker(t) {
    const now = shared("tabs.placement") === "right" ? "right" : "top";
    return this.segments(t, "st-tabs", [["top", "On top"], ["right", "On the right"]], now, (value) => setShared("tabs.placement", value));
  }

  appearancePicker(t) {
    const pick = (value, cx) =>
      this.change((p) => {
        if (value === null) delete p.appearance;
        else p.appearance = value;
      }, cx);
    return this.segments(t, "st-ap", APPEARANCES, this.person.appearance ?? null, pick);
  }

  // The tab bar's folder button and the panel's header follow this; the tabs mod shuts one left open.
  panels() {
    return shared("workspace.panels") ?? PANELS.map(([id]) => id);
  }

  togglePanel(id) {
    const shown = this.panels(), on = shown.includes(id);
    setShared("workspace.panels", PANELS.map(([p]) => p).filter((p) => (p === id ? !on : shown.includes(p))));
  }

  usageOn() {
    return shared("usage.enabled") !== false;
  }

  // Off leaves nothing behind, so turning it back on asks OpenCode's question again. Clearing "usage"
  // also takes the mark a check running now would need to save (`checkUsage`).
  toggleUsage() {
    const on = this.usageOn();
    setShared("usage.enabled", !on);
    if (on) {
      setShared("usage", null);
      setShared("usage.opencode", null);
      setShared("usage.warned", null);
    }
  }

  themePicker(t, light) {
    const s = settings();
    const current = light ? s.theme_light : s.theme_dark;
    return h_flex()
      .w_full()
      .flex_wrap()
      .gap(8)
      .children(
        // A theme named like a layout (themes/win98.json) is that layout's own.
        themes()
          .filter((x) => Boolean(x.light) === light && (x.name === shared("layout") || !layouts().includes(x.name)))
          .map(({ name, colors: c }) => {
            const dot = (color) => div().w(8).h(8).rounded(4).bg(color);
            const pick = (_e, cx) => {
              run("app.theme", { name });
              cx.notify();
            };
            const picture = v_flex()
              .h(46)
              .w_full()
              .p(7)
              .gap(6)
              .rounded(8)
              .border_1()
              .border_color(t.border)
              .bg(c.background)
              .child(div().h(4).w(44).rounded(2).bg(c.terminal_foreground))
              .child(h_flex().gap(4).child(dot(c.accent)).child(dot(c.ansi1)).child(dot(c.ansi2)).child(dot(c.ansi3)).child(dot(c.ansi5)));
            return this.choice(t, `st-t-${name}`, name === current, pick, picture, name.replace(/-/g, " "));
          }),
      );
  }

  // The font in use, written in itself; a click opens the list.
  fontButton(t, which, family) {
    const open = this.picking === which;
    return h_flex()
      .id(`st-f-${which}`)
      .w(220)
      .h(34)
      .px(12)
      .gap(8)
      .items_center()
      .rounded(11)
      .border_1()
      .border_color(open ? t.row_ring : t.pill_ring)
      .bg(t.well)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.picking = open ? null : which;
        this.filter = "";
        this.fontInput.set_value("");
        if (this.picking) this.fontInput.focus();
        else this.handle.focus();
        cx.notify();
      })
      .child(div().flex_1().min_w(0).truncate().font_family(family).text_size(13).text_color(t.foreground).child(family))
      .child(svg(I("chevron-down")).size(12).flex_none().text_color(t.label));
  }

  fontList(t, which, def) {
    const q = this.filter.toLowerCase();
    const matches = fonts().filter((f) => f.toLowerCase().includes(q)).slice(0, 200);
    const choose = (name, cx) => {
      this.change((p) => {
        if (name === null) delete p[which];
        else p[which] = name;
      }, cx);
      this.picking = null;
      this.handle.focus();
      cx.notify();
    };
    const item = (id, label, family, onClick) =>
      h_flex()
        .id(id)
        .h(30)
        .px(10)
        .items_center()
        .rounded(10)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(onClick)
        .child(div().font_family(family).text_size(13).text_color(t.foreground).child(label));
    return v_flex()
      .w_full()
      .mb(9)
      .rounded(14)
      .border_1()
      .border_color(t.card_border)
      .bg(t.well)
      // Let the child's native scroll run before stopping the page's wheel event.
      .on_scroll_wheel((_e, cx) => cx.stop_propagation())
      .child(div().px(12).pt(7).text_size(13).child(Input.new(this.fontInput).h(28).text_color(t.foreground)))
      .child(
        div()
          .id(`st-fl-${which}`)
          .h(200)
          .p(4)
          .overflow_y_scrollbar()
          .when(!q, (el) => el.child(item(`st-fd-${which}`, `Default (${def})`, def, (_e, cx) => choose(null, cx))))
          .children(matches.map((f, i) => item(`st-fi-${which}-${i}`, f, f, (_e, cx) => choose(f, cx)))),
      );
  }

  look(t, cx) {
    const s = settings();
    const p = this.person;
    const own = (key, composed, def) => (p[key] ?? def) !== composed;
    const size = (key, value, d, cx) => this.change((q) => (q[key] = Math.max(8, Math.min(32, (q[key] ?? value) + d))), cx);
    const fontRow = (which, sizeKey, title, family, def, sizeNow) =>
      v_flex()
        .w_full()
        .child(
          this.row(
            t,
            title,
            own(which, family, def) ? "This layout sets its own; yours shows in the others." : null,
            h_flex()
              .gap(8)
              .items_center()
              .child(this.fontButton(t, which, family))
              // The panels' text follows zoom: they size their rows to it.
              .when(Boolean(sizeKey), (el) => el.child(this.stepper(t, `st-${sizeKey}`, `${Math.round(sizeNow)}`, (_e, cx) => size(sizeKey, sizeNow, -1, cx), (_e, cx) => size(sizeKey, sizeNow, 1, cx)))),
          ),
        )
        .when(this.picking === which, (el) => el.child(this.fontList(t, which, def)));
    const main = shared("layout") === "main";
    const subhead = (text) => div().px(2).pt(16).pb(8).child(sectionLabel(t, text));
    return v_flex()
      .w_full()
      .child(this.group(t, "Layout", this.layoutPicker(t, cx)))
      .when(main, (el) =>
        el.child(
          this.group(
            t,
            "Workspace",
            this.card(
              t,
              this.row(t, "Tabs", "A bar on top, or a column on the right.", this.tabsPicker(t)),
              ...PANELS.map(([id, title, about]) => this.row(t, title, about, this.toggle(t, `st-panel-${id}`, this.panels().includes(id), () => this.togglePanel(id)))),
              this.row(t, "Usage limits", "Your subscriptions' limits in the sidebar, checked every 15 minutes.", this.toggle(t, "st-usage", this.usageOn(), () => this.toggleUsage())),
            ),
          ),
        ),
      )
      .child(
        this.group(
          t,
          "Theme",
          this.card(t, this.row(t, "Appearance", "Light or dark, or as your system is now.", this.appearancePicker(t))),
          this.note(t, "For the layout you're in: each layout keeps its own light and dark theme."),
          subhead("DARK"),
          this.themePicker(t, false),
          subhead("LIGHT"),
          this.themePicker(t, true),
        ),
      )
      .child(
        this.group(
          t,
          "Size and fonts",
          this.card(
            t,
            this.row(
              t,
              "Zoom",
              "Everything: terminals, panels, text.",
              h_flex()
                .gap(8)
                .items_center()
                .child(this.stepper(t, "st-zoom", `${Math.round(s.zoom * 100)}%`, () => run("app.zoom_out"), () => run("app.zoom_in")))
                .child(this.button(t, "st-zoom-reset", "Reset", () => run("app.zoom_reset"))),
            ),
            fontRow("font", "font_size", "Terminal font", s.font_family, DEFAULT_FONT, s.font_size),
            fontRow("ui_font", null, "Interface font", s.ui_font_family, DEFAULT_UI_FONT),
          ),
        ),
      );
  }

  // Machines -------------------------------------------------------------

  async loadMachines() {
    if (this.machineLoading) return;
    this.machineLoading = true;
    try {
      const r = await hc(["machine", "ls", "--json"]);
      if (r.code !== 0) throw new Error(r.stderr || r.stdout || "Couldn't read machines.");
      const list = JSON.parse(r.stdout).machines;
      if (!Array.isArray(list)) throw new Error("Couldn't read machines.");
      this.machineList = list.filter((m) => !m.temporary);
      this.machineError = null;
    } catch (e) {
      this.machineError = String(e);
    } finally {
      this.machineLoading = false;
    }
  }

  machineAction(machine, action, cx, name) {
    if (this.machineBusy[machine]) return;
    if (action === "rename" && (!name?.trim() || name.trim() === machine)) return;
    this.machineBusy[machine] = action;
    delete this.machineResults[machine];
    this.machineEdit = null;
    this.handle.focus();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const args = ["machine", action, machine];
        if (action === "rename") args.push(name.trim());
        const r = await hc(args);
        let payload = null;
        try { payload = JSON.parse(r.stdout || r.stderr); } catch {}
        if (r.code !== 0) throw new Error(payload?.error?.message || (r.stderr || r.stdout || "It didn't work.").trim());
        const message = action === "update"
          ? `Updated ${machine}${payload?.version ? ` to hc ${payload.version}` : ""}; its terminals kept running.`
          : action === "rename" ? `Renamed ${machine} to ${name.trim()}.` : `Removed ${machine}; its terminals keep running there.`;
        if (action === "update") this.machineResults[machine] = { message, ok: true };
        else this.machineNotice = message;
      } catch (e) {
        this.machineResults[machine] = { message: String(e), ok: false };
      } finally {
        delete this.machineBusy[machine];
      }
      await this.loadMachines();
      cx.notify();
    });
  }

  olderCore(remote, local) {
    const parse = (v) => /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(v ?? "");
    const a = parse(remote), b = parse(local);
    if (!a || !b) return false;
    for (let i = 1; i <= 3; i++) {
      if (+a[i] !== +b[i]) return +a[i] < +b[i];
    }
    if (!a[4] || !b[4]) return Boolean(a[4] && !b[4]);
    const x = a[4].split("."), y = b[4].split(".");
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (x[i] === y[i]) continue;
      if (x[i] === undefined || y[i] === undefined) return x[i] === undefined;
      const xn = /^\d+$/.test(x[i]), yn = /^\d+$/.test(y[i]);
      return xn && yn ? +x[i] < +y[i] : xn !== yn ? xn : x[i] < y[i];
    }
    return false;
  }

  machineLine(t, color, name, facts) {
    return h_flex().flex_1().min_w(0).gap(10).items_center()
      .child(div().size(6).flex_none().rounded(3).bg(color))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(13.5).text_color(t.foreground).child(name))
        .child(div().truncate().font_family(MONO).text_size(10.5).text_color(t.label).child(facts)));
  }

  machineRow(t, m, localVersion) {
    const busy = this.machineBusy[m.name];
    const edit = this.machineEdit?.machine === m.name ? this.machineEdit : null;
    const state = String(m.state ?? "unknown").replace(/[_-]/g, " ");
    const color = ["connected", "online"].includes(m.state) ? t.added : ["connecting", "reconnecting"].includes(m.state) ? t.working : t.failed;
    const result = this.machineResults[m.name];
    const controls = h_flex().gap(6).items_center();
    if (busy) controls.child(loader(t.accent)).child(div().text_size(12).text_color(t.muted).child(busy === "update" ? "Updating…" : busy === "rename" ? "Renaming…" : "Removing…"));
    else {
      if (this.olderCore(m.version, localVersion)) controls.child(this.button(t, `st-m-update-${m.name}`, "Update", (_e, cx) => this.machineAction(m.name, "update", cx)));
      for (const [action, label] of [["rename", "Rename"], ["rm", "Remove"]]) {
        controls.child(this.button(t, `st-m-${action}-${m.name}`, label, (_e, cx) => {
          this.machineEdit = { machine: m.name, action, name: m.name };
          if (action === "rename") {
            this.renameInput.set_value(m.name);
            this.renameInput.set_selected_range({ start: 0, end: encodeURIComponent(m.name).replace(/%[0-9A-F]{2}/g, "_").length });
            this.renameFocused = true;
            this.renameInput.focus();
          }
          cx.notify();
        }));
      }
    }
    const row = v_flex().w_full().min_h(52).py(9).gap(8)
      .child(h_flex().gap(10).items_center()
        .child(this.machineLine(t, color, m.name, `${m.target ?? ""} · ${state} · ${m.version ? `hc ${m.version}` : "hc version unknown"}`))
        .child(controls.flex_none()));
    if (busy === "update") row.child(div().text_size(12.5).text_color(t.dim).child("Copying this computer's herdr-core. Its terminals keep running."));
    if (edit && !busy) {
      const cancel = this.button(t, `st-m-cancel-${m.name}`, "Cancel", (_e, cx) => { this.machineEdit = null; this.handle.focus(); cx.notify(); });
      if (edit.action === "rm") row.child(v_flex().gap(8)
        .child(div().text_size(12.5).text_color(t.muted).child(`Remove ${m.name}? Its terminals keep running there.`))
        .child(h_flex().gap(6).child(cancel).child(this.button(t, `st-m-confirm-${m.name}`, "Remove machine", (_e, cx) => this.machineAction(m.name, "rm", cx)))));
      else row.child(v_flex().gap(6)
        .child(div().text_size(12).text_color(t.dim).child("New name (addresses using the old name stop working)"))
        .child(h_flex().gap(6).items_center()
          .child(Input.new(this.renameInput).flex_1().min_w(0).h(34).px(10).rounded(11).border_1().border_color(this.renameFocused ? t.row_ring : t.pill_ring).bg(t.well).text_size(13).text_color(t.foreground))
          .child(cancel).child(this.button(t, `st-m-save-${m.name}`, "Save", (_e, cx) => this.machineAction(m.name, "rename", cx, edit.name)))));
    }
    if (result) row.child(div().text_size(12).text_color(result.ok ? t.added : t.failed).child(result.message));
    return row;
  }

  machines(t) {
    const version = updates().core.version;
    const line = (color, text) => div().px(2).pt(10).text_size(12).line_height("17px").text_color(color).child(text);
    return v_flex().w_full()
      .child(this.group(t, "Machines",
        this.card(t,
          h_flex().w_full().min_h(52).py(9).items_center().child(this.machineLine(t, t.added, "This computer", `connected · ${version ? `hc ${version}` : "hc version unknown"}`)),
          ...(this.machineList ?? []).map((m) => this.machineRow(t, m, version))),
        this.note(t, "Your computers, reached over ssh. Their terminals keep running when you disconnect."),
        this.machineList === null && !this.machineError ? h_flex().px(2).pt(10).gap(8).items_center().child(loader(t.accent)).child(div().text_size(12).text_color(t.label).child("Reading machines…")) : null,
        this.machineList?.length === 0 ? line(t.label, "No other machines yet.") : null,
        this.machineError ? line(t.failed, this.machineError) : null,
        this.machineNotice ? line(t.added, this.machineNotice) : null,
        h_flex().pt(14).child(this.button(t, "st-m-add", "Add a machine", () => run("mod.open", { name: "machine-add" })))));
  }

  // Alerts ---------------------------------------------------------------

  alerts(t) {
    const sounds = this.person.sounds ?? {};
    const on = sounds.enabled !== false;
    const file = (f) => (f ? f.split(/[\\/]/).pop() : "Kavex's sound");
    return this.group(
      t,
      "Sounds",
      this.card(
        t,
        this.row(
          t,
          "Play sounds",
          "When an agent needs you, and when one finishes while you're not looking. A note shows in the corner either way.",
          this.toggle(t, "st-sounds", on, (_e, cx) => this.change((p) => (p.sounds = { ...(p.sounds ?? {}), enabled: !on }), cx)),
        ),
        this.row(t, "An agent needs you", file(sounds.blocked), this.button(t, "st-play-blocked", "Play", () => playSound("blocked"))),
        this.row(t, "An agent finished", file(sounds.done), this.button(t, "st-play-done", "Play", () => playSound("done"))),
      ),
      this.note(t, "Want your own sounds? Ask your agent to set sounds.done and sounds.blocked in settings.json to an MP3."),
    );
  }

  // Updates --------------------------------------------------------------

  updates(t) {
    const u = updates();
    const at = (secs) => {
      const d = new Date(secs * 1000);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    const checked = u.checked ? ` Checked at ${at(u.checked)}.` : "";
    // Pressed: "Checking\u2026" while it looks, then "Up to date" for a moment
    // (a find changes the row instead). One per row: an element shows once.
    const asked = this.asked && Date.now() - this.asked < 3000;
    const check = (id) =>
      !u.checks
        ? null
        : u.checking && this.asked
          ? div().px(12).text_size(13).text_color(t.label).child("Checking\u2026")
          : asked
            ? div().px(12).text_size(13).text_color(t.added).child("\u2713 Up to date")
            : this.button(t, id, "Check now", (_e, cx) => {
                this.asked = Date.now();
                run("app.check_updates");
                cx.notify();
              });
    const primary = (id, label, f) =>
      h_flex().id(id).h(34).px(15).flex_none().items_center().rounded(11).cursor_pointer().bg(t.accent).text_color(t.accent_foreground).text_size(13).font_medium().hover((s) => s.opacity(0.9)).on_click(f).child(label);
    const app = !u.app.updates
      ? ["A build from source: it updates with git, not here.", null]
      : u.app.ready
        ? [`${u.app.ready} is ready. Restart to switch now; it also switches when you quit.`, primary("st-app-update", "Restart to update", () => run("app.update"))]
        : [`Up to date.${checked}`, check("st-check-app")];
    const c = u.core;
    const core = c.managed
      ? [`Managed by ${c.managed}: update it there.`, null]
      : c.updating
        ? ["Updating\u2026 your terminals keep running.", null]
        : c.error
          ? [`The update failed: ${c.error}`, primary("st-core-retry", "Try again", () => run("app.update_core"))]
          : c.ready
            ? [`${c.ready} is ready. Your terminals keep running through it.`, primary("st-core-update", "Update herdr-core", () => run("app.update_core"))]
            : u.checks
              ? [`Up to date.${checked}`, check("st-check-core")]
              : ["Not checked: a build from source looks for no updates.", null];
    return v_flex()
      .w_full()
      .child(this.group(t, "Kavex", this.card(t, this.row(t, this.named(t, "Kavex", u.app.version), app[0], h_flex().gap(8).flex_none().items_center()
        .child(this.button(t, "st-whats-new", "What's new", () => { closeOverlay(props()?.overlay); run("app.whats_new"); }))
        .when(Boolean(app[1]), (el) => el.child(app[1]))))))
      .child(this.group(t, "herdr-core",
        this.card(t, this.row(t, this.named(t, "herdr-core", c.version), core[0], core[1] ?? div())),
        this.note(t, "Kavex looks for both every hour and tells you in the corner. herdr-core runs your terminals, so they keep running through its updates.")));
  }


  // Privacy --------------------------------------------------------------

  // A report as it goes out, one line per line of JSON.
  report(t, id, title, about, report) {
    const lines = JSON.stringify(report, null, 2).split("\n");
    return v_flex()
      .w_full()
      .pt(14)
      .gap(3)
      .child(div().px(2).text_size(13).text_color(t.foreground).child(title))
      .when(Boolean(about), (el) => el.child(div().px(2).text_size(12).text_color(t.label).child(about)))
      .child(
        v_flex()
          .id(id)
          .mt(5)
          .w_full()
          .p(12)
          .rounded(14)
          .border_1()
          .border_color(t.card_border)
          .bg(t.well)
          .children(lines.map((l) => div().font_family(MONO).text_size(11.5).line_height("17px").text_color(t.muted).whitespace_nowrap().child(l || " "))),
      );
  }

  privacy(t) {
    const s = telemetry();
    const on = s ? s.setting : this.person.telemetry !== false;
    const at = (secs) => new Date(secs * 1000).toLocaleString();
    const why = s?.off_because ? `Off for now: ${s.off_because} is set where Kavex started.` : null;
    const body = v_flex()
      .w_full()
      .child(this.heading(t, "Usage data"))
      .child(
        this.card(
          t,
          this.row(
            t,
            "Share anonymous usage data",
            why ?? "Once a day: which agents and features you use, how many spaces and tabs, your system and Kavex's version. Never what's in your terminals, never names of files, folders or projects.",
            this.toggle(t, "st-telemetry", on, (_e, cx) =>
              this.change((p) => {
                if (on) p.telemetry = false;
                else delete p.telemetry;
              }, cx),
            ),
          ),
          this.row(
            t,
            "What we send",
            s && !s.sends ? "Kavex never sends this. It's only shown here." : "Exactly what leaves your computer, word for word.",
            this.button(t, "st-telemetry-show", this.showData ? "Hide" : "Show", (_e, cx) => {
              this.showData = !this.showData;
              cx.notify();
            }),
          ),
        ),
      );
    if (!this.showData) return body;
    if (!s?.enabled) return body.child(this.note(t, "Nothing is collected or sent while it's off."));
    return body
      .children(s.queued.map((r, i) => this.report(t, `st-tq-${i}`, `Waiting to send: ${r.day}`, "Sent as is, soon.", r)))
      .when(Boolean(s.draft), (el) => el.child(this.report(t, "st-td", "Today so far", "A draft: it changes until the day ends (UTC), then goes out once.", s.draft)))
      .when(Boolean(s.last_sent), (el) => el.child(this.report(t, "st-tl", `Last sent: ${s.last_sent.report.day}`, `Sent ${at(s.last_sent.at)}.`, s.last_sent.report)));
  }

  // ----------------------------------------------------------------------

  navRow(t, id, icon, title, on, onClick, mark) {
    return h_flex()
      .id(id)
      .h(34)
      .flex_none()
      .px(10)
      .gap(10)
      .items_center()
      .rounded(10)
      .border_1()
      .border_color(on ? t.chip_active_ring : t.clear)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.row_selected_strong))
      .when(!on, (el) => el.hover((st) => st.bg(t.hover)))
      .on_click(onClick)
      .child(svg(I(icon)).size(16).flex_none().text_color(on ? t.accent : t.label))
      .child(div().flex_1().min_w(0).truncate().text_size(13.5).text_color(on ? t.foreground : t.muted).child(title))
      .when(Boolean(mark), (el) => el.child(div().size(6).flex_none().rounded(3).bg(t.accent)));
  }

  render(cx) {
    const t = look(theme());
    const u = updates();
    const waiting = Boolean(u.app.ready || (u.core.ready && !u.core.managed));
    const nav = v_flex()
      .flex_none()
      .w(190)
      .h_full()
      .px(4)
      .pb(2)
      .gap(2)
      .child(h_flex().h(44).flex_none().px(10).items_center().text_size(15).font_medium().text_color(t.foreground).child("Settings"))
      .children(
        SECTIONS.map((s) =>
          this.navRow(t, `st-s-${s.id}`, s.icon, s.title, s.id === this.section, (_e, cx) => {
            this.section = s.id;
            this.picking = null;
            this.machineEdit = null;
            this.handle.focus();
            if (s.id === "machines") cx.spawn(async (cx) => { await this.loadMachines(); cx.notify(); });
            cx.notify();
          }, s.id === "updates" && waiting),
        ),
      )
      .child(div().flex_1())
      .child(this.navRow(t, "st-feedback", "messages", "Send feedback", false, () => { closeOverlay(props()?.overlay); run("app.feedback"); }));
    return h_flex()
      .id("settings")
      .track_focus(this.handle)
      .w_full()
      .h(620)
      .min_h(0)
      .p(6)
      .gap(6)
      .rounded(13)
      .bg(t.canvas)
      .text_color(t.foreground)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (this.machineEdit) {
          if (k === "escape") this.machineEdit = null;
          else return;
          this.handle.focus();
          cx.stop_propagation();
          cx.notify();
          return;
        }
        if (k === "escape") {
          if (this.picking) this.picking = null;
          else return this.close();
          this.handle.focus();
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(nav)
      .child(
        div()
          .flex_1()
          .min_w(0)
          .h_full()
          .rounded(14)
          .overflow_hidden()
          .bg(t.panel)
          .border_1()
          .border_color(t.panel_border)
          .child(
            div()
              .id("st-body")
              .size_full()
              .overflow_y_scrollbar()
              .child(
                div()
                  .px(22)
                  .pt(20)
                  .pb(8)
                  .child(
                    this.section === "look"
                      ? this.look(t, cx)
                      : this.section === "machines"
                        ? this.machines(t)
                      : this.section === "alerts"
                        ? this.alerts(t)
                        : this.section === "privacy"
                          ? this.privacy(t)
                          : this.updates(t),
                  ),
              ),
          ),
      );
  }
}
