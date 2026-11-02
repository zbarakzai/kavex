# 05 — Added machines, Linux and Windows

**What to build:** Everything from tickets 01–04 works the same on added machines and on Linux and Windows. Numbers on added machines refresh every 30 seconds, setup runs on the machine the agent is on, and where something can't be read, the row shows no percent rather than a wrong number.

See `.scratch/session-context-and-cost/spec.md`, stories 46–51, and ADR 0002.

**Blocked by:** 03 — Codex with its hook; 04 — Pi with its add-on

**Status:** ready-for-human

Added machines:

- [ ] Agents on an added machine show the same percent and dropdown
- [ ] Sessions are read on the agent's own machine, every 30 seconds, only while the row is listed
- [ ] Claude's `/context` check runs on that machine, once per model
- [ ] The Codex hook and Pi extension are set up on that machine, under the same rules as here
- [ ] The person approves the Codex hook once per machine
- [ ] A machine going offline keeps the last numbers, and rows don't flicker
- [ ] A machine that doesn't have `hc` where the hook expects it shows `–`, and never a wrong number

Linux:

- [ ] Claude, Codex and Pi work as they do on a Mac
- [ ] It's checked in the Linux sandbox

Windows:

- [ ] A filter that handles 100 MB session files is chosen and tested on a real Windows machine
- [ ] Claude's per-process record and process id are checked on Windows, including whether the foreground process matches it
- [ ] The Codex hook has a Windows command, through `commandWindows`
- [ ] The Pi extension works on Windows
- [ ] Anything that fails shows no percent, with no error
- [ ] Mac and Linux behaviour stays unchanged, and tested

Tests and docs:

- [ ] Tests cover an added machine's terminal, an offline machine, and the Windows path handling, through the same seam
- [ ] Platform differences sit behind one small module, as the project rules ask
- [ ] The user guide covers added machines and Windows, in the same commit
- [ ] Zakiullah checks it on their Windows machine before this ticket closes
## Comments

Built on `session/05-machines`, in the `agents` mod. **Nothing here has run on a real added machine, on Linux, or on Windows.** All three are built and tested at the seam, and the ticket stays open until you've checked them. No dev window was opened, as asked.

### What I found that changes the plan

1. **On Windows, the foreground process is not Claude.** herdr-core's `foreground()` on Windows returns "the program it started", as a pseudo console has no foreground group. Zaki starts agents inside a shell, so `foreground.pid` is the shell, and the route in the spec and ADR would have found no record on nearly every Windows Claude. What I built: on Windows, Zaki walks the processes under that pid and reads the first record it finds, parents first, re-walking at most every 30 seconds per terminal. It stays exact, not a guess by folder. **Needs your eye:** one more PowerShell per Claude row every 30 seconds.
2. **`hc file write` with no input blanks the file.** It exits 0 and writes 0 bytes (seen on an isolated core). A mod's `exec` and `hc()` have no stdin, so the spec's route, called plainly, would have emptied a person's `hooks.json`. The text is now piped in from a shell here: `sh` on Mac and Linux, PowerShell on Windows.
3. **An added machine's reads can't be 8 MiB.** Output comes back as base64 inside the same 8 MiB cap, so anything over about 6 MiB fails outright, which a Pi session could hit. Windows are 4 MiB there.

### Where this differs from the spec, and why

4. **The Windows "filter" is a small reader, not a filter.** `findstr` and `Select-String` can't start at an offset, per their official docs, so whole-file output would hit exec's silent 8 MiB cut and lose usage lines: a wrong number. It opens the file shared, reads one window, and prints matching lines as raw bytes, the same contract as `dd | grep`.
5. **"Only while the row is listed" means a row in the list on added machines.** An `agents()` entry, or a sub-agent of one. A terminal with no row there isn't read. This computer is unchanged.
6. **An idle session on an added machine sends only its size.** Not in the spec. Without it each idle agent re-sent up to 2 MiB every 30 seconds.
7. **A machine with only shells left still gets a pass**, or a stale label would outlive its agent there.
8. **Offline is `machines()` saying `unavailable`**, which also covers a connected machine whose layout read failed. Reading pauses for both.
9. **`writeTextFile`'s refusal to overwrite is weaker on added machines.** `hc file write` isn't compare-and-swap, so the file is re-read just before writing. A small race remains, as the spec expected.
10. **Git for Windows' `sh` counts as Windows**, by its `uname`, or its paths wouldn't match what agents write.
11. **The guide now says "Nothing leaves your own machines"**, as numbers do cross your line to your own machine. Spec story 52 says "nothing sent over the network".
12. `sizes.js` moved into `machine.js`, and the Codex `.ps1` now reads stdin as UTF-8, or a non-ASCII path would be mangled. `setup` stays 1: this has never shipped.

