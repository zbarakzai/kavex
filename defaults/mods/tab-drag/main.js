// Carries a tab drag past the bar: a clear layer over the whole window, open while a tab
// is carried, so the pointer can wander and the terminals under it stay out of it. The
// tab bar or Tabs column does everything else. It closes itself: a layer nobody can click through must
// never outlive the press, whatever became of the bar.

import { View, div } from "gpui-kit";
import { run, props, closeOverlay, nextCommand } from "herdr";

export default class TabDrag extends View {
  init(_props, cx) {
    this.busy = false;
    cx.spawn(async () => {
      for (;;) {
        await nextCommand();
        this.busy = false;
        this.send();
      }
    });
  }

  to() {
    return props()?.to ?? "tabs";
  }

  // Only the newest place matters, and the bar asks for it when it's ready. Queued instead,
  // every place would replay in turn, and a tab held longer would fall further behind.
  send() {
    if (this.busy || !this.at) return;
    this.busy = true;
    run(`${this.to()}.drag:${this.at.x},${this.at.y}`);
    this.at = null;
  }

  // The bar closes this when it lands. Just after, in case the bar can't.
  release(e, cx) {
    this.at = null;
    this.busy = true;
    run(`${this.to()}.drop:${e.position.x},${e.position.y}`);
    cx.timer.after(150, () => closeOverlay(props().overlay));
  }

  render() {
    return div().id("tab-drag").size_full()
      .on_mouse_move((e) => { this.at = e.position; this.send(); })
      .on_mouse_up("left", (e, cx) => this.release(e, cx));
  }
}
