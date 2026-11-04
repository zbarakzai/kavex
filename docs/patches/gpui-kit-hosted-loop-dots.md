# gpui-kit: loader dots drawn by the spinner layer

Package: `vendor/gpui-kit` (crate `gpui-shell`), vendored from
longbridge/gpui-kit at 1ccf011. Commit d27472c. Patch:
`gpui-kit-hosted-loop-dots.patch`.

## What it changes

gpui-kit already has a `HERDR:` spinner layer: a spinner in a view that a
ShellRoot shows is painted by the ShellRoot, so a spinner step doesn't rebuild
its view. This patch does the same for a loader dot: a leaf `div` whose only
motion is one opacity `loop`, with a solid background, corners and a size and
nothing else (no children, border, shadow, listener, identity, state style or
transition). The view lays out an empty slot; the ShellRoot paints the dot's
background there at the loop's opacity now, times its ancestors' opacity. That
is the same math GPUI's element opacity does, with the same corners, mask,
shared clock and 33 ms cadence, so the pixels are the same.

Dots go back inline, as spinners do, when something in the view could cover
them: what already keeps spinners inline (popover, select, hover or focus
opacity), or anything moving in the view (a transition or spring, such as a
dragged tab).

## Root cause

Each loader dot's opacity `loop` (`defaults/mods/agents/loader.js`) woke its
whole mod view every 33 ms. While an agent works, that rebuilt, laid out and
painted the tab bar, spaces and agents views about 20 times a second, for ten
dots each. The dots really do change on every frame, so a lower rate would
change the look; only the rebuild could go.

## Numbers (Windows, agent working, ledger id 7)

Median of 10 eight-second stretches per build, two instances each, alternating.

| Agent working | before | after |
| --- | --- | --- |
| app CPU (% of a core) | 13.5 (IQR 1.4) | 9.3 (IQR 2.2) |
| window thread CPU (% of a core) | 11.7 | 6.9 |
| main-thread frame time (ms per second) | 99.0 | 57.4 |
| materialize (ms per second) | 12.7 | 0.02 |
| frame time, median (ms) | 5.0 | 2.9 |
| frames per second | 18.9 | 19.4 |

The start screen and an idle terminal are within noise. Screenshots while an
agent works show the same dots in the tab and the agents row.

## Tests when applied

- App, `cargo test --release --locked`: same results as without the patch (two
  known Windows failures; a parallel-run race in `mods::lifecycle_tests` that
  passes alone).
- gpui-shell's lib tests, `-j 1` (a `-j 2` run was stopped for low memory):
  701 pass, 14 fail, the same 14 as without the patch. They fail for reasons
  outside it on this Windows checkout: Unix-style test paths, example folders
  not vendored, `ping.exe` missing from PATH, file locks, websocket timing.
- gpui-shell has no tests for the spinner layer, so none were added.

## Files touched

`vendor/gpui-kit/crates/shell/src/materialize.rs`, every change marked `HERDR:`:

- `materialize_node` (about line 820): records motion, hands a dot to `dot_slot`.
- `plain_div` (about line 2161): split out of `flex_element`, shared with `is_dot`.
- `Loop` (about line 2800): `Clone`; `loop_now` (about line 2821): split out
  of `apply_loops` (about line 3156), shared with the layer.
- Thread-locals `DOTS` .. `MOVING` (about line 2882) and `struct Dot` (about line 2902).
- `forget_spins` and `build_view` (about lines 2915 and 2929): dots kept per view,
  inline while anything moves.
- `is_dot`, `dot_slot`, `paint_dots` (about lines 3003-3060), and the
  `paint_dots` call in `spin_layer` (about line 3081).

`vendor/gpui-kit/Cargo.toml`: two lines added to the header comment.

## Re-applying after an update

1. Update the vendored crates, keeping the header in `vendor/gpui-kit/Cargo.toml`.
2. `git apply docs/patches/gpui-kit-hosted-loop-dots.patch` (add `-3` if the
   context moved). It needs the spinner layer (`Spin`, `spin_layer`,
   `build_view`, the `HERDR:` loop code) to be there first.
3. Check the `HERDR:` markers listed above are all there.
4. Run gpui-shell's tests. It is a member of gpui-kit's own workspace, which
   isn't the app's: copy the app's `Cargo.lock` into `vendor/gpui-kit`, add the
   app's vendored `[patch.crates-io]` entries (`gpui-pre*`, `taffy`, `zed-xim`,
   `xim-ctext`, as `../<name>` paths) and its quickjs-jit `[patch]` to
   `vendor/gpui-kit/Cargo.toml`, run `cargo test --release -p gpui-shell --lib`
   from `vendor/gpui-kit`, then remove both.
5. Run the app's `cargo test --release --locked`, and look at an agent's
   loader dots while it works: they should look and move as before.
6. Changing a vendored Cargo.toml changes its hash in `THIRD-PARTY-NOTICES`:
   run `just notices` (or update that one `Input-SHA256` line for a comment-only change).

## Upstream

Not yet offered. Goes to longbridge/gpui-kit
(https://github.com/longbridge/gpui-kit), together with the spinner layer it
builds on, which is also Herdr's.
