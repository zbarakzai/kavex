// Go to a tab. Drops from the Terminals layout's space chip (popup, at: "top"). Spaces with
// something that needs you come first, quiet spaces (no agent running)
// fold into "earlier". Type to filter, ↑/↓ and Enter to go, ctrl+d to close
// a tab, Esc to leave. Last rows: new work (a tab here, a space on this
// computer or on each connected machine).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, spaces, terminals, run, hc, theme, props, closeOverlay } from "herdr";
import { loader } from "./loader.js";
import { badge, look, MONO, spaced, tile } from "./look.js";

const GUTTER = 5;
const EDGE = GUTTER + 14;
const SEARCH = 44;
const FOOTER = 42;
const ROW = 34;
const HEAD = 38;
const EARLIER = 30;
const CARD_EDGE = 5;
const MOST = 440;

const caption = (text) => spaced(text.toUpperCase(), 9.5, 0.05);

// One card per space, one for new work, with the fold for quiet spaces between them.
function cardsOf(rows) {
  const cards = [];
  for (const r of rows) {
    if (r.kind === "head" || r.kind === "new" || r.kind === "earlier") cards.push([r]);
    else cards.at(-1).push(r);
  }
  return cards;
}

const cardHeight = (card) => (card[0].kind === "earlier" ? EARLIER : CARD_EDGE * 2 + card.reduce((sum, r) => sum + (r.kind === "head" ? HEAD : ROW), 0));

export default class Picker extends View {
  init(_props, cx) {
    this.filter = "";
    this.input = InputState.new({ placeholder: "Go to a tab, space or agent…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", () => this.go(this.rows().filter(r => r.kind === "ctx" || r.kind === "new" || r.kind === "space")[this.at]));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.at = null;
    this.showEarlier = false;
    this.machines = [];
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => m.state === "connected" && !m.temporary).map((m) => m.name);
      } catch {}
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  rows() {
    const f = this.filter.toLowerCase();
    const all = agents();
    const live = terminals().filter((x) => x.state === "live");
    const teamOf = (addrs) => {
      let n = 0;
      const walk = (a) => live.filter((x) => x.parent === a).forEach((k) => (n++, walk(k.address)));
      addrs.forEach(walk);
      return n;
    };
    const groups = spaces().map((w) => {
      const ctxs = w.tabs
        .map((ctx) => {
          const mine = all.filter((a) => a.tab === ctx.id);
          return { w, ctx, mine, team: teamOf(mine.map((a) => a.address)) };
        })
        .filter((c) => !f || [w.name, c.ctx.name, ...c.mine.map((a) => a.program?.name ?? "")].join(" ").toLowerCase().includes(f));
      return { w, ctxs };
    });
    const busy = groups.filter((p) => p.w.status && p.ctxs.length);
    const quiet = groups.filter((p) => !p.w.status && p.ctxs.length);
    busy.sort((a, b) => (b.w.status === "blocked") - (a.w.status === "blocked"));
    const out = [];
    const add = (p) => {
      out.push({ kind: "head", w: p.w });
      for (const c of p.ctxs) out.push({ kind: "ctx", ...c });
    };
    busy.forEach(add);
    if (quiet.length) {
      out.push({ kind: "earlier", count: quiet.length });
      if (this.showEarlier || f) quiet.forEach(add);
    }
    out.push({ kind: "new" });
    out.push({ kind: "space", machine: null });
    for (const m of this.machines) out.push({ kind: "space", machine: m });
    return out;
  }

  go(r) {
    if (!r) return;
    this.close();
    if (r.kind === "ctx") run("tab.select", { id: r.ctx.id });
    else if (r.kind === "new") run("tab.new");
    else if (r.kind === "space") run("space.new", r.machine ? { machine: r.machine } : {});
  }

  status(k, status) {
    if (status === "working") return h_flex().flex_none().gap(6).items_center().child(loader(k.accent)).child(badge(k, status));
    return badge(k, status);
  }

