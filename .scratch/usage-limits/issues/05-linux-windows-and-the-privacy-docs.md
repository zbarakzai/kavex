# 05 — Linux, Windows and the privacy docs

**What to build:** Usage is proven on the systems it ships on, not only on the Mac it was built on, and the docs say exactly what it reads and sends. This needs a person with real Linux and Windows machines, and an added machine.

See `.scratch/usage-limits/spec.md`, stories 61, 66 and 67, and "Not proven" under Further Notes.

**Blocked by:** 01, 02, 03 and 04

**Status:** ready-for-human

Linux:

- [ ] Claude Code and Codex rows show correct numbers in the sandbox or on a real Linux machine
- [ ] The icon, popover and Settings row work there

Windows:

- [ ] Claude Code and Codex rows show correct numbers on a real Windows machine, through PowerShell
- [ ] The Codex fixed wait is long enough, or is replaced
- [ ] Any Windows quirk found is fixed next to the quirk, with a test, and other systems stay unchanged

Added machines:

- [ ] A real added machine shows its subscriptions
- [ ] The same account on this computer and an added machine shows as one row
- [ ] An added Windows machine is noted as unsupported, or fixed

Other unproven items:

- [ ] A real OpenCode Go subscription is tried if one is available, otherwise this stays noted as unproven
- [ ] Claude's 5-hour line is confirmed when it next appears, otherwise this stays noted as unproven

Docs:

- [x] The README's privacy section stays true, and names the OpenCode exception
- [x] The security doc says what Usage reads, what it runs and what it sends

## Comments

The Docs boxes are done on `feat/usage`. Everything else here needs real machines.
