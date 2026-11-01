import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, run, setShared, shared, theme } from "herdr";
import { checking, NEAR, subscriptions, usedNow } from "./checks.js";
import { look, MONO, sectionLabel, tile } from "./look.js";

const PAD = 14;
const BAR = 340 - 2 - PAD * 2; // the popup's width, less its frame and sides

// "5d 3h", "2h 10m", "12m".
function span(ms) {
  const minutes = Math.floor(ms / 60_000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (days) return `${days}d ${hours % 24}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return minutes ? `${minutes}m` : "<1m";
}

const ago = (ms) => (ms < 60_000 ? "just now" : `${span(ms)} ago`);

// How old the numbers are, which a failed check doesn't change. With nothing to show, when it looked.
function freshness(usage, rows, now) {
  if (checking(usage, now)) return "Checking…";
  const when = rows.length ? Math.max(...rows.map((row) => row.checkedAt ?? 0)) : usage.checkedAt;
  return when ? `Updated ${ago(now - when)}` : "";
}

export default class Usage extends View {
  init(_props, cx) {
    this.from = props()?.from;
    cx.timer.every(30_000, (cx) => cx.notify());
    run("workspace-chrome.check-usage");
  }

  async close() {
    if (this.from) setShared("popup.closed", { from: this.from, at: Date.now() });
  }

  limit(id, limit, k, now) {
    const used = usedNow(limit, now), left = limit.resetsAt ? limit.resetsAt - now : 0;
    return v_flex().id(`limit-${id}`).gap(5).flex_none()
      .child(h_flex().gap(8).items_center().text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(k.text_secondary).child(limit.label))
        .child(div().flex_none().font_family(MONO).text_color(k.foreground).child(`${used}%`))
        .when(left > 0, (el) => el.child(div().flex_none().text_color(k.text_faint).child(`resets in ${span(left)}`))))
      .child(div().w(BAR).h(4).rounded(2).overflow_hidden().bg(k.hover_strong)
        .child(div().id(`bar-${id}`).h_full().rounded(2).bg(used >= NEAR ? k.blocked : k.muted).w((BAR * Math.min(used, 100)) / 100).transition("width", 240)));
  }

  row(row, k, now) {
    const id = row.who ?? row.agent, note = !row.failed ? null : row.limits.length ? `Last checked ${ago(now - row.checkedAt)}` : "Could not check";
    return v_flex().flex_none().gap(10)
      .child(h_flex().gap(8).items_center()
        .child(tile(row, 22, k))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().text_color(k.foreground).child(row.name))
        .child(div().flex_none().text_size(12).text_color(k.muted).child(row.plan ?? "")))
      .children(row.limits.map((limit) => this.limit(`${id}-${limit.label}`, limit, k, now)))
      .when(Boolean(note), (el) => el.child(div().text_size(11).text_color(k.text_faint).child(note)));
  }

  render() {
    const k = look(theme()), usage = shared("usage") ?? {}, now = Date.now();
    // `ask` is OpenCode waiting for the person's answer, not a subscription yet.
    const rows = subscriptions(usage.entries).filter((row) => !row.ask);
    return v_flex().id("usage").w_full().min_h(0).text_color(k.foreground)
      .child(h_flex().h(40).flex_none().pl(PAD).pr(7).items_center().justify_between()
        .child(sectionLabel(k, "USAGE LIMITS"))
        .child(h_flex().id("usage-refresh").size(26).flex_none().items_center().justify_center().rounded(7).text_color(k.muted)
          .hover((s) => s.bg(k.hover_strong).text_color(k.foreground))
          .on_click(() => run("workspace-chrome.refresh-usage"))
          .child(svg("mods/workspace-chrome/icons/updates.svg").size(16))))
      .child(v_flex().id("usage-rows").min_h(0).gap(18).px(PAD).pb(12).overflow_y_scrollbar()
        .when(!rows.length && Boolean(usage.checkedAt), (el) => el.child(div().text_size(13).text_color(k.muted).child("No subscriptions found")))
        .children(rows.map((row) => this.row(row, k, now))))
      .child(h_flex().h(32).flex_none().px(PAD).items_center().text_size(11).text_color(k.text_faint).child(freshness(usage, rows, now)));
  }
}
