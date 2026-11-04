# gpui-kit (gpui-shell): an unchanged application reuses its modules

Package: `vendor/gpui-kit` (crate `gpui-shell`, from longbridge/gpui-kit at
1ccf011). Patch: `gpui-kit-overlay-generation.patch`.

## What it changes

`ShellRuntime::load_app` keeps each successful load as a `ReusableApp`: its
module registration, its entry, its evaluated class and a weak handle that is
alive while a copy holds it. The module loader stamps every file a load reads
(size and modified time) before reading it. A later load of the same
application, once no copy holds the earlier one, registers that generation
again and serves its class under a new application generation, instead of
evaluating every module once more. A load whose files, entry or dependencies
changed loads fresh, as before, and the stale entry is dropped. Copies alive
at the same time still get their own modules.

What mods notice: a module's top-level code runs once per app run until one of
its files changes, so module-level variables keep their values from one copy
to the next (an overlay opened again). `defaults/AGENTS.md` says to keep
per-copy state on the View. No shipped mod keeps module-level state.

## Root cause

Every load was a new module generation (`main.js?v=N`), which is how a reload
picks up a change in an imported module. QuickJS frees an evaluated module
only with its context (`js_free_module_def` is static, with no public API), so
each overlay open (Settings, menus, prompts) kept its bytecode and JIT
feedback for the life of the app: memory grew with every open, and in some
runs each open got slower.

## Numbers (Windows, ledger id 16)

Settings opened 20 times per round, 5 rounds per build, alternating builds.

| | before | after |
| --- | --- | --- |
| private memory added per open (opens 2-20) | 1.19 MB (rounds 1.16-1.33) | 0.01 MB (-0.12-0.19) |
| private memory growth, start to 20th open | 27.8 MB | 5.6 MB |
| opens 2-20: command to drawn, median / p95 | 208 / 866 ms | 204 / 286 ms |
| opens 2-20: worst frame, median / p95 | 50 / 545 ms | 51 / 73 ms |
| opens 2-20: main thread busy, median / p95 | 233 / 1384 ms | 222 / 284 ms |

The medians were already flat; the p95 tails come from one of five rounds
before, whose worst frame climbed from 220 to 570 ms between the 5th and 20th
open, so read them as a sign, not proof.

## Tests when applied

- App, `cargo test --release --locked`: integration tests pass; unit tests
  have only the two known Windows failures (`fitted_popups...`,
  `packed_path_points...`).
- gpui-shell's lib tests, `-j 1`: 702 pass, 14 fail, the same 14 as without
  the patch (reasons outside it on this Windows checkout, listed on
  [the loader dots page](gpui-kit-hosted-loop-dots.md)). The new test
  `a_released_unchanged_application_reuses_its_modules` passes: two copies
  alive at once get their own modules, a released unchanged load is reused,
  and a changed import loads fresh.
- A built app opened Settings five times: drawn each time (220-370 ms),
  nothing in its log.

## Files touched

`vendor/gpui-kit/crates/shell/src/engine/quickjs/mod.rs`, every change marked
`HERDR:`:

- `ShellRuntime.reusable_apps` (about line 1411) and its initialiser (about
  line 1729).
- `load_app` (about lines 2199-2270): reuse of a released unchanged load,
  stamping the entry, keeping a successful load.
- `ApplicationModules.files`, `FileStamp`, `file_stamp`, `struct ReusableApp`
  and `ReusableApp::serves` (about lines 5342-5390).
- `AppModules::reregister` and `AppModules::modules` (about lines 5429-5456).
- The loader stamps each module before reading it (about line 5600).
- Test `a_released_unchanged_application_reuses_its_modules` (about line 10725).

`vendor/gpui-kit/Cargo.toml`: lines added to the header comment.

## Re-applying after an update

1. Update the vendored crates, keeping the header in `vendor/gpui-kit/Cargo.toml`.
2. `git apply -3 docs/patches/gpui-kit-overlay-generation.patch`. If
   `load_app` or `AppModules` moved, redo it by hand from this page and the
   `HERDR:` comments. If upstream frees old module generations itself, drop it.
3. Check the `HERDR:` markers listed above are all there.
4. Run gpui-shell's tests as described in
   [the loader dots page](gpui-kit-hosted-loop-dots.md) (step 4), including
   `a_released_unchanged_application_reuses_its_modules`.
5. Run the app's `cargo test --release --locked`; open Settings several times
   and check it draws, and that editing a mod's file still reloads it.
6. Run `just notices` (or update the `vendor/gpui-kit/Cargo.toml`
   `Input-SHA256` line for a comment-only change).

## Upstream

Not yet offered. Goes to longbridge/gpui-kit
(https://github.com/longbridge/gpui-kit).
