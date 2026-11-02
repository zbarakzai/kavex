# 04 — Pi with its add-on

**What to build:** Pi rows show the same percent and dropdown as Claude and Codex. Zaki adds a small global extension to Pi by itself, keeping the person's other extensions. The extension reports the session and its context limit, and API cost comes from what Pi stores with each message, so Pi needs no price list.

See `.scratch/session-context-and-cost/spec.md`, stories 33 and 44, and ADR 0002. The Pi facts in the spec come from reading its source (v1.4.0), so check each one against a real install first.

**Blocked by:** 03 — Codex with its hook

**Status:** ready-for-human

Before starting:

- [ ] Pi is installed on the test machine
- [ ] Whether Pi asks the person to approve a global extension is checked, and if it does, Zaki never approves it for them and the dropdown says what to do
- [ ] Whether Pi's stored cost is at API prices is checked, also when Pi is signed in with a subscription, and the dropdown's last line is kept only if it's true

Setup:

- [ ] Zaki adds the extension when it first sees Pi on this computer, and again only if its setup changes
- [ ] Other extensions stay as they were
- [ ] The extension does nothing outside a Zaki terminal
- [ ] It labels the terminal with the session file and the context limit when a session starts

Numbers and sessions:

- [ ] Context used comes from the last valid token total
- [ ] API cost is the sum of what Pi stored for each message
- [ ] A new Pi with no session file yet shows no percent, and "No usage yet" in the dropdown
- [ ] `/new` shows the new session's numbers, and compacting and resuming keep the session
- [ ] A Pi with no reported session shows `–`
- [ ] Two Pi agents in one folder each show their own numbers

Tests and docs:

- [ ] Tests cover each row state with sanitised sample sessions, through the same seam
- [ ] The user guide says Zaki adds this extension and where it is, in the same commit
- [ ] It's checked with a real Pi, and the changelog notes say plainly that Zaki adds the extension
## Comments

Built on `feat/session-context`, in the `agents` mod. Pi isn't installed here and wasn't installed for this. Everything about Pi below comes from reading `@earendil-works/pi-coding-agent` and `pi-ai` **1.4.0**, downloaded with `npm pack` into an empty scratch folder and never run. So nothing here has been seen working in a real Pi or a real window.

### The two checks the ticket asked for, from source

- **Does Pi ask to approve a global extension? No.** `addAutoDiscoveredResources` in `core/package-manager.js` adds user extensions outside both `if (projectTrusted)` blocks, and `docs/security.md` lists only project resources under trust. So Zaki has nothing to approve, for or with the person. The dropdown's line covers what's left: a Pi already running hasn't loaded it. "Run `/reload` in Pi to load Zaki's extension."
- **Is the stored cost at API prices, also on a subscription? Yes.** `calculateCost(model, usage)` reads only `model.cost` from Pi's catalogue and never sees the login, and sign-in uses the same catalogue entries. The only thing login changes is the footer's ` (sub)`. So the dropdown's last line is true and **stays for Pi**. Two limits: Pi's catalogue is Pi's, not a provider's page, and on Anthropic sign-in Pi warns that use draws "extra usage, billed per token", so there the figure may be close to a real bill and "not what you paid" reads a little off.

### Where this differs from the spec, and why

1. **The last line is kept.** The spec says "For Pi the last line goes, as long as Pi's stored cost is an API-price figure too". Ticket 02's notes read that as dropped; the ticket says kept only if true, and it's true. **Needs your eye** if you meant dropped.
2. **After compacting, context is unknown, not lower.** Story 26 wants it lower. A Pi compaction stores no new size, and Pi itself says `?` until its next answer. Showing the old 90% in orange would be a wrong number, so the row shows nothing and the dropdown `? / 200k`. Cost goes on.
3. **API cost covers more than messages.** Spec: each message's `usage.cost.total`. Pi's own `/session` total also counts tools that call a model, compaction and branch summaries, and cache warming, so this sums the same and should match `/session`. On a `/fork` or `/clone` the copied entries' costs come along, as they do in Pi.
4. **Tokens with no cost read "no price".** Not in the spec for Pi. Pi stores 0 for a model it has no price for (local models, `kimi-coding/k3-256k`), and `$0.00` with the API line under it would be false. So story 24's rule applies, for the whole session.
5. **A second label, `zaki.limit`, set again when the model changes.** The spec has one label and sets it on `session_start`. Switching model changes the limit mid-session, so the extension also listens to `model_select`. Both labels go when the terminal is back at its shell.
6. **`–` means no label after 6 seconds, or once it has worked.** Pi's extension runs at launch, unlike Codex's hook, so waiting needn't wait for work; a few seconds' grace stops a flash on every launch. The cost: a real `–` takes up to 8 seconds to show.
7. **A Pi with no screen can't take the label.** Not in the spec. `pi -p` from a tool inherits `HC_TERMINAL_ID`, and would have overwritten its parent's label. The extension acts only in TUI mode, and only with a session file. So `pi --no-session` shows `–`, with a line about `/reload` that won't help it.
8. **Any absolute `.jsonl` counts as a session file.** Tighter than nothing, looser than Codex: `--session-dir` and `--session` can put one anywhere.
9. **The line filter is `"cacheRead":`,** not `totalTokens`, as older lines have no total.

