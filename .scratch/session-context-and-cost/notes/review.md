# Code review of feat/session-context against 5938448 (717065f)

## Standards
Hard:
1. .github/workflows/ci.yml: "just test (what CI runs)", but sessions.test.ts was added to the justfile only, so CI's "Test the mods" never runs it.
2. docs/security.md: "The built-in file API limits writes to the app home". machine.js passes writeTextFile to installers writing ~/.codex/hooks.json, ~/.zaki/*, ~/.pi/agent/extensions/. "What stays on disk" omits them.
3. CONTEXT.md: Limit is a subscription cap; a context's size is its "total". Branch uses zaki.limit, agents.limits, agent.limit(), "context limit". The label and key persist: rename before shipping.
4. CONTEXT.md avoids "Spend": pi.js spend(), facts.spent; claude.js and codex.js spent.
5. ~/.claude/CLAUDE.md comments only on very complex sections: 141 of 948 lines in new modules are comments, many on simple code.
Judgement, documented standards:
- defaults/AGENTS.md "keep it a map with rules and short examples": a 74-line prose bullet with token maths.
- Platform rules: no Windows check recorded (Zakiullah's, outstanding).
- CONTRIBUTING "Keep PRs small": 4,388 lines.
Smells (judgement calls):
- Duplicated Code: `total >= used ? { used, total, percent…` (sessions.js:90, pi.js:70); `?? -X) < X` throttle (sessions.js:72,139,269; machine.js:129); `if (now !== …) await write` (codex.js:100, pi.js:82).
- Data Clumps: tokens/cost/unpriced in all three facts and numbers.
- Shotgun Surgery: the hc search list in SCRIPT, WINDOWS_SCRIPT and pi.js places.
- Refused Bequest: locate(term, _label, _limit, machine), each agent ignoring different positional params.
- Mysterious Name: AWAY is 30000 ms in sessions.js:24 and 4 MiB in machine.js:14; still(run) throws; run is a pass.
- Primitive Obsession: t.address.includes("/") (sessions.js:70,81) bypasses machineOf; bare code === 3.
- Repeated Switches: props()?.sortMenu / props()?.session in both init and render.
- Feature Envy: Sessions.shown unpacks Claude-only asked.
- Divergent Change: Sessions handles scheduling, label tidying, installs, reading, watching and limits.

## Spec
(a) Missing or partial
1. Manual checks outside the seam not run (real Codex approval, Pi, added machine, Linux, Windows). zaki check not run after the machine.js refactor.
2. Unapproved Codex that hasn't worked shows nothing and "No usage yet", not `–`. (User decision)
3. 4 of 238 Codex helpers uncounted; one session reads $48.72 where truth is "no price".
4. Codex /clear: old numbers stay until the new session's first message. (User decision)
5. Pi /compact: row blank, dropdown `?`. (User decision)
6. Changelog wording cited in 03.md and 04.md, which aren't in the repo.
(b) Scope creep: Fast, long-context, US-only pricing; clearing labels at the shell; Pi re-labelling on model_select; Pi's /reload message, useless for --no-session.
(c) Looks wrong
1. dropdown.js shows "No usage yet" for `none` too, so an unreadable session claims no usage. NEW
2. Codex percent uses a 12,000 base: 65k / 258k at 22%. (User decision)
3. Codex totals sum each response, not the newest total. (User decision)
4. Pi: a usage line over a megabyte crossing a window edge loses its usage, so numbers read low.
5. On added machines an unreadable hooks.json looks absent and gets replaced, against "leave it untouched".
6. Windows: a stale sessions/<pid>.json can show another session's numbers.
7. Pi accepts any absolute .jsonl.
8. "For Pi the last line goes": kept. (User decision)
