# gpui-pre-windows: suspend and resume run from the message loop

Package: `vendor/gpui-pre-windows` (crate `gpui-pre-windows` 0.3.8, GPUI's
Windows backend from zed-industries/zed). Patch:
`gpui-pre-windows-power-event-deferred.patch`.

## What it changes

The platform window's `WM_POWERBROADCAST` handler no longer calls GPUI's
`system_sleep` / `system_wake` callbacks itself. For `PBT_APMSUSPEND` and
`PBT_APMRESUMEAUTOMATIC` it posts a new `WM_GPUI_POWER_EVENT` (the `PBT_` code
in `lparam`) back to the same window and answers the broadcast at once. The
posted message reaches `handle_gpui_events` from the app's own message loop,
which runs the callback as before. This is how GPUI's macOS platform already
runs them: from the main queue, never inside another call.

## Root cause

`WM_POWERBROADCAST` (closing the lid sends `PBT_APMSUSPEND`) is a sent
message, so any message pump on the UI thread delivers it. That includes the
COM modal loop inside accesskit's `UiaLookupId`, which runs inside GPUI's
`Window::new` while `open_window` holds the `App` `RefCell`. GPUI's sleep
callback (`vendor/gpui-pre/src/app.rs`, about line 996) borrows the app again
and panics "RefCell already borrowed". A panic in a window procedure cannot
unwind, so the process aborts (0xC0000409, fast-fail 7). Found from Windows
Error Reporting's dump of a perf run: the System log shows "entering Modern
Standby, Reason: Lid" one second before the crash.

## Numbers (Windows, ledger id 15a)

Very first starts (empty home, core running), with a thread sending the test
instance's own platform window `WM_POWERBROADCAST` / `PBT_APMSUSPEND` from the
moment it exists until the app accepts commands (scratchpad `fresh15.py
--power`).

| | before | after |
| --- | --- | --- |
| starts ending in 0xC0000409, lid message during start | 3 of 3 | 0 of 4 (36-87 messages each) |
| starts ending abnormally, normal use (no power message) | 0 of 64 | not rerun |

## Tests when applied

- App, `cargo test --release --locked`: integration tests pass; unit tests
  have only the two known Windows failures (`fitted_popups...`,
  `packed_path_points...`).
- `gpui-pre-windows` is outside the app's workspace and has no tests of its
  own for this; none were added. The check is the lid message sent during
  very first starts (above).
- A built app opened Settings five times with nothing in its log.

## Files touched

Every change is marked `HERDR:`.

- `src/events.rs`: the `WM_GPUI_POWER_EVENT` constant (about line 32).
- `src/platform.rs`: routed to `handle_gpui_events` (about lines 1241 and
  1268); `handle_power_broadcast` posts the event and `run_power_event` runs
  the callbacks (about lines 1401-1433).
- `Cargo.toml`: a `HERDR:` note in the header.

## Re-applying after an update

1. Update the vendored crate, keeping the `HERDR:` notes in
   `vendor/gpui-pre-windows/Cargo.toml` and the other patches (dead keys,
   [frame demand](gpui-pre-windows-frame-demand.md)).
2. `git apply -3 docs/patches/gpui-pre-windows-power-event-deferred.patch`. If
   `handle_power_broadcast` moved, redo it by hand from this page and the
   `HERDR:` comments. If upstream no longer runs the power callbacks inside
   the window procedure, drop it.
3. Check the markers listed above are all there.
4. Run `just notices` (the manifest's hash is in `THIRD-PARTY-NOTICES`), then
   the app's `cargo test --release --locked`.
5. On Windows, run a few very first starts with the lid message sent during
   start (`fresh15.py --power` from the perf work, or close the lid while the
   window opens): none should crash.

## Upstream

Not yet offered. To offer to zed-industries/zed: the Windows platform should
run power callbacks from its message loop, as the macOS platform does.
