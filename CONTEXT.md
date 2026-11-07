# Kavex

A desktop app for running coding agents side by side, on this computer and on added machines.

## Language

**Agent**:
A coding program a person runs in a terminal, such as Claude Code, Codex or OpenCode.
_Avoid_: Tool, assistant

**Session**:
One conversation an agent holds. An agent runs in one terminal and holds one session at a time. Clearing the conversation starts a new session; compacting or resuming keeps the same one.
_Avoid_: Thread, chat, run

**Context**:
How much a session's conversation fills what its model can hold at once, as tokens used out of that total. Compacting shrinks it.
_Avoid_: Memory, context usage

**API cost**:
What a session's tokens would cost at the provider's public API prices. On a subscription this is not money the person paid.
_Avoid_: Spend, bill, price

**Machine**:
A computer Kavex runs terminals on: this computer or one the person added.
_Avoid_: Host, server, remote

**Provider**:
The company that sells a subscription, such as Anthropic, OpenAI or OpenCode.
_Avoid_: Vendor

**Subscription**:
A paid plan one account holds with a provider. Several agents and machines can draw on the same subscription; an agent signed in with an API key has none.
_Avoid_: Plan, account, agent (when the plan is meant)

**Limit**:
A cap on a subscription's use over a time window, with how much is used and when it resets.
_Avoid_: Quota, allowance
