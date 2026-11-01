// The loading look: ten dots in an even triangle resting in a dim primary, a bright dot and its
// tail racing around the edge. Each dot's brightness over one lap is worked out once, and `loop`
// plays it natively. Each mod that shows it keeps a copy, as mods can't import each other's files;
// scripts/look.test.ts keeps them equal.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

const LAP = 333;

// DIM keeps the whole triangle readable on black; the still middle dot sits a little above it.
const DIM = 0.26, MIDDLE = 0.42, TRAIL = [1, 0.8, 0.62, 0.46, 0.34];

// [row, dot] from the tip, down the left, along the base and up the right. The middle dot isn't on it.
const EDGE = [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [3, 2], [3, 3], [2, 2], [1, 1]];

export const DOTS = [1, 2, 3, 4].map((count, row) => Array.from({ length: count }, (_, dot) => {
  const at = EDGE.findIndex(([r, d]) => r === row && d === dot);
  return EDGE.map((_step, head) => (at < 0 ? MIDDLE : TRAIL[(head - at + EDGE.length) % EDGE.length] ?? DIM));
}));

// The gaps stay put at any dot size: 1 across and 0.5 down is what keeps the sides even at 2 and 2.5.
export const loader = (color, dot = 2.5) => v_flex().flex_none().items_center().gap(0.5).children(DOTS.map((row) =>
  h_flex().flex_none().gap(1).children(row.map((values) =>
    div().size(dot).flex_none().rounded(dot).bg(color).loop("opacity", { values, period: LAP })))));
