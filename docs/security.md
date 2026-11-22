# Security and privacy

## Mods have your access

A mod is trusted JavaScript running inside Kavex. It can run programs with your environment, fetch URLs and read files.
`fs/promises` limits writes to the app home, but `writeTextFile` writes anywhere you can, and a mod can run a program to do the same. Neither is a security boundary.
Mods can also run programs and write files on connected machines.

There is no permission prompt for each program or network request. Read a mod before installing it, and treat it like a shell script you would run yourself.
Layouts can load mods. Check those references too.

## What stays on disk

The default app home is `~/.config/kavex`, including on macOS and Windows (under your user home).
`XDG_CONFIG_HOME` changes the config root. `HERDR_APP_HOME` selects an app home directly and takes precedence.

This folder holds your settings, keys, layouts, mods, generated agent guide and API types.
It also holds mod data, shared state, window positions, this screen's focus and zoom, update notes and cached media, and telemetry while enabled.
Mods may store sensitive data here. Kavex does not encrypt this folder.
The [installed guide's file map](../defaults/AGENTS.md#the-files) explains the files.

For [session context](#session-context-and-api-cost), Kavex also writes these outside the app home, on each machine where it sees the agent:

- `~/.codex/hooks.json`: one hook added at the end of `SessionStart`. Your own hooks keep their place, and a file Kavex can't read or understand is left alone.
- `~/.kavex/codex-session.sh` and `~/.kavex/codex-session.ps1`: the script that hook runs.
- `~/.pi/agent/extensions/kavex-session.ts`: an extension of Kavex's own. Pi loads it with nothing to approve.

They do nothing outside a Kavex terminal, and they stay behind if you remove Kavex or the app home.

Spaces, tabs and splits are stored in each machine's core document, not in the app home.
Terminals and their output belong to [herdr-core](https://github.com/herdrdev/herdr-core).
Removing the app home does not stop the core or erase its data.

The app exposes a local control socket in its home so agents can inspect and drive the window.
Treat access to that home as access to the window and its commands.
Remote connections use SSH through the core.

## Updates and signing

Installed releases check Kavex's GitHub releases (`github.com/zbarakzai/kavex/releases`), download an update, and check its SHA-256 checksum against the release manifest before unpacking it.
The app switches to the downloaded version on quit. Source builds do not update themselves.
Core updates are handled separately by the core's updater, from Herdr's release service.

A checksum from the same service detects a damaged download; it is not an independent signature on the manifest.
The app does not verify a separate cryptographic signature on update manifests.

The release pipeline supports Apple Developer ID signing on macOS and Azure artifact signing on Windows when their credentials are configured.
Without them, packages can be unsigned or ad hoc signed.
On macOS the installer and updater verify certificate-signed bundles and preserve their signatures.
Apple notarization is tested separately; it is not required for publishing a release.
Do not assume every download is notarized or signed.

## Usage limits

Open **Usage** at the bottom right. A custom layout with just the
sidebar footer offers **More actions → Usage limits**.
While Kavex is active, checks run when readings are due and every 15 minutes. **Settings → Look →
Usage limits** stops polling and clears usage data and access choices.

**CLI readings.** Claude Code, Codex, Antigravity, Muse, Amp and Copilot can report usage through
their own programs. Kavex launches their usage-only commands or calls their account quota methods,
on the machine where the agent runs. Their own CLI handles its login and provider requests.

**Provider requests.** In Usage’s **Manage Accounts**, you can grant access for a provider on a
particular machine. Kavex then reads the following credentials for its usage request.

| Provider | Login source | Request origin |
| --- | --- | --- |
| Claude Code | Claude Code credentials file or its macOS Keychain item | `api.anthropic.com` |
| Codex | Codex’s `auth.json` when App Server needs a supplemental reading | `chatgpt.com` |
| OpenCode Go | OpenCode `auth.json` and read-only credential database | `opencode.ai` |
| Cursor | Cursor CLI login, platform credential store or read-only Cursor account database | `cursor.com` |
| Gemini | Gemini CLI or OpenCode’s Google login | `cloudcode-pa.googleapis.com` and `oauth2.googleapis.com` |
| Grok | Grok CLI account session | `cli-chat-proxy.grok.com` |
| Kimi | Kimi CLI account and credential files | `api.kimi.com` |

Kavex validates the origin before sending credentials and refuses to forward them to a different
origin after a redirect. Gemini may renew its token in memory. The account probes do not persist
credentials or change the provider's login files. On added machines, Node.js 18 or Bun runs the
adapter locally to that machine and returns its sanitized results to Kavex.

**Stored data.** The app home’s `shared.json` holds usage readings, tier labels, account fingerprints,
access decisions, and a bounded timeline of observed limits. It contains no credentials, email,
raw account ID, or provider login response. Clearing or switching a discovered account clears the
history for that provider and machine.

## Session context and API cost

The `agents` mod shows how full each Claude Code, Codex and Pi session is, and what it would cost at API prices. It has no off switch.

**What it runs.** On the machine the agent runs on:

- Claude Code: `claude -p "/context"`, once per model and kept for a day, with no saved session, MCP servers or setting sources. It spends no tokens.
- `sh` with `dd`, `wc`, `grep` and `find` to read session files. Windows uses PowerShell, which also lists running processes to find Claude Code's.
- Codex's hook and Pi's extension run `hc label`, to tell Kavex which session file a terminal holds and, for Pi, its context's total.

Kavex never approves its Codex hook. Codex runs it only after you trust it in `/hooks`.

**What it reads.** Your agents' session files, which hold your conversations, and Claude Code's per-process record in `~/.claude/sessions`. A filter runs over each file, and only lines with usage, a model or a helper's name reach the mod. For Pi those lines hold the whole answer. To set up, it reads `~/.codex/hooks.json` and the files listed under [What stays on disk](#what-stays-on-disk). It doesn't read any agent's login, or Codex's `config.toml`.

**What it sends.** Nothing. On an added machine the numbers come back over your own connection to it.

**What it keeps.** In `shared.json` in the app home, not encrypted: each model's context total, and which agents are set up on which machine. Terminal labels in the core hold each session file's path, and Pi's context total. No conversation text, token count or cost is saved.

## Telemetry

Kavex collects a small daily usage report with a random install ID, but no build sends it: Kavex has no telemetry server yet.
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

[Back to Kavex](../README.md)
