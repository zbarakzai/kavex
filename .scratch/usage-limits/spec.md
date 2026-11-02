# Usage limits

Status: ready-for-human

## Problem Statement

People running Claude Code, Codex and OpenCode in Zaki pay for subscriptions with weekly and shorter limits. Zaki shows none of this. To find out how much of a limit is left, they have to run a command in each agent, one machine at a time, or visit each provider's site. So they hit a limit in the middle of work without warning, and they can't tell which subscription still has room.

Tools that solve this usually read the person's login and call private provider addresses. That is not acceptable here: no login may reach Zaki, and the mod should send nothing itself.

## Solution

A shipped mod named Usage. A gauge icon in the sidebar footer, beside Add machine and Settings, opens a popover listing each subscription behind the agents on this computer and on added machines. Each row shows the tier name, every limit with percent used, and the time until it resets, weekly first.

Numbers come from each agent's own command, on the machine it is signed in on. Logins stay with the agents. OpenCode has no such command, so it is the one exception: Zaki reads its key and sends it only to `opencode.ai`, and only after the person presses Allow.

Checks run when the popover opens and every 15 minutes. The icon gets an orange dot when any limit reaches 90% used. A Settings row turns everything off, background checks included.

## User Stories

### Seeing limits

1. As a Zaki user, I want a gauge icon in the sidebar footer, so that my limits are one click away.
2. As a Zaki user, I want the icon beside Add machine and Settings, so that it sits with the other app-wide controls.
3. As a Zaki user, I want the icon visible even before any subscription is found, so that the feature stays easy to find.
4. As a Zaki user, I want clicking the icon to open a popover, so that I can look at my limits without leaving my work.
5. As a Zaki user, I want a second click on the icon to close the popover, so that it behaves like the other footer popups.
6. As a Zaki user, I want one row per subscription, so that I see what I pay for and not a list of programs.
7. As a Zaki user, I want each row to show the agent's logo and name, so that I recognise it at a glance.
8. As a Zaki user, I want each row to show the tier name, such as Max or Pro 100, so that I know which subscription it is.
9. As a Zaki user, I want each limit to show percent used, so that I know how much is gone.
10. As a Zaki user, I want each limit to show the time until it resets, so that I can plan around it.
11. As a Zaki user, I want a bar for each limit, so that I can compare limits without reading numbers.
12. As a Zaki user, I want the weekly limit first, so that the limit that matters most is on top.
13. As a Claude Code user, I want model-specific weekly limits shown beside the general one, so that I can see when one model is the one running out.
14. As a Claude Code user, I want the 5-hour limit shown when Claude reports it, so that I can see my short-term room as well.
15. As a Codex user, I want every limit Codex reports, including a model's own, so that nothing is hidden from me.
16. As an OpenCode Go user, I want my weekly, 5-hour and monthly limits, so that I see the same detail as the other agents.
17. As a Zaki user, I want the popover to match the design system and the current theme, so that it feels like part of the app.
18. As a Zaki user, I want bars to animate when their numbers change, so that a refresh is noticeable without being loud.
19. As a Zaki user, I want the reset time to count down while the popover is open, so that it never goes stale in front of me.
20. As a Zaki user, I want a limit past its reset time to read 0% before the next check, so that I'm not shown a limit that has already started over.

### Which subscriptions count

21. As a Zaki user with an agent signed in through an API key, I want it left out, so that the list only shows subscriptions with limits.
22. As a Zaki user with a signed-out agent, I want it left out, so that it doesn't look like a problem.
23. As a Zaki user with an agent not installed, I want nothing shown for it, so that the list stays relevant to me.
24. As a Zaki user with no subscriptions, I want one quiet "No subscriptions found" line, so that an empty popover reads as a result and not as a bug.
25. As an OpenCode user without a Go subscription, I want no row and no error, so that having no Go subscription isn't treated as a problem.

### Machines

