// Behind the ram: a wake of bits that follows the pointer and burns out in under a second, 0 at its
// edge, 1 further in, brackets in the theme's accent at the middle. The pointer only heats cells: a
// timer draws them, and runs only while something is lit. It's its own view, so its redraws never
// touch the ram.

import { View, div } from "gpui-kit";
import { theme } from "herdr";

const CELL = 13.2, ROW = 18, WIDE = 7, TALL = 5, FADE = 0.88, TICK = 40;
const BRACKETS = "{}[]()<>";

const grain = (col, row) => (((col * 73856093) ^ (row * 19349663)) >>> 0) % 97 / 97;

export default class Trail extends View {
  init() {
    this.cols = 0;
    this.rows = 0;
    this.heat = new Float32Array(0);
    this.bits = [];
    this.marks = [];
  }

  sized({ width, height }) {
    this.cols = Math.ceil(width / CELL);
    this.rows = Math.ceil(height / ROW);
    this.heat = new Float32Array(this.cols * this.rows);
    this.bits = [];
    this.marks = [];
  }

  brush(col, row) {
    for (let r = Math.max(0, Math.floor(row - TALL)); r < Math.min(this.rows, row + TALL); r += 1) {
      for (let c = Math.max(0, Math.floor(col - WIDE)); c < Math.min(this.cols, col + WIDE); c += 1) {
        const away = ((c - col) / WIDE) ** 2 + ((r - row) / TALL) ** 2;
        if (away >= 1) continue;
        const i = r * this.cols + c;
        this.heat[i] = Math.max(this.heat[i], (1 - away) * (0.7 + 0.3 * grain(c, r)));
      }
    }
  }

  moved({ x, y }, cx) {
    const col = x / CELL, row = y / ROW, last = this.last ?? { col, row };
    const steps = Math.max(1, Math.ceil(Math.hypot(col - last.col, row - last.row)));
    for (let step = 1; step <= steps; step += 1) this.brush(last.col + ((col - last.col) * step) / steps, last.row + ((row - last.row) * step) / steps);
    this.last = { col, row };
    if (!this.burning) this.burn(cx);
  }

  burn(cx) {
    this.burning = true;
    cx.timer.after(TICK, (cx) => {
      const lit = this.draw();
      for (let i = 0; i < this.heat.length; i += 1) this.heat[i] *= FADE;
      cx.notify();
      if (lit) this.burn(cx);
      else this.burning = false;
    });
  }

  // Returns whether anything is lit.
  draw() {
    let lit = false;
    this.bits = [];
    this.marks = [];
    for (let row = 0; row < this.rows; row += 1) {
      let bits = "", marks = "";
      for (let col = 0; col < this.cols; col += 1) {
        const heat = this.heat[row * this.cols + col];
        lit ||= heat >= 0.1;
        bits += heat < 0.1 || heat >= 0.62 ? "  " : heat < 0.28 ? "0 " : "1 ";
        marks += heat >= 0.62 ? `${BRACKETS[Math.floor(grain(row, col) * BRACKETS.length)]} ` : "  ";
      }
      this.bits.push(bits.trimEnd());
      this.marks.push(marks.trimEnd());
    }
    return lit;
  }

  render() {
    const t = theme();
    // Only the rows with something on them become elements.
    const rows = (lines, color) => lines.flatMap((line, row) => (line ? [div().absolute().top(row * ROW).left(0).h(ROW).whitespace_nowrap().text_color(color).child(line)] : []));
    return div().id("trail").relative().size_full().font_family("Geist Mono").text_size(11)
      .on_size_change((size, cx) => { this.sized(size); cx.notify(); })
      .on_hover((hovered) => { if (!hovered) this.last = null; })
      .on_mouse_move((event, cx) => this.moved(event.local_position, cx))
      .children([...rows(this.bits, t.dim), ...rows(this.marks, t.accent)]);
  }
}
