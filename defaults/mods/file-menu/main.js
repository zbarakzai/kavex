// Right-click in the Files panel: a file, a folder, or with `root` the folder shown. Opened as a
// popup by `files`, which holds what was clicked: a row runs files.<id> and the panel does it.
// `from` tells the panel this shut. Everything but Reveal works on a space's machine too.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, window, focused, terminals, setShared } from "herdr";

const REVEAL = { macos: "Reveal in Finder", windows: "Reveal in Explorer" };

function rows({ dir, root, local }) {
  const f = focused(), terminal = terminals().find((t) => t.address === f?.terminal), shell = terminal?.program?.shell;
  const line = (list) => list.map((row, i) => (i ? row : { ...row, line: true }));
  return [
    ...(dir
      ? [
          { id: "new", icon: "file-new", label: "New file" },
          ...line([
            ...(terminal ? [{ id: "cd", icon: "terminal", label: "cd to directory", off: !shell, hint: shell ? "" : "not in a shell" }] : []),
            { id: "tab", icon: "plus", label: "Open in new tab" },
          ]),
        ]
      : [
          ...(f?.pane ? [{ id: "pane", icon: "split-right", label: "Open in new pane" }] : []),
          { id: "tab", icon: "plus", label: "Open in new tab" },
        ]),
    ...(local ? [{ id: "reveal", icon: "folder", label: REVEAL[window()?.platform] ?? "Reveal in file manager" }] : []),
    ...(root ? [] : [{ id: "rename", icon: "rename", label: "Rename" }, { id: "delete", icon: "trash", label: "Delete", danger: true }]),
    ...(terminal ? line([{ id: "attach", icon: "attach", label: "Attach as context" }]) : []),
    ...line([
      { id: "copy", icon: "copy", label: "Copy path" },
      ...(root ? [] : [{ id: "relative", icon: "copy", label: "Copy relative path" }]),
    ]),
  ];
}

export default class FileMenu extends View {
  init(_props, cx) {
    this.at = -1; // the row the arrow keys are on: none until they're used
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  async close() {
    setShared("popup.closed", { from: props()?.from, at: Date.now() });
  }

  choose(row) {
    if (row.off) return;
    closeOverlay(props().overlay);
    run(`files.${row.id}`);
  }

  row(row, i, t) {
    const color = row.off ? t.dim : row.danger ? (t.failed ?? t.blocked) : t.foreground;
    return v_flex()
      .when(row.line && i > 0, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
      .child(h_flex().id(`fm-${row.id}`).h(31).px(8).gap(9).rounded(7).items_center().text_color(color)
        .when(i === this.at, (el) => el.bg(t.selected))
        .when(!row.off, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => this.choose(row))
        .child(svg(`mods/workspace-chrome/icons/${row.icon}.svg`).size(16).flex_none().text_color(row.off ? t.dim : row.danger ? color : t.muted))
        .child(div().flex_1().truncate().child(row.label))
        .when(Boolean(row.hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(row.hint))));
  }

  render() {
    const t = theme(), list = rows(props() ?? {});
    const step = (by) => {
      for (let i = this.at + by, n = 0; n < list.length; i += by, n++) {
        const at = (i + list.length) % list.length;
        if (!list[at].off) return at;
      }
      return this.at;
    };
    return v_flex().id("file-menu").track_focus(this.handle).w_full().min_h(0).p(5).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(props().overlay);
        else if (e.key === "down") this.at = step(1);
        else if (e.key === "up") this.at = this.at < 0 ? step(0) : step(-1);
        else if (e.key === "enter" && list[this.at]) this.choose(list[this.at]);
        else return;
        cx.notify();
      })
      .children(list.map((row, i) => this.row(row, i, t)));
  }
}
