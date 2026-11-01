// What each agent's session shows on its row and in its dropdown. An agent here is a small
// object (see claude.js): `locate` finds a terminal's session, `helpers` its helpers' files,
// `filter`, `facts` and `add` read their lines, `numbers` says what they add up to (cost included,
// or left out for "no price"), and `limit` asks how big its model's context is, unless `numbers`
// knows and gives `context` itself. One that labels its own terminal is marked `reports`, and
// one with files of its own to set up has `setup`, a version, and `install`.

import { exec, hc, home, readTextFile, setShared, shared, terminals, watchFolder, writeTextFile } from "herdr";
import { claude } from "./claude.js";
import { codex } from "./codex.js";

const AGENTS = { claude, codex };

const LABEL = "zaki.session";
const NONE = { state: "none" };
const EMPTY = { state: "empty" };
const WAITING = { state: "waiting" };
const WORKED = ["working", "done"];
const EVERY = 2000;
const LIMITS = "agents.limits";
const SETUP = "agents.setup";
const KEPT = 86400000;
const RETRY = 600000;

// A session can be 100 MB and exec's output stops at 8 MiB, so it's read in windows no bigger
// than that, each its own script step, and after that only its end. A window starts one block
// back, which reads again a line cut by the last window's edge or caught half written; lines
// count once, so that's harmless. `dd` because BSD `head -c` takes five times as long.
const BLOCK = 1048576;
const WINDOW = 8;
const NEW_LINES = `[ -f "$1" ] || exit 3
wc -c < "$1" && dd if="$1" bs=${BLOCK} skip="$2" count=${WINDOW} 2>/dev/null | LC_ALL=C grep -aF -- "$3"`;

// This computer only, for now: an address with a machine in it (`vps/t7`) isn't read.
export const hasSession = (t) => Boolean(AGENTS[t?.program?.key]) && !t.address.includes("/");

export class Sessions {
  // `only`: an address, for a dropdown following its one agent.
  constructor(only = null) {
    this.only = only;
    this.live = new Map();
    this.folders = new Set();
    this.asked = new Map();
    this.tried = new Map();
  }

  start(cx) {
    this.pass(cx);
    cx.timer.every(EVERY, (cx) => this.pass(cx));
  }

  shown(address) {
    const found = this.live.get(address)?.result ?? NONE;
    if (found.state !== "ready" || found.context) return found;
    const { asked, used, ...rest } = found;
    const total = shared(LIMITS)?.[asked]?.total;
    // More used than the total means the total is wrong: no percent rather than a wrong one.
    const context = total >= used ? { used, total, percent: Math.round((used / total) * 100) } : { used };
    return { ...rest, context };
  }

  // A pass that's still reading is left alone. `reading` is a time because a stopped script
  // can't clear a flag, and it names the one pass that may touch a session: one the machine
  // slept through wakes to find itself replaced, and leaves its old lines unread.
  pass(cx) {
    if (Date.now() - (this.reading ?? 0) < 60000) return;
    const run = (this.reading = Date.now());
    cx.spawn(async (cx) => {
      const all = terminals();
      const listed = all.filter((t) => t.state === "live" && hasSession(t) && (!this.only || t.address === this.only));
      for (const a of this.live.keys()) if (!listed.some((t) => t.address === a)) this.live.delete(a);
      if (!this.only) await this.tidy(all);
      for (const term of listed) {
        if (!this.only) this.setUp(term.program.key, AGENTS[term.program.key], cx);
        if (this.reading === run) await this.follow(term, run, cx);
      }
      if (this.reading === run) this.reading = 0;
    });
  }

  // A label outlives the agent that set it, and the next one only sets its own on its first
  // message: back at the shell, it goes, so that one can't show the last one's numbers.
  async tidy(all) {
    for (const t of all) {
      if (t.state !== "live" || !t.program?.shell || !t.labels?.[LABEL]) continue;
      try {
        await hc(["label", t.address, `${LABEL}=`]);
      } catch {}
    }
  }

  // An agent's own files, once per `agent.setup` per machine. `name` keys that, so a machine
  // can have its own. One that couldn't be done waits before the next try.
  setUp(name, agent, cx) {
    const now = Date.now();
    if (agent.setup === undefined || shared(SETUP)?.[name] === agent.setup) return;
    if (now - (this.tried.get(name) ?? -RETRY) < RETRY) return;
    this.tried.set(name, now);
    cx.spawn(async () => {
      const done = await agent.install({ home: home(), read: readTextFile, write: writeTextFile }).catch(() => false);
      if (done) setShared(SETUP, { ...shared(SETUP), [name]: agent.setup });
    });
  }

