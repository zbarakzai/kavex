# Security and privacy

## Mods have your access

A mod is trusted JavaScript running inside Zaki. It can run programs with your environment, fetch URLs and read files.
The built-in file API limits writes to the app home, but a mod can run a program to write elsewhere. That is not a security boundary.
Mods can also run programs on connected machines.

There is no permission prompt for each program or network request. Read a mod before installing it, and treat it like a shell script you would run yourself.
Layouts can load mods. Check those references too.

## What stays on disk

The default app home is `~/.config/zaki`, including on macOS and Windows (under your user home).
`XDG_CONFIG_HOME` changes the config root. `HERDR_APP_HOME` selects an app home directly and takes precedence.

This folder holds your settings, keys, layouts, mods, generated agent guide and API types.
It also holds mod data, shared state, window positions, this screen's focus and zoom, update notes and cached media, and telemetry while enabled.
Mods may store sensitive data here. Zaki does not encrypt this folder.
The [installed guide's file map](../defaults/AGENTS.md#the-files) explains the files.

Spaces, tabs and splits are stored in each machine's core document, not in the app home.
Terminals and their output belong to [herdr-core](https://github.com/herdrdev/herdr-core).
Removing the app home does not stop the core or erase its data.

The app exposes a local control socket in its home so agents can inspect and drive the window.
Treat access to that home as access to the window and its commands.
Remote connections use SSH through the core.

## Updates and signing

Installed releases check Zaki's release service, download an update, and check its SHA-256 checksum against the release manifest before unpacking it.
The app switches to the downloaded version on quit. Source builds do not update themselves.
The release service is reached through a private link. It keeps Zaki from being found, but anyone who has the link, or a copy of the app, can download releases.
Core updates are handled separately by the core's updater, from Herdr's release service.

A checksum from the same service detects a damaged download; it is not an independent signature on the manifest.
The app does not verify a separate cryptographic signature on update manifests.

The release pipeline supports Apple Developer ID signing on macOS and Azure artifact signing on Windows when their credentials are configured.
Without them, packages can be unsigned or ad hoc signed.
On macOS the installer and updater verify certificate-signed bundles and preserve their signatures.
Apple notarization is tested separately; it is not required for publishing a release.
Do not assume every download is notarized or signed.

## Usage limits

The gauge in the sidebar footer shows your subscriptions' limits. It checks 5 seconds after the footer starts, every 15 minutes, and when you open it. **Settings → Look → Usage limits** turns it off: checks stop and everything below is cleared, including your OpenCode answer.

**What it runs.** On this computer and on each added machine:

- Your shell, once per check, to learn its `PATH`: `$SHELL -ic 'printenv PATH'`. Your shell's startup files run when it does. Windows skips this step.
- `command -v` (`Get-Command` on Windows), to look for an agent Zaki didn't find by itself.
- Claude Code: `claude auth status`, then `claude -p /usage`, with no hooks, plugins, MCP servers or saved session. It spends no tokens.
- Codex: `codex app-server` in read-only mode, asked for your account and your limits.

Agents start the way `programs.json`'s `run` says, if you changed it.

**What it reads.** The answers to those commands. It doesn't read Claude Code's or Codex's login, and it never touches the macOS Keychain. Those answers include your email, which is used to make a short SHA-256 fingerprint, so that one account on two machines shows as one row. The email isn't kept.

**What it sends.** For Claude Code and Codex, nothing: those programs talk to their own providers, as they always do. OpenCode has no such command, so it is the one exception, and it works like this:

- Nothing is read or sent until you press Allow on the card in the popover. Not now saves that answer and reads nothing. Turning Usage limits off and on asks again.
- After Allow, on this computer only, each check reads the keys for `opencode` and `opencode-go` from `~/.local/share/opencode/auth.json` and from the `credential` table of `opencode.db` beside it, with `sqlite3 -readonly`. Keys on added machines are never read.
- A key written as a variable or a command, such as `$OPENCODE_API_KEY` or `!pass show opencode`, is left alone and never sent.
- Each key is sent in turn to `https://opencode.ai/zen/go/v1/usage` as a Bearer header, until one gives Go's limits. That is the only address it goes to. Zaki's `fetch` refuses to carry that header through a redirect to anywhere else.

**What it keeps.** In `shared.json` in the app home, not encrypted: each subscription's name, tier and limits, and the fingerprint for Claude Code and Codex. No key, login or email is saved, and nothing made from an OpenCode key.

## Telemetry

Zaki collects a small daily usage report with a random install ID, but no build sends it: Zaki has no telemetry server yet.
Reports include app and core versions, OS and architecture, bucketed usage time and counts, known agent names, built-in layout names, mod counts, app command names, and fixed event counters.
Custom layout names become `custom`; custom mod names are not sent.
Terminal text, prompts, file contents, folder paths and free-text names are not included.

Turn it off in **Settings → Privacy**. That page also lets you inspect the report.
Or set this field in your existing `settings.json`:

```json
{
  "telemetry": false
}
```

Turning it off deletes the local install ID and unsent reports. It cannot recall reports already sent.
For one run, set `DO_NOT_TRACK=1` or `HERDR_TELEMETRY=0`. CI environments disable collection too.
Ordinary source builds collect locally while enabled but do not send, unless pointed at a test endpoint with `HERDR_TELEMETRY_URL`.

Telemetry being off does not stop update checks, Usage limits, mod network requests or feedback you choose to send.
Feedback is drafted for you to review and send, not sent silently.

[Back to Zaki](../README.md)
