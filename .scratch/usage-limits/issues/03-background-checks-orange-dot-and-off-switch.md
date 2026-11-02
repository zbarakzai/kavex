# 03 — Background checks, orange dot and off switch

**What to build:** Limits are checked every 15 minutes without opening anything, and the icon gets an orange dot when any limit reaches 90% used. A Usage limits row in Settings turns the whole feature off: the icon goes, checks stop, and saved data is cleared.

See `.scratch/usage-limits/spec.md`, stories 34, 45–47 and 62–65.

**Blocked by:** 01 — Claude Code limits in the popover

**Status:** ready-for-human

Background checks:

- [x] Checks run every 15 minutes from the always-mounted footer copy, so they carry on with the popover closed
- [x] The first background check starts 5 seconds after launch
- [x] Only one copy runs the timer, however many windows or footers exist

The warning:

- [x] The icon shows the orange dot when any limit is at 90% or more, and not at 89%
- [x] A bar at 90% or more turns orange
- [x] The dot clears once the limit passes its reset time
- [x] The dot and bar use the theme's blocked status color, with no hex

The off switch:

- [x] Settings has a Usage limits row in its Workspace group
- [x] Turning it off hides the icon and closes off every check, with no `exec` calls
- [x] Turning it off clears the saved numbers and the OpenCode answer
- [x] A check still running when it's turned off saves nothing
- [x] Turning it back on shows the icon and checks again

Tests and docs:

- [x] Tests cover the timer, the dot at 89 and 90 and after a reset, and each off case through the faked `herdr`
- [x] The user guide describes the Settings row, in the same commit
- [ ] The dot and Settings row are looked at in an isolated dev window on this Mac

## Comments

Built and merged to `feat/usage`. Only the look is left, then this can be resolved.

- No footer owns the timer. Each footer has a 1-minute watch and the first to find a check due marks it, so only one pass runs. Checks land every 15 to 16 minutes.
- A running pass holds an `era` in `usage`, and saves only into the era it started in, so a late pass can't restore cleared numbers.
- Turning back on checks within a minute, not at once.
- Background checks need a layout with the footer, so none run in Terminals or Zaki 98. The Settings row shows only in `main`.
