# Zaki on Windows: performance baseline

2026-11-03, commit `a84987d` (harness) on `worktree-perf-windows`, branched from `origin/master` at `b8179cd` (Zaki 0.4.0).
Release build, built as shipped (`cargo build --release --locked`, Rust 1.95.0, Zig 0.16.0).
Results: `20261103-090211-baseline.json` (run 1, commit `46935c8`) and `20261103-093948-baseline-2.json` (run 2, `a84987d`, the same app code). Profiles: `profiles/20261103-091402-*`.
Machine: Ryzen AI 9 HX 370 (24 logical CPUs), 32 GB, on AC, Balanced plan. Display 2560×1600 at 60 Hz on the Radeon 890M.
herdr-core 0.1.17.

## How to reproduce

```powershell
. <scratchpad>\perf-env.ps1                      # Rust, Zig, libclang, MSVC for this shell only
py -3.12 scripts/perf/perf.py run --label <name> # builds, then about 16 min of scenarios
py -3.12 scripts/perf/perf.py compare .scratch/perf/<a>.json .scratch/perf/<b>.json
py -3.12 scripts/perf/perf.py profile            # needs target/symbols, see scripts/perf/README.md
py -3.12 scripts/perf/open_delay.py              # the terminal-open stall on its own
```

## Noise: read this before any number

- **Herdr 1.x servers.** Four `herdr.exe server` processes (Herdr 1.x, started by hand as `herdr --session X` inside PowerShell terminals) used 65% of a core during both runs, and up to 90% earlier.
  - Each run records this in `meta.herdr_background_load`.
- **Other work on the machine.** A Python job from another project used 3 to 5 more cores throughout (`machine_other_load`, 350–570% of a core).
- **The live Zaki** used 15–30% of a core.
- **Run 1 vs run 2, same app code, about 40 min apart:**
  - `perf.py compare` found 4 of 163 headline metrics moved beyond their spread and 5%. The largest was 12.5%: first-run platform start, and a new tab's first bytes.
  - So treat differences under about 15% as noise.
  - CPU percentages are single readings per stretch, so compare them only across repeated runs. `compare` marks them `?`, not `*`.
  - Run 2 had heavier background load: up to 9.9 cores busy and herdr at 64–86% of a core.
- **The file cache was warm** for every cold start. Clearing it needs elevation.

What the test instances leave out, compared with an installed Zaki:
- **Usage checks are off** (`usage.enabled: false`), so a test never runs the person's `claude -p /usage` or `codex app-server`. A real install runs these PowerShell processes 5 s after start and every 15 min.
- **No update checks:** `HERDR_APP_RELEASE` is unset.
- **Telemetry collects but has no endpoint**, the same as shipped builds.

## Headline numbers (median, p95, n; run 1)

| What | Median | p95 | n |
|---|---|---|---|
| Cold start, warm home and running core: first painted frame | 1103 ms | 1233 | 12 |
| ... prompt visible / accepting commands | 1177 / 1352 ms | 1336 / 1467 | 12 |
| Cold start, core not running: first paint / prompt visible | 1292 / 2284 ms | 1410 / 2453 | 12 |
| Cold start, empty home (first run): first paint | 2167 ms | 2444 | 13 |
| New tab, default shell: command to prompt visible | 1872 ms | 2564 | 12 |
| New split / new space, default shell | 1790 / 1815 ms | 1879 / 1980 | 12 |
| New tab, `cmd.exe` | 1238 ms | 1443 | 12 |
| New tab, PowerShell `-NoProfile` | 1801 ms | 1904 | 12 |
| Same shells on the core with no app, first text (default / `-NoProfile` / cmd; run 2) | 1719 / 599 / 93 ms | 1873 / 726 / 107 | 12 |
| Keystroke to echo painted (cmd / PowerShell) | 13.1 / 13.2 ms | 20.2 / 20.6 | 120 |
| Hover sidebar: fps, main thread per frame | 58.7 fps, 5.1 ms | 7.1 ms | 479 |
| Tab switch: main thread per frame; command to frame | 14.0 ms; 27 ms | 20.4; 33 | 39; 20 |
| Open Settings: main thread per frame | 38 ms | 455 ms (max 700) | 35 |
| Palette: command to settled | 190 ms | 195 | 20 |
| Output throughput (visible / hidden tab / core alone) | 305 / 290 / 322 MB/s | | 3 |
| Idle, one terminal: app CPU, wakeups/s | 4.1–4.9%, 516–553/s | | 3×20 s |
| Idle: memory, threads, handles | 158 MB WS, 138 MB private, 45, 1223 | | |
| Idle, 22 terminals: app CPU, private memory | 3.0–4.2% (23% while settling), 266 MB | | 3×20 s |