26. As a person with added machines, I want their subscriptions included, so that I see everything I pay for in one place.
27. As a person signed in to one account on two machines, I want one row labelled with both machines, so that one subscription isn't counted twice.
28. As a person signed in to different accounts on two machines, I want two rows, each labelled with its machine, so that I can tell them apart.
29. As a person with one machine, I want no machine label, so that the row stays clean.
30. As a person whose added machine is offline, I want its last numbers kept with a note, so that one unreachable machine doesn't empty my list.
31. As a person who removes a machine, I want its subscriptions gone after the next check, so that the list matches my setup.
32. As a person with a shared account where one machine's check fails, I want the row to keep the other machine's fresh numbers, so that one failure doesn't make good data look stale.

### Freshness and failure

33. As a Zaki user, I want limits checked when the popover opens, so that what I see is current.
34. As a Zaki user, I want limits checked every 15 minutes in the background, so that the warning dot works without my opening anything.
35. As a Zaki user, I want repeated clicks within a minute to reuse the last result, so that I don't start the agents over and over.
36. As a Zaki user, I want a refresh button, so that I can get fresh numbers when it matters.
37. As a Zaki user, I want to see "Checking…" while a check runs, so that I know something is happening.
38. As a Zaki user, I want to see how long ago the numbers were updated, so that I know how far to trust them.
39. As a Zaki user, I want a failed check to keep the last numbers with their age, so that I still have something useful.
40. As a Zaki user, I want "Could not check" when a check fails and nothing older exists, so that a failure isn't mistaken for no subscription.
41. As a Zaki user after an agent update changes its output, I want the last numbers kept rather than wrong ones shown, so that I can trust what is on screen.
42. As a Zaki user who quit in the middle of a check, I want the next start to check normally, so that a cut-off check doesn't block later ones.
43. As a Zaki user who started Zaki from the Dock, I want agents found through my shell's PATH, so that agents installed through nvm or similar still count.
44. As a Zaki user, I want checks not to freeze or slow the window, so that the feature costs me nothing while I work.

### Warning

45. As a Zaki user, I want an orange dot on the icon when any limit reaches 90% used, so that I'm warned before I hit it.
46. As a Zaki user, I want the bar of a limit at 90% or more to turn orange, so that I can see which limit caused the dot.
47. As a Zaki user, I want the dot to clear when the limit resets, so that it never warns about a limit that has started over.
48. As a Zaki user, I want the same limit counted once when one account is on two machines, so that the dot follows the row I can see.

### Privacy and consent

49. As a Claude Code user, I want Zaki to run Claude's own command, so that my login stays in Claude and no Keychain prompt appears.
50. As a Codex user, I want Zaki to run Codex's own command, so that my login stays in Codex.
51. As a Claude Code user, I want a check to spend none of my tokens, so that watching a limit doesn't use it up.
52. As a Claude Code user, I want checks to skip my hooks and plugins and to save no session, so that a background check doesn't run my automation or fill my history.
53. As an OpenCode user, I want to be asked before Zaki reads my key, so that it never happens without my say.
54. As an OpenCode user, I want the Allow card to say what is read and where it goes, so that I can decide with the facts.
55. As an OpenCode user, I want to choose Not now and have the card stop asking, so that I'm not nagged.
56. As an OpenCode user who changed my mind, I want turning the Settings row off and on to ask me again, so that neither answer is permanent.
57. As an OpenCode user, I want my limits shown soon after I press Allow, so that I don't wait for the next 15-minute check.
58. As an OpenCode user, I want my key sent only to `opencode.ai`, so that it can't reach anyone else.
59. As an OpenCode user with a key written as a variable or command, I want it left alone, so that Zaki never sends something that isn't a real key.
60. As a Zaki user, I want no login, email or key saved in Zaki's shared storage, so that a leaked settings file holds nothing sensitive.
61. As a privacy-minded user, I want the README and security docs to say exactly what Usage reads and sends, so that I can judge it myself.

### Turning it off

62. As a Zaki user, I want a Usage limits row in Settings, so that I can turn the whole feature off.
63. As a Zaki user who turned it off, I want the icon gone and all checks stopped, so that nothing runs for a feature I don't use.
64. As a Zaki user who turned it off, I want the saved numbers and my OpenCode answer cleared, so that nothing is left behind.
65. As a Zaki user who turns it off during a check, I want that check to save nothing, so that off really means off.

