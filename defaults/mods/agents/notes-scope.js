import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { machineOn } from "./machine.js";
import { pi } from "./pi.js";

function origin(term) {
  return term.address.includes("/") ? term.address.split("/", 2) : [null, term.address];
}

export function terminalScope(term) {
  if (!term?.address) return null;
  const [machine, address] = origin(term);
  const started = term.created_ms ?? term.pid;
  return started == null ? null : { machine, terminalRun: `${address}:${started}` };
}

export async function noteScope(term) {
  if (!term?.address) return null;
  const [machine] = origin(term);
  const agent = term.program?.key;
  const label = term.labels?.["kavex.session"];
  let session;
  try {
    if (agent === "claude") session = (await claude.locate({ term, machine: await machineOn(machine) }))?.id;
    if (agent === "codex") session = codex.locate({ label })?.id;
    if (agent === "pi") session = pi.locate({ label })?.id;
  } catch {
    // A missing record or a lost connection still lets the user save the quote for this terminal.
  }
  return session ? { machine, agent, session } : terminalScope(term);
}
