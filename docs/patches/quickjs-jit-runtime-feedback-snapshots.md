# quickjs-jit-runtime: feedback snapshots share their lists

Package: `vendor/quickjs-jit-runtime` (quickjs-jit's `jit` crate, pinned rev
96593cd). Commit 5486787. Patch: `quickjs-jit-runtime-feedback-snapshots.patch`.

## What it changes

`FeedbackTable::snapshot` copied every list in the JIT's feedback table each
time it was called. Now each feedback cell keeps the shared copy a snapshot
holds (`Entry::shared`; whole call and call-signature entries in `frozen`) and
makes it again only when that cell changes. A snapshot copies pointers instead
of allocating every list. The result is exactly what a snapshot built from
scratch would be.

## Root cause

While a newly loaded mod copy warms up, the JIT's maintenance takes a snapshot
at nearly every hot event: about 190 deep copies of the whole table per
Settings open, on the window thread (80% of its samples). The table also grows
with every open, because gpui-shell loads each copy as a new module generation
that QuickJS never frees, so each open got slower.

## Numbers (Windows, ledger id 4)

| Settings, later opens (40 each) | before | after |
| --- | --- | --- |
| command to drawn, median (p95) | 598 ms (1103) | 350 ms (651) |
| worst frame, median (p95) | 348 ms (696) | 185 ms (373) |
| main-thread busy, median | 661 ms | 399 ms |
| 10th open, command to drawn | 1077 ms | 403 ms |

Harness: mods ms per Settings frame 543 -> 38; main-thread long tasks p95
2728 -> 98 ms.

## Files touched

- `vendor/quickjs-jit-runtime/Cargo.toml`: two lines added to the header comment.
- `vendor/quickjs-jit-runtime/src/runtime/feedback.rs`: `shared` on `Entry`
  (about line 205), `frozen` on the call and call-signature entries (about
  lines 797 and 831), the mutators clear them, `FeedbackTable::snapshot` (about
  line 1325) uses them, and the test module `snapshot_cache_tests` at the end
  (about line 1445). Every change is marked `HERDR:`.

## Re-applying after an update

1. Update the vendored crate, keeping the `HERDR:` header in its Cargo.toml.
2. `git apply docs/patches/quickjs-jit-runtime-feedback-snapshots.patch`
   (add `-3` if the context moved). If it doesn't apply, redo it by hand from
   the `HERDR:` comments: every list a snapshot holds is kept per cell and
   cleared by that cell's mutator.
3. Check every `HERDR:` marker in `src/runtime/feedback.rs` is there.
4. Run the crate's tests (`snapshot_cache_tests::kept_copies_follow_every_change`
   checks every mutator). The crate has no workspace of its own: add an empty
   `[workspace]` table to its Cargo.toml and copy the app's `Cargo.lock` next to
   it, run `cargo test --release --lib`, then remove both.
5. Run the app's `cargo test --release --locked`. Changing the crate's
   Cargo.toml changes its hash in `THIRD-PARTY-NOTICES` (`tests/notices.rs`):
   run `just notices` (or update that one `Input-SHA256` line for a comment-only change).

If upstream has a fix of its own for the copying, drop this patch.

## Upstream

Not yet offered. Goes to longbridge/quickjs-jit, beside #38 (the other `HERDR:`
change in this crate, in `src/lib.rs`).

Not fixed here, for the maintainer: the module-generation leak in gpui-shell's
`load_app` (`vendor/gpui-kit/crates/shell/src/engine/quickjs/mod.rs`), which is
why the table grows with every overlay load.
