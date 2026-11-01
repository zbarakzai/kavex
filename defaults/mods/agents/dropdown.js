// The popup a logo opens: it only draws what `sessions` says.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { look, MONO } from "./look.js";

const BAR = 80;

// Tokens in a few letters: 950, 12k, 65.2k, 2.1M.
function count(n) {
  const short = (value, unit) => `${value < 100 ? Number(value.toFixed(1)) : Math.round(value)}${unit}`;
  return n < 1000 ? String(n) : n < 999500 ? short(n / 1e3, "k") : short(n / 1e6, "M");
}

function money(cost) {
  if (cost === undefined) return "no price";
  return cost > 0 && cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

export function dropdown(t, session) {
  const waiting = session.state === "waiting";
  if (session.state !== "ready") return div().w_full().p(12).text_size(12.8).text_color(t.muted).child(waiting ? "Run `/hooks` in Codex, trust Zaki's hook, then restart this Codex." : "No usage yet");
  const k = look(t);
  const { used, total, percent } = session.context;
  const known = percent !== undefined;
  const line = (label) => h_flex().w_full().gap(8).items_center().child(div().w(52).flex_none().text_color(k.label).child(label));
  const figure = (text) => div().flex_none().font_family(MONO).text_size(11).text_color(t.foreground).child(text);
  const { input, output, cached } = session.tokens;
  return v_flex()
    .w_full()
    .p(12)
    .gap(8)
    .text_size(12)
    .child(div().text_size(12.8).font_medium().text_color(t.foreground).child(session.model))
    .child(
      line("Context")
        .when(known, (el) => el.child(div().w(BAR).h(4).flex_none().rounded(2).bg(k.well).child(div().h_full().w((BAR * percent) / 100).rounded(2).bg(percent >= 90 ? t.blocked : t.accent))))
        .child(figure(known ? `${count(used)} / ${count(total)}` : count(used)))
        .when(known, (el) => el.child(figure(`${percent}%`))),
    )
    .child(line("API cost").child(div().flex_1()).child(figure(money(session.cost))))
    .child(line("Tokens").child(figure(`in ${count(input)} · out ${count(output)} · cached ${count(cached)}`)))
    .child(div().text_size(11).text_color(k.label).child("What this would cost on the API, not what you paid."));
}
