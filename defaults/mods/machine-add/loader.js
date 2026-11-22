// Mods keep separate copies of this helper, and share the SVG asset.
import { svg } from "gpui-kit";

// Preserve the loader's footprint and let GPUI animate it independently of the mod.
export function loader(color, scale = 2.5) {
  return svg("mods/workspace-chrome/icons/spinner.svg")
    .w(scale * 4 + 3).h(scale * 4 + 1.5).flex_none().text_color(color)
    .spin(900);
}

const STATUS_ICONS = {
  idle: "idle", queued: "queued", blocked: "warning", done: "success", failed: "error",
};

export function statusIcon(status, color, size = 10) {
  const name = STATUS_ICONS[status] ?? "info";
  return svg(`mods/workspace-chrome/icons/${name}.svg`).w(size).h(size).flex_none().text_color(color);
}
