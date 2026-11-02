# 02 — API cost for Claude

**What to build:** The Claude dropdown shows the session's API cost, with a line making clear it isn't money the person paid. Zaki ships its own price list, helpers count toward the cost, and a model missing from the list reads "no price" rather than a made-up number. The cost follows the session: it resets on `/clear`, carries on through `/compact`, and is kept on resume.

See `.scratch/session-context-and-cost/spec.md`, stories 14, 16, 23–28, and 52–54.

**Blocked by:** 01 — Claude context on the row and in the dropdown

**Status:** ready-for-human

The price list:

- [ ] A price list ships inside the mod, per model and per token class, in US dollars
- [ ] Prices come from Anthropic's official pricing page when the list is written, never from memory
- [ ] Token classes follow what Claude reports, including 5-minute and 1-hour cache writes
- [ ] The release steps say the list has to be checked at each release

The number:

- [ ] API cost is worked out per message and per model, across the session file and its helpers' files
- [ ] Repeated lines for one message are counted once
- [ ] A session that used several models names the current one and counts them all
- [ ] If any model in a session has no exact price, the dropdown reads "no price" and the token counts stay
- [ ] The dropdown adds the line "What this would cost on the API, not what you paid."
- [ ] A short sample session's API cost is checked against Claude's own `/cost`, and any difference is explained or fixed

Sessions:

- [ ] `/clear` resets API cost
- [ ] `/compact` keeps API cost going
- [ ] A resumed session keeps its API cost
- [ ] Helpers add to their parent's API cost, and not to its context

Tests and docs:

- [ ] Tests cover several models, helpers, repeated lines, and one model with no price, through the same seam as ticket 01
- [ ] The user guide covers API cost and what it means on a subscription, in the same commit
- [ ] Nothing is sent over the network, and prices are never fetched
## Comments

2026-11-01, built on `session/02-cost`. The boxes above are left as they were; the lists below say what was seen and what wasn't.

**Where the prices came from.** https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-01. Current models' figures were cross-read against https://claude.com/pricing the same day, and they agree. Model ids come from https://platform.claude.com/docs/en/about-claude/model-deprecations. `prices.js` lists all 20 models on the page. `claude-mythos-preview` has no price on the page, so it isn't in the list.

**Pricing rules the spec didn't have, all from that page:**

- Haiku 5.5 is priced per message: a prompt over 100,000 tokens, cache included, pays the higher prices for that message alone.
- Fast mode has its own input and output prices on Opus 5.5, Opus 5 and Opus 4.8, with caching multipliers on top. Fast on any other model reads "no price".
- US-only inference is 1.1x on every class. An `inference_geo` Zaki doesn't know reads "no price".

None of these three has been seen in a real line: `speed` was only ever `standard` or absent, `inference_geo` only `global` or `not_available`, and none of the 84 real Haiku 5.5 messages on this Mac went over 100,000 (the biggest was 76,848). `speed: "fast"` as the written value comes from the page's `model.speed`. They are tested on made-up lines only.

**Against Claude's `/cost`: not checked.** No `/cost` ran, so that box stays open. `claude -p` is denied to agents, and I didn't try another way round. What I did instead, running no `claude` process: Claude stores each project's last session in `~/.claude.json` (`lastModelUsage`, per model, with `costUSD`). Only amounts were read. I assumed this is what `/cost` shows, and didn't confirm it.

Three real sessions still have both a stored figure and a file. The real `add` and `numbers` over those files:

| Stored | Zaki | Gap | The extra tokens Claude counted, at Zaki's prices |
|---|---|---|---|
| $0.8056 | $0.6819 | $0.1236 | $0.1236 |
| $1.0078 | $0.9117 | $0.0961 | $0.0961–0.0963 |
| $2.9618 | $2.7769 | $0.1849 | $0.1786–0.1931 |