  // A session stays due until a read gets to its end, so a failed read leaves the last result
  // standing for the next pass to try again, and a change during a read isn't lost.
  async follow(term, run, cx) {
    const agent = AGENTS[term.program.key];
    let session = this.live.get(term.address);
    try {
      const found = await agent.locate(term, term.labels?.[LABEL]);
      if (this.reading !== run) return;
      if (found && found.id !== session?.id) {
        session = { ...found, facts: agent.facts(), files: new Map(), changes: 1, done: 0 };
        this.live.set(term.address, session);
      }
      if (agent.reports && !session?.file) return this.unreported(term, cx);
      if (!session || (session.done === session.changes && this.folders.has(session.folder))) return;
      const { changes } = session;
      const had = JSON.stringify(session.result);
      const result = await this.read(session, agent, run);
      if (result) session.done = changes;
      session.result = result ?? session.result ?? EMPTY;
      this.watch(session, cx);
      if (session.result.state === "ready" && !this.only && agent.limit) this.ask(agent, session.result.asked, cx);
      if (JSON.stringify(session.result) !== had) cx.notify();
    } catch {}
  }

  // An agent that reports its own session and hasn't. Codex's hook runs on its first message, not
  // at launch, so one that hasn't worked yet may simply be new; only one that has is waiting.
  unreported(term, cx) {
    const had = this.live.get(term.address);
    const worked = had?.worked || WORKED.includes(term.status);
    const result = worked ? WAITING : EMPTY;
    this.live.set(term.address, { worked, result });
    if (had?.result !== result) cx.notify();
  }

  // A pass that has been replaced stops here, before it touches anything.
  still(run) {
    if (this.reading !== run) throw new Error("replaced");
  }

  // What a session comes to, or null while it has no file. Helpers add to its facts, and only
  // those that have grown are read; one found rewritten starts the whole session over, and a
  // helper can name more of them.
  async read(session, agent, run) {
    for (;;) {
      if (!(await this.take(session, session.file, agent, run))) return null;
      const { facts } = session;
      for (let again = Boolean(agent.helpers); again && session.facts === facts; ) {
        const helpers = await agent.helpers(session);
        this.still(run);
        again = helpers.some(({ file }) => !session.files.has(file));
        for (const { file, size } of helpers) {
          if (session.files.get(file)?.size !== size) await this.take(session, file, agent, run, true);
        }
      }
      if (session.facts === facts) break;
    }
    const numbers = agent.numbers(session.facts);
    return numbers ? { state: "ready", ...numbers } : EMPTY;
  }

  // Reads a file's new lines into the session's facts, or returns false if it isn't there.
  async take(session, file, agent, run, helper = false) {
    for (;;) {
      const block = session.files.get(file)?.block ?? 0;
      const { code, stdout } = await exec("sh", ["-c", NEW_LINES, "sh", file, String(block), agent.filter]);
      this.still(run);
      if (code === 3) return false;
      const lines = stdout.split("\n");
      const size = Number(lines[0]);
      if (!lines[0] || !Number.isFinite(size)) throw new Error("no size");
      if (size < block * BLOCK) {
        session.facts = agent.facts();
        session.files.clear();
        continue;
      }
      for (let i = 1; i < lines.length; i++) {
        try {
          agent.add(session.facts, JSON.parse(lines[i]), helper, file);
        } catch {}
      }
      const end = block + WINDOW;
      const last = Math.floor(size / BLOCK);
      session.files.set(file, { block: Math.max(0, Math.min(end, last) - 1), size });
      if (end > last) return true;
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

  // Once per model and kept for a day; a check that failed waits before the next try.
  ask(agent, model, cx) {
    const now = Date.now();
    const kept = shared(LIMITS)?.[model];
    if ((kept && now - kept.at < KEPT) || now - (this.asked.get(model) ?? -RETRY) < RETRY) return;
    this.asked.set(model, now);
    cx.spawn(async () => {
      const total = await agent.limit(model).catch(() => null);
      if (total) setShared(LIMITS, { ...shared(LIMITS), [model]: { total, at: Date.now() } });
    });
  }
}
