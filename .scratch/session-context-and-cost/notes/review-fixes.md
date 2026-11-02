# Review fixes: facts worth keeping

Branch `session/review-fixes`, on `feat/session-context` with `master` merged.

## App facts
- `readTextFile` here: null only for NotFound, anything else rejects (`mod_files.rs`). On an added machine: null for ANY failed `cat`, and invalid UTF-8 comes back with U+FFFD (`read_remote`, `from_utf8_lossy`). So setup uses `machine.files.read`, which asks the machine; session reads keep plain `machine.read`, or each missing Claude record would cost a PowerShell on Windows.
- `writeTextFile` has no path limit. Only `fs/promises` is limited, by `write_roots([app_dir()])` (`src/mods.rs`).
- `test -e` can't tell "folder can't be entered" from "missing". `LC_ALL=C cat` and its ENOENT words can.

## Real Codex files (404 files, read only)
- All 4 "uncounted" helpers are detectable from the parent's own lines, no tree search. 3 are in a spawn reply: `{"agent_id":"<uuid>","nickname":...}` as `function_call_output`, or in `custom_tool_call_output` with an array `output`. Only 3 such lines exist in the whole tree.
- The 4th is `source: {subagent: "review"}`, the only one of its kind (cli 0.144.4). Its parent never names it, but writes `item_completed` with `item.type` `EnteredReviewMode`. There's no `entered_review_mode` event in these files.
- Result: the 96.0 MB session (the 91.6 MiB one) reads no price, was $48.72. 150 of 158 sessions stay priced.

## Real Claude records
- `startedAt` was 0.7 to 1.7 s after the process's start on all 5 records looked at. `procStart` is `ps lstart` text, so not portable to Windows.

## Reading
- A window now reads on to the end of its last line (`dd ... | head -n 1`). With that, a window's first line is always a harmless tail, so `i > 1 || block === 0` is the rule for `torn`.
- `torn` lines clear when a whole line starting with them arrives (half written). A line over 1 MiB caught half written can stay `torn`: fails to no price, on purpose.
- Windows here are 7 MiB, to leave exec room for that line. Added machines stay 4 MiB. A kept line over about 2 MiB there makes exec reject, so the last result stays: stale, as any failed read.
- Only Pi reads `torn`. Claude and Codex still skip a broken line, as their tests say.

## Traps
- The guard refuses heredocs, `sed` with computed values, python with computed args and `cd` to the shared checkout. Use Write and Edit, and script files run plainly.
- `chmod 000` tests need a fake `hc` that swaps files in: `cat >` refuses a mode-000 file and hides the bug.
- The `NEW_LINES_WINDOWS` extension and `ABSENT_WINDOWS` have never run. Tested against fakes only.
- The main checkout has uncommitted `CONTEXT.md` terms (Session, Context, API cost) and `docs/adr/0002`, not on any branch here.