## 1. Cold start

| Phase (warm home, core running) | ms from process start (median) |
|---|---|
| `main()` reached | 50 |
| finding the core (`core_bin::find`, spawns `hc --version`) | 78 (p95 141) |
| `hc connect` + hello | 67 |
| `mods::write_workspace` | 233 |
| GPUI platform up (`start:platform` 437 to `start:app_running` 773): DirectX device, DirectWrite | 336 |
| fonts, mods init | 16 |
| `open_window` (`AppWindow::new`: JS runtime 19, themes/icons 24, layouts 6, mod loads 92, first sync) | 310 |
| first render / first paint | 1072 / 1103 |
| prompt of the reattached terminal visible | 1177 |
| control socket answering | 1352 |

- **Core not running:** `hc connect` takes 192 ms, and the reattached terminal gets a new shell, so the prompt shows at 2.3 s.
- **Empty home:**
  - `write_workspace` takes 753 ms: it installs every default.
  - `open_window` takes 854 ms.
  - First paint is at 2.2 s.

## 2. Opening a terminal

Default shell: `powershell.exe -NoExit -Command "$global:__hc_prompt …"` (Windows PowerShell 5.1, no `pwsh` on PATH). The person's profile is loaded, and it runs `starship init`.

| Step (new tab, default shell) | Median |
|---|---|
| `zaki do` client to the app (harness only, not a person's click) | 60 ms |
| `tab.new` on the main thread, including `terminal.run` | 70 ms, of which `terminal.run` is 61 |
| `terminal.attach` done, first bytes (ConPTY's mode setup, nothing visible) | 161 ms |
| first bytes to first visible text | **1710 ms** |
| prompt visible | 1872 ms |

**Where the time goes depends on the shell** (run 2, medians, n = 12 each):

| Shell | bare process, no terminal | core alone, no app: first text | app: prompt visible | app adds |
|---|---|---|---|---|
| default (PowerShell 5.1 + the person's starship profile) | 1186 ms | 1719 ms | 1752 ms | +33 ms (noise) |
| PowerShell `-NoProfile` | 409 ms | 599 ms | 1763 ms | **+1164 ms** |
| `cmd.exe` | 71 ms | 93 ms | 1264 ms | **+1171 ms** |

- "Core alone" is the harness speaking the app's protocol to the same core, with `terminal.run` and then `terminal.attach` (`open.core_alone`). Run 1's value for it is wrong; that was fixed in a84987d.
- **For this person, opening a terminal is the shell starting.** PowerShell 5.1 takes about 0.4 s, the profile's `starship init` about 0.8 s more.
- **The core path adds about 0.5 s over the bare process.** That's ConPTY plus hc's prompt wrapper. Which of the two is unconfirmed.
- **Zaki adds nothing measurable here, because the stall below hides behind that 1.7 s.** With a fast shell it shows on every open.

**The core sends a terminal's first output about 1.2 s late, but only for terminals the app starts.** `scripts/perf/open_delay.py` starts `cmd.exe` three ways on one core, with the app running. A second viewer attaches as soon as the core announces each terminal, so it sees when the core sent the prompt, not when the app drew it.

| How `cmd.exe` was started | Prompt sent by the core after |
|---|---|
| `hc run --bg` | 209–238 ms |
| the harness's own `hc connect` connection (`instance.CoreClient`) | 93–137 ms |
| the app's `terminal.open` | **1534–1822 ms** |

Each of these was tried alone on the harness's connection. None made the prompt late; all stayed at 100–365 ms:
- resize at attach, after ConPTY's `?9001h`, or 30 ms later;
- a focus event, early or late;
- display facts;
- `zaki.space`/`zaki.tab` labels;
- a `terminal.label` call during startup;
- an active `events.subscribe`;
- the app adopting and attaching the terminal;
- a `doc.set` of the app's real layout document.

The stall isn't a fixed wait either: `cmd` comes out at about 1.26 s and `-NoProfile` at about 1.76 s. It depends on something in how the app starts the terminal, which the core's code would show.

## 3. Input latency

PostMessage `X` to the test window, then the app's input mark, the core's echo and the next frame. `cmd` and default PowerShell, n = 120 each.

| Step | cmd | PowerShell |
|---|---|---|
| window message to bytes sent to the core | 0.24 ms | 0.25 ms |
| core round trip (ConPTY, the shell's echo) | 0.75 | 1.27 |
| echo received to the frame starting (vsync pacing) | 8.8 (p95 16.1) | 7.8 (p95 15.0) |
| the frame (render, paint, Present) | 3.0 | 3.0 |
| **total, to Present returning** | **13.1 (p95 20.2)** | **13.2 (p95 20.6)** |

- **Typing isn't the problem.** Waiting for vsync is half a frame on average, as expected.
- **Not measured:** DWM composition after Present, about one more refresh (16.7 ms at 60 Hz). Measuring it needs PresentMon or ETW, which need elevation.

## 4. Frame times

Per drawn frame, the whole window message: render, prepaint and paint, then GPU submission and Present.

| Scenario | fps | main ms/frame p50 / p95 / max | over 16.7 ms | JS ms/frame | app CPU |
|---|---|---|---|---|---|
| hover sidebar | 58.7 | 5.1 / 7.1 / 10.0 | 0 | 0.01 (materialize 0.82) | 38% |
| hover tab bar | 58.6 | 5.3 / 8.0 / 10.0 | 0 | 0.00 | 42% |
| scroll 6000-line scrollback | 57.7 | 5.4 / 7.1 / 10.9 | 0 | 0.01 | 39% |
| tab switch (every 150 ms) | 4.7 | 14.0 / 20.4 / 22.4 | 9 of 39 | 3.83 | 13% |
| palette open/close | 18 | 4.2 / 15.4 / 56.0 | 4 | 0.77 | 17% |
| help open/close | 19 | 6.6 / 18.9 / 26.8 | 13 | 0.37 | 21% |
| **Settings open/close** | 4.2 | **38 / 455 / 700** | **22 of 35** | **35.5** | 63% |
| typing (above) | | 3.0 | 0 | | |

- **Render vs paint:** render (`AppWindow::render`) is about 0.2 ms everywhere. The time is in prepaint and paint (`frame_render_to_paint`), plus 1.1–1.4 ms of GPU submission and Present.
- **Mod loads on the main thread:** each open loads its mod there, taking 14 ms for the palette, 19 ms for Settings (p95 65) and 13 ms for help.
- **Resize: not measured.** Posting a `SetWindowPos` storm drew only 3 frames in 8 s, unlike a person's drag (Windows' modal sizing loop).

## 5. Throughput

The writer is 64 MB of 80-column lines in 64 KB writes.

| | MB/s, writer side | app CPU | VT parse on the main thread |
|---|---|---|---|
| visible tab | 305 (272–354) | 13–19% | 141 ms per run |
| hidden tab | 290 (271–358) | | 146 ms per run |
| core alone, no app | 322 (255–325) | | |

ConPTY is the limit, not Zaki. Zaki is within the noise of the core alone, and frames stay at about 6 ms.

## 6. Idle

| | app CPU | wakeups/s | main thread | VSyncProvider thread | WM_PAINT with nothing to draw | frames drawn |
|---|---|---|---|---|---|---|
| one terminal | 4.1–4.9% | 516–553 | 1.25%, 290/s | 0.94%, 76/s | 59.9/s at 0.06 ms | 0.1/s |
| start screen (no space) | 12.6% | 691 | | | | 18.5/s |
| agent working, no output | 11.4% | 758 | 81 ms/s in frames | | | 19.6/s |
| agent whose title changes every 0.5 s | 16.2% | 751 | 125 ms/s in frames, JS 31 ms/s | | | 22.5/s |
| 22 terminals (12 tabs, 4 splits) | 3.0–4.2% | 459–472 | 4.4%, 260/s | 0.94%, 66/s | 47/s | 0.05–0.2/s |

Memory and GPU:
- **Fresh instance:** 158 MB working set, 138 MB private, 45 threads, 1,223 handles.
- **With 22 terminals:** 266 MB private (about 6 MB per terminal), 51 threads.
- **GPU (Radeon 890M):** 17 MB dedicated and 85 MB shared.
- **Core, holder and ConPTY at idle:** under 0.3% of a core together.

### The live installed Zaki (read-only, PID 54660, 20 s, `perf.py live`)

| | live 0.4.0 | fresh test instance, one terminal |
|---|---|---|
| CPU | 24.4% of a core (main thread 18.0%, 2.0% of it kernel, 322 wakeups/s) | 4.1–4.9% (main thread 1.25%, 290/s) |
| VSyncProvider thread | 0.31%, 68.5 wakeups/s | 0.94%, 76/s |
| memory | 166 MB working set, **497 MB private** | 158 MB, 138 MB private |
| threads, handles | 74, 1416 | 45, 1223 |
| CPU so far | 10,213 s (5,680 s when the brief was written) | |

- **What the live app carries:** its core holds 22 live terminals, including working agents, this session among them.
- **How much of its load that explains (estimate):** a working agent alone costs about 7% of a core in redraws (section 6, ranking item 7), and memory grows by about 6 MB per terminal.
- **What it also does that the tests don't:** usage checks, update checks and git polling of real repos.
- **What I couldn't do:** sample the live process's stacks without attaching to it. The sampler runs only inside an app started with `HERDR_APP_PROFILE`.

## 7. Where the time goes (sampled)

The in-app sampler runs at 500 Hz on the symbols build. Folded stacks for each scenario and its main-thread CPU, main-thread blocked and background CPU are in `profiles/` (`20261103-091402-*`).

- **Startup (empty home):** `mods::write_workspace` → `sync_defaults` dominates. Its self time is `ZwCreateFile` 378, `ZwSetInformationFile` (rename) 193, `ZwClose` 78, `ZwWriteFile` 70 samples. The rest is the D3D11 device and AMD driver, plus DirectWrite.
- **Idle:** the main thread is on CPU 92 of 6,000 ticks. Most of it is `AppWindow::poll`, and file reads in `update_notes::cached_media`. The VSyncProvider thread wakes in `DwmFlush` every vsync.
- **Opening terminals:** the main thread blocks for 164 samples in `AppWindow::spawn` → `Core::run` → `call_timeout`, the synchronous `terminal.run`.
  - It also blocks for 113 samples in `ZwCreateFile`. 90 of those come from `sync_folders` → `mods::scan`, and 11 from `update_notes::cached_media`.
  - A further 36 on-CPU samples are in `persist::write_atomic` (view.json).
- **Hover and scroll:** the time is the whole window's prepaint and paint (`Window::draw_roots`, div prepaint), plus heap allocation (`RtlAllocateHeap` 111, `copyBlocks` 167). About 5% of the time waits on the GPU in `DirectXRenderer::present`.
- **Main-thread JS (QuickJS JIT)** shows in tab switches and Settings, and is small elsewhere.
- **Spawns:** every process spawned from Rust goes through `spawn::command`, with CREATE_NO_WINDOW. No spawn without it is reachable on Windows except `explorer.exe` (links.rs:208).
- **`process_cwd`** is a no-op on Windows (`process_cwd.rs:31`).

### GPU backend

- **Backend:** Direct3D 11.1 through DirectComposition, flip-sequential swap chain, `Present(0)` without a vsync wait (`directx_renderer.rs:251`). Pacing comes from the VSyncProvider thread's `DwmFlush`.
- **Adapter:** `EnumAdapters(0)` with no GPU preference (`directx_devices.rs:116`), so Windows' default. Here that's the Radeon 890M, which drives the built-in display ("Using GPU: AMD Radeon(TM) 890M Graphics").
- **Present cost:** 1.1–1.4 ms of each frame after paint.
- **Unmeasured:** a window on a display driven by the RTX 5090 would pay a cross-adapter copy.

## 8. The live herdr.exe processes

Unrelated to Zaki's code.
- **What they are:** each heavy `herdr.exe server` (PIDs 14276, 25892, 28212, 33196) is Herdr 1.x's own server, running under a `herdr.exe --session <name>` client.
- **Who started them:** a person started those clients in PowerShell terminals hosted by herdr-core holders. Zaki's only part is that its terminals host the PowerShell.
- **What they cost:** 18–28% of a core each, 72–85% of it in the kernel.
  - About 900 wakeups/s and 4,000–5,000 page faults/s each, on tokio worker threads.
  - Almost no I/O (about 10 reads/s), and their clients use 0.3–1.2%.
- **Why (unconfirmed):** this looks like an internal polling loop. Herdr 1.x is not in this repository, so I can't name it.
- **Total:** together about 65–90% of a core, all day. Closing unused Herdr 1.x sessions would remove it.

## Ranked bottlenecks

Ranked by what a person notices. Gains are estimates unless marked measured.

1. **Opening a terminal takes about 1.75 s, and for this person that's the shell starting.**
   - Measured, run 2: tab 1.75 s, split 1.73 s, space 1.81 s, p95 about 1.9 s.
   - The same default shell started on the core with no app takes 1.72 s to first text. Bare Windows PowerShell 5.1 takes 0.41 s, and with the starship profile 1.19 s.
   - Cause:
     - PowerShell 5.1 startup plus the person's profile, on every open, serially.
     - About 0.5 s more in the core path (ConPTY and hc's prompt wrapper), unconfirmed which.
     - `terminal.run` is 50–60 ms of it (item 6).
   - Sure: high.
   - Fix:
     - Needs herdr-core: a pre-started spare shell handed out on `terminal.run` takes the shell's start off the click. Only the core can hold one.
     - In the app: nothing big. The core already picks PowerShell 7 when installed (defaults/AGENTS.md, Commands), and it isn't here.
     - The profile is the person's.
   - Gain: up to about 1.6 s per open with a warm spare; about 0.5 s if the core path matches the bare process.
2. **Terminals the app starts get their first output about 1.17 s late, in the core.**
   - Measured: `cmd` 1.26 s in the app vs 0.09 s on the core alone; `-NoProfile` 1.76 s vs 0.60 s.
   - `scripts/perf/open_delay.py`: `cmd` started by `hc run --bg` is ready in 0.21–0.24 s, by another connection in 0.09–0.14 s, by the app in 1.53–1.82 s. A second viewer sees the same, so it happens before the app.
   - Hidden for this person behind the 1.7 s profiled shell. It costs everyone with a fast shell (cmd, `-NoProfile`, a lean pwsh).
   - Cause: something about the app's own `hc connect` connection (`hc.rs:255`) or its call. Every message the app sends was ruled out one by one (section 2).
   - Sure: high on cost and place, unknown on cause.
   - Fix: needs herdr-core (Can) together with the app: run `open_delay.py` with the core's logging or code.
   - Gain: about 1.2 s per open for fast shells; about 0 for the default here.
3. **Cold start does about 0.65 s of avoidable work before the first frame.**
   - Measured: first paint at 1.10 s.
   - `write_workspace` takes 233 ms warm and 753 ms fresh (`mods.rs:62`: 29 unconditional writes to `frame/`, 499 reads and hashes in `sync_defaults`, `mods.rs:97`). Windows file creation and renames dominate (profile).
   - Finding the core takes 78 ms (`core_bin.rs:78,86`: `hc --version` is spawned even when settings name the core).
   - GPUI platform start is 336 ms and `open_window` 310 ms, both serial after the core connect.
   - Sure: high.
   - Fix, in the app: write only what changed and off the main thread; cache the core's version; connect to the core in parallel with the platform start.
   - Gain: about 250–400 ms warm, 700+ ms on first run.
4. **Opening Settings freezes the window for up to 0.7 s.**
   - Measured: frames at a 38 ms median, 455 ms p95, 700 ms max; mods JS 35 ms per frame; one 604 ms main-thread task.
   - Cause: the Settings mod's JS render plus a synchronous mod load (`window.rs:1511`, 19 ms). Which part of `defaults/mods/settings` is unconfirmed; it wasn't profiled on its own.
   - Fix: in mods.
   - Gain: about 0.5 s of jank per open.
5. **File I/O on the main thread during ordinary use.**
   - `sync_folders` → `mods::scan` runs every 25th poll (10 s) and on mod-folder file events (`window.rs:3632,3669,3685`).
   - During the open scenario it ran about 9 times and was the main thread's largest blocking cost after `terminal.run` (90 blocked + 30 CPU samples). What writes into `mods/` when a terminal opens is unconfirmed.
   - `persist::write_atomic` of view.json runs on every `sync` (`ui:save` 6–10 ms per new tab, `window.rs:1034`).
   - `update_notes` media reads run every 400 ms (`update_notes.rs:204`).
   - Sure: high on the cost, medium on the trigger.
   - Fix: in the app; move to a background thread, or skip when nothing changed.
   - Gain: removes 10–30 ms hitches.
6. **`terminal.run` blocks the UI thread.**
   - Measured: 51–61 ms median, 92–112 ms max, per new terminal (`window.rs:2247` → `hc.rs:370`, sampled in `AppWindow::spawn` → `Core::run`). The window can't draw meanwhile.
   - Fix: in the app; start it on a background thread and show the pane when it returns.
   - Gain: 50–110 ms less freeze per open; the total time doesn't change.
7. **Any working agent keeps the whole window redrawing at about 20 fps.**
   - Measured: 19.6 fps with no output, 11.4% of a core vs 4.5% idle, 81 ms/s of main-thread frames.
   - Cause: the `loader` dots' `.loop` in the tabs, spaces and agents mods wakes a full re-materialize every 33 ms (`vendor/gpui-kit/.../materialize.rs:3020`), redrawing the whole window. The lead said 30 fps; the measured rate is 20 fps.
   - Fix: in mods and gpui-kit; an animation that repaints only itself, or a lower rate.
   - Gain: about 7% of a core per window while an agent works.
8. **One event refreshes every mod.**
   - Measured: an agent title changing twice a second gives 3.9 refreshes/s of all copies, 31 ms/s of JS (about 8 ms per refresh) and 16.2% of a core.
   - Code: `window.rs:1533` refreshes all copies, hidden ones too.
   - Fix: in the app; refresh only copies whose inputs changed.
   - Gain: about 5% of a core per busy agent, and less jank.
9. **Hover redraws the whole window on every mouse move.**
   - Measured: 59 fps at 5 ms of main thread per frame, 38–42% of a core while the mouse moves. No dropped frames.
   - Fix: in gpui-kit and the app; notify only the hovered view.
   - Gain: CPU and battery, not latency.
10. **Windows vsync wakes an idle window every frame.**
   - Confirmed in code: `vendor/gpui-pre-windows/src/platform.rs:487` calls `RedrawWindow(RDW_INVALIDATE)` for every window on every vsync. The macOS copy has an idle patch (`vendor/gpui-pre-macos`, HERDR:).
   - Measured at idle: 60 empty WM_PAINT/s at 0.06 ms each, plus the VSyncProvider thread at 0.94% of a core and 76 wakeups/s. That's about 1.3% of a core and about 136 of the app's 520 wakeups/s, roughly a third of idle CPU.
   - Fix: in the app's vendored GPUI; stop invalidating while no frame is requested, as on macOS.
   - Gain: about 1.3% of a core and 136 wakeups/s at idle, on every Windows machine.
11. **Tab switches go over budget.**
    - Measured: 14 ms median main thread per frame, 9 of 39 frames over 16.7 ms, 3.8 ms of mods JS per frame, 27 ms from command to frame.
    - Fix: in the app and mods; fewer refreshes per switch (see 8).
12. **The empty start screen animates all the time.**
    - Measured: 18.5 fps and 12.6% of a core with no space open (`defaults/mods/start/main.js:83-98`).
    - Fix: in mods; stop after a while or when the window isn't focused.
13. **Memory grows with terminals.**
    - Measured: about 6 MB private per terminal, since every tab stays attached with 2,000 lines of history parsed on the main thread (`window.rs:1372`). The live app has 497 MB private and 74 threads.
    - Fix: in the app; detach hidden terminals, or keep less history. Medium priority.
14. **GPU adapter choice: not a bottleneck here.**
    - Measured: the iGPU is picked through `EnumAdapters(0)` (`directx_devices.rs:116`). Present costs 1.1–1.4 ms per frame, and frames meet budget.
    - Risk (unmeasured): a window on the RTX-driven display.
    - Fix: optional, in vendored GPUI; pick the adapter of the window's monitor.

### The leads, confirmed or ruled out

| Lead | Verdict | Numbers |
|---|---|---|
| `terminal.run` on the UI thread | confirmed | 51–61 ms median main-thread block per open; profile stack `AppWindow::spawn` → `Core::run` |
| `update.rs:138` changelog re-parse every 400 ms | confirmed, small | 1.2 ms per poll (p95 1.8): about 0.3% of a core |
| `mods.rs:62` start-up file I/O | confirmed, large | 233 ms warm (21% of time to first paint), 753 ms on first run |
| VT parse on the main thread | confirmed, ruled out as a cause of lag | always on the main thread; 0.23 ms per batch; 141 ms per 64 MB run; Zaki's throughput within noise of the core's |
| refresh of all mods per event | confirmed | about 8 ms of JS per refresh, about 2 refreshes per title change |
| ~30 fps redraw while an agent works | confirmed at about 20 fps | 19.6 fps, +7% of a core |
| vsync invalidates every frame | confirmed, measured | about 1.3% of a core, 136 wakeups/s at idle |
| adapter choice | confirmed: Radeon 890M | not a bottleneck on this display |

### Not measured, and why

- **Photon latency and GPU time per frame:** they need PresentMon or ETW, which need elevation.
- **Interactive resize:** posted `SetWindowPos` calls don't drive redraws the way a drag does.
- **Context menus:** posted right-clicks weren't scripted. The palette, Settings and help overlays stand in.
- **Cold start with a cold disk cache:** clearing the cache needs elevation.
- **Inside herdr-core and Herdr 1.x:** their source isn't in this repository, so the open stall's exact cause and the servers' polling are unconfirmed.
