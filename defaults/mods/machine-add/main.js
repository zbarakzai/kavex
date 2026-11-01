// Add a machine: the hosts in ~/.ssh/config to pick from (or type one),
// each added with one click (`hc machine add`). When the machine needs
// something first (herdr-core installed there, a password, a new host
// key), the same command opens in a small terminal window where you answer
// it; the list sees the machine once it's added. Opened as a dialog
// (`mod.open machine-add`); the sidebars' Add machine and the welcome
// open it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { hc, exec, home, readTextFile, theme, props, closeOverlay, openOverlay } from "herdr";
import { loader } from "./loader.js";
import { look, MONO, spaced } from "./look.js";

const I = (name) => `mods/workspace-chrome/icons/${name}.svg`;

const GUTTER = 5;
const EDGE = GUTTER + 14;
const FOOTER = 42;
const ROW = 40;
const MOST = 280;

const caption = (text) => spaced(text.toUpperCase(), 9.5, 0.05);

const card = (k) => v_flex().flex_none().rounded(10).bg(k.card).border_1().border_color(k.card_border);

const tag = (status, label) => h_flex().h(17).px(6).flex_none().items_center().rounded(5).bg(status.bg).text_color(status.fg).font_medium().child(spaced(label.toUpperCase(), 9, 0.08));

const hint = (k, keys, label) => h_flex().flex_none().gap(6).items_center()
  .child(h_flex().h(18).px(5).flex_none().items_center().rounded(5).border_1().border_color(k.pill_ring).text_color(k.muted).child(caption(keys)))
  .child(caption(label).text_color(k.text_faint));

