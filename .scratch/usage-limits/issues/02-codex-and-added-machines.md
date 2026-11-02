# 02 — Codex and added machines

**What to build:** The popover also shows Codex subscriptions, and shows subscriptions from added machines as well as this computer. One account on two machines is one row labelled with both, two accounts stay as two rows, and one machine failing leaves the others alone.

See `.scratch/usage-limits/spec.md`, stories 15, 26–32, 48 and 50, and ADR 0001.

**Blocked by:** 01 — Claude Code limits in the popover

**Status:** resolved

Codex:

- [x] A Codex subscription shows its tier name and every limit Codex reports, including a model's own
- [x] Codex is read through its own command, and its login stays in Codex
- [x] An API-key or signed-out Codex gives no row
- [x] A Codex check waits for its last answer rather than a fixed time on Mac and Linux

Machines:

- [x] Claude Code and Codex are checked on every added machine, on that machine
- [x] One account on two machines is one row, labelled with both and showing the newest numbers
- [x] Different accounts on two machines are two rows, each labelled with its machine
- [x] A row on this computer alone has no machine label
- [x] A row on an added machine is labelled with that machine
- [x] An unreachable machine keeps its last numbers, marked with their age
- [x] A shared row keeps the fresh numbers when one of its machines fails
- [x] A removed machine's rows go after the next check
- [x] Accounts are matched by a fingerprint, with no email stored

Tests and docs:

- [x] Tests cover Codex's answers and these machine cases through the faked `herdr`
- [x] Test data is sanitised
- [x] The user guide says Codex and added machines count, in the same commit
- [x] Each Codex check is watched on this Mac for leftover temp folders, and the result is noted here

## Comments

Built and merged to `feat/usage`. Added machines are tested through fakes only; ticket 05 covers real ones.

- Leftover temp folders: 8 real Codex 0.163.0 checks on this Mac left none in `~/.codex/.tmp` or `$TMPDIR`, and no process was left behind.
- 1 of those 8, the first, returned no `account` while its limits arrived. It is now a failed check that keeps the last numbers, not a signed-out result. The cause is unknown.
- `run` from `programs.json` is used only when its first word is the agent's own program; flags are dropped, so they can't reach background checks.
- Stories 28 and 29 clash. A row on this computer alone gets "This computer" only when another row of the same agent exists.