### Platforms and agents' guide

66. As a Linux user, I want Usage to work the same as on a Mac, so that no platform is left behind.
67. As a Windows user, I want Usage to work through PowerShell, so that it works without a Unix shell.
68. As an agent working for a Zaki user, I want the user guide to describe the Usage mod and its off switch, so that I can answer questions about it correctly.

## Implementation Decisions

### Where it lives

- Everything is in mods. No change to the app's core, no new shared mod API, and nothing asked of herdr-core. Against the three core questions in the project rules, the answer is no each time: the app doesn't act on this, mods can see it, and mods can do it correctly.
- New shipped mod `usage`, with no place in a layout, opened only as a popup overlay.
- The `workspace-chrome` mod gets the footer button, and its always-mounted footer copy owns the background timer, because popups stop when they close.
- The Settings mod gets one row in its Workspace group.
- Mods can't import each other's files, so the checks module and the shared look helper exist as byte-identical copies in the mods that use them. The existing look test enforces this; the checks module gets added to it.

### Checks module

A deep module with a small interface, shared by the popover and the footer:

- `checkUsage({ force })`: runs one pass over all machines and saves the result. Does nothing when turned off, when a pass is under way (one started in the last minute), or, unless forced, when the last pass is under a minute old.
- `subscriptions(entries)`: turns saved entries into rows, one per subscription.
- `usedNow(limit, now)`: the percent to show, which is 0 past the reset time.
- `nearLimit(entries, now)`: whether the icon should show its dot.
- Constants for the 15-minute interval and the 90% threshold.

Shared storage holds this shape (from the first draft, trimmed):

```
usage = {
  startedAt?, checkedAt,
  entries: { "<agent>|<machine>": {
    agent, name, icon, tint, machine, plan, who, checkedAt, failed?, ask?,
    limits: [{ label, used, resetsAt }],
  } },
}
usage.enabled   // false means off; anything else means on
usage.opencode  // true after Allow, false after Not now, unset before asking
```

`who` is a short SHA-256 fingerprint, used only to spot one account on two machines. Emails and keys are never stored.

### How each agent is read

Decided in ADR 0001. Each check runs on the machine the agent is on, in that machine's shell PATH.

| Agent | Signed in with a subscription | Limits | Account match |
|---|---|---|---|
| Claude Code | `claude auth status`: logged in, auth method `claude.ai` | `claude -p /usage` with JSON output, no saved session, no MCP, no setting sources, in UTC; the `Current …: N% used · resets …` lines are parsed | Email and organisation |
| Codex | `codex app-server` over a pipe, `account/read`: type `chatgpt` | `account/rateLimits/read`, every bucket | Email and tier |
| OpenCode | A key in its auth file or the `credential` table of its database | `https://opencode.ai/zen/go/v1/usage` with the key as Bearer and a custom User-Agent; 401 and 403 mean no row | The key |

- Reading a line that doesn't match gives no limit. Reading no limits at all counts as a failed check.
- Codex's input stays open until its last answer arrives, because the server stops answering once input ends. Windows uses a fixed wait.
- The private Claude and Codex usage addresses and the macOS Keychain are not used, even though they would give cleaner data. ADR 0001 records why.

### Failure rules

- A check that throws keeps the last entry, marked failed. With no last entry, it's a failed row with no limits.
- An agent that reports signed out, or using an API key, gives no row. That is a result, not a failure, and it removes any older row.
- A machine that can't be reached keeps its last entries, marked failed.
- Each machine and each agent is checked on its own, so one failure can't affect another.

### Rows

- Entries with the same `who` merge into one row, showing the newest numbers and listing every machine.
- A row shows machine names when it has more than one, or when it's on an added machine.
- Limits sort weekly first, then model limits, then shorter windows.

### Popover

- 340 px wide, up to 480 px high, sized to its content.
- Header with a section label and a refresh button. A failed row gets a note giving the age of its numbers. Footer line with "Checking…" or "Updated 3m ago".
- Times read like `5d 3h`, `2h 10m`, `12m`.
- A limit at 90% or more uses the theme's blocked status color. All colors come from the theme, with no hex in the mod.
- Opening runs an unforced check. The refresh button runs a forced one. A 30-second tick keeps times current while open.