Context is Pi's last real total. Pi's footer adds an estimate for messages since, so it can read a little higher while tools run.

### Risks I can't close from here

- **Extensions folder with its own entry.** If `~/.pi/agent/extensions/` itself holds an `index.ts`, `index.js` or a manifest `package.json`, Pi loads only that, so Zaki's file never runs and the row stays `–`, and `/reload` won't help. The way round it is writing to Pi's `settings.json`, which I left alone as the ticket wants other things untouched.
- `PI_CODING_AGENT_DIR`, `--no-extensions` and an `extensions` filter in settings also leave `–`. A Pi older than 0.78.1 has no `ctx.mode`, so it never labels.
- `hc` found only through `settings.json`'s `core` isn't found, as for Codex.
- Pi's session lines hold whole answers, so a line over 1 MiB crossing a read window's edge is lost, and its usage goes uncounted. That takes an answer over about 250k tokens, or a tool result with `usage` and an image.
- A virtual model's window can change per request with no `model_select`, so `zaki.limit` can lag.
- `/tree` lags until the next answer, as it stays in one file and writes nothing.

### Acceptance boxes

21 deliberate breaks of the code: 20 caught at first, the 21st after adding a test for it (a limit label that isn't a number would have re-read the file every pass). `zaki check` passes on a scratch copy of the mod with setup stubbed out, so that run touched no real home.

**Verified at the seam** (real files, real `sh`, fake app):

- Added when first seen; a second run changes nothing; only again if setup changes; one the person removed stays removed; other extensions and `settings.json` byte for byte; a failed write isn't taken for done; a dropdown or a Pi on another machine sets nothing up.
- Context from the last valid total, skipping aborted, failed and empty; API cost and tokens as above; each entry once though windows read twice.
- New Pi with no file: no percent, "No usage yet", then its numbers. `/new`, compaction and resume as labels and lines would show them. `–` and the dropdown's line. Two Pi agents in one folder. Each row state, with made-up sessions: `ready`, `empty`, `waiting`, `none`, no known limit.
- No network and no login: a pass reads only the session and the extension file.
- The guide says Zaki adds this and where, in the same commit. Changelog wording is in `04.md`.
- Budgets: 190 ms for a worst-case 8 MiB window in the real runtime (`zaki check`), `numbers` 0 ms, and a 100+ MB session with a 17 MB line read whole.

**Verified outside the seam:**

- The generated extension ran as a real process, under `bun` with stand-ins for `pi` and `ctx` built from Pi's `.d.ts`: nothing outside a Zaki terminal, finds `hc` with a bare PATH, prints nothing, survives `hc` missing or failing.
- The same extension against **real `hc` on an isolated core**: both labels in one call, a path with a space stays whole, a missing limit removes the label, and the clear Zaki sends leaves no labels.
- The real `~/.pi` is unchanged.

**Not verified: needs a real Pi or you**

- **Pi is installed on the test machine.** It isn't, as agreed.
- **It's checked with a real Pi.** Not done. That's the ticket's last box, and it stands behind all of these:
- **Pi really loads the file**, under its `jiti` loader rather than `bun`, with no prompt. Source only.
- **The extension really labels the terminal** on launch, `/new`, `/resume`, `/fork`, `/reload` and a model change. No real `session_start` fired. Extension API from types and source.
- **`/new`, compacting and resuming in a real session.** Seam only.
- **A real session file.** None exists here. Every line in the tests follows `docs/session-format.md` and the source, so a difference between docs and files would pass the tests.
- **Stored cost on a real subscription login.** Source only. Compare with `/session`.
- **`/reload` really picks up a new file in a running Pi.** Source only.
- **Zaki sees a running Pi as `program.key` `pi`.** `programs.json` has the entry; never seen live.
- **The real `writeTextFile` creating `~/.pi/agent/extensions/`.** Ticket 03's rule says it makes parent folders; only the test fake ran here.
- **Windows.** The extension never ran there, and reading needs `sh`. Added machines and Linux: ticket 05.
- **Anything visual.** No dev window, as asked: the dash, `? / 200k`, and the `/reload` line in the 290 px popup.

### Boxes I'd reword

"`/new` shows the new session's numbers, and compacting and resuming keep the session": holds, with context unknown after compacting, by point 2.

2026-11-01: code is on `feat/session-context` at 829bbe4, review fixes included. Set to `ready-for-human`: the unticked real-world checks above are the person's to do. Decisions and what is left are in `notes/review.md` and the comments above.
