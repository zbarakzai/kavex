// Customize > Skills, laid out like Codex's: a title with search and actions, then plain rows in
// two columns under section titles; a skill opens up close on click. The work is in skills.js.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, MarkdownState, Popover, TextView } from "gpui-base";
import { exec, pickFolder, shared, setShared, window } from "herdr";
import { MONO, groupHue, soft } from "./look.js";
import { loader } from "./loader.js";
import {
  CATALOG_REPO, TARGETS, addFolder, autoOn, body, busy, cachedCatalog, checkSkills, checksOn, fromGitHub, hold, install, openFolder,
  readSkill, remove, scan, setEnabled, update, updateAll, webUrl,
} from "./skills.js";

const I = (name) => `mods/workspace-chrome/icons/${name}.svg`;
const SHOWN = 8; // rows a section shows before "See … and N more"
const REFRESH = 10 * 60_000; // opening the page looks for updates when the last look is older than this
const HUES = ["blue", "violet", "teal"];
const KNOB = { duration: 140, easing: "ease-out" };
const MENU_EASE = { duration: 160, easing: "ease-out" }, MENU_RISE = 6, MENU_REVEAL = 30; // as the app's own menus arrive

const docLook = (t) => ({
  foreground: t.text_secondary, heading: t.foreground, muted: t.muted, link: t.ansi4, code: t.card, inline_code: t.hover, border: t.card_border,
  hover: t.hover_strong, selection: soft(t.foreground, "26"), alerts: { note: t.ansi4, tip: t.ansi2, important: t.ansi5, warning: t.ansi3, caution: t.failed },
  mark: soft(t.ansi3, "40"), mark_active: soft(t.ansi4, "80"),
  syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
  copy_icon: I("copy"), copied_icon: I("check"),
});

const hueOf = (k, key) => {
  let n = 0;
  for (const c of key ?? "") n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return groupHue(k, HUES[n % HUES.length]);
};

const browse = (url) => {
  const p = window()?.platform;
  return p === "windows" ? exec("cmd", ["/c", "start", "", url]) : exec(p === "macos" ? "open" : "xdg-open", [url]);
};

const capital = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;
const more = (rest) => (rest.length > 2 ? `See ${rest[0].title}, ${rest[1].title}, and ${rest.length - 2} more` : `See ${rest.map((r) => r.title).join(" and ")}`);

