// The window's minimize, maximize and close buttons, where the system draws none. They belong in
// the window's top right corner, so whichever block holds that corner draws them: one rule, read
// from the layout by every mod that can hold it. tabs, tabs-column, files and changes each keep a
// copy, as mods can't import each other's files; scripts/look.test.ts keeps them equal.

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run, window } from "herdr";

const HOLDERS = ["tabs-column", "panel", "tabs"];
const SIZE = 26, GAP = 4; // each button, and the room between them
// Close turns the system's red on hover, with a white icon.
const CLOSE = "#c42b1c", CLOSE_TEXT = "#ffffff";

const stop = (_e, cx) => cx.stop_propagation();

// The rightmost shown block that can hold them. A sidebar moved to the right edge can't, so it's skipped.
function rightmost(node) {
  if (!node || node.hidden) return null;
  if (HOLDERS.includes(node.id)) return node.id;
  return [...(node.children ?? [])].reverse().reduce((hit, child) => hit ?? rightmost(child), null);
}

// Whether this block holds the corner and draws them. A clone's tab bar may have another id, so
// with no holder it's the bar.
export function holdsButtons(holder) {
  return Boolean(window()?.buttons) && (rightmost(layout()) ?? "tabs") === holder;
}

// The three buttons in a row, for the end of the holder's header.
export function windowButtons(k) {
  const w = window(), native = w.platform === "windows";
  const icon = (name) => svg(`mods/workspace-chrome/icons/${name}.svg`).size(16);
  // A press is the button's, not the draggable bar's: a right one there opens the system's window menu.
  const button = (id, glyph, command) => div().id(id).size(SIZE).flex_none().flex().items_center().justify_center().rounded(8).text_color(k.muted)
    .on_mouse_down("left", stop).on_mouse_down("right", stop).on_click(() => run(command)).child(glyph);
  const quiet = (s) => s.bg(k.hover_strong).text_color(k.foreground);
  return h_flex().id("window-buttons").flex_none().gap(GAP).items_center()
    .child(button("minimize", native ? icon("win-minimize") : "−", "window.minimize").hover(quiet))
    .child(button("maximize", native ? icon(w.maximized ? "win-restore" : "win-maximize") : "□", "window.maximize").hover(quiet))
    .child(button("close-window", icon(native ? "win-close" : "close"), "window.close").hover((s) => s.bg(CLOSE).text_color(CLOSE_TEXT)));
}
