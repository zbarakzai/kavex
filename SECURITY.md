# Security

Report vulnerabilities privately through [GitHub's Report a vulnerability](https://github.com/zbarakzai/kavex/security/advisories/new). Don't post exploit details in a public issue.

Include the Kavex version, OS, what you found, steps to reproduce it, and the impact. A small proof of concept helps. Remove secrets and personal data from logs.

Only the latest release is supported.

For how Kavex handles trusted mods, updates and telemetry, see [security and privacy](docs/security.md).

Usage limits calls agent usage commands and account endpoints. Credential-backed checks require the person to authorize that provider on the machine holding the login. [Usage limits](docs/security.md#usage-limits) lists what it reads, runs and sends.
