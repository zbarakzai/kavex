# Codex and Pi report their own session through a hook Zaki installs

To show a session's context and API cost on an agent's row, Zaki must know which session belongs to which terminal. Claude Code writes a per-process record, so its match is exact. Codex and Pi write nothing that links a running process to a session, so Zaki adds a small hook to Codex and a small extension to Pi. Each one labels the terminal with its session file when a session starts.

This is the first time Zaki writes into an agent's own settings, and it has to keep working as those agents change. The choice was made because several agents in one folder is normal here, and showing one agent's numbers on another's row is worse than showing none.

Codex won't run a new hook until the person approves it in `/hooks`. Zaki never writes that approval itself, because it is Codex's safety check and the person's decision. Until it's approved, the row shows `–` and the dropdown says what to do.

## Considered Options

- **Match by folder and terminal title:** nothing to install, and it worked on the one live Codex tested, but two agents with the same name in one folder could swap numbers, and the title can be turned off.
- **Codex's log database:** it has process ids beside session ids, but one live agent had 1,000 rows and no session id, and reading it needs `sqlite3`.
- **Writing Codex's approval from Zaki:** no step for the person, but it bypasses a safety check they own.
- **Pi's RPC mode:** needs no extension, but runs a separate process and doesn't see the live session.
