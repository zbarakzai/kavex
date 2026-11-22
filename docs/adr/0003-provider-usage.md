# Provider usage follows the execution owner

Kavex has one workspace usage service built from its own mods. It applies Orca's separation of
provider acquisition, account and machine routing, refresh policy, and presentation. The providers
share an observation format and each keeps its own protocol. [Orca providers](https://github.com/stablyai/orca/tree/b342cee0ff07f7d702db5c09543d7506a9424a48/src/main/rate-limits/providers)

## Acquiring a reading

The provider registry identifies the CLI and consent requirement. Claude and Codex have their
own CLI sources and optional credential-backed sources. Antigravity and Muse verify CLI support
before calling a usage command. Amp calls its usage command. Copilot reads account quota over its
headless JSON-RPC protocol. OpenCode Go uses its keyed endpoint. Cursor, Gemini, Grok and Kimi use
their provider's login store and usage endpoint. Gemini may renew its OAuth token in memory.

A machine receives its own probe. Credential-backed probes can use a Node.js 18 or Bun process
where the account lives. Desktops without either runtime can use the mod's network API. The
execution owner returns a reading with status, provider windows, and an optional hashed account
identifier. It keeps tokens, response bodies and user identifiers in memory. Remote configurations
that require the network adapter prompt for usage access on that machine.

Agent runtimes which share another provider's subscription show the available source in the
roster. Kiro, Qoder and Command Code expose interactive usage views. These programs get an explicit
status until a supported background source exists.

## Publishing and refreshing

The mod starts one generation of probes and publishes each finished provider immediately. Every
result carries its generation and resolves to a provider and machine. The most recent published
generation wins. Removing a machine purges its readings and history. A known account switch
starts a new timeline. Manual refresh queues once while a generation runs.

Automatic checks pause when the desktop is inactive. Activation reuses readings for five
minutes. Background polling runs every 15 minutes and checks earlier for known resets or retry
dates. Retries respect available provider Retry-After headers and use exponential backoff for
temporary failures. A failed check retains the age and still-current windows from the last
successful result for 30 minutes. Throttling and renewable Claude login expiry use up to 24
hours. Confirmed sign-out clears the reading. [Orca polling](https://github.com/stablyai/orca/blob/b342cee0ff07f7d702db5c09543d7506a9424a48/src/main/rate-limits/service/service-polling.ts) · [Orca result policy](https://github.com/stablyai/orca/blob/b342cee0ff07f7d702db5c09543d7506a9424a48/src/main/rate-limits/service/service-result-policy.ts)

## Presenting readings

The Usage button below the workspace opens the roster for the active machine. A custom
layout with just the sidebar footer offers the roster for all machines in More actions. The roster sorts by the highest primary usage percentage
and offers Compact / Detailed and Used / Left preferences. Provider details show every
limit and balance alongside the reading's age.
Kavex's Accounts view manages access to installed provider accounts. History shows samples of
observed quota windows per provider and machine. [Orca usage roster](https://github.com/stablyai/orca/blob/b342cee0ff07f7d702db5c09543d7506a9424a48/src/renderer/src/components/status-bar/usage/UsageRosterPanel.tsx)
