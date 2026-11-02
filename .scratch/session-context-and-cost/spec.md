# Session context and API cost

Status: needs-triage

## Problem Statement

People running several agents in Zaki can't see how full each session's context is. They find out when an agent starts compacting or gets worse at its job, or they have to focus each agent and run a command in it. They also can't tell which model an agent is running, or what a session would cost at API prices, without opening that agent. With many agents open, often in the same folder, there is no way to compare them at a glance.

## Solution

Each row in the Agents list shows the session's context as a small percent, between the name and the time. Clicking the agent's logo opens a dropdown with the model, a context bar, the API cost and token counts, and it stays live while open.

This works for Claude Code, Codex and Pi, on this computer and on added machines, on Mac, Linux and Windows. Numbers come from files the agents already write on the machine they run on. Nothing is sent anywhere, and no login is read.

Codex and Pi don't say which terminal a session belongs to, so Zaki adds a small hook to Codex and a small add-on to Pi that report it. Codex won't run a new hook until the person approves it once in `/hooks`, and Zaki never approves it for them.

## User Stories

### The row

1. As a Zaki user, I want each agent's row to show its context as a percent, so that I can see how full every session is without focusing it.
2. As a Zaki user, I want the percent between the name and the time, so that it sits with the row's other small facts.
3. As a Zaki user, I want the percent in the same small text as the time, so that it doesn't compete with the name.
4. As a Zaki user, I want the percent to stay when hovering swaps the time for the pin, so that it doesn't jump away under my pointer.
5. As a Zaki user, I want the percent to turn orange at 90%, so that a session close to full stands out.
6. As a Zaki user, I want orange to keep its meaning of "needs you", so that the warning matches the rest of the app.
7. As a Zaki user with a narrow sidebar, I want the name to shorten before the percent goes, so that the number stays readable.
8. As a Zaki user with the rail collapsed, I want no percent there, so that the rail stays as simple as it is.
9. As a Zaki user with sub-agents, I want each sub-agent's row to show its own percent, so that I can see every session.
10. As a Zaki user, I want the percent to update as the agent works, so that it's never badly out of date.

### The dropdown

11. As a Zaki user, I want clicking an agent's logo to open a dropdown, so that the detail is one click away.
12. As a Zaki user, I want the dropdown to name the model running now, so that I know what the agent is using.
13. As a Zaki user, I want a context bar with tokens used, the total and the percent, so that I see the real size and not only a share.
14. As a Zaki user, I want the API cost, so that I can judge what the session is worth at API prices.
15. As a Zaki user, I want input, output and cached token counts, so that I can see what the cost is made of.
16. As a person on a subscription, I want a line saying "What this would cost on the API, not what you paid.", so that I'm not misled about what I spent.
17. As a Zaki user, I want the numbers to stay live while the dropdown is open, so that I can watch a working agent.
18. As a Zaki user, I want clicking outside or pressing Esc to close the dropdown, so that it behaves like the app's other popups.
19. As a Zaki user, I want the dropdown to use the theme's colors, so that it fits the app.
20. As a Zaki user, I want a sub-agent's logo to open the same dropdown, so that every session gets the same detail.
21. As a Zaki user, I want clicking the logo not to focus the agent, so that I can check a session without leaving my work.
22. As a Zaki user with sub-agents, I want the chevron to keep folding them, so that nothing is lost when the logo gets a new job.
23. As a Zaki user whose session used several models, I want the current model named and the API cost to cover all of them, so that the cost isn't understated.
24. As a Zaki user on a model missing from Zaki's price list, I want "no price" shown with the token counts still there, so that I get no made-up number.

### When numbers change

