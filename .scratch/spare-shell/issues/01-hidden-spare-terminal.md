# A hidden spare terminal in herdr-core, so a new tab shows its prompt at once

Status: ready-for-human
Owner: Can (herdr-core). Zaki's side: Zakiullah.

## Problem

On Windows, a new tab, split or space with the default shell takes about 1.4–2 s before its prompt shows. Nearly all of that is PowerShell 5.1 and the person's profile starting. The app's own part is about 50 ms (perf-windows branch, fixes 1 and 13 in `.scratch/perf/ledger.jsonl`). The app can't make PowerShell start faster, but it could start one ahead of time.

## Request

A way to start a terminal that stays out of sight until it's adopted:

- `terminal.run` (and `hc run`) takes a flag, for example `--spare` or a reserved label, that keeps the terminal out of `hc ls`, `events.subscribe` / the terminal list, and session restore.
- An adopt step turns it into a normal terminal: relabel it, or a `terminal.adopt <id>`. From that moment it shows up everywhere, with the next address (`tN`) as if it had just started.
- A spare that is never adopted is ended when its client disconnects, so a crashed app leaves nothing behind.

## Why the core

Today every terminal is listed. On an isolated core, `hc run --bg --keep --no-parent` with no command and no labels showed up in `hc ls --json` as `t1 powershell.exe live`. A spare would therefore be visible:

- in `hc ls`, to agents and to mods' `hc()`;
- in mods' `terminals()`, which documents "every core terminal" (`defaults/AGENTS.md`);
- and it would shift the next tab's `tN`.

Hiding it in the app alone would change a documented mod API, and `hc ls` would still show it.

## Zaki's side, once the core has it

- Start one spare default-shell terminal after first paint, in the folder the next new terminal would get.
- On a default-shell open whose folder matches, adopt the spare, then start the next one. Opens with a command, an agent or another folder start as today.
- Drop the spare and start a fresh one when the shell, its settings or the folder change. Close it on quit.

## Expected gain and cost

- About 1.4–2 s less per new default-shell terminal on Windows; not measured, since it needs the core change.
- One idle PowerShell process, about 60–80 MB.

## Comments
