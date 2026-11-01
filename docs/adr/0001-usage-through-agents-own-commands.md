# Usage limits come from each agent's own command

The `usage` mod shows subscription limits by running `claude -p /usage` and `codex app-server`, on the machine each agent is signed in on. It does not read Claude's or Codex's login, and it does not call `api.anthropic.com/api/oauth/usage` or `chatgpt.com/backend-api/wham/usage`, even though those give cleaner data and Omarchy uses the Claude one.

The rule is that no login reaches Zaki and the mod itself sends no request. Reading Claude's token would need a macOS Keychain prompt, and Anthropic's terms say developers may not "collect, store, or intermediate" Claude.ai credentials. Refreshing a token outside the CLI has also logged people out in other tools. Running the agent's own command avoids all of that, at the price of parsing the text Claude prints for people, so the mod keeps the last numbers when that text changes.

OpenCode is the one exception, because it has no such command: the mod reads its key and sends it only to `opencode.ai`, and only after the person presses Allow.

## Considered Options

- **Status line wrapper:** official and structured, but it edits the person's Claude settings, and a status line hides Claude's footer hints. It also only updates while Claude runs.
- **Private endpoints with consent:** still makes the mod send a request with someone's login, which the rule forbids.
