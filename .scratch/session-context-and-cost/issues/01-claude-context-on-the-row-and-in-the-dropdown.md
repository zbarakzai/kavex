# 01 — Claude context on the row and in the dropdown

**What to build:** Each Claude Code row in the Agents list shows its session's context as a small percent, and turns orange at 90%. Clicking the agent's logo opens a live dropdown with the model, a context bar and token counts. This works on this computer. It's the first path through every layer, and it sets up the sessions module and test file the later tickets add to. API cost comes in ticket 02, so the dropdown has no cost line yet.

See `.scratch/session-context-and-cost/spec.md`, stories 1–13, 15, 17–22, 25, 26, 29–31, 34–36 and 52–55, and ADR 0002.

**Blocked by:** None — can start immediately

**Status:** ready-for-human

Finding and reading the session:

- [ ] Each Claude row is matched to its session through the terminal's foreground process, so agents in one folder never mix
- [ ] Session files of 100 MB read without Zaki's 1 MB file limit getting in the way, and the window stays smooth with a dozen agents
- [ ] Context used comes from the newest main conversation message, with helpers left out
- [ ] Repeated lines for one message are counted once
- [ ] The context total comes from Claude's own `/context`, once per model per machine, kept for a day, spending 0 tokens
- [ ] Until the total is known, the dropdown shows tokens and the row shows nothing
- [ ] Numbers update within about 2 seconds of the session file changing
- [ ] A failed read keeps the last result, and an unreadable session shows no percent and no error

The row:

- [ ] The percent sits between the name and the time, in the time's small text
- [ ] The percent stays when hovering swaps the time for the pin
- [ ] At 90% and up it uses the theme's blocked color, with no hex
- [ ] The name shortens before the percent goes
- [ ] The collapsed rail shows no percent
- [ ] Sub-agent rows show their own percent
- [ ] A new Claude shows no percent before its first message
- [ ] OpenCode and other agents show no percent and their rows behave as they do today

The dropdown:

- [ ] Clicking a Claude or sub-agent logo opens it, and doesn't focus the agent or fold anything
- [ ] The chevron still folds sub-agents
- [ ] OpenCode's and other agents' logo clicks act like clicking the row
- [ ] It shows the model running now, the context bar with used, total and percent, and input, output and cached tokens
- [ ] It stays live while open, and clicking outside or pressing Esc closes it
- [ ] A new Claude's dropdown says "No usage yet"
- [ ] It uses only theme colors

Sessions:

- [ ] `/clear` shows the new session's numbers
- [ ] `/compact` lowers context once Claude reports the new figure, and how soon that happens is recorded

Tests and docs:

- [ ] Tests run the real `agents` mod with `herdr` faked, on its own `bun test` line in the recipe
- [ ] Test data is sanitised, with no real prompts, paths or names
- [ ] The user guide says what the row and dropdown show, in the same commit
- [ ] Nothing is sent over the network, and no login is read
- [ ] It's checked in an isolated dev window on this Mac, including a session on a hand-picked 1M model, and any wrong total is recorded

## Comments

2026-11-01, built on `session/01-claude`. The boxes above are left as they were; the lists below say what was seen and what wasn't.

**How soon `/compact` lowers context.** Not at the `/compact`, but with Claude's next message. Nothing was compacted live for this. It comes from 13 real compactions in the 120 newest session files, timing the `compact_boundary` line against the first assistant line after it:

- Claude carrying on by itself: 3.6 s and 4.9 s at the quickest. Eight other automatic ones took 5 minutes to over 7 hours, waiting on the person or a closed lid.
- Manual `/compact`: 39 s, 191 s and 316 s, which is the time until the person's next message.
- The figure then fell from 252k–969k to 52k–91k every time.
- The boundary line has `postTokens` at once, but it reads about 25k where the next message reports about 78k, because it leaves out the system prompt and tools. It isn't used: a late right number beats an early low one.

**Wrong totals on a 1M model.** None seen, and the hand-picked 1M session was **not run**, so this is still open. What is known:

- Running `claude -p "/context"` from the agent's shell was denied by Claude Code's auto mode, so no live `/context` ran for this ticket, in the shell or in the app. The dev copy of the mod had that call removed, and the total was seeded.
- The reply format comes from the grilling's saved run, which had no `--model` and no `--setting-sources ""`: `**Tokens:** 13.7k / 1m (1%)` for `claude-opus-5-5`. The exact command the mod runs is untested.
- `requestedModel` never held a `[1m]` in about 24,000 assistant lines, so nothing here has shown what a hand-picked variant writes. The mod asks `/context` for `requestedModel`, falling back to `model`.
- A total smaller than the context used shows no percent. A total that's too big can't be told from a right one.

**Seen in the isolated window** (real app and runtime, 13 fake agents, scratch `HOME`, the existing debug binary with the mod hot-copied):

- `terminals()` carries `foreground.pid`, and each row matched its own record.
- Ten real sessions of 17–107 MB read with no interrupted script. Tokens matched an independent sum on all ten, and context on nine.
- The tenth was the bug fixed in `362bfb9`: a read the machine slept through overlapped the next pass, and put an older line back as newest. The popup's single read gave the right figure before the fix. After the fix there is a test, but no second run on real files.
- A small session went from empty to 93% to 95%, each within a pass of the file changing, through the real `watchFolder` and `exec`.
- A cold read of the 107 MB file took 1.27 s, off the main thread, in the popup's copy. Later reads are about 0.02 s outside the app.
- A fresh record read `empty`, and OpenCode read `none`.
- `/usr/bin/grep` is really 0.82 s on 107 MB. The spec's 0.03 s was probably this shell's ugrep. BSD `head -c` cost five times `dd`, hence `dd`.
- QuickJS parses a typical window in 1 ms and a full 8 MiB window in about 40 ms.

**Not seen.** The machine slept through the run, about 60 s awake in every 15 minutes, so the window drew only at launch and every `zaki shot` was the stale launch frame:

- Anything drawn: the row's look, the orange, the shortening name, the dropdown's layout. `zaki check` ran all five dropdown states through the real builders, and bun tests cover the rest, but nobody has looked at it.
- A real pointer on the logo or chevron, and Esc or clicking outside. Pointer input can't be faked here; the popup was opened by a hook in the dev copy.
- Smoothness with a dozen agents: no frames to measure, and timings in wake bursts aren't reliable. The per-step costs above are the only evidence.
- Real `/clear` and real `/compact`. Tests cover both. For `/clear` the files only suggest the record follows: two of eleven live records name a session file born 3 and 12 hours after their process started.

2026-11-01: code is on `feat/session-context` at 829bbe4, review fixes included. Set to `ready-for-human`: the unticked real-world checks above are the person's to do. Decisions and what is left are in `notes/review.md` and the comments above.
