// The window's minimize, maximize and close buttons, where the system draws none
// (`window().buttons`). Only the tab bar above the terminals draws them, at its right end,
// whatever else is open beside it: the side panel and the Tabs column never do.

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run, window } from "herdr";

const SIZE = 26, GAP = 4; // each button, and the room between them
// Close turns the system's red on hover, with a white icon.
const CLOSE = "#c42b1c", CLOSE_TEXT = "#ffffff";

const stop = (_e, cx) => cx.stop_propagation();

// The three buttons in a row, for the end of the tab bar.
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