### Consent and off

- OpenCode's Allow card reads: "Zaki reads your OpenCode key and sends it only to opencode.ai, to ask for your Go plan's limits."
- Claude Code and Codex need no consent, because the mod sends nothing and no login reaches Zaki.
- **Allow** saves true and leads to a check, even if a pass is running, so OpenCode's limits don't wait 15 minutes.
- **Not now** saves false, and the card stops appearing.
- Turning Usage off clears the saved numbers and the OpenCode answer, so turning it back on asks again. This is the only way to change that answer in the first version. A pass that finishes after the switch saves nothing.

### Footer button

- The label space beside it shrinks by the button's width. The button shows unless Usage is off.
- The collapsed rail stays Settings-only.
- The dot uses the same blocked status color.
- A second press closes the popup, using the app's usual reopen guard.
- The first background check starts 5 seconds after launch, not at launch, so startup stays quick.

### Icon

- One new gauge icon, solid, 16 px, in the shared icon folder. It is original art, so it adds no licence notice.

### Docs

- The user guide's mod list, the README's privacy section, and the security doc all change in the same work. The README's privacy promise has to stay true once OpenCode's exception exists.

## Testing Decisions

### What makes a good test

A good test feeds in what the outside world would say and checks what a person would see. It should survive a rewrite of the module's internals. Tests shouldn't call internal helpers or read internal state when the same behavior can be seen in the popover's rendered output or in what got saved to shared storage.

### The one seam

The `herdr` module, plus `fetch`. Tests run the real popover, footer button, Settings row and checks module, and fake only what comes back from outside:

- **`exec` output:** saved Claude and Codex output, covering normal, signed out, API key, unreadable text, failure and exec timeout.
- **`knownAgents` and `machines`:** several machines, shared and separate accounts, a machine that can't be reached, an agent not installed.
- **`fetch`:** OpenCode answering 200, 401 and 403, a bad answer, and no network.
- **`shared` and `setShared`:** turned off, consent states, last numbers, a pass under way.

Test data must be sanitised: no real email, organisation, or key. Tests never touch real logins, agents or the network.

### What gets tested

- Rows, percentages, reset times and sort order for each agent.
- Claude's reset text: date and time, time only, year rollover, and a line carrying no reset.
- Hidden cases: signed out, API key, not installed, no Go subscription.
- One account on two machines merging; two accounts staying apart.
- Failures keeping old numbers; a machine failure not touching others.
- Timing: reuse under a minute, forced refresh, a pass under way, a cut-off pass no longer blocking.
- The dot at 89 and 90, and after a reset.
- OpenCode: no key read and no `fetch` before Allow, no key read after Not now, `fetch` going only to `opencode.ai`, variable and command entries never sent, and shared storage never holding the key or an email.
- Off: no `exec`, no `fetch`, no icon, saved data cleared, a late pass saving nothing, and Allow asked again after turning back on.

### Prior art

The recording fakes of `gpui-kit` and `herdr` in the tab menu, Settings and tabs column tests. `mock.module` leaks across files, so this test gets its own `bun test` line in the recipe, like those. The look test covers the identical copies.

### Manual checks, outside the seam

A dev window on this Mac, in an isolated home: how the icon and popover actually look, real clicks, the close-on-second-press, and a Dock-style launch finding agents through the shell PATH.

## Out of Scope

- Agents beyond Claude Code, Codex and OpenCode.
- OpenCode on added machines. It is checked on this computer only, so that a key never travels for another machine's sake.
- OpenCode keys held in a Console session or in environment variables. Only its key files count.
- More than one login per agent per machine, such as extra Claude config folders.
- Provider billing, spend in money, or token counts.
- Usage history or charts over time.
- Notifications, sounds or toasts at the warning threshold. The dot is the warning.
- A choice of warning threshold or check interval.
- A keyboard shortcut or `hc` command for the popover.
- The icon on the collapsed rail.
- Claude's private usage address, the macOS Keychain, or status-line wrappers, per ADR 0001.
- Any core or herdr-core change.

