# Security

Report vulnerabilities privately through [GitHub's Report a vulnerability](https://github.com/zbarakzai/zaki/security/advisories/new). Don't post exploit details in a public issue.

Include the Zaki version, OS, what you found, steps to reproduce it, and the impact. A small proof of concept helps. Remove secrets and personal data from logs.

Only the latest release is supported.

For how Zaki handles trusted mods, updates and telemetry, see [security and privacy](docs/security.md).

Usage limits runs Claude Code's and Codex's own commands and reads their answers, so their logins stay with them. The one thing it sends itself is your OpenCode key, to `opencode.ai` only, and only after you press Allow. [Usage limits](docs/security.md#usage-limits) lists what it reads, runs and sends.
