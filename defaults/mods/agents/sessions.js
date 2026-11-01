// What each agent's session shows on its row and in its dropdown. An agent here is a small
// object (see claude.js): `locate` finds a terminal's session, `helpers` its helpers' files,
// `filter`, `facts` and `add` read their lines, `numbers` says what they add up to (cost included,
// or left out for "no price"), and `limit` asks how big its model's context is, unless `numbers`
// knows and gives `context` itself. One that labels its own terminal is marked `reports`, says
// what to do in `waiting`, and has `patience` if it labels at launch. One with files of its own to
// set up has `setup`, a version, and `install`. What differs from one machine to the next is in
// machine.js: each agent is handed the machine it's on.

import { agents, hc, machines, setShared, shared, terminals, watchFolder } from "herdr";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { BLOCK, NO_FILE, machineOn } from "./machine.js";
import { pi } from "./pi.js";

const AGENTS = { claude, codex, pi };

const LABEL = "zaki.session";
const LIMIT = "zaki.limit";
const NONE = { state: "none" };
const EMPTY = { state: "empty", say: "No usage yet" };
const WORKED = ["working", "done"];
const EVERY = 2000;
const AWAY = 30000;
const LIMITS = "agents.limits";
const SETUP = "agents.setup";
const KEPT = 86400000;
const RETRY = 600000;

export const hasSession = (t) => Boolean(AGENTS[t?.program?.key]);

const machineOf = (address) => (address.includes("/") ? address.split("/")[0] : null);
const onMachine = (on, name) => (on ? `${on}/${name}` : name);
const offline = (on) => machines().find((m) => m.name === on)?.layout === "unavailable";
const leftBehind = (t) => (t.state === "live" && t.program?.shell ? [LABEL, LIMIT].filter((label) => t.labels?.[label]) : []);

// Reading an added machine costs traffic, so only for a row in the list: an agent, or one of its
// sub-agents.
function hasRow(term, all) {
  for (let t = term; t; t = all.find((x) => x.address === t.parent)) {
    if (agents().some((a) => a.address === t.address)) return true;
  }
  return false;
}

export class Sessions {
  // `only`: an address, for a dropdown following its one agent.
  constructor(only = null) {
    this.only = only;
    this.live = new Map();
    this.folders = new Set();
    this.asked = new Map();
    this.tried = new Map();
    this.reading = new Map();
    this.last = new Map();
    this.machines = new Map();
  }

  start(cx) {
    this.tick(cx);
    cx.timer.every(EVERY, (cx) => this.tick(cx));
  }

  // This computer every tick, each added machine every 30 seconds, and each on a pass of its own:
  // a slow machine holds up nothing but itself. One that's offline is left alone, so its rows keep
  // what they had.
  tick(cx) {
    this.pass(null, cx);
    const all = terminals();
    const due = all.filter((t) => t.address.includes("/") && (this.follows(t, all) || (!this.only && leftBehind(t).length)));
    for (const on of new Set(due.map((t) => machineOf(t.address)))) {
      if (offline(on) || Date.now() - (this.last.get(on) ?? -AWAY) < AWAY) continue;
      this.last.set(on, Date.now());
      this.pass(on, cx);
    }
  }

  follows(t, all) {
    if (t.state !== "live" || !hasSession(t)) return false;
    if (this.only) return t.address === this.only;
    return !t.address.includes("/") || hasRow(t, all);
  }

  shown(address) {
    const found = this.live.get(address)?.result ?? NONE;
    if (found.state !== "ready" || found.context) return found;
    const { asked, used, ...rest } = found;
    const total = shared(LIMITS)?.[onMachine(machineOf(address), asked)]?.total;
    // More used than the total means the total is wrong: no percent rather than a wrong one.
    const context = total >= used ? { used, total, percent: Math.round((used / total) * 100) } : { used };
    return { ...rest, context };
  }

