# Windows performance harness

Measures a release build on a real Windows desktop and writes numbers two builds
can be compared by. `scripts/bench.py` is the older cross-platform CPU bench; this
one adds startup phases, terminal opening, input latency, frame times, throughput
and a sampling profiler.

```powershell
# Needs cargo, zig, libclang and MSVC in the environment, and hc on PATH.
py -3.12 scripts/perf/perf.py run --label before          # builds, then measures: about 30 min
py -3.12 scripts/perf/perf.py run --label after --only open,frames
py -3.12 scripts/perf/perf.py compare .scratch/perf/<before>.json .scratch/perf/<after>.json
py -3.12 scripts/perf/perf.py live --pid 1234             # read-only, any process
```

Scenarios for `--only`: `cold`, `open`, `input`, `frames`, `throughput`, `idle`.

`compare` marks a change as real only if it moved by more than both runs' spread
(interquartile range) and by at least 5% (`--threshold`). `--all` shows everything,
`--grep open.tab` narrows it.

## What it won't touch

Each test instance has its own `HC_SESSION`, `HERDR_APP_HOME`, `XDG_STATE_HOME`,
`XDG_CONFIG_HOME` and app id, and the environment is rebuilt without `HC_*` and
`HERDR*`, because the shell it runs in may be a terminal of a live Zaki. Before
the first launch it proves the core is new and has a different id from the live
one. Processes are ended only by tracked pid and creation time. Test homes turn
the usage footer off (`usage.enabled: false`) so a test never runs the person's
real `claude` or `codex`.

Input goes to the test window's own HWND with `PostMessage`. It doesn't use
`SendInput` and doesn't move the mouse. The window opens on the real desktop, and
is told it's active by a posted `WM_ACTIVATE`, so it doesn't take the foreground
on purpose. Windows may still show it on top, and it may take focus briefly when
it opens, once per cold start.

## Instrumentation

All of it is off unless `HERDR_APP_BENCH_EVENTS=<file>` is set; each call is then
one relaxed load (see `src/bench.rs`). With it on, the app writes a JSON line per
mark, span and drawn frame, on the same precise clock the harness uses, so a key
posted here lines up with the frame that showed it. `src/bench/wndproc.rs` wraps
the test window's procedure to time whole frames including `Present`.

## Profiling

ETW needs elevation, so `HERDR_APP_PROFILE=<file>` starts a sampler inside the app
instead: 500 Hz, suspends a thread, copies its stack, resumes it, and unwinds the
copy. `profile` needs a build with line tables, which doesn't change the code:

```powershell
$env:CARGO_TARGET_DIR='target/symbols'; $env:CARGO_PROFILE_RELEASE_DEBUG='line-tables-only'; $env:CARGO_PROFILE_RELEASE_STRIP='none'
cargo build --release --locked --bin zaki
Remove-Item Env:CARGO_TARGET_DIR, Env:CARGO_PROFILE_RELEASE_DEBUG, Env:CARGO_PROFILE_RELEASE_STRIP
py -3.12 scripts/perf/perf.py profile --only idle,open
```

It writes `.scratch/perf/profiles/<time>-<scenario>-{main_cpu,main_blocked,background_cpu}.folded.gz`
(folded stacks, gzipped: `gzip -dc x.folded.gz | inferno-flamegraph > x.svg`), and
`<time>-summary.json` with the top functions by self and inclusive samples. A sample
counts as running only if its thread used more than 100k cycles since the last tick
and its innermost frame isn't a wait (`symbols.py` WAITS). Numbers from a
sampled run are not comparable with `run`: the sampler itself costs time.
