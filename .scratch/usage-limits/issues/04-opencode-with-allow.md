# 04 — OpenCode with Allow

**What to build:** An OpenCode user sees a card saying what Zaki reads and where it goes, with Allow and Not now. After Allow, their Go limits appear in the popover. Their key goes only to `opencode.ai`, and nothing is read before they agree.

See `.scratch/usage-limits/spec.md`, stories 16, 25 and 53–59, and ADR 0001. This is the only part of Usage that sends a request itself, so its privacy rules matter most.

**Blocked by:** 01 — Claude Code limits in the popover; 03 — Background checks, orange dot and off switch

**Status:** ready-for-human

Consent:

- [x] With OpenCode installed and no answer yet, the popover shows the card: "Zaki reads your OpenCode key and sends it only to opencode.ai, to ask for your Go plan's limits."
- [x] No key is read and no request is sent before Allow
- [x] Not now hides the card for good, and no key is read
- [x] After turning Usage off and on again, the card asks again
- [x] Allow checks straight away, even during a running check, so limits don't wait 15 minutes

The check:

- [x] Keys come from OpenCode's auth file and its database's `credential` table only
- [x] A key written as a variable or a command is never sent
- [x] The request goes to `opencode.ai` and nowhere else
- [x] Go's weekly, 5-hour and monthly limits show, weekly first
- [x] A 401 or 403 gives no row and no error
- [x] A network failure keeps the last numbers with their age
- [x] OpenCode is checked on this computer only, decided in one place
- [x] The key is never saved in shared storage

Tests and docs:

- [x] Tests cover consent states, and answers of 200, 401 and 403, a bad answer and no network, through faked `herdr` and `fetch`
- [x] Tests prove `fetch` only reaches `opencode.ai`, and that shared storage never holds the key
- [x] Test data is made up, with no real key
- [x] The user guide describes the Allow step, in the same commit
- [ ] The card is looked at in an isolated dev window on this Mac
- [x] A real Go subscription stays unproven here, and is noted as such when this ticket closes

## Comments

Built and merged to `feat/usage`. Only the look is left, then this can be resolved. A real OpenCode Go subscription remains unproven: `goLimits` follows the draft and fake answers only.

- Allow's click saves the answer itself. The footer command only starts the check, and in a real app run it gave no consent. A mod can still call `setShared` directly, as mods are trusted; the guide tells agents never to.
- OpenCode saves no `who`, so nothing made from the key is stored.
- A key must look like a single token, which also blocks `{env:X}`, backticks and `%X%`.
- Harmless leftover: Allow pressed before a running pass reaches its agents sends two requests, and that pass's result is dropped.