  // A pass that's still reading is left alone. `reading` holds a time because a stopped script
  // can't clear a flag, and it names the one pass per machine that may touch a session: one the
  // machine slept through wakes to find itself replaced, and leaves its old lines unread.
  pass(on, cx) {
    if (Date.now() - (this.reading.get(on)?.at ?? 0) < 60000) return;
    const run = { on, at: Date.now() };
    this.reading.set(on, run);
    cx.spawn(async (cx) => {
      const all = terminals();
      const here = all.filter((t) => machineOf(t.address) === on);
      const listed = here.filter((t) => this.follows(t, all));
      for (const a of this.live.keys()) if (machineOf(a) === on && !listed.some((t) => t.address === a)) this.live.delete(a);
      if (!this.only) await this.tidy(here);
      run.machine = listed.length ? await this.machine(on).catch(() => null) : null;
      for (const term of run.machine ? listed : []) {
        if (!this.only) this.setUp(run.machine, term.program.key, AGENTS[term.program.key], cx);
        if (this.reading.get(on) === run && !(on && offline(on))) await this.follow(term, run, cx);
      }
      if (this.reading.get(on) === run) this.reading.delete(on);
    });
  }

  async machine(on) {
    if (!this.machines.has(on)) this.machines.set(on, await machineOn(on));
    return this.machines.get(on);
  }

  // A label outlives the agent that set it, and the next one only sets its own on its first
  // message: back at the shell, it goes, so that one can't show the last one's numbers.
  async tidy(all) {
    for (const t of all) {
      const left = leftBehind(t);
      if (!left.length) continue;
      try {
        await hc(["label", t.address, ...left.map((label) => `${label}=`)]);
      } catch {}
    }
  }

  // An agent's own files, once per `agent.setup` per machine. One that couldn't be done waits
  // before the next try.
  setUp(machine, key, agent, cx) {
    const now = Date.now();
    const name = onMachine(machine.on, key);
    if (agent.setup === undefined || shared(SETUP)?.[name] === agent.setup) return;
    if (now - (this.tried.get(name) ?? -RETRY) < RETRY) return;
    this.tried.set(name, now);
    cx.spawn(async () => {
      const done = await agent.install(machine.files).catch(() => false);
      if (done) setShared(SETUP, { ...shared(SETUP), [name]: agent.setup });
    });
  }

  // A session stays due until a read gets to its end, so a failed read leaves the last result
  // standing for the next pass to try again, and a change during a read isn't lost.
  async follow(term, run, cx) {
    const agent = AGENTS[term.program.key];
    let session = this.live.get(term.address);
    try {
      const found = await agent.locate(term, term.labels?.[LABEL], term.labels?.[LIMIT], run.machine);
      if (this.reading.get(run.on) !== run) return;
      if (found && found.id !== session?.id) {
        session = { ...found, facts: agent.facts(), files: new Map(), torn: new Set(), changes: 1, done: 0 };
        this.live.set(term.address, session);
      } else if (found && found.limit !== session.limit) {
        session.limit = found.limit;
        session.changes++;
      }
      if (agent.reports && !session?.file) return this.unreported(term, agent, cx);
      if (!session || (session.done === session.changes && this.folders.has(session.folder))) return;
      const { changes } = session;
      const had = JSON.stringify(session.result);
      const result = await this.read(session, agent, run);
      if (result) session.done = changes;
      session.result = result ?? session.result ?? EMPTY;
      if (!run.on) this.watch(session, cx);
      if (session.result.state === "ready" && !this.only && agent.limit) this.ask(agent, session.result.asked, run.machine, cx);
      if (JSON.stringify(session.result) !== had) cx.notify();
    } catch {}
  }

  // An agent that reports its own session and hasn't. Codex's hook runs on its first message, not
  // at launch, so one that hasn't worked yet may simply be new; only one that has is waiting. One
  // that reports at launch is waiting too once it has had time to start.
  unreported(term, agent, cx) {
    const had = this.live.get(term.address);
    const since = had?.since ?? Date.now();
    const late = had?.late || WORKED.includes(term.status) || Date.now() - since >= agent.patience;
    const result = late ? agent.waiting : EMPTY;
    this.live.set(term.address, { since, late, result });
    if (had?.result !== result) cx.notify();
  }