// Host entries people can pick: named ones, not patterns.
function parseConfig(text) {
  const hosts = [];
  let cur = null;
  for (const raw of (text ?? "").split("\n")) {
    const m = raw.trim().match(/^([^\s#=]+)\s*=?\s*(.*)$/);
    if (!m) continue;
    const [key, value] = [m[1].toLowerCase(), m[2].trim()];
    if (key === "host" || key === "match") {
      const names = key === "host" ? value.split(/\s+/).filter((h) => h && !/[*?!]/.test(h)) : [];
      cur = names.length ? { alias: names[0], aliases: names.slice(1), hostname: null, user: null } : null;
      if (cur) hosts.push(cur);
    } else if (cur && key === "hostname") cur.hostname = value;
    else if (cur && key === "user") cur.user = value;
  }
  return hosts;
}

export default class MachineAdd extends View {
  init(_props, cx) {
    this.hosts = null;
    this.added = [];
    this.state = {}; // target -> "adding" | "terminal" | error text
    this.typed = "";
    this.input = InputState.new({ placeholder: "user@host" });
    this.input.on("change", (_e, cx) => { this.typed = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.add(this.typed, cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    if (props()?.part !== "bar") {
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
    }
    this.macs = {}; // target -> { name, core } for an added Mac
    this.opened = {};
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      this.hosts = parseConfig(await readTextFile(`${home()}/.ssh/config`).catch(() => null));
      await this.refresh();
      cx.notify();
    });
    // While a terminal finishes an add, the list catches up.
    cx.timer.every(3000, (cx) => {
      if (!Object.values(this.state).includes("terminal")) return;
      cx.spawn(async (cx) => {
        await this.refresh();
        cx.notify();
      });
    });
  }

  async refresh() {
    const r = await hc(["machine", "ls", "--json"]).catch(() => null);
    try {
      this.added = r?.code === 0 ? (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary) : [];
    } catch {
      this.added = [];
    }
    for (const m of this.added) {
      if (this.state[m.target] !== "terminal") continue;
      delete this.state[m.target];
      await this.checkMac(m.target);
    }
  }

  isAdded(target) {
    return this.added.some((m) => m.target === target || m.name === target || m.host === target);
  }

  add(target, cx) {
    target = target.trim();
    if (!target || this.state[target] === "adding") return;
    this.state[target] = "adding";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(["machine", "add", target, "--json"]).catch((e) => ({ code: 1, stderr: String(e), stdout: "" }));
      let why = null;
      try {
        why = r.code === 0 ? null : (JSON.parse(r.stdout || r.stderr).error ?? { message: (r.stderr || r.stdout).trim() });
      } catch {
        why = { message: (r.stderr || r.stdout || "it didn't answer").trim() };
      }
      if (!why) {
        delete this.state[target];
        this.input.set_value("");
        this.typed = "";
        await this.refresh();
        await this.checkMac(target);
      } else if (["hc_missing", "incompatible", "login_needed", "auth_failed", "host_key"].includes(why.kind) || /password|passphrase|host key|permission denied|login/i.test(why.message ?? "")) {
        this.state[target] = "terminal";
        await this.inTerminal(target);
      } else this.state[target] = why.message || "it didn't work";
      await this.refresh();
      cx.notify();
    });
  }

  // macOS asks on its own screen before anything reads Desktop, Documents
  // or Downloads, and the asking program waits: say so once, with the way
  // to allow it for good.
  async checkMac(target) {
    const m = this.added.find((x) => x.target === target || x.name === target);
    if (!m) return;
    const r = await exec("sh", ["-c", 'uname; command -v herdr-core || echo "$HOME/.local/bin/herdr-core"'], { on: m.name }).catch(() => null);
    const [os, core] = (r?.stdout ?? "").trim().split("\n");
    if (os === "Darwin") this.macs[target] = { name: m.name, core: core ?? "~/.local/bin/herdr-core" };
  }

  macCard(k, target) {
    const mac = this.macs[target];
    return v_flex().mx(4).mb(4).p(12).gap(8).rounded(8).bg(k.status.blocked.bg)
      .child(div().text_size(12.5).font_medium().text_color(k.foreground).child(`${mac.name} is a Mac: allow its folders once`))
      .child(div().text_size(12.5).line_height("18px").text_color(k.text_secondary)
        .child("macOS asks on the Mac's own screen before an agent reads Desktop, Documents or Downloads, and waits until someone answers. Give herdr-core Full Disk Access there and it never asks again:"))
      .child(div().px(8).py(4).rounded(6).bg(k.well).border_1().border_color(k.card_border).font_family(MONO).text_size(11.5).text_color(k.foreground).child(mac.core))
      .child(h_flex().gap(8).items_center()
        .child(h_flex().id(`ma-mac-${target}`).h(28).px(12).flex_none().items_center().rounded_full().bg(k.solid).text_color(k.solid_foreground).text_size(12).font_medium().cursor_pointer()
          .hover((s) => s.opacity(0.88))
          .on_click((_e, cx) => {
            exec("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"], { on: mac.name }).catch(() => null);
            this.opened[target] = true;
            cx.notify();
          })
          .child(`Open the setting on ${mac.name}`))
        .when(Boolean(this.opened[target]), (el) => el.child(div().text_size(12).text_color(k.text_faint).child("It's open on the Mac's screen."))));
  }

  // The same add in a terminal, for what only the person can answer.
  async inTerminal(target) {
    const r = await hc(["run", "--bg", "--json", "--no-parent", "--name", `add-${target.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()}`.slice(0, 32), "--", "hc", "machine", "add", target]).catch(() => null);
    let address = null;
    try {
      address = r?.code === 0 ? JSON.parse(r.stdout).address : null;
    } catch {}
    if (!address) {
      this.state[target] = "Couldn't open a terminal for it. Run `hc machine add " + target + "` in one.";
      return;
    }
    openOverlay({
      kind: "dialog",
      key: `machine-add-${target}`,
      width: 640,
      height: 300,
      layout: {
        type: "column",
        children: [
          { type: "block", size: { px: 30 }, content: { mod: "machine-add", props: { part: "bar", target } } },
          { type: "block", content: { terminal: address } },
        ],
      },
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  key(e, cx) {
    if (e.key === "escape") { this.close(); cx.stop_propagation(); }
  }

  // The terminal window's title bar.
  bar(t) {
    return h_flex()
      .size_full()
      .px(12)
      .gap(8)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .text_size(12.5)
      .text_color(t.muted)
      .child(svg(I("machine")).size(16))
      .child(div().flex_1().child(`Adding ${props().target}: answer it here`))
      .child(
        div()
          .id("ma-bar-close")
          .w(22)
          .h(22)
          .rounded(6)
          .flex()
          .items_center()
          .justify_center()
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => closeOverlay(props().overlay))
          .child(svg(I("close")).size(16)),
      );
  }

  row(k, target, label, sub) {
    const st = this.state[target], done = this.isAdded(target), idle = !done && !st;
    const failed = typeof st === "string" && !["adding", "terminal"].includes(st);
    const right = done ? tag(k.status.done, "Added")
      : st === "adding" ? h_flex().flex_none().gap(6).items_center().child(loader(k.accent)).child(tag(k.status.working, "Connecting"))
      : st === "terminal" ? tag(k.status.blocked, "Waiting in its terminal")
      : h_flex().id(`ma-add-${target}`).h(26).px(12).flex_none().items_center().rounded_full().border_1().border_color(k.pill_ring).bg(k.pill).text_size(12).font_medium().cursor_pointer()
        .hover((s) => s.bg(k.hover_strong))
        .on_click((_e, cx) => this.add(target, cx))
        .child("Add");
    return v_flex().flex_none()
      .child(h_flex().id(`ma-row-${target}`).h(ROW).px(8).gap(10).flex_none().items_center().rounded(7)
        .hover((s) => s.bg(k.hover))
        .when(idle, (el) => el.cursor_pointer().on_click((_e, cx) => this.add(target, cx)))
        .child(h_flex().size(22).flex_none().items_center().justify_center().rounded(6).bg(k.tile).text_color(k.tile_text).child(svg(I("machine")).size(16)))
        .child(div().flex_none().text_size(13).text_color(k.row_name).child(label))
        .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(11.5).text_color(k.text_faint).child(sub ?? ""))
        .child(right))
      .when(failed, (el) => el.child(div().pl(40).pr(8).pb(6).text_size(12).text_color(k.failed_text).child(st)))
      .when(Boolean(this.macs[target]), (el) => el.child(this.macCard(k, target)));
  }

  render() {
    const k = look(theme());
    if (props()?.part === "bar") return this.bar(k);
    const hosts = this.hosts ?? [], typed = this.typed.trim(), trouble = typed ? this.state[typed] : null;
    const note = this.hosts === null ? "Reading ~/.ssh/config…" : hosts.length ? null : "No hosts in your ssh config. Type one below.";
    return v_flex().id("machine-add").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).rounded(13).bg(k.canvas).text_size(13).text_color(k.foreground)
      .child(v_flex().flex_none().gap(4).px(EDGE).pt(15).pb(12)
        .child(div().text_size(14).font_medium().child("Add a machine"))
        .child(div().text_size(12.5).line_height("18px").text_color(k.muted)
          .child("A VPS, a Mac mini, a box at home: Zaki reaches it over ssh, and agents there keep running while your laptop sleeps.")))
      .child(v_flex().min_h(0).flex_shrink(1).gap(GUTTER).px(GUTTER)
        .child(card(k).p(4)
          .child(div().px(9).pt(8).pb(8).text_color(k.text_faint).child(caption("From your ssh config")))
          .when(Boolean(note), (el) => el.child(div().px(9).pb(8).text_size(12.5).text_color(k.muted).child(note)))
          // A dialog is as tall as its content, and a scroller adds nothing to that: it collapses to no
          // height. So the list is only a scroller, at its full room, once the rows won't fit.
          .when(hosts.length > 0, (el) => el.child(v_flex().id("ma-hosts")
            .when(hosts.length * ROW > MOST, (list) => list.h(MOST).min_h(0).overflow_y_scroll())
            .children(hosts.map((h) => this.row(k, h.alias, h.alias, [h.user, h.hostname].filter(Boolean).join("@") || (h.aliases.length ? `also ${h.aliases.join(", ")}` : "")))))))
        .child(card(k).p(13).gap(9)
          .child(div().text_color(k.text_faint).child(caption("Or type how ssh reaches it")))
          .child(h_flex().gap(8).items_center()
            .child(Input.new(this.input).flex_1().h(34).px(10).gap(6).items_center().rounded(8).border_1().border_color(this.inputFocused ? k.idle : k.pill_ring).bg(k.well).text_size(13).text_color(k.foreground))
            .child(h_flex().id("ma-add-typed").h(34).px(16).flex_none().items_center().rounded_full().bg(typed ? k.accent : k.raised).text_color(typed ? k.accent_foreground : k.text_faint).text_size(12.5).font_medium().cursor_pointer()
              .when(Boolean(typed), (el) => el.hover((s) => s.opacity(0.88)))
              .on_click((_e, cx) => this.add(this.typed, cx))
              .child("Add")))
          .when(Boolean(trouble), (el) => el.child(div().text_size(12).text_color(k.failed_text).child(String(trouble))))))
      .child(h_flex().h(FOOTER).flex_none().px(EDGE).gap(14).items_center()
        .child(hint(k, "Enter", "Add"))
        .child(div().flex_1())
        .child(hint(k, "Esc", "Leave")));
  }
}
