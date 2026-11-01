# Zaki app

The Zaki desktop app (`zaki`): a native GPUI client of
[herdr-core](https://github.com/herdrdev/herdr-core), forked from
[Herdr](https://github.com/herdrdev/herdr-app). Zakiullah (`zbarakzai`)
maintains Zaki. Can (`ogulcancelik`) maintains Herdr and herdr-core.

If AGENTS.local.md exists, read it too: the maintainer's local rules.

## Compatibility

Preserve compatibility with released versions and installed user data.
Discuss breaking changes and removal of compatibility code with the maintainer
before changing documented behavior.

## Before you grow the app's core: ask Zakiullah

The app's core (the model, machine layout documents, commands, and shared mod APIs)
stays small; everything else is mods. Before adding anything to it, answer
these three, then discuss with Zakiullah and wait for the go-ahead:

1. Does the app itself act on it (it changes what the app does, not only
   how something looks)?
2. Can only the app see it (e.g. a change that happens while no mod is
   watching)?
3. Can mods not do it correctly, even with care?

If all three are no, it belongs in mods (their shared storage, their own
code), even at the price of some repetition. What the app asks of
herdr-core goes through Can, who maintains it.

`zaki --skill` prints the window manual in `src/SKILL.md`.
Keep it current when changing agent-facing behavior.

## The guide users' agents read

`defaults/AGENTS.md` is written into every user's `~/.config/zaki` on
every start: it's how their agents learn what the app can do. A change to
what users or agents can do (a command, a setting, a layout or mod
feature, a file) updates it in the same commit. `cargo test` checks that it
names every command and settings.json key; the rest is on you. Keep it a
map with rules and short examples: the `.d.ts` files are generated and are
the full API.

## What ships in the box

`defaults/` is built into the app: mods, `layouts/*.json`, `keys.json`
(Linux, Windows) and `keys.macos.json` (Mac). Shipped layouts and mods are
replaced on start; edited versions are moved to personal copies. Layout
clicks are kept separately. `keys.json` is installed only when missing, so a
changed default key never reaches existing users by itself.

## Platform differences

Gate per OS only where the OS really behaves differently. A one-line
`cfg!(windows)` next to the quirk is fine, with a comment saying why; anything
bigger goes behind one small module per concern rather than `#[cfg]` spread
through shared code. Give the quirk a test on its platform and keep the other
platforms' behavior unchanged (and tested). Windows and macOS changes are
checked on those systems, not only by cross-compiling.

## Building and testing

`just build`, `just test` (what CI runs, on Linux), `just check` (the tests).
`just dev` runs this checkout beside an installed Zaki, with its own home and core.
`just install` builds and installs the desktop app using the platform installer,
replacing an installed release. On Windows it updates `%LOCALAPPDATA%\Programs\zaki` and the Start menu;
quit and reopen Zaki to use the new build. Windows recipes use PowerShell by default;
`just --shell pwsh --shell-arg -Command <recipe>` uses pwsh.

Never run a bare `target/*/zaki` (no arguments) on a machine where you
also use the app without `HERDR_APP_HOME` pointing at a scratch home: it
opens a second window on your real setup. Subcommands and `--help` only
talk.

On Linux, test UI changes in the sandbox: `scripts/sandbox up`, then `do
<command> [json]`, `status`, `shot` (screenshot), `move|click|drag`
(pointer input, window px), `type`, `key <keysym> [Control_L ...]`, `hc
...`, `restart`, `down`. It has its own core, home and a headless display
(Weston + Xwayland) under `/var/tmp/zaki-sandbox`, so nothing pops up
on your screen. Never fake input on a real display. Run `scripts/sandbox
down` when done.

## Contributing

Work on a branch and open a pull request to `master`. CI must pass and
Zakiullah approves; merges are squashed. Commit messages: lowercase conventional
commits, single line, no AI co-author lines. Only Zakiullah releases: check
`defaults/mods/agents/prices.js` against each provider's official pricing page
(a model missing from it reads "no price" until it's added), bump the version
in `Cargo.toml`, add its CHANGELOG section, wait for `ci` on `master`, then
push the `v*` tag. `release.yml` publishes to the R2 bucket in the
repository's `R2_BUCKET` and `RELEASES_URL` variables, and installed copies
update from there. The bucket stays private: the Cloudflare Worker in
`distribution/worker` serves it under the secret key in `RELEASES_URL`. That
key is built into installed copies, so changing it means everyone reinstalls.

CHANGELOG.md: every release gets a `## [x.y.z] - YYYY-MM-DD` section
(`### New` / `### Fixed`), written at release time from the commits since the
last tag; Zaki shows it as the update notes. One line per change, in user
words (what a person notices, not code), with the issue or PR number and
`thanks @name` for contributors. Leave out internal changes and fixes for bugs
that never shipped.

Never stop, signal, or restart someone else's app or core. Use an isolated
app home and core session for testing.

## Agent skills

### Issue tracker

Issues and specs live as local Markdown under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five roles, kept as a `Status:` line in each issue file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