## Further Notes

### Decisions to confirm

These came up while writing the spec and were not put to Zakiullah during the grilling:

- OpenCode is checked on this computer only, and only through its key files.
- The icon always shows, even with no subscriptions.
- Only one login per agent per machine is read.
- Turning Usage off clears the saved numbers and the OpenCode answer. Without this, Not now could never be undone.

### Not proven

Tested on this Mac only, with Claude Code 2.1.316 and Codex 0.163.0. These have never been run:

- **Linux** and **Windows**. Project rules say Windows changes are checked on Windows, not only by cross-compiling, so the PowerShell paths need a real Windows check before release. The Codex fixed wait is a guess.
- **Added machines.** No machine was available to test with. They are assumed to have a POSIX shell, so an added Windows machine would fail its checks.
- **OpenCode Go.** Follows Omarchy's collector. OpenCode isn't installed here, and no Go subscription was tested, as Zakiullah accepted.
- **Claude's 5-hour line.** It's in Claude's code but never appeared in tests.
- **The gauge icon.** Drawn but never seen rendered.

### Known costs

- Claude's numbers come from text written for people, so a Claude update can break them. The failure is safe, since the last numbers stay, but the row stops updating until the parser is fixed.
- Each Codex check syncs its plugin list, and Omarchy reports this can leave temp folders behind. The 15-minute interval keeps this small; watch for it during the Mac check.
- The checks start each agent every 15 minutes on every machine, even when nobody looks at the popover. That is the price of the dot, and the Settings row stops it.

### Existing work

A first draft sits uncommitted in the `zaki-usage` worktree on branch `feat/usage`: the checks module, the copied look helper, the mod manifest, the gauge icon and ADR 0001. It was written before this spec and has not been reviewed. Treat it as a draft: it doesn't yet clear data on turn off, guard a late pass, or check right after Allow during a running pass, and it decides twice that OpenCode runs on this computer only. The branch started from `448acb5` and master has moved on, so it needs rebasing first. The domain terms and tracker notes are in the main checkout only, uncommitted.

## Changes made during the build

Where the code differs from the text above. The code is what shipped on `feat/usage`.

- **Who runs the checks:** the footer runs all of them, because popup tasks are cancelled on close. The popover asks through `workspace-chrome.check-usage` and `refresh-usage`.
- **Timer:** every footer has a 1-minute watch and only one pass runs, in place of one copy owning a timer. Checks land every 15 to 16 minutes.
- **Storage:** `usage` also holds `era`, which is what stops a late pass saving. `usage.checkedAt` is when a pass started.
- **OpenCode:** rows have no `who`, so nothing made from the key is stored. Allow's click saves the answer; the footer command only starts the check.
- **Rows:** a row on this computer alone gets "This computer" only when another row of the same agent exists, which settles stories 28 and 29.
- **`programs.json`:** a custom `run` is used only when its first word is the agent's own program, with flags dropped.
- **Look:** the popover follows a reference image from Zakiullah: near-black shell, one card per subscription, mono captions, and a solid two-part bar per limit, because limits aren't parts of one total. It's 400 by 540, up from 340 by 480, and scrolls only when the rows don't fit.
- **Refresh:** a `Refresh` pill in the footer, with the shared loader while checking.
- **Colors:** Claude's bar is always the primary orange. Near a limit, its percent and the gauge dot carry the warning. Codex and OpenCode turn orange at 90%.
- **Codex:** the check waits for both answers, as Codex can answer limits first. That explains the blank account seen in about 1 run in 8.
- **Also on this branch:** the picker and Add a machine moved to the same design, and Add a machine's host list no longer collapses.
- **After the merge (PR #7):** two ideas from the Relevo comparison. A limit on course to run out before its reset says when, as a straight line from its pace at the check, skipping the first 5% of its window; this meant keeping each limit's length as `minutes`. Reaching 90% raises one toast. `usage.warned` lists the limits already warned about, so going by that needs no reset time, and a limit can warn again once it's below 90%.
