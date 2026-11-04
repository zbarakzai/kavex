# Zaki on Windows: final before and after

- **Before:** the two recorded baseline runs, 2026-11-03: `20261103-090211-baseline.json` (46935c8) and `20261103-093948-baseline-2.json` (a84987d). Both are the same app code, Zaki 0.4.0 plus the harness.
- **After:** one full run, 2026-11-04: `20261104-162754-final-head-1.json`. It ran `bins/zaki-fix12.exe` (sha256 90b1ab29…), which has all the app code of fixes 2–12d.
  - Checked against HEAD's source: the exe embeds HEAD's `defaults/mods/tabs/main.js`, `tabs-column/main.js` and `defaults/AGENTS.md` byte for byte. It also contains 12a's `core-checked.json`.
  - 12b's A/B measured this same exe syncing once per new tab.
  - The commits after it (141263e, e4833d4) change only a `#[cfg(test)]` module and records.
- **All rows:** `final-comparison.json` (median, spread, change, fix ids, verdict per row).

## Read this first: the two days are not the same machine state

- The machine's other load was much higher for the after run: a median of 651% of a core across scenarios, peaking at 1708%, with herdr.exe at 104%. The baseline runs had a median of 405–457%, peaking at about 1000%, with herdr.exe at 64%.
- The runs were not alternated: one after run against two recorded before runs.
- The same PowerShell started on the core with no app took 19% longer than on the baseline day (1719 → 2053 ms first text), and bare `powershell -NoProfile` took 25% longer. Any change under about 20% in a load-sensitive row is not evidence either way.
- Wakeups/s: the harness now counts context switches per thread (it changed after the baseline), so baseline wakeups are slightly off.

## Headline (median; spread = within-run IQR or run-to-run range, the larger)

| What | Before | After | Change | Fixes |
|---|---|---|---|---|
| Start, core running: first frame | 1119 ms ±130 | 947 ms ±179 | −15% (within spread) | 3, 12a |
| Start, core running: accepting commands | 1359 ±176 | 1227 ±261 | −10% (noise) | 3, 12a |
| Start, no core: first frame | 1320 ±100 | 1074 ±131 | **−19%** | 3, 12a |
| Very first start (empty home): first frame | 2257 ±229 | 1397 ±69 | **−38%** | 3 |
| Very first start: accepting commands | 2722 ±346 | 1671 ±608 | **−39%** | 3 |
| Window frozen per new tab / split | 66 / 75 ms | 0.09 / 0.08 ms | **−99.9%** | 2, 12b |
| New tab, default shell: prompt visible | 1812 ±211 | 2042 ±124 | +13% (shell alone +19% today) | — |
| New tab running `cmd.exe`: prompt visible | 1251 ±128 | 1838 ±229 | **+47%, see below** | ? |
| Keystroke to echo, cmd / PowerShell | 13.5 / 13.2 ms | 4.9 / 5.3 ms | **−64%** / −60% (spread 8.5) | 9 |
| Hover sidebar: fps / app CPU | 58.6 fps / 40% | 11.3 fps / 12% | measurement corrected | 5 (5b) |
| Hover tab bar: fps / app CPU | 58.6 fps / 39% | 17.8 fps / 15% | measurement corrected | 5 (5b, 12c) |
| Tab switch: command to frame | 28.2 ±7.2 | 20.6 ±3.1 | **−27%** | 10, 12b, 12d |
| Tab switch: main thread per frame | 14.8 ±3.8 | 18.6 ±3.1 | +25% (within spread) | — |
| Tab switch: frames over 16.7 ms per 8 s | 12 ±6 | 30 | **worse, see below** | — |
| Settings loop: worst frame / p95 frame | 727 / 456 ms | 375 / 250 ms | **−49% / −45%** | 4 |
| Settings opens done in 8 s | 10 | 12 | +20% | 4 |
| Palette: command to settled | 189 ±10 | 201 ±8 | +6% | — |
| Idle, one terminal: app CPU / wakeups | 4.2% / 535/s | 1.8% / 265/s | **−57% / −50%** | 9, 10 |
| Idle, one terminal: empty WM_PAINTs | 59.9/s | 0.2/s | **−99.6%** | 9 |
| Idle, 22 terminals: app CPU / wakeups | 4.2% / 586/s | 3.0% / 349/s | −29% (noise) / **−41%** | 9, 10 |
| Agent working: main-thread frame ms per s | 79.8 | 61.8 | **−23%** (CPU −5%, noise) | 7, 9 |
| Agent title changing: app CPU / mod ms per s | 18.2% / 30.2 | 13.9% / 21.1 | **−24% / −30%** | 6 |
| Start screen (animating): app CPU / fps | 13.3% / 18.6 | 15.6% / 21.2 | +18% / +14% | (8 not kept) |
| Scrolling: app CPU / main thread per frame | 38.7% / 5.2 ms | 30.1% / 7.3 ms | −22% / +40%, at 37 fps vs 58 | — |
| Output into a visible / hidden tab | 301 / 296 MB/s | 323 / 337 MB/s | within noise | — |
| Idle, 22 terminals: private memory | 263 MB | 298 MB | +13% | — |

## What regressed or stayed bad

1. **New tab running a program (`cmd.exe`): 1251 → 1838 ms.**
   - Across every full run up to fix 6 (414a556) it read 1300–1480 ms at 520–850% load. Only this run reads 1838 ms, with one 5.5 s outlier.
   - The app's own steps grew a little: CLI to app 54 → 76 ms, attached 132 → 176 ms. Nearly all of the rise is in "first output to ink", the wrapped PowerShell starting (1137 → 1647 ms).
   - Either today's load or one of fixes 5b–12d. One run can't tell which.
   - **Next step:** a focused open-only A/B, `zaki-fix12.exe` against `zaki-head10.exe` / `zaki-head11.exe`, alternated, before calling it a regression.
2. **Tab switch over budget: about 30 frames over 16.7 ms per 8 s, against 9–15 on the baseline day.**
   - It has read 30–36 in nearly every full run since fix 2's, so the drift is not from 12a–12d.
   - Command to frame improved (28 → 21 ms), so a switch shows sooner, but its frames are heavier under this load.
   - Cause (fix 11): three sidebar mods redraw identical output on every switch. Fixing it needs a narrower mod API (maintainer).
3. **Scrolling drew 37 fps instead of 58.**
   - Per-frame main thread is up (5.2 → 7.3 ms) while CPU is down. With 712% other load in that stretch this looks like the machine; no fix touched scrolling.
   - Worth one repeat before reading anything into it.
4. **Start screen still costs about 15% of a core** while it animates. Fix 8 (a vendor patch) was not kept; the rest is a design call.
5. **Opening a terminal is still about 2 s**, nearly all PowerShell 5.1 and the profile starting.
   - Needs herdr-core (a pre-started spare shell).
   - A tab running a program also pays the documented interactive-shell wrapper, about 1.2 s (fix 1; maintainer).
6. **Settings still takes about 350 ms to open and gets slower with each open** (gpui-shell keeps every overlay load as a new module generation; fix 4 notes; maintainer).

## Ledger check (commit e4833d4)

- **Fix 4:** the first metric was `frames.settings.frame_main_thread_ms` 11.67 → 50.15. It is a median over all frames drawn in the stretch, and the after stretch completed 11 opens in 47 frames against 3 in 15. Its p95 and max fell 2698 → 330 and 2835 → 419 ms. The row now leads with the per-open A/B: worst frame 348 → 185 ms, command to drawn 598 → 350 ms.
- **Fix 11** reads as a regression because it records a rejected experiment (kept=false). That is correct.
- **No row has before/after swapped.**
