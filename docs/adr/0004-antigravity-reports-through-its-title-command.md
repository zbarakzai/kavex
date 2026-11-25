# Antigravity reports its session through its title command, and its numbers live in the terminal label

Antigravity CLI documents no session file Kavex could read for context and API cost, but it hands its live state, with those numbers, to a title command on every change. So Kavex wraps the person's title command in a small bridge that runs theirs as before and labels its own terminal `kavex.session=antigravity:<JSON>` with the conversation ID, model and reported numbers. Unlike the other agents' labels, this one holds token totals and cost until the terminal is back at its shell: there is no file to point at, and the label ties the numbers to the exact terminal, as ADR 0002 asks.

The person's title has to keep working, in and outside Kavex. agy runs a launcher, not the bridge directly, so their command still runs if Node.js or Bun goes away, and a person with no title command gets `agy` rather than an empty title.

## Considered Options

- **The status line:** the same state, but it replaces what the person sees at the bottom of agy (ADR 0001).
- **Transcripts and hooks:** hooks name the conversation but carry no token or cost figures, and the transcript format isn't documented.
- **One snapshot file per terminal:** keeps numbers out of the core, but needs polling, file names built from IDs, and cleanup when terminals go.
