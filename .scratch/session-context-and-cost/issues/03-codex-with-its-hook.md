# 03 — Codex with its hook

**What to build:** Codex rows show the same percent and dropdown as Claude, matched exactly to their session. Zaki adds a small hook to Codex by itself, keeping the person's own hooks and their approvals. Codex won't run the hook until the person approves it once in `/hooks`, and Zaki never approves it for them. Until then the row shows `–` and the dropdown says what to do.

See `.scratch/session-context-and-cost/spec.md`, stories 32, 37–43 and 45, and ADR 0002.

**Blocked by:** 02 — API cost for Claude

**Status:** ready-for-human

Setup:

- [ ] Zaki adds the hook when it first sees Codex on this computer, and again only if its setup changes
- [ ] Other hooks stay exactly as they were, and keep their position and approval
- [ ] A second run changes nothing
- [ ] A hook file that isn't valid is left alone, and the row stays `–`
- [ ] Zaki never writes Codex's approval record
- [ ] The hook's command stays fixed and points at a script Zaki keeps, so a script change doesn't ask for approval again, and this is tested with a real approval
- [ ] The hook does nothing outside a Zaki terminal
- [ ] The hook finds `hc` from Codex's environment, including when Zaki was started from the Dock

Matching:

- [ ] When a session starts, the hook labels the terminal with its session file
- [ ] `startup`, `resume`, `clear`, `compact` and `fork` all update the label
- [ ] Whether `/new` fires the hook is tested, and handled if it doesn't
- [ ] Two Codex agents in one folder each show their own numbers

Numbers:

- [ ] Context used and total come from the newest token record, and the model from the newest turn record
- [ ] The percent is compared with what Codex itself shows, and any difference is explained or fixed
- [ ] OpenAI's prices join the price list, taken from their official page
- [ ] API cost treats cached input separately, and counts helpers
- [ ] How helper sessions name their parent is checked on real files
- [ ] `/clear`, `/compact` and resume behave as they do for Claude

The row and dropdown:

- [ ] A Codex with no reported session shows `–`
- [ ] Its dropdown says "Run `/hooks` in Codex, trust Zaki's hook, then restart this Codex."
- [ ] After approving and restarting, the same agent shows its numbers
- [ ] A new Codex shows no percent before its first message, and "No usage yet" in the dropdown

Tests and docs:

- [ ] Tests cover an empty hook file, one with other hooks, an invalid one, a second run, and the hook script with no terminal id
- [ ] Tests cover each row state with sanitised sample sessions, through the same seam
- [ ] The user guide says Zaki adds this hook, where it is, and that the person approves it, in the same commit
- [ ] A real approval through `/hooks` is done on this Mac, and the changelog notes say plainly that Zaki adds the hook
## Comments

Built on `session/03-codex`, in the `agents` mod. No live Codex was started, so nothing here has been seen working in a real Codex or a real window. What that leaves open is listed below, box by box.

### Where this differs from the spec, and why

1. **The hook runs on the first message, not at launch.** Codex queues `SessionStart` at session start and runs it inside the first turn (`run_pending_session_start_hooks` in `run_turn`). So before a first message a new, approved Codex has no label, exactly like an unapproved one, and "no label" can't mean `–` by itself. What I built: no label and never seen `working` or `done` reads as `empty`; no label after that reads as `waiting`. So both boxes hold, and before its first message an unapproved Codex says "No usage yet" rather than the `/hooks` line. **Needs your eye.** The cost: after a Zaki restart, an old unapproved Codex shows nothing until its next message, then `–`.
2. **`/clear`, `/new`, `/fork` and resume lag behind Claude.** For the same reason, the old numbers stay until the new session's first message. Nothing tells Zaki sooner. `/compact` is better than Claude: Codex writes the new size at once, so context drops at once.
3. **A terminal's label outlives its Codex.** Not in the spec. A new Codex in the same terminal would have shown the last one's numbers until its first message. Zaki now removes the label once the terminal is back at its shell (`hc label <t> zaki.session=`). It needs Zaki running when that Codex exits; otherwise the old label stays until the next first message.
4. **Totals are not the newest record's total.** Spec says they are. On real files that total falls back to near zero mid-session (5 times in 4 files, one from 38.9M) and doesn't say which model spent what. So cost and tokens add up each response's `last_token_usage`. 30 of 31 real sessions match an independent sum exactly, helpers included. The other one is the old format in point 8.
5. **The percent is Codex's own sum, not used over total.** Its footer takes 12,000 off both sides, so 65k of 258k reads 22% where plain division gives 25%. Fixed to match, read from `percent_of_context_window_remaining`: the row is 100 minus Codex's "% context left". The dropdown can look a few points off its own two numbers. Say if you'd rather have plain division.
6. **Long context and Fast have prices of their own.** Neither is in the spec. A response over 272K input costs more (351 of 39,509 real records), and Fast doubles most prices. Both are in the list, per response. Any other tier, and any cache write, reads "no price": Codex gives one write figure and the page prices 30-minute and 12-hour writes apart. `cache_write_input_tokens` was 0 on every real record. GPT-5.6 Sol's price is marked promotional until at least 2026-11-21.
7. **The script is in `~/.zaki/`, not `~/.config/zaki`.** `appHome()` moves with `HERDR_APP_HOME`, so `just dev` would add a second hook and ask for a second approval. Same folder as worktrees.
8. **Helpers come from their parent's lines, not a search.** The spec's search means grepping 1.6 GB. A parent's `SubAgentActivity` lines name 234 of 238 helpers, and only then is a file looked for by name. Depth reaches 3, and 39 of 238 sit in another day's folder, so the whole `sessions` folder is watched. The other 4 are July sessions with no `turn_context`: they go uncounted, and one such session reads $48.72 where the truth is "no price".