  render() {
    const k = look(theme());
    const rows = this.rows();
    const pickable = rows.filter((r) => r.kind === "ctx" || r.kind === "new" || r.kind === "space");
    // Opens on where you are.
    if (this.at === null) this.at = Math.max(0, pickable.findIndex((r) => r.kind === "ctx" && r.w.active && r.ctx.active));
    this.at = Math.min(this.at, pickable.length - 1);
    const sel = pickable[this.at];

    const picks = (el, r) => el.h(ROW).px(8).gap(10).flex_none().items_center().rounded(7).cursor_pointer()
      .when(r === sel, (row) => row.bg(k.row_selected_strong))
      .hover((s) => s.bg(r === sel ? k.row_active_hover : k.hover))
      .on_click(() => this.go(r));

    const row = (r) => {
      if (r.kind === "head") {
        return h_flex().h(HEAD).px(8).gap(10).flex_none().items_center()
          .child(h_flex().size(22).flex_none().rounded(6).bg(r.w.active ? k.accent : k.tile).items_center().justify_center().font_family(MONO).text_size(10.5)
            .text_color(r.w.active ? k.accent_foreground : k.tile_text).child([...r.w.name][0]?.toUpperCase() ?? "?"))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(k.text_secondary).child(r.w.name))
          .when(Boolean(r.w.machine), (el) => el.child(caption(r.w.machine).text_color(k.text_faint)));
      }
      if (r.kind === "new" || r.kind === "space") {
        const label = r.kind === "new" ? "New tab" : r.machine ? `New space on ${r.machine}` : "New space";
        return picks(h_flex().id(r.kind === "new" ? "pk-new" : `pk-space-${r.machine ?? "here"}`), r)
          .child(h_flex().size(22).flex_none().rounded(6).bg(k.tile).items_center().justify_center().text_color(k.tile_text)
            .child(svg("mods/workspace-chrome/icons/plus.svg").size(16).flex_none()))
          .child(div().flex_1().min_w(0).truncate().text_color(k.text_secondary).child(label));
      }
      const others = Math.max(0, r.mine.length - 1) + r.team, here = r.w.active && r.ctx.active;
      return picks(h_flex().id(`pk-${r.ctx.id}`), r)
        .child(tile(r.mine[0]?.program, 22, k))
        .child(div().flex_1().min_w(0).truncate().text_color(k.row_name).when(here, (d) => d.font_medium()).child(r.ctx.name))
        .when(others > 0, (el) => el.child(caption(`+${others}`).text_color(k.text_faint)))
        .when(Boolean(r.ctx.status), (el) => el.child(this.status(k, r.ctx.status)));
    };

    const card = (rows) => {
      const [first] = rows;
      if (first.kind === "earlier") {
        return h_flex().id("pk-earlier").h(EARLIER).px(14).gap(6).flex_none().items_center().text_color(k.text_faint).cursor_pointer()
          .hover((s) => s.text_color(k.foreground))
          .on_click((_e, cx) => {
            this.showEarlier = !this.showEarlier;
            cx.notify();
          })
          .child(caption(`Earlier · ${first.count} quiet space${first.count > 1 ? "s" : ""}`))
          .child(svg(`mods/workspace-chrome/icons/chevron-${this.showEarlier ? "down" : "right"}.svg`).size(12).flex_none());
      }
      return v_flex().flex_none().p(CARD_EDGE - 1).rounded(10).bg(k.card).border_1().border_color(k.card_border).children(rows.map(row));
    };

    const hint = (keys, label) => h_flex().flex_none().gap(6).items_center()
      .child(h_flex().h(18).px(5).flex_none().items_center().rounded(5).border_1().border_color(k.pill_ring).text_color(k.muted).child(caption(keys)))
      .child(caption(label).text_color(k.text_faint));

    const cards = cardsOf(rows);
    const tall = cards.reduce((sum, c) => sum + cardHeight(c), GUTTER * (cards.length - 1));

    return v_flex()
      .id("picker")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .rounded(13)
      .bg(k.canvas)
      .text_size(13)
      .on_key_down((e, cx) => {
        const key = e.key;
        if (key === "escape") return this.close();
        if (key === "down") this.at = (this.at + 1) % pickable.length;
        else if (key === "up") this.at = (this.at + pickable.length - 1) % pickable.length;
        else if (key === "d" && e.modifiers.control) {
          if (sel?.kind === "ctx") {
            this.close();
            run("tab.close", { id: sel.ctx.id });
          }
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().h(SEARCH).flex_none().m(GUTTER).px(14).gap(10).items_center().rounded(10).bg(k.card).border_1().border_color(k.card_border)
        .child(svg("mods/workspace-chrome/icons/search.svg").size(16).flex_none().text_color(k.text_faint))
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(k.foreground)))
      .child(v_flex().h(Math.min(MOST, tall)).min_h(0).flex_shrink(1).px(GUTTER).gap(GUTTER).overflow_y_scrollbar().children(cards.map(card)))
      .child(h_flex().h(FOOTER).flex_none().px(EDGE).gap(14).items_center()
        .child(hint("↑↓", "Move"))
        .child(hint("Enter", "Go"))
        .child(hint("Ctrl D", "Close tab"))
        .child(div().flex_1())
        .child(hint("Esc", "Leave")));
  }
}