export class SkillsPage {
  constructor() {
    this.tab = "browse";
    this.query = "";
    this.expanded = {};
    this.menu = null; // "add" | "options"
    this.linking = false; // the GitHub link field is open
    this.found = null; // what a GitHub link holds
    this.detail = null; // a row's key
    this.doc = null;
    this.docFor = null;
    this.confirm = null;
    this.errors = {};
    this.edited = {};
    this.notice = null;
    this.catalog = null;
    this.state = null;
    this.loading = false;
    this.seen = undefined;
    this.search = InputState.new({ placeholder: "Search skills" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); cx.notify(); });
    this.link = InputState.new({ placeholder: "github.com/owner/repo/tree/main/skills/name" });
    this.link.on("submit", (_e, cx) => this.addLink(cx));
  }

  release() {
    this.doc?.release();
    this.doc = null;
  }

  open(cx) {
    this.reload(cx);
    const last = shared("skills.check")?.at;
    if (checksOn() && (!last || Date.now() - last > REFRESH)) this.refresh(cx);
  }

  reload(cx) {
    if (this.loading) return;
    this.loading = true;
    this.seen = shared("skills.changed");
    cx.spawn(async (cx) => {
      try {
        this.catalog = (await cachedCatalog()) ?? this.catalog;
        this.state = await scan();
      } catch (e) {
        this.notice = { ok: false, text: String(e?.message ?? e) };
      } finally {
        this.loading = false;
      }
      cx.notify();
    });
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      cx.notify();
      await checkSkills({ force: true });
      this.reload(cx);
    });
  }

  escape() {
    if (this.menu) this.menu = null;
    else if (this.confirm) this.confirm = null;
    else if (this.detail) this.closeDetail();
    else if (this.linking) this.linking = false;
    else return false;
    return true;
  }

  closeDetail() {
    this.detail = null;
    this.release();
    this.docFor = null;
    this.confirm = null;
  }

  act(name, cx, run) {
    delete this.errors[name];
    delete this.edited[name];
    this.notice = null;
    this.menu = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await run();
      } catch (e) {
        if (e?.edited) this.edited[name] = true;
        else this.errors[name] = String(e?.message ?? e);
      }
      this.reload(cx);
      cx.notify();
    });
  }

  addLink(cx) {
    const link = this.link.value().trim();
    if (!link) return;
    this.found = { loading: true };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const skills = await fromGitHub(link);
        if (skills.length === 1) {
          this.found = null;
          await install(skills[0]);
          this.link.set_value("");
          this.linking = false;
          this.notice = { ok: true, text: `Installed ${skills[0].title} for every agent.` };
        } else this.found = { skills };
      } catch (e) {
        this.found = { error: String(e?.message ?? e) };
      }
      this.reload(cx);
      cx.notify();
    });
  }

  addFolder(cx) {
    this.menu = null;
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Add skill" });
      if (!folder) return;
      try {
        const name = await addFolder(folder);
        this.notice = { ok: true, text: `Added ${name} for every agent. It changes when you edit that folder.` };
      } catch (e) {
        this.notice = { ok: false, text: String(e?.message ?? e) };
      }
      this.reload(cx);
      cx.notify();
    });
  }

  // What the page lists ----------------------------------------------------------

  lock() {
    return this.state?.lock?.skills ?? {};
  }

  // Which list a catalog skill came from, so an older list never offers a step back.
  listed(e) {
    return e.source === "github" ? e : { ...e, seen: this.catalog?.generated ?? null };
  }

  updates() {
    const lock = this.lock();
    return (shared("skills.updates") ?? []).filter((u) => lock[u.name]);
  }

  installed() {
    const updates = new Set(this.updates().map((u) => u.name));
    const zaki = Object.values(this.lock()).map((s) => ({ kind: "zaki", key: s.name, name: s.name, title: s.title, short: s.short, description: s.description, hue: s.repo ?? "folder", s, update: updates.has(s.name) }));
    const own = (this.state?.personal ?? []).map((p) => ({ kind: "personal", key: `p:${p.name}`, name: p.name, title: p.title, short: p.short, description: p.description, hue: "personal", p }));
    return [...zaki, ...own].sort((a, b) => a.title.localeCompare(b.title));
  }

  browseList() {
    return (this.catalog?.skills ?? []).map((e) => ({ kind: "catalog", key: `c:${e.id}`, name: e.name, title: e.title, short: e.short, description: e.description, hue: e.repo, e }));
  }

  systemList() {
    return (this.state?.system ?? []).map((x) => ({ kind: "system", key: `s:${x.from}:${x.name}`, name: x.name, title: x.title, short: x.short, description: x.description, x }));
  }

  filter(items) {
    const q = this.query;
    if (!q) return items;
    return items.filter((i) => [i.name, i.title, i.short, i.description, i.e?.repo, i.s?.repo, i.x?.from].some((v) => v?.toLowerCase().includes(q)));
  }

  find(key) {
    const found = (this.found?.skills ?? []).map((e) => ({ kind: "catalog", key: `f:${e.id}`, name: e.name, title: e.title, short: e.short, description: e.description, hue: e.repo, e }));
    return [...this.installed(), ...this.browseList(), ...this.systemList(), ...found].find((i) => i.key === key) ?? null;
  }

  standing(e) {
    const s = this.lock()[e.name];
    if (s) return s.id === e.id ? { is: "mine", s } : { is: "name", s };
    const p = (this.state?.personal ?? []).find((x) => x.name === e.name);
    return p ? { is: "theirs", p } : { is: "free" };
  }

  // Pieces ------------------------------------------------------------------------

  tile(t, item, size = 36) {
    const letter = (item.title || item.name || "?").trim()[0]?.toUpperCase() ?? "?";
    const color = item.kind === "system" ? t.tile_text : hueOf(t, item.hue).text;
    return h_flex().size(size).flex_none().items_center().justify_center().rounded(size * 0.25).bg(t.tile).border_1().border_color(t.card_border)
      .child(div().font_family(MONO).text_size(size * 0.38).font_medium().text_color(color).child(letter));
  }

  // Quiet, like Codex's: text in a ring, a fill only on hover.
  button(t, id, label, onClick, { solid = false, danger = false, icon = null, caret = false } = {}) {
    return h_flex().id(id).h(32).px(12).gap(6).flex_none().items_center().rounded(999).cursor_pointer().text_size(13)
      .when(solid, (el) => el.bg(t.solid ?? t.foreground).text_color(t.solid_foreground ?? t.surface).font_medium().hover((s) => s.opacity(0.88)))
      .when(!solid, (el) => el.border_1().border_color(t.pill_ring).text_color(danger ? t.failed : t.foreground).hover((s) => s.bg(t.hover_strong)))
      .when(Boolean(onClick), (el) => el.on_click(onClick))
      .when(Boolean(icon), (el) => el.child(svg(I(icon)).size(16).flex_none()))
      .child(label)
      .when(caret, (el) => el.child(svg(I("chevron-down")).size(12).flex_none()));
  }

  iconButton(t, id, icon, onClick, { on = false, spinning = false } = {}) {
    return h_flex().id(id).size(32).flex_none().items_center().justify_center().rounded(999).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.hover_strong)).hover((s) => s.bg(t.hover_strong).text_color(t.foreground))
      .when(Boolean(onClick), (el) => el.on_click(onClick))
      .child(spinning ? loader(t.accent) : svg(I(icon)).size(16));
  }

  toggle(t, id, on, onClick) {
    return div().id(id).relative().w(36).h(20).flex_none().rounded(10).cursor_pointer().bg(on ? t.foreground : t.pill_selected).on_click(onClick)
      .child(div().id(`${id}-knob`).absolute().top(2).left(on ? 18 : 2).size(16).rounded(8).bg(on ? t.surface : t.muted).transition("left", KNOB));
  }

  doing(t, name) {
    const what = busy(name);
    return what ? h_flex().gap(8).items_center().flex_none().child(loader(t.accent)).child(div().text_size(12).text_color(t.label).child(`${capital(what)}…`)) : null;
  }

  heading(t, title, right = null) {
    return h_flex().w_full().px(10).pb(8).mb(6).gap(12).items_center().border_b(1).border_color(t.card_border)
      .child(div().flex_1().min_w(0).text_size(15).font_medium().text_color(t.foreground).child(title))
      .when(Boolean(right), (el) => el.child(right));
  }

  // What sits at a row's end: nothing loud. A check when it's in, a + to get it.
  end(t, item) {
    const doing = this.doing(t, item.name);
    if (doing && (item.kind === "zaki" || (item.kind === "catalog" && this.standing(item.e).is === "free"))) return doing;
    if (item.kind === "zaki") {
      if (item.update) return div().size(7).mr(4).rounded(4).bg(t.accent);
      return svg(I("check")).size(16).flex_none().text_color(item.s.enabled === false ? t.dim : t.label);
    }
    if (item.kind === "catalog") {
      const st = this.standing(item.e);
      if (st.is === "mine") return svg(I("check")).size(16).flex_none().text_color(t.label);
      if (st.is === "free") return this.iconButton(t, `cz-get-${item.key}`, "plus", (_e, cx) => this.act(item.name, cx, () => install(this.listed(item.e))));
    }
    return null;
  }

  row(t, item) {
    const off = item.kind === "zaki" && item.s.enabled === false;
    return h_flex().id(`cz-row-${item.key}`).flex_1().min_w(0).h(60).pr(10).gap(8).items_center().rounded(10).hover((s) => s.bg(t.hover))
      .child(h_flex().id(`cz-${item.key}`).flex_1().min_w(0).h_full().pl(10).gap(12).items_center().cursor_pointer().on_click((_e, cx) => this.openDetail(item, cx))
        .child(this.tile(t, item))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().min_w(0).gap(8).items_center()
            .child(div().min_w(0).truncate().text_size(13.5).text_color(off ? t.muted : t.foreground).child(item.title))
            .when(off, (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child("Off"))))
          .child(div().truncate().text_size(12.5).text_color(this.errors[item.name] ? t.failed : t.label).child(this.errors[item.name] ?? (item.short || item.name)))))
      .child(h_flex().w(32).flex_none().items_center().justify_center().child(this.end(t, item) ?? div()));
  }

  grid(t, items) {
    const rows = [];
    for (let i = 0; i < items.length; i += 2)
      rows.push(h_flex().w_full().gap(24).child(this.row(t, items[i])).child(items[i + 1] ? this.row(t, items[i + 1]) : div().flex_1()));
    return v_flex().w_full().gap(4).children(rows);
  }

  list(t, id, items, empty) {
    if (!items.length) return div().px(10).py(12).text_size(13).text_color(t.label).child(empty);
    const all = this.query || this.expanded[id], shown = all ? items : items.slice(0, SHOWN), rest = all ? [] : items.slice(SHOWN);
    return v_flex().w_full()
      .child(this.grid(t, shown))
      .when(rest.length > 0, (el) => el.child(h_flex().id(`cz-more-${id}`).px(10).pt(14).cursor_pointer().text_size(13).text_color(t.label).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.expanded[id] = true; cx.notify(); }).child(more(rest))));
  }

  // The page's top: what it is, then search and its actions on the right.
  header(t) {
    const check = shared("skills.check") ?? {}, checking = Boolean(check.running && Date.now() - check.running < 90_000);
    return h_flex().w_full().gap(16).items_start()
      .child(v_flex().flex_1().min_w(0).gap(6)
        .child(div().text_size(22).font_medium().text_color(t.foreground).child("Skills"))
        .child(div().text_size(13.5).text_color(t.muted).child("Extend every agent with task-specific skills")))
      .child(h_flex().flex_none().gap(6).items_center()
        .child(h_flex().w(240).h(32).px(12).gap(8).items_center().rounded(999).border_1().border_color(t.pill_ring)
          .child(svg(I("search")).size(16).flex_none().text_color(t.dim))
          .child(div().flex_1().min_w(0).text_size(13).child(Input.new(this.search).h(26).text_color(t.foreground))))
        .child(this.iconButton(t, "cz-refresh", "refresh", (_e, cx) => this.refresh(cx), { spinning: checking }))
        .child(this.popover("options", this.iconButton(t, "cz-options", "settings", null, { on: this.menu === "options" }), () => this.dropdown(t)))
        .child(this.popover("add", this.button(t, "cz-add", "Add", null, { solid: true, caret: true }), () => this.dropdown(t))));
  }

  // The Popover opens and shuts its menu; a press outside or Esc shuts it too.
  popover(id, trigger, content) {
    const open = this.menu === id;
    return Popover.new(`cz-menu-${id}`).anchor("top_right").open(open)
      .on_open_change((next, cx) => {
        this.menu = next ? id : null;
        if (next) {
          this.menuIn = false;
          cx.timer.after(MENU_REVEAL, (cx) => { this.menuIn = true; cx.notify(); });
        }
        cx.notify();
      })
      .trigger(trigger).when(open, (el) => el.content(content()));
  }

  dropdown(t) {
    const box = (w) => v_flex().id("cz-menu-box").relative().top(this.menuIn ? 0 : -MENU_RISE).opacity(this.menuIn ? 1 : 0).transition("opacity", MENU_EASE).transition("top", MENU_EASE)
      .mt(6).w(w).p(6).gap(2).rounded(14).bg(t.raised).border_1().border_color(t.border).shadow_lg();
    const item = (id, icon, title, about, onClick) => h_flex().id(id).w_full().px(10).py(8).gap(10).items_start().rounded(9).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick)
      .child(svg(I(icon)).size(16).mt(1).flex_none().text_color(t.label))
      .child(v_flex().flex_1().min_w(0).gap(2).child(div().text_size(13).text_color(t.foreground).child(title)).child(div().text_size(12).text_color(t.label).child(about)));
    if (this.menu === "add")
      return box(300)
        .child(item("cz-add-link", "branch", "From a GitHub link", "A skill's folder, or a repo of skills", (_e, cx) => { this.menu = null; this.linking = true; this.found = null; this.link.focus(); cx.notify(); }))
        .child(item("cz-add-folder", "folder", "From a folder", "A skill of your own, used where it is", (_e, cx) => this.addFolder(cx)))
        .child(item("cz-add-suggest", "plus", "Suggest one for the list", "github.com/zbarakzai/zaki-skills", () => { this.menu = null; browse(CATALOG_REPO); }));
    const check = shared("skills.check") ?? {}, at = check.at ? new Date(check.at) : null;
    const when = at ? `Last looked at ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` : "Not looked yet";
    const line = (id, title, about, on, onClick) => h_flex().w_full().px(10).py(8).gap(12).items_center()
      .child(v_flex().flex_1().min_w(0).gap(2).child(div().text_size(13).text_color(t.foreground).child(title)).child(div().text_size(12).text_color(t.label).child(about)))
      .child(this.toggle(t, id, on, onClick));
    return box(320)
      .child(line("cz-checks", "Look for updates", `Every 6 hours. ${when}.`, checksOn(), (_e, cx) => { setShared("skills.checks", !checksOn()); cx.notify(); }))
      .child(line("cz-auto", "Update by themselves", "Skills you haven't changed", autoOn(), (_e, cx) => { setShared("skills.auto", !autoOn()); cx.notify(); }))
      .when(Boolean(check.error), (el) => el.child(div().px(10).pb(6).text_size(12).text_color(t.failed).child(check.error)));
  }

  linkBar(t) {
    const found = this.found;
    return v_flex().w_full().pt(20).gap(8)
      .child(h_flex().w_full().gap(8).items_center()
        .child(h_flex().flex_1().min_w(0).h(36).px(12).items_center().rounded(11).border_1().border_color(t.row_ring).bg(t.well)
          .child(div().flex_1().min_w(0).text_size(13).child(Input.new(this.link).h(28).text_color(t.foreground))))
        .child(found?.loading ? h_flex().px(8).child(loader(t.accent)) : this.button(t, "cz-link-add", "Add", (_e, cx) => this.addLink(cx), { solid: true }))
        .child(this.button(t, "cz-link-cancel", "Cancel", (_e, cx) => { this.linking = false; this.found = null; cx.notify(); })))
      .when(Boolean(found?.error), (el) => el.child(div().px(2).text_size(12.5).text_color(t.failed).child(found.error)))
      .when(Boolean(found?.skills), (el) => el.child(v_flex().w_full().pt(8)
        .child(div().px(10).pb(6).text_size(12.5).text_color(t.label).child(`${found.skills.length} skills there`))
        .child(this.grid(t, found.skills.map((e) => ({ kind: "catalog", key: `f:${e.id}`, name: e.name, title: e.title, short: e.short, description: e.description, hue: e.repo, e }))))));
  }

  updatesSection(t) {
    const list = this.updates();
    if (!list.length || this.query) return null;
    const all = list.length > 1 && list.every((u) => !busy(u.name))
      ? this.button(t, "cz-update-all", "Update all", (_e, cx) => this.act("*", cx, async () => {
        for (const u of await updateAll(list)) this.edited[u.name] = true;
      }))
      : null;
    const rows = list.map((u) => {
      const s = this.lock()[u.name], edited = this.edited[u.name], error = this.errors[u.name];
      const item = { kind: "zaki", key: u.name, name: u.name, title: s?.title ?? u.title, hue: s?.repo ?? "folder" };
      const controls = this.doing(t, u.name)
        ?? (edited
          ? h_flex().gap(6).flex_none()
            .child(this.button(t, `cz-keep-${u.name}`, "Keep mine", (_e, cx) => this.act(u.name, cx, () => hold(u.name))))
            .child(this.button(t, `cz-replace-${u.name}`, "Replace", (_e, cx) => this.act(u.name, cx, () => update(u.name, { entry: u.entry, force: true }))))
          : this.button(t, `cz-update-${u.name}`, "Update", (_e, cx) => this.act(u.name, cx, () => update(u.name, { entry: u.entry }))));
      return h_flex().w_full().h(60).px(10).gap(12).items_center()
        .child(this.tile(t, item))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_size(13.5).text_color(t.foreground).child(item.title))
          .child(div().truncate().text_size(12.5).text_color(error ? t.failed : t.label).child(error ?? (edited ? "You changed it since it was installed" : "A new version is out"))))
        .child(controls);
    });
    return v_flex().w_full().child(this.heading(t, "Updates", all)).children(rows);
  }

  tabs(t) {
    return h_flex().gap(4).items_center().children([["browse", "Browse"], ["system", "System"]].map(([id, label]) =>
      h_flex().id(`cz-tab-${id}`).h(36).px(16).items_center().rounded(999).cursor_pointer().text_size(13.5)
        .when(this.tab === id, (el) => el.bg(t.pill_selected).text_color(t.foreground))
        .when(this.tab !== id, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
        .on_click((_e, cx) => { this.tab = id; cx.notify(); })
        .child(label)));
  }

  listView(t) {
    const installed = this.filter(this.installed());
    const lower = this.tab === "browse" ? this.filter(this.browseList()) : this.filter(this.systemList());
    const failed = shared("skills.check")?.error;
    const lowerEmpty = this.tab === "browse"
      ? (!this.catalog ? (failed ? `Couldn't get the list: ${failed}` : "Getting the list…") : "No skill in the list matches.")
      : (this.query ? "Nothing matches." : "Codex's own skills and Claude Code plugins' show here.");
    return v_flex().w_full()
      .child(this.header(t))
      .when(this.linking, (el) => el.child(this.linkBar(t)))
      .when(Boolean(this.notice), (el) => el.child(div().pt(14).px(2).text_size(12.5).text_color(this.notice.ok ? t.added : t.failed).child(this.notice.text)))
      .when(Boolean(this.errors["*"]), (el) => el.child(div().pt(14).px(2).text_size(12.5).text_color(t.failed).child(this.errors["*"])))
      .child(v_flex().w_full().pt(32).gap(36)
        .child(this.updatesSection(t) ?? div())
        .child(v_flex().w_full()
          .child(this.heading(t, "Installed"))
          .child(this.list(t, "installed", installed, this.query ? "Nothing installed matches." : "Nothing yet. Pick skills from Browse and every agent gets them.")))
        .child(v_flex().w_full().gap(16)
          .child(this.tabs(t))
          .child(this.list(t, this.tab, lower, lowerEmpty))))
  }

  // A skill up close ----------------------------------------------------------------

  openDetail(item, cx) {
    this.closeDetail();
    this.menu = null;
    this.detail = item.key;
    cx.notify();
    cx.spawn(async (cx) => {
      const source = item.s ?? item.e ?? item.p ?? item.x;
      const text = await readSkill(source).catch(() => null);
      if (this.detail !== item.key) return;
      this.doc = MarkdownState.new({ value: body(text ?? "") || "_This skill has no SKILL.md to show._", folder: source.folder ?? "" });
      this.docFor = item.key;
      cx.notify();
    });
  }

  actions(t, item) {
    const out = h_flex().gap(6).items_center().flex_none();
    const doing = this.doing(t, item.name);
    if (doing) return out.child(doing);
    if (item.kind === "catalog") {
      const st = this.standing(item.e);
      if (st.is === "free") return out.child(this.button(t, "cz-d-install", "Install", (_e, cx) => this.act(item.name, cx, () => install(this.listed(item.e))), { solid: true }));
      if (st.is === "theirs") return out.child(this.button(t, "cz-d-replace", "Use this one", (_e, cx) => this.act(item.name, cx, () => install(this.listed(item.e), { replace: true })), { solid: true }));
      return out;
    }
    if (item.kind !== "zaki") return item.p || item.x ? out.child(this.button(t, "cz-d-folder", "Open folder", () => openFolder((item.p ?? item.x).folder))) : out;
    const s = item.s, unlink = s.source === "folder";
    if (this.confirm === item.name)
      return out.child(this.button(t, "cz-d-cancel", "Cancel", (_e, cx) => { this.confirm = null; cx.notify(); }))
        .child(this.button(t, "cz-d-confirm", unlink ? "Remove from agents" : "Remove", (_e, cx) => { this.confirm = null; this.act(item.name, cx, async () => { await remove(item.name); this.closeDetail(); }); }, { danger: true }));
    const u = this.updates().find((x) => x.name === item.name);
    return out
      .when(Boolean(u), (el) => el.child(this.button(t, "cz-d-update", "Update", (_e, cx) => this.act(item.name, cx, () => update(item.name, { entry: u.entry })), { solid: true })))
      .child(this.button(t, "cz-d-on", s.enabled === false ? "Turn on" : "Turn off", (_e, cx) => this.act(item.name, cx, () => setEnabled(item.name, s.enabled === false))))
      .child(this.button(t, "cz-d-remove", "Remove", (_e, cx) => { this.confirm = item.name; cx.notify(); }));
  }

  facts(t, item) {
    const source = item.s ?? item.e ?? item.p ?? item.x;
    const line = (title, value, onClick) => h_flex().w_full().h(36).gap(16).items_center()
      .child(div().w(110).flex_none().text_size(12.5).text_color(t.label).child(title))
      .child(onClick
        ? h_flex().id(`cz-f-${title}`).min_w(0).cursor_pointer().text_color(t.ansi4).hover((s) => s.opacity(0.8)).on_click(onClick).child(div().truncate().text_size(12.5).child(value))
        : div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.text_secondary).child(value));
    const rows = [];
    if (source.repo) rows.push(line("From", `${source.repo}${source.path ? `/${source.path}` : ""}`, () => browse(webUrl(source))));
    if (source.commit) rows.push(line("Version", source.commit.slice(0, 7)));
    if (item.kind === "zaki") {
      const linked = this.state?.linked?.[item.name] ?? [];
      rows.push(line("Agents", item.s.enabled === false ? "Off for every agent" : TARGETS.filter((x) => linked.includes(x.id)).map((x) => x.agents).join(", ") || "None yet"));
    }
    if (item.kind === "personal") rows.push(line("In", item.p.places.join(", ")));
    if (item.kind === "system") rows.push(line("Comes with", item.x.from));
    if (source.folder) rows.push(line("Folder", source.folder.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~"), () => openFolder(source.folder)));
    return v_flex().w_full().children(rows);
  }

  detailView(t) {
    const item = this.find(this.detail);
    if (!item) {
      this.closeDetail();
      return this.listView(t);
    }
    if (this.doc) this.doc.set_look(docLook(t));
    const error = this.errors[item.name];
    const from = item.e?.repo ?? item.s?.repo ?? (item.p ? "Your own" : item.x?.from) ?? "Your own";
    return v_flex().w_full()
      .child(h_flex().id("cz-d-back").pb(24).gap(6).items_center().cursor_pointer().text_color(t.label).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.closeDetail(); cx.notify(); })
        .child(svg(I("chevron-left")).size(16)).child(div().text_size(13).child("Skills")))
      .child(h_flex().w_full().gap(16).items_center()
        .child(this.tile(t, item, 48))
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(div().truncate().text_size(20).font_medium().text_color(t.foreground).child(item.title))
          .child(div().truncate().text_size(13).text_color(t.label).child(item.s?.enabled === false ? `${from} · Off` : from)))
        .child(this.actions(t, item)))
      .when(this.confirm === item.name, (el) => el.child(div().pt(14).text_size(13).text_color(t.muted)
        .child(item.s?.source === "folder" ? `Agents stop seeing ${item.title}. Your folder stays as it is.` : `Every agent stops seeing ${item.title}, and Zaki's copy is deleted.`)))
      .when(Boolean(error), (el) => el.child(div().pt(14).text_size(13).text_color(t.failed).child(error)))
      .when(Boolean(this.edited[item.name]), (el) => el.child(div().pt(14).text_size(13).text_color(t.muted).child("You changed this skill. Pick Replace or Keep mine under Updates.")))
      .when(Boolean(item.description), (el) => el.child(div().pt(24).max_w(680).text_size(14).line_height("21px").text_color(t.text_secondary).child(item.description)))
      .child(div().pt(24).child(this.heading(t, "Details")))
      .child(div().px(10).child(this.facts(t, item)))
      .child(div().pt(28).child(this.heading(t, "SKILL.md")))
      .child(div().w_full().h(480).rounded(12).overflow_hidden().border_1().border_color(t.card_border).bg(t.background)
        .on_scroll_wheel((_e, cx) => cx.stop_propagation())
        .child(this.doc && this.docFor === item.key
          ? div().size_full().px(20).py(12).child(TextView.state(this.doc).scrollable(true).selectable(true).size_full().text_size(13.5))
          : h_flex().size_full().items_center().justify_center().child(loader(t.accent))));
  }

  render(t, cx) {
    if (shared("skills.changed") !== this.seen && !this.loading) this.reload(cx);
    return this.detail ? this.detailView(t) : this.listView(t);
  }
}
