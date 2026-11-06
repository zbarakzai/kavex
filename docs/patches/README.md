# Patches to vendored packages

`vendor/` holds third-party packages. Zaki's changes to them are small, marked
`HERDR:` in the code, and noted in the package's Cargo.toml header (or in the
app's `Cargo.toml` `[patch]` comments). Each patch from the performance work
has a page here and a `.patch` file next to it.

## Patches from the performance work

| Package | Patch | Why | Gain | Upstream |
| --- | --- | --- | --- | --- |
| quickjs-jit-runtime | [feedback snapshots share their lists](quickjs-jit-runtime-feedback-snapshots.md) (5486787) | Every JIT maintenance step copied the whole feedback table; Settings froze while its mod warmed up | later Settings opens 598 -> 350 ms to drawn, worst frame 348 -> 185 ms | not yet offered; longbridge/quickjs-jit |
| gpui-kit (gpui-shell) | [loader dots drawn by the spinner layer](gpui-kit-hosted-loop-dots.md) (d27472c) | An agent's loader dots rebuilt three whole mod views 20 times a second | agent working: app CPU 13.5 -> 9.3% of a core, main-thread frame time 99 -> 57 ms/s | not yet offered; longbridge/gpui-kit |
| gpui-pre-windows | [windows drawn only on demand](gpui-pre-windows-frame-demand.md) (d46a715) | The vsync thread invalidated every window on every vsync, so an idle or minimised window repainted 60 times a second | idle terminal: 638 -> 292 app wakeups/s, 4.9 -> 1.6% of a core; 0 empty paints | not yet offered; to offer as a Windows `frame_waker` to zed-industries/zed |
| gpui-pre-windows | [suspend and resume run from the message loop](gpui-pre-windows-power-event-deferred.md) (8fc095c) | Closing the lid while a window opened ran GPUI's sleep callback inside a COM modal loop, which re-borrowed the app and aborted it | lid message during a very first start: 3 of 3 starts crashed -> 0 of 4 | not yet offered; zed-industries/zed |
| gpui-kit (gpui-shell) | [an unchanged application reuses its modules](gpui-kit-overlay-generation.md) (79a7bf5) | Every overlay open evaluated its mod's modules again, and QuickJS keeps evaluated modules until the app quits | Settings: 1.19 -> 0.01 MB of memory per open; 27.8 -> 5.6 MB after 20 opens | not yet offered; longbridge/gpui-kit |
| gpui-kit (gpui-shell) | start screen: leave out unlit outline lines (fix 8) | Lines at opacity 0 were still built and laid out every frame | start screen main thread 14.9 -> 11.7% of a core | measured, not applied (user declined); patch kept in `.scratch/perf/patches/fix7-8-loops.patch` (fix 8's hunks) |

## Patches that were there before (maintainer's, pre-existing)

| Package | What its `HERDR:` changes do | Upstream |
| --- | --- | --- |
| gpui-pre | Frame capture as a production API without test support; a list measures only what shows; an empty scene is told apart from a window not drawn yet | zed-industries/zed |
| gpui-pre-wgpu | Frame capture: the atlas outlives a redraw request, the last scene replays without the surface, identical readback in window and tests | zed-industries/zed |
| gpui-pre-apple | Frame capture; never acquire a drawable (it can block while covered or minimised) | zed-industries/zed |
| gpui-pre-macos | An idle window stops its display link instead of waking every vsync | zed-industries/zed |
| gpui-pre-linux | Snapping a maximised window to a half kept its old size; a dead key's physical key no longer reaches Kitty input; capture from the window's atlas | zed-industries/zed |
| gpui-pre-windows | Dead keys complete through native text input (dead-key state on the UI thread) | zed-industries/zed |
| taffy | A flex item's min-content was measured even when unused | DioxusLabs/taffy |
| zed-xim, xim-ctext | XIM's Latin-1 / COMPOUND_TEXT decodes without panicking; bad input from an XIM server can't close the app | Riey/xim-rs |
| quickjs-jit-runtime | longbridge/quickjs-jit#38 (call feedback copied on every refresh scan); full upkeep only when due, not on every promise job | #38 open upstream; drop once merged |
| gpui-kit (gpui-base) | GitHub alerts in Markdown; long documents measure only what shows, keep the reader's place and give an outline; HTML inline flows; absolute children pinned to the corner | longbridge/gpui-kit |
| gpui-kit (gpui-shell) | Retained code editors and Markdown documents with built-in syntax highlighting; native `frames`, `loop` and `spin` animations and the hosted spinner layer; packed `paintPath`; app-wide zoom; fitted views; description-only render checks; reload for a host that watches files | longbridge/gpui-kit |

`vendor/ghostty` is a git submodule with no `HERDR:` changes.

To list a package's patches: `rg -n "HERDR:" vendor/<package>`.

## How to re-apply after updating a vendored package

1. Before updating, list the package's `HERDR:` markers
   (`rg -n "HERDR:" vendor/<package>`) and keep the list.
2. Replace the package with the new upstream copy. Keep the `HERDR:` lines of
   its Cargo.toml header and update the version or rev they name.
3. For each patch with a page here: `git apply -3 docs/patches/<name>.patch`.
   If it doesn't apply, redo it by hand from the page and the `HERDR:` comments.
   Drop a patch that upstream has taken.
4. For the maintainer's older patches, redo each marker from the list in step 1.
5. Check every marker from step 1 is back (or knowingly dropped).
6. Run the package's own tests where it has them (each page says how), then
   the app's `cargo test --release --locked`.
7. Run `just notices`: `THIRD-PARTY-NOTICES` keeps a hash of each vendored
   Cargo.toml, and `tests/notices.rs` fails when one changes.