25. As a Zaki user, I want `/clear` to reset context and API cost, so that the numbers describe the new session.
26. As a Zaki user, I want `/compact` to lower context while API cost carries on, so that the numbers match what happened.
27. As a Zaki user, I want a resumed session to keep its API cost and context, so that one conversation has one running total.
28. As a Zaki user, I want an agent's helpers counted in its API cost, so that the cost reflects everything the session used.
29. As a Zaki user, I want a helper's tokens kept out of the agent's context, so that the percent shows only the agent's own conversation.
30. As a Zaki user with a new agent, I want no percent before its first message, and "No usage yet" in the dropdown, so that a blank session doesn't look broken.

### Which agents show numbers

31. As a Claude Code user, I want every Claude row to show its own numbers, so that agents in one folder never get mixed up.
32. As a Codex user, I want every Codex row matched exactly to its session, so that I never see another agent's numbers.
33. As a Pi user, I want the same percent and dropdown, so that Pi agents aren't left out.
34. As an OpenCode user, I want no percent and a logo click that acts like clicking the row, so that nothing pretends to work.
35. As a user of any other agent, I want the same, so that its row behaves as it does today.
36. As a person with an agent that can't be read, I want no percent rather than an error, so that one bad file doesn't get in the way.

### Setting up Codex and Pi

37. As a Codex user, I want Zaki to add its hook by itself, so that I don't have to edit config files.
38. As a Codex user with hooks of my own, I want them kept exactly as they are, including their approval, so that Zaki doesn't break my setup.
39. As a Codex user, I want Zaki never to approve its own hook, so that Codex's safety check stays mine to make.
40. As a Codex user who hasn't approved the hook, I want a `–` in the row, so that I can tell it's waiting rather than missing.
41. As a Codex user, I want the dropdown to say "Run `/hooks` in Codex, trust Zaki's hook, then restart this Codex.", so that I know exactly what to do.
42. As a Codex user, I want to approve once per machine, so that setup doesn't come back.
43. As a Codex user who doesn't use Zaki for a session, I want the hook to do nothing outside Zaki, so that it never gets in my way.
44. As a Pi user, I want Zaki to add its add-on by itself and keep my other extensions, so that Pi works without setup.
45. As a person whose Codex hook file can't be understood, I want Zaki to leave it untouched, so that it never damages my config.

### Machines and systems

46. As a person with added machines, I want their agents to show the same numbers, so that every row works the same.
47. As a person with added machines, I want those numbers to refresh every 30 seconds, so that they stay fresh without constant traffic.
48. As a person whose added machine goes offline, I want the last numbers kept, so that rows don't flicker.
49. As a Linux user, I want this to work as it does on a Mac, so that no system is left behind.
50. As a Windows user, I want this to work as well, so that Windows isn't left behind.
51. As a person on a system where something fails, I want no percent rather than a wrong number, so that I can trust what's shown.

### Privacy and speed

52. As a Zaki user, I want nothing sent over the network, so that my work stays on my machines.
53. As a Zaki user, I want no login read, so that my accounts stay with my agents.
54. As a Zaki user, I want Zaki not to spend tokens to show this, so that watching a session costs nothing.
55. As a Zaki user with 100 MB sessions and a dozen agents, I want the window to stay smooth, so that this feature has no cost I can feel.

## Implementation Decisions

### Where it lives

- Everything is in the `agents` mod. No change to the app's core, no new shared mod API, and nothing asked of herdr-core. Against the three core questions in the project rules, the answer is no each time.
- A new deep module inside the mod, `sessions`, sits behind a small interface. Given a terminal record and the way to reach its machine, it returns what to show. The row and the dropdown only draw that result.
- The dropdown is a popup of the same mod, opened through a prop as the sort menu is. It reads its one session itself, so nothing goes through shared state, which would redraw every mod.
- The logo stops folding sub-agents and stops the click reaching the row. The chevron keeps folding.
- No Settings row. Failures show as no percent.

### What the module returns

Shape, not code:

- `state`: `ready`, `empty` (no usage yet), `waiting` (Codex or Pi with no session reported) or `none` (not supported, or unreadable)
- `model`, the one running now
- `context`: `{ used, total, percent }`, with `total` and `percent` missing when the limit isn't known
- `tokens`: `{ input, output, cached }`
- `cost`: a number, or missing for "no price"

### Finding the session

Each agent's own route, decided in ADR 0002.

| Agent | Route |
|---|---|
| Claude Code | The terminal's foreground process id finds Claude's per-process record, which gives the session id and folder, and so the session file. Exact, and tested on 12 live agents. |
| Codex | The hook runs at session start and sets the terminal label `zaki.session` to the session file, using `HC_TERMINAL_ID`. It fires for `startup`, `resume`, `clear`, `compact` and `fork`, so a new session replaces the label. |
| Pi | A global extension does the same on `session_start`, and also labels the context limit from `getContextUsage()`. |

- Foreground process and labels are already in the terminal record.
- Pi writes a session file only once a conversation exists, so a label pointing at no file reads as `empty`.
- Only a real session file path counts; anything else in the label is ignored.

### Reading a session

- Zaki's text file reader stops at 1 MB and `hc file read` errors on these files, so neither can read them. Session files reach 100 MB.
- The mod runs a line filter through `exec`: `grep` on Mac and Linux, tested at 0.03 s on a 100 MB file, and a Windows equivalent. It keeps only the lines with usage and model, and they are parsed in the mod. Lines of over a megabyte exist, but these are not the usage lines.
- A session is read again when its file changes: watched here, at most once every 2 seconds per session. Added machines are read every 30 seconds, and only while the session's row is listed.
- A failed read keeps the last result.

### Working out the numbers

**Claude Code**
- Context used is the newest main conversation message's input, cache read and cache write tokens added together. Helpers' messages don't count.
- A message can appear on several lines, so lines are counted once per message id.
- Totals cover the session file and its helpers' files.
- The total comes from `claude -p "/context"` with JSON output, for that model, with no saved session, no MCP and no setting sources. Tested at 0 tokens and about 6 seconds. It runs once per model per machine and is kept for a day. Until it answers, tokens show and the percent doesn't.

**Codex**
- Context used is the newest `token_count` record's latest usage, and the total is its `model_context_window`. The model comes from the newest `turn_context` record.
- Totals come from the newest record's total usage. Input there includes cached tokens, so cached is taken out before pricing.
- Helpers are separate session files naming their parent's id, found by searching for it.

**Pi**
- Context used is the last valid `usage.totalTokens`. The total comes from the extension's label.
- API cost is the sum of each message's stored `usage.cost.total`, so Pi needs no price list.

### API cost

- A price list ships inside the mod: per model, per token class, in US dollars. Classes follow what the agent reports, including Claude's 5-minute and 1-hour cache writes.
- Prices come from each provider's official pricing page when the list is written, never from memory.
- An exact model match is required. If any model in a session has no price, the whole cost reads "no price".
- The list has to be checked at each release. A new model reads "no price" until then.

### Setup

- The mod sets up an agent on a machine when it first sees that agent there, and again if Zaki's version of the setup changes.
- The Codex hook is added as a new group at the end of `SessionStart`, because Codex keys approval on a hook's position, and moving others would cancel theirs.
- The hook's command stays fixed and points at a small script Zaki keeps in its own folder, so changing the script doesn't ask for approval again.
- The hook exits at once with no `HC_TERMINAL_ID`. It uses only `sh` and `hc`, with `commandWindows` for Windows.
- If the hook file isn't valid, it's left alone and the row stays `–`.
- Zaki never writes Codex's approval record.
- Files here go through the mod's text writer, which refuses to overwrite a changed file. Files on added machines go through `hc file write --on`.
- The dropdown can't tell "not approved" from "started before approval", so one message covers both.

### Row and dropdown

- Row: the percent uses the mono small text of the time. At 90% and up it uses the theme's blocked color. No hex.
- States: `ready` shows the percent, `waiting` shows `–`, `empty` and `none` show nothing. With no known total, the row shows nothing.
- Dropdown layout, as agreed:

```
Claude Opus 5.5
Context   ▓▓░░░░░░░░   65.2k / 1M   7%
API cost                          $4.12
Tokens    in 12k · out 8k · cached 2.1M
What this would cost on the API, not what you paid.
```

- For a `waiting` agent it shows the `/hooks` message. For an `empty` one, "No usage yet". For Pi the last line goes, as long as Pi's stored cost is an API-price figure too.
- OpenCode and other agents get no dropdown, and the logo click reaches the row.

### Docs

- `defaults/AGENTS.md` says what the row and dropdown show, that Zaki adds a hook to Codex and an add-on to Pi, and where they are, in the first commit that changes each.
- CHANGELOG notes say plainly that Zaki adds these.

## Testing Decisions

### What makes a good test

A test feeds the mod what a machine would give it and checks what the person sees. It doesn't check how lines are filtered or which helper ran.

### The one seam

The whole mod with `herdr` faked, as the other mods are tested: terminal records, `exec` results and file contents go in, and the row and dropdown come out. No new seam is added.

### What gets tested

- Each agent's numbers from sanitised sample session files, including repeated lines and helpers
- Context and cost after clear, compact and resume
- Each state: ready, empty, waiting, none, and no known total
- The 90% switch, and hovering keeping the percent
- The logo opening the dropdown without focusing or folding, and the chevron still folding
- "no price" for one unknown model in a session
- Hook setup: empty file, a file with other hooks whose positions stay put, an invalid file left alone, and a second run changing nothing
- The hook script doing nothing without `HC_TERMINAL_ID`
- No network call and no login path anywhere in a pass

### Prior art

`scripts/tab-menu.test.ts` and `scripts/file-menu.test.ts` for a real mod with `herdr` faked, each on its own `bun test` line in the recipe.

### Manual checks, outside the seam

- This Mac in an isolated dev window, then a real Codex approval through `/hooks`, including `/clear` and resume
- Pi on a machine with it installed
- An added machine
- Linux in the sandbox
- Windows, by Zakiullah on their machine

## Out of Scope

- OpenCode, which needs its own ticket: two plugin systems, a database Zaki can't read, and a format that changed on 2026-10-29
- Agents other than Claude Code, Codex and Pi
- Subscription limits, which belong to the Usage mod
- Money actually spent, or spend per day or across sessions
- History after an agent closes
- Cost alerts
- An off switch
- Zaki approving hooks
- The collapsed rail
- Fetching prices online

## Further Notes

### Not proven

- Linux, Windows and added machines
- That Claude's per-process record has the same shape and process id on Windows
- That Windows has a filter good enough for these files
- That `/context` gives the right total for a session started on a model variant, such as a 1M option picked by hand
- How soon Claude's context drops after compacting: the new figure may wait for the next message
- That Codex's percent matches what Codex shows, because it may leave out a base amount
- That Codex's trust covers the hook definition and not the script it runs (docs say "the exact hook definition")
- That Codex's `SessionStart` fires on `/new`; its docs list `clear` but don't name the command
- That Codex helper files name their parent in a searchable way
- That Pi loads a global extension with no approval, and that its stored cost is at API prices
- That `hc` is on the hook's PATH in every setup
- Pi isn't installed on this Mac, and the Pi facts come from reading its source (v1.4.0)

### Known costs

- Zaki now keeps files in Codex's and Pi's settings, and has to keep working as those agents change. The hook stays behind after uninstalling, harmless outside Zaki.
- The price list goes stale between releases.
- An existing Codex shows `–` until the hook is approved and it's restarted.

### Related work

The Usage mod (`.scratch/usage-limits/`) reads subscription limits, and is a separate feature on its own branch. If it lands first, the `claude -p` way of running a check can be shared by copying, as mods can't import each other.