### Risks I can't close from here

- **`just dev` shares the real `HOME`**: a dev window that sees a Codex really writes `~/.codex/hooks.json`. Test with a scratch `HOME`.
- `CODEX_HOME` isn't honoured, and an `hc` found only through `settings.json`'s `core` isn't found by the hook. Both leave that person at `–`.
- This Mac has `[features] hooks = true` by hand. Whether hooks run without it wasn't checked.
- The hook's input fields come from the docs and source, and "transcript format isn't a stable interface" is Codex's own warning. A change there means `–` or `empty`, never wrong numbers, as the label must be a real rollout path.

### Acceptance boxes

**Verified** by test at the seam, plus what's named:

- Hook added on first sight and again only if setup changes; other hooks stay in position; second run changes nothing; invalid file left alone and the row stays `–`.
- Zaki never writes the approval record: tests with a real-shaped `config.toml`, and a scan of the source. The real `~/.codex` is unchanged by date and content, with no `~/.zaki`.
- Hook does nothing outside a Zaki terminal; finds `hc` with a bare PATH. **The real generated script ran through `zsh -lc` against real `hc` 0.1.15 on an isolated core**, with `hc` reachable only through its fallback folder: labelled a path with spaces, printed nothing, and did nothing with no terminal id.
- Two Codex agents in one folder.
- Context from the newest record, model from the newest turn: real files.
- OpenAI's prices from `developers.openai.com/api/docs/pricing`, read 2026-11-01. `openai.com/api/pricing` returned 403. Rows read twice.
- Cached input apart, helpers counted: real files. How helpers name their parent: all 238 real helpers.
- `–`, the dropdown's words, "No usage yet".
- Tests and sanitised samples. The guide says what Zaki adds, where, and that the person approves, in the same commit.
- Changelog wording is in `03.md`.
- Budgets: 152 ms for a worst-case 8 MiB window in the real runtime, `numbers` 0 ms, a 105 MB session and a 100 MB test session read whole. `zaki check` passes on the mod. 14 deliberate breaks: 13 caught at first, the 14th after making the fake `hc` print as the real one does.

**Not verified: needs a live Codex or you**

- **A real approval through `/hooks` on this Mac.** Nothing can stand in for it, and it blocks the next four.
- **Script change needs no re-approval.** The source says the hash covers the definition and nothing reads the script. Not proven with a real approval.
- **Other hooks keep their approval.** Follows from the key being position-based and those groups not changing. Not observed.
- **After approving and restarting, the same agent shows its numbers.** Tested at the seam by a label arriving; not with a real restart.
- **The hook really labels the terminal, for `startup`, `resume`, `clear`, `compact` and `fork`.** The script handles all five with no matcher. No real Codex fired it.
- **Whether `/new` fires the hook.** Source only: every new session queues it unconditionally, but bare `/new` opens a checkout picker and I didn't follow that to the thread start. If it doesn't fire, the old numbers stay on the row.
- **The percent against what Codex shows.** Formula taken from source, with no live side-by-side.
- **`/clear`, `/compact`, resume as they behave for Claude.** Seam only, and different as in points 2 and 3.
- **`/fork`.** No real forked session of a person's exists here, so whether its file copies token records is unknown.
- **Fast on a real line.** Every real session says `default`.
- **Dock launch.** Simulated with a bare environment, not launched.
- **Windows.** The `.ps1` has never run. There's no `pwsh` here.
- **Anything visual.** No dev window, as asked: the dash, and the `/hooks` line wrapping in the 290 px popup.

### Boxes I'd reword

"A new Codex shows no percent before its first message": holds, by point 1, for approved and unapproved alike. "Its dropdown says Run `/hooks`": holds only once that Codex has worked.

2026-11-01: code is on `feat/session-context` at 829bbe4, review fixes included. Set to `ready-for-human`: the unticked real-world checks above are the person's to do. Decisions and what is left are in `notes/review.md` and the comments above.

2026-11-01, first live run: the hook fired on a real Codex 0.166.0 and labelled its terminal, but the row stayed blank. Codex's app-server keeps the session file open, and macOS file watching reports no write to an open file until it closes (reproduced on a scratch file), so a read before the first token record left the row on `empty` for good. Fixed in b81702e: `keepsOpen` makes a Codex check its file's size each pass. The fake tests couldn't catch it, as `appendFileSync` closes the file each time. Pi also closes after each write (`appendFileSync` in 1.4.0's session-manager), so it doesn't need this.