### Risks I can't close from here

- **PowerShell cost on Windows.** Each read and helper listing starts a PowerShell, roughly 0.3 s each by estimate, one at a time. A dozen busy agents could keep one running nearly all the time. It's off the main thread, but please watch CPU. If it's too much, the fix is a longer interval on Windows.
- **A stale Claude record on Windows.** A crash can leave `sessions/<pid>.json`, and Windows reuses pids fast. If such a pid lands on a process under the terminal, ahead of the real Claude, that row shows the old session. Rare, but it is the one wrong-number path here.
- **A hook file that can't be read on an added machine** looks like no file (`cat` fails, `readTextFile` gives null), so Zaki would replace it. Here that's refused; there it isn't. Permission-denied only. An invalid file is still left alone.
- **`claude` or `codex` not on the core's PATH on an added machine:** no percent. Fine, but it may be common.
- **An unrelated `hc` first on PATH** stops the hook's search: `–`, never a wrong number.
- **Lines over 1 MiB crossing a window edge are lost** (see 04), twice as likely with 4 MiB windows on Pi.
- **Setup text over 128 KiB (Linux) or about 32 KB (Windows)** can't go through the argument: setup fails and the row stays `–`.
- **`files/ops.js` has the smart-quote bug** this ticket avoids: a Windows path with `’` breaks out of its string. Not touched, worth its own ticket.

### Acceptance boxes

**Verified**

- Mac and Linux behaviour stays unchanged, and tested: all 187 earlier tests kept, one replaced by a stronger one and two trimmed since new tests cover them, 228 in `sessions.test.ts`; every `bun test` line in the recipe plus `docs.test.ts` passes. The read script changed slightly, and its new form ran under `/bin/dash` on real files.
- Tests cover an added machine's terminal, an offline machine and the Windows path handling, through the same seam.
- Platform differences sit behind one small module: `machine.js`.
- The user guide covers added machines and Windows, in the same commit.
- Each failure-guard test was broken on purpose and seen to fail. That exposed one weak test (stuck machine), now fixed, and two mutations that hadn't applied, now redone.

**At the seam only, not on a real machine**

- Agents on an added machine show the same percent and dropdown.
- Sessions read on the agent's machine, every 30 seconds, only while listed.
- `/context` on that machine, once per model.
- Hook and extension set up on that machine, under the same rules (see 9).
- A machine going offline keeps the last numbers. The core's source says its terminals stay listed; not observed.
- A machine without `hc` where the hook expects it shows `–`.
- Anything that fails on Windows shows no percent, with no error: six failure kinds, against stand-ins.
- The Codex hook has a Windows command through `commandWindows`: present, and the key confirmed in Codex's docs. Never run.

**Not verified, with the reason**

- **The person approves the Codex hook once per machine.** Zaki never writes the approval (tested), but no real approval happened anywhere.
- **Anything against a real second core.** A local one through `hc machine add --via` was the plan. A guard refused the command and I didn't reword it. So `--on` itself, real mirrored labels and foreground, and a real offline are all unseen. An isolated single core did confirm `hc exec` and `hc file write` behaviour.
- **Claude, Codex and Pi work on Linux as on a Mac.** Same code as a Mac, plus the `dash` run with BSD tools. GNU `dd`, `wc` and `grep` weren't run.
- **Checked in the Linux sandbox.** `scripts/sandbox` needs Weston, which isn't here.
- **A filter chosen and tested on a real Windows machine.** Chosen from official docs; never run, no `pwsh` here, so no timing on 100 MB either.
- **Claude's per-process record and pid on Windows.** The foreground question is answered from source (item 1). The record's shape and path, the process walk, and Claude's folder naming for `C:\` paths are all unproven.
- **The Pi extension works on Windows.** Plain JS, never run there.
- **`zaki check` and the real-runtime timing.** The brief allowed only the `bun test` lines. The new code is small per step, but nothing was timed under QuickJS. I did check the new imports against `herdr.d.ts`.
- **Zakiullah checks it on their Windows machine.** Yours. Order that would save time: (1) does PowerShell read a big live session, and how fast; (2) does a Claude row show a percent; (3) `/hooks` approval on Codex; (4) Pi.

2026-11-01: code is on `feat/session-context` at 829bbe4, review fixes included. Set to `ready-for-human`: the unticked real-world checks above are the person's to do. Decisions and what is left are in `notes/review.md` and the comments above.