(A range because the stored figures don't split 5-minute from 1-hour writes.)

- Zaki reads low, by 6–15% on these short sessions. In every case Claude counted more tokens than the files hold, and those tokens price out to the gap. So the difference is calls missing from the files, not wrong prices or arithmetic. It can't be fixed from the files. Which calls they are isn't known; the Haiku ones may be session naming, but that's a guess.
- Separately, all 28 stored entries for 7 models fell inside what the list gives with every cache write at 5 minutes and every one at 1 hour: Opus 5.5, 5, 4.8, 4.7, 4.6, Haiku 5.5 and 4.5. 26 landed on one of those two ends to 4 places, and 2 between them. Some are tiny amounts that prove little. It's strong on input, output and read, and weaker on the write classes.

What this doesn't prove:

- That `/cost` shows the stored figure.
- Sessions with helpers: all three have none, so a helper's cost has never been compared with anything of Claude's.
- Compaction: all three have none, so whether a `/compact` call reaches the files is unknown, and a compacted session may read further under.
- 13 of the 20 listed models have no check beyond the page: Fable, Mythos, Sonnet, Opus 4.5 and the retired ones.
- Fast mode, US-only inference and the Haiku tier.
- Resumed sessions, which the stored figures may or may not cover.

**A fact that changed the build.** Ticket 01's note that repeated lines never differ holds for main files only. In helper files, 4,799 of about 38,800 repeats differ, always in `output_tokens` alone and always rising: the first line is a part-way count, and the last is final. Across 116 real sessions with helpers, first-line-wins gives 1.46M output tokens against 6.39M at the final figure. So each message now keeps its biggest output. Seen on Claude 2.1.284 to 2.1.302.

**Sessions.**

- `/clear`, `/compact`, resume: seam tests only. None was run for real.
- Resume, from the files: across all 235 session files on this Mac, no message appears in two files, and no file names another session, so nothing copies into a new file. Which of those were resumed can't be told, so this suggests rather than shows it. `--fork-session` wasn't seen.
- Helpers: `isSidechain` was true on all of about 15,650 helper lines and false on all of about 53,000 main ones. Zaki still goes by which file a line came from, so a change there can't reach context.

**Budgets.** A 100 MB session with 40 helpers and 80,000 messages adds up right in `sessions.test.ts`, with no `exec` over its limit. Bun says nothing about budgets, so the steps were also timed in the real runtime: the installed Zaki's `zaki check`, headless, no window, on a timing copy of the mod that was deleted afterwards.

| Step | Time |
|---|---|
| 8 MiB window of 3 KB lines | 51 ms |
| 6.3 MiB window of the smallest lines (11,000) | 155 ms |
| `numbers`, any size | 0 ms |
| One dropdown draw | 0.1 ms or less |

The first version re-summed every message on each read: 40 ms at 10k messages and 201 ms at 50k, on top of the window's parse, up to every 2 seconds. It now keeps running totals. A loop over 100k messages in a single step did hit the budget, but only because the timing copy ran them in one step; a real read gives one step one window. Whether a step blocks the window wasn't measured: there's no dev window here.

**Left out, on purpose.**

- Web search: `$10` per 1,000 searches isn't a token class and isn't counted. `server_tool_use` was zero in about 60,000 lines, and `webSearchRequests` was zero in all the stored figures, so it hasn't mattered here. The guide says so.
- `service_tier`: only `standard` seen. The page has no priority prices, so any other tier is priced as standard.
- `[1m]`: Claude's stored keys have it (`claude-opus-4-8[1m]`), but no `message.model` does, in about 69,000 lines. An exact match would read such a line as "no price".
- Cache writes with no 5-minute and 1-hour split count as 5-minute. No real line lacks the split.

**Not seen.** No dev window, as asked, so nothing here has been looked at: the API cost row, "no price", the new line's fit in the 290 px popup (it may wrap; the height limit went from 150 to 190 for that), and "API cost" fitting its 52 px label. The dropdown's text and order are tested through the real builders only.

**Tests.** Every new rule was also checked by breaking it: 25 one-line breaks, 23 caught by the test meant for it. One didn't apply at first, and was redone and caught. The one left, reading `.meta.json` too, changes nothing: the `.jsonl` match drops them.

2026-11-01: code is on `feat/session-context` at 829bbe4, review fixes included. Set to `ready-for-human`: the unticked real-world checks above are the person's to do. Decisions and what is left are in `notes/review.md` and the comments above.
