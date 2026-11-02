# 01 — Claude Code limits in the popover

**What to build:** A gauge icon in the sidebar footer opens the Usage popover, which shows the Claude Code subscription on this computer: tier name, each limit with a bar, percent used and time to reset, weekly first. The popover refreshes on open and from its refresh button, and tells the person how old the numbers are. This is the first path through every layer, and it sets up the test file the later tickets add to.

See `.scratch/usage-limits/spec.md`, stories 1–14, 17–24, 33, 35–44, 49, 51, 52 and 60, and ADR 0001.

**Blocked by:** None — can start immediately

**Status:** ready-for-human

Before starting:

- [x] The draft in the `zaki-usage` worktree is rebased onto current master
- [x] The draft is reviewed against the spec and treated as a draft, not as finished work

The icon and popover:

- [x] The gauge icon shows in the footer beside Add machine and Settings, and stays off the collapsed rail
- [x] The icon shows even when no subscription is found
- [ ] Clicking it opens the popover, and a second click closes it
- [x] The popover is 340 px wide, up to 480 px high, sized to its content, and uses only theme colors
- [x] A row shows Claude's logo, name and tier name, with each limit's bar, percent used and time to reset
- [x] Weekly limits come first, then model limits, then the 5-hour limit when Claude reports it
- [ ] Bars animate when their numbers change, and times keep counting while the popover is open
- [x] A limit past its reset time reads 0% before the next check

Checks:

- [x] Opening the popover checks, reusing a result under a minute old
- [x] The refresh button forces a check
- [x] The footer line shows "Checking…" or how long ago the numbers were updated
- [x] Agents are found through the shell's PATH, even when Zaki was started from the Dock
- [x] Claude is checked through its own commands, with no hooks, plugins, saved session or tokens spent
- [x] Checks never block the window

What gets hidden or kept:

- [x] A signed-out, API-key or not-installed Claude gives no row
- [x] With nothing to show, the popover reads "No subscriptions found"
- [x] A failed check keeps the last numbers with their age
- [x] A failed check with no earlier numbers reads "Could not check"
- [x] Text that can't be parsed counts as a failed check, and no wrong numbers appear
- [x] A check cut off by quitting doesn't block the next one
- [x] No login or email is saved in shared storage

Tests and docs:

- [x] Tests run the real popover, footer button and checks with `herdr` faked, on its own `bun test` line in the recipe
- [x] Test data is sanitised, with no real email or organisation
- [x] The checks module is added to the look test's identical copies
- [x] The user guide lists the Usage mod in the same commit
- [ ] The icon and popover are looked at in an isolated dev window on this Mac

## Comments

Built and merged to `feat/usage`. Only a look with a real pointer is left, then this can be resolved.

- Real run on this Mac through the app, in an isolated home: Claude Max showed `This week` 26% and `Fable` 3%. `--setting-sources=` works on Claude 2.1.316 and spent 0 tokens.
- Started with a bare Dock-style PATH (`/usr/bin:/bin:/usr/sbin:/sbin`): Claude in `~/.local/bin` and Codex under nvm were both found. This was a launch with that PATH, not a real click on the Dock.
- Not seen: the dev window was fully covered by another window, so no frame with the new mods was drawn. The look of the icon and popover, the second click and the bar animation are unchecked.
- All checks run in the footer, because popup tasks are cancelled on close.
