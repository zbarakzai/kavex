# gpui-pre-windows: windows drawn only on demand

Package: `vendor/gpui-pre-windows` (crate `gpui-pre-windows` 0.3.8, GPUI's
Windows backend from zed-industries/zed). Commit d46a715. Patch:
`gpui-pre-windows-frame-demand.patch`.

## What it changes

Each window gets a `FrameDemand` counter: the number of vsyncs it still wants.
The backend now implements GPUI's `frame_waker` hook (as the macOS idle patch
in `vendor/gpui-pre-macos` does): whenever GPUI wants a frame it sets the
counter to 3 vsyncs. The `VSyncProvider` thread invalidates only the windows
with demand left, and parks while none has any. Parked, it still wakes once a
second to check for a lost GPU device; woken, it invalidates at once, because
the first `DwmFlush` after idle returns early and waiting for a vsync would
then sleep a whole frame.

Three more places ask for frames:

- a touchpad contact and DirectManipulation gesture events keep frames for 60
  vsyncs, because pans and inertia only move when a paint runs
  DirectManipulation's update;
- a deferred re-entrant draw asks for the frame it skipped;
- restoring a minimised window asks for a frame, since demand that came while
  it was minimised found no callback (without this, a restored window stayed
  dirty and drew nothing).

## Root cause

Upstream's `VSyncProvider` thread called `RedrawWindow(RDW_INVALIDATE)` on
every window on every vsync, visible or minimised. An idle window took 60
empty `WM_PAINT`s a second plus about 110 vsync-thread wakeups. Nothing in the
app asks for continuous frames; GPUI's `frame_waker` hook was just not
implemented on Windows.

## Numbers (Windows, ledger id 9)

Eight-second stretches with no input; 9 stretches before, 6 after (window
states: 6 and 4), alternating builds.

| | before | after |
| --- | --- | --- |
| idle terminal: app wakeups/s | 638 (IQR 24) | 292 (IQR 9) |
| idle terminal: app CPU (% of a core) | 4.9 | 1.6 |
| idle terminal: empty WM_PAINTs/s | 60 | 0 |
| idle terminal: VSyncProvider wakeups/s | 109 | 1.3 |
| idle terminal: window thread wakeups/s | 331 | 79 |
| agent working, minimised: app wakeups/s | 672 | 304 |
| agent working, minimised: app CPU (% of a core) | 4.5 | 1.6 |
| agent working: frames drawn/s (clock-based dots) | 19.5 | 21.3 |
| agent working: app CPU (% of a core) | 10.5 | 10.1 |
| start screen: app CPU (% of a core) | 18.2 | 18.7 (within noise) |

Animations are clock-based and look the same; they draw slightly closer to
their 1/30 s cadence because a late timer no longer waits for the next vsync.
While anything animates the vsync thread keeps running as before: the saving
is at idle, unfocused or minimised.

Not covered: GPUI's "keep presenting for 1 s after high-rate input" now stops
3 vsyncs after the last demand, as with the macOS patch (it only re-presents
an unchanged frame). A touchpad contact held still for more than about a
second before it moves relies on DirectManipulation's status change to start
frames again.

## Tests when applied

- App, `cargo test --release --locked`: integration tests pass; unit tests
  have the two known Windows failures (`fitted_popups...`,
  `packed_path_points...`), plus `mods::lifecycle_tests::final_close_pumps_native_awaits_before_the_window_goes`
  failing once under heavy machine load (GPUI's test platform, not this code;
  it passes on a rerun).
- `gpui-pre-windows` is outside the app's workspace and has no tests of its
  own for this; none were added.

## Files touched

Every change is marked `HERDR:`.

- `src/platform.rs`: `TrackedWindow.frame_demand` (about line 45); `FrameDemand`,
  `VSYNC_THREAD`, `wake_vsync_thread` (about lines 48-79); waking the parked
  thread on stop (about lines 460 and 1429); the park and the per-window skip in
  the vsync loop (about lines 488 and 527); `open_window` (about line 822).
- `src/window.rs`: the `frame_demand` field (about lines 58 and 174) and
  `frame_waker` (about line 976).
- `src/events.rs`: wakes on restore from minimised (about line 264), a
  touchpad contact (about line 1329), a deferred draw (about line 1346) and
  gesture events (about line 1356).
- `Cargo.toml`: a `HERDR:` note in the header.

## Re-applying after an update

1. Update the vendored crate, keeping the `HERDR:` note in
   `vendor/gpui-pre-windows/Cargo.toml` and the older dead-key patch.
2. `git apply -3 docs/patches/gpui-pre-windows-frame-demand.patch`. If the
   vsync thread or `draw_window` moved, redo it by hand from this page and the
   `HERDR:` comments. If upstream gained a Windows `frame_waker`, drop it.
3. Check the markers listed above are all there.
4. Run `just notices` (the manifest's hash is in `THIRD-PARTY-NOTICES`), then
   the app's `cargo test --release --locked`.
5. On Windows, check an idle window draws no frames (the perf harness's idle
   scenario, or `scripts/perf` with `HERDR_APP_BENCH_EVENTS`), that a window
   minimised and restored draws again, that typing and an agent's dots look
   as before, and that a touchpad pan and its inertia still scroll.

## Upstream

Not yet offered. To offer to zed-industries/zed as a Windows `frame_waker`,
next to the macOS idle patch it mirrors.
