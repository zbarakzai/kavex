import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, run, setShared, shared, theme } from "herdr";
import { checking, NEAR, POPOVER_HEIGHT, POPOVER_WIDTH, subscriptions, usedNow } from "./checks.js";
import { loader } from "./loader.js";
import { look, spaced, tile } from "./look.js";

const FRAME = 1;
const GUTTER = 5;
const PAD = 14;
const EDGE = GUTTER + PAD;
const HEADER = 44;
const FOOTER = 46;
const ROOM = POPOVER_HEIGHT - HEADER - FOOTER - FRAME * 2;

const LIMIT_TALL = 34;
const LIMIT_GAP = 14;
const CARD_GAP = 12;
const BAR = POPOVER_WIDTH - (FRAME + GUTTER + FRAME + PAD) * 2;
const BAR_TALL = 7;
const BAR_GAP = 3;

// Claude wears the primary orange. On any other agent, orange means a limit that's nearly used.
const hueOf = (agent, k) => ({ claude: k.accent, codex: k.groups.blue.text, opencode: k.groups.teal.text })[agent] ?? k.muted;
const ASK_TALL = 148;
const ASKS = "Zaki reads your OpenCode key and sends it only to opencode.ai, to ask for your Go plan's limits.";

function timeText(ms) {
  const minutes = Math.floor(ms / 60_000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (days) return `${days}d ${hours % 24}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return minutes ? `${minutes}m` : "<1m";
}

// A popup is as tall as its content, and a scroller adds nothing to that: it collapses to no height.
// So the list only becomes a scroller, at the full room, when this rough height says it won't fit.
function tall(row) {
  const count = row.limits.length, limits = count * LIMIT_TALL + (count - 1) * LIMIT_GAP;
  return (PAD + FRAME) * 2 + (row.place ? 38 : 26) + (count ? CARD_GAP + limits : 0) + (row.failed ? CARD_GAP + 14 : 0);
}

const ago = (ms) => (ms < 60_000 ? "just now" : `${timeText(ms)} ago`);

function freshness(usage, rows, now) {
  if (checking(usage, now)) return "Checking…";
  const when = rows.length ? Math.max(...rows.map((row) => row.checkedAt ?? 0)) : usage.checkedAt;
  return when ? `Updated ${ago(now - when)}` : "";
}

const caption = (text, color) => spaced(text.toUpperCase(), 9.5, 0.05).text_color(color);

const card = (k) => v_flex().flex_none().gap(CARD_GAP).p(PAD).rounded(10).bg(k.card).border_1().border_color(k.card_border);

const pill = (id, bg, fg, press) => h_flex().id(id).flex_none().items_center().rounded_full().bg(bg).text_color(fg).cursor_pointer()
  .hover((s) => s.opacity(0.88)).on_click(press);

export default class Usage extends View {
  init(_props, cx) {
    this.from = props()?.from;
    cx.timer.every(30_000, (cx) => cx.notify());
    run("workspace-chrome.check-usage");
  }

  async close() {
    if (this.from) setShared("popup.closed", { from: this.from, at: Date.now() });
  }

  // What's used, then a gap, then what's left: the two parts of one limit.
  bar(id, used, color, k) {
    const part = () => div().h_full().rounded_full();
    return h_flex().flex_none().w(BAR).h(BAR_TALL)
      .child(part().id(`bar-${id}`).flex_none().bg(color).w((BAR * Math.min(used, 100)) / 100).transition("width", 240))
      .when(used < 100, (el) => el.child(part().flex_1().min_w(0).ml(used > 0 ? BAR_GAP : 0).bg(k.row_ring)));
  }

  limit(id, limit, hue, k, now) {
    const used = usedNow(limit, now), left = limit.resetsAt ? limit.resetsAt - now : 0, near = used >= NEAR;
    return v_flex().id(`limit-${id}`).h(LIMIT_TALL).flex_none().gap(8)
      .child(this.bar(id, used, near ? k.blocked : hue, k))
      .child(h_flex().gap(8).items_center()
        .child(div().size(7).flex_none().rounded_full().bg(near ? k.blocked : hue))
        .child(div().flex_1().min_w(0).overflow_hidden().child(caption(limit.label, k.muted)))
        .child(div().flex_none().text_size(14).font_medium().text_color(near ? k.accent_text : k.foreground).child(`${used}%`))
        .when(left > 0, (el) => el.child(div().flex_none().child(caption(`Resets in ${timeText(left)}`, k.text_faint)))));
  }

  row(row, k, now) {
    const id = row.who ?? `${row.agent}-${row.machines[0]}`, hue = hueOf(row.agent, k);
    const note = !row.failed ? null : row.limits.length ? `Last checked ${ago(now - row.checkedAt)}` : "Could not check";
    return card(k)
      .child(h_flex().gap(10).items_center()
        .child(tile(row, 26, k))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_size(14).font_medium().text_color(k.foreground).child(row.name))
          .when(Boolean(row.place), (el) => el.child(div().min_w(0).overflow_hidden().child(caption(row.place, k.text_faint)))))
        .when(Boolean(row.plan), (el) => el.child(h_flex().h(22).px(8).flex_none().items_center().rounded_full().border_1().border_color(k.pill_ring).child(caption(row.plan, k.muted)))))
      .when(row.limits.length > 0, (el) => el.child(v_flex().gap(LIMIT_GAP)
        .children(row.limits.map((limit) => this.limit(`${id}-${limit.label}`, limit, hue, k, now)))))
      .when(Boolean(note), (el) => el.child(caption(note, row.limits.length ? k.text_faint : k.failed_text)));
  }

  // Only a press answers. The footer runs the check, as one started here would stop with the popover.
  asking(row, k) {
    const button = (id, label, bg, fg, press) => pill(id, bg, fg, press).h(28).px(12).child(label);
    return card(k).id("usage-ask")
      .child(h_flex().gap(10).items_center()
        .child(tile(row, 26, k))
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_medium().text_color(k.foreground).child(row.name)))
      .child(div().text_size(12).text_color(k.text_secondary).child(ASKS))
      .child(h_flex().gap(6).justify_end().text_size(12)
        .child(button("usage-not-now", "Not now", k.raised, k.foreground, () => setShared("usage.opencode", false)))
        .child(button("usage-allow", "Allow", k.solid, k.solid_foreground, () => {
          setShared("usage.opencode", true);
          run("workspace-chrome.allow-opencode");
        })));
  }

  render() {
    const k = look(theme()), usage = shared("usage") ?? {}, now = Date.now(), found = subscriptions(usage.entries);
    const answer = shared("usage.opencode"), rows = found.filter((row) => !row.ask), waiting = answer === false ? null : found.find((row) => row.ask);
    const asking = answer == null ? waiting : null;
    const needs = rows.reduce((sum, row) => sum + tall(row) + GUTTER, (asking ? ASK_TALL : 0) + GUTTER);
    const none = !rows.length && !waiting && Boolean(usage.checkedAt);
    return v_flex().id("usage").w_full().min_h(0).rounded(13).bg(k.canvas).text_color(k.foreground)
      .child(h_flex().h(HEADER).flex_none().px(EDGE).items_center().text_size(14).font_medium().child("Usage limits"))
      .child(v_flex().id("usage-rows").gap(GUTTER).px(GUTTER)
        .when(needs > ROOM, (el) => el.h(ROOM).min_h(0).overflow_y_scrollbar())
        .when(Boolean(asking), (el) => el.child(this.asking(asking, k)))
        .when(none, (el) => el.child(card(k).child(div().text_size(13).text_color(k.muted).child("No subscriptions found"))))
        .children(rows.map((row) => this.row(row, k, now))))
      .child(h_flex().h(FOOTER).flex_none().pl(EDGE).pr(GUTTER + 4).items_center().justify_between()
        .child(caption(freshness(usage, rows, now), k.text_faint))
        .child(pill("usage-refresh", k.accent, k.accent_foreground, () => run("workspace-chrome.refresh-usage")).h(30).gap(6).pl(9).pr(12).text_size(12.5).font_medium()
          .child(h_flex().size(16).flex_none().items_center().justify_center()
            .child(checking(usage, now) ? loader(k.accent_foreground, 2) : svg("mods/workspace-chrome/icons/refresh.svg").size(16)))
          .child("Refresh")));
  }
}
