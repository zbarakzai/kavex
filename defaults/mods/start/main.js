// What the tab area shows with no space open. The ram draws itself once, fills in and stays: from
// then on a light travels its outlines while it breathes and blinks. All of it runs natively, from
// `loop` values worked out once and transitions started once.

import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex } from "gpui-base";
import { keys, theme } from "herdr";
import { SIZE, STRETCHES } from "./outline.js";
import Trail from "./trail.js";

const WIDTH = 200, SCALE = WIDTH / SIZE[0], HEIGHT = SIZE[1] * SCALE;

// The entrance, in ms: lines by 2300, filled by 3400, then the lines sink in and the light takes over.
const FILLED = 3300, SUNK = 4100;

// One lap of the light: out along the horns, then down through the face, then a moment's rest.
const LAP = 7000, STOPS = 70;

const rise = (ms, from, to) => {
  const x = Math.min(1, Math.max(0, (ms - from) / (to - from)));
  return x * x * (3 - 2 * x);
};
const lap = (at) => Array.from({ length: STOPS }, (_, i) => Number(at((i * LAP) / STOPS).toFixed(3)));

// A soft crest moving along a line, off both ends at rest, so the lap joins up without a jump.
function crest(ms, from, span, where) {
  const away = Math.abs(where - (-0.35 + 1.7 * rise(ms, from, from + span))) / 0.3;
  return away < 1 ? (1 + Math.cos(Math.PI * away)) / 2 : 0;
}

const stroke = (points, width) => {
  let path = PathBuilder.stroke(width).move_to(points[0] * SCALE, points[1] * SCALE);
  for (let i = 2; i < points.length; i += 2) path = path.line_to(points[i] * SCALE, points[i + 1] * SCALE);
  return path.build();
};

const LINES = STRETCHES.map(({ group, at, points }) => {
  const [start, span, from, length] = group === "horn" ? [200, 1500, 0, 3600] : [800, 1500, 2600, 3800];
  return {
    horn: group === "horn",
    drawn: Math.round(start + span * rise(at, 0, 1)),
    light: lap((ms) => crest(ms, from, length, at)),
    line: stroke(points, 1.3),
    glow: stroke(points, 3.6),
  };
});

// Lids in the face's color close over the eyes, at uneven gaps: once, then twice quickly much later.
const BLINKS = 11000;
const shut = (ms, at) => rise(ms, at, at + 70) * (1 - rise(ms, at + 90, at + 220));
const BLINK = Array.from({ length: 366 }, (_, i) => {
  const ms = (i * BLINKS) / 366;
  return Number(Math.max(shut(ms, 3100), shut(ms, 8400), shut(ms, 8680)).toFixed(3));
});

const hint = () => {
  const key = keys().find((k) => k.section === "global" && k.action === "space.new")?.keys.trim();
  return `No space open. Make one${key ? ` (${key})` : ""}.`;
};

export default class Start extends View {
  init(_props, cx) {
    this.trail = cx.new(Trail);
    this.stage = "before";
    const to = (stage, ms) => cx.timer.after(ms, (cx) => { this.stage = stage; cx.notify(); });
    to("drawing", 40);
    to("filled", FILLED);
    to("alive", SUNK);
  }

  // The lines of the entrance, each coming on at its time, sinking into the fill together.
  entrance(colors) {
    const shown = this.stage !== "before";
    return div().id("ram-entrance").absolute().inset_0().opacity(this.stage === "filled" ? 0 : 1).transition("opacity", { duration: 800, easing: "ease-in-out" })
      .children(LINES.map(({ horn, drawn, line }, i) => div().id(`ram-line-${i}`).absolute().inset_0().opacity(shown ? 1 : 0).transition("opacity", { duration: 200, delay: drawn })
        .child(window.paint_path(line, horn ? colors.horn : colors.face).size_full())));
  }

  // The light that runs the outlines once the ram is whole.
  travelling(colors) {
    const on = this.stage === "filled" || this.stage === "alive";
    return div().id("ram-light").absolute().inset_0().opacity(on ? 1 : 0).transition("opacity", { duration: 1200, easing: "ease-in-out" })
      .children(LINES.map(({ horn, light, line, glow }) => {
        const color = horn ? colors.hornLight : colors.face;
        return div().absolute().inset_0().loop("opacity", { values: light, period: LAP })
          .child(window.paint_path(glow, `${color.slice(0, 7)}40`).absolute().size_full())
          .child(window.paint_path(line, color).absolute().size_full());
      }));
  }

  ram(t) {
    const colors = { horn: t.accent, hornLight: t.accent_text_soft ?? t.accent, face: t.foreground };
    const shape = (name, color, delay) => div().id(`ram-${name}`).absolute().inset_0().opacity(this.stage === "before" ? 0 : 1).transition("opacity", { duration: 1100, delay, easing: "ease-in-out" })
      .child(svg(`mods/start/${name}.svg`).w(WIDTH).h(HEIGHT).text_color(color).loop("opacity", { from: 0.9, to: 1, period: 5200 }));
    return div().relative().w(WIDTH).h(HEIGHT).flex_none().loop("top", { from: 0, to: -3, period: 5200 })
      .child(shape("horns", t.accent, 2200))
      .child(shape("face", t.foreground, 2400))
      .when(this.stage !== "alive", (el) => el.child(this.entrance(colors)))
      .when(this.stage !== "before", (el) => el.child(this.travelling(colors)))
      .when(this.stage === "alive", (el) => el.child(svg("mods/start/lids.svg").absolute().w(WIDTH).h(HEIGHT).text_color(t.foreground).loop("opacity", { values: BLINK, period: BLINKS })));
  }

  render() {
    const t = theme();
    return div().relative().size_full().overflow_hidden()
      .child(div().absolute().inset_0().child(this.trail))
      .child(v_flex().absolute().inset_0().items_center().justify_center().gap(22)
        .child(this.ram(t))
        .child(div().text_size(13).text_color(t.dim).child(hint())));
  }
}