  // A pass that has been replaced stops here, before it touches anything.
  still(run) {
    if (this.reading.get(run.on) !== run) throw new Error("replaced");
  }

  // What a session comes to, or null while it has no file. Helpers add to its facts, and only
  // those that have grown are read; one found rewritten starts the whole session over, and a
  // helper can name more of them.
  async read(session, agent, run) {
    for (;;) {
      if (!(await this.take(session, session.file, agent, run))) return null;
      const { facts } = session;
      for (let again = Boolean(agent.helpers); again && session.facts === facts; ) {
        const helpers = await agent.helpers(session, run.machine);
        this.still(run);
        again = helpers.some(({ file }) => !session.files.has(file));
        for (const { file, size } of helpers) {
          if (session.files.get(file)?.size !== size) await this.take(session, file, agent, run, true);
        }
      }
      if (session.facts === facts) break;
    }
    const numbers = agent.numbers(session.facts, session);
    return numbers ? { state: "ready", ...numbers } : EMPTY;
  }

  // Reads a file's new lines into the session's facts, or returns false if it isn't there. A
  // window starts one block back, which reads again a line caught half written; lines count once,
  // so that's harmless. After its first read, only a file's end is read, and on an added machine
  // only if it has grown.
  //
  // `torn` holds kept lines that wouldn't parse until the whole line turns up: their usage is
  // missing, which an agent can't tell from none. A window's first line is the exception, as it
  // starts inside a line the window before read whole.
  async take(session, file, agent, run, helper = false) {
    const { machine } = run;
    for (;;) {
      const kept = session.files.get(file);
      const block = kept?.block ?? 0;
      const { code, stdout } = await machine.lines(file, block, machine.window, agent.filter, machine.on && kept?.done ? kept.size : "");
      this.still(run);
      if (code === NO_FILE) return false;
      const lines = stdout.split("\n");
      const size = Number(lines[0]);
      if (!lines[0] || !Number.isFinite(size)) throw new Error("no size");
      if (size < block * BLOCK) {
        session.facts = agent.facts();
        session.files.clear();
        session.torn.clear();
        continue;
      }
      for (let i = 1; i < lines.length; i++) {
        const text = lines[i];
        if (!text) continue;
        try {
          agent.add(session.facts, JSON.parse(text), helper, file);
          for (const part of session.torn) if (text.startsWith(part)) session.torn.delete(part);
        } catch {
          if (i > 1 || block === 0) session.torn.add(text);
        }
      }
      const end = block + machine.window;
      const last = Math.floor(size / BLOCK);
      const done = end > last;
      session.files.set(file, { block: Math.max(0, Math.min(end, last) - 1), size, done });
      if (done) return true;
    }
  }

  // Changes under a session's folder make it due, so nothing is read more than once per pass
  // however fast it's written. A folder that can't be watched is read every pass.
  watch(session, cx) {
    const { folder } = session;
    if (this.folders.has(folder)) return;
    this.folders.add(folder);
    cx.spawn(async () => {
      try {
        for (;;) {
          const changed = await watchFolder(folder);
          for (const s of this.live.values()) if (s.file && changed.some((path) => path.includes(s.id) || s.files.has(path))) s.changes++;
        }
      } catch {
        this.folders.delete(folder);
      }
    });
  }

  // Once per model per machine and kept for a day; a check that failed waits before the next try.
  ask(agent, model, machine, cx) {
    const now = Date.now();
    const key = onMachine(machine.on, model);
    const kept = shared(LIMITS)?.[key];
    if ((kept && now - kept.at < KEPT) || now - (this.asked.get(key) ?? -RETRY) < RETRY) return;
    this.asked.set(key, now);
    cx.spawn(async () => {
      const total = await agent.limit(model, machine).catch(() => null);
      if (total) setShared(LIMITS, { ...shared(LIMITS), [key]: { total, at: Date.now() } });
    });
  }
}
