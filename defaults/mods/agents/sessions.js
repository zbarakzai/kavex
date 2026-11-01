// What each agent's session shows on its row and in its dropdown. An agent here is a small
// object (see claude.js): `locate` finds a terminal's session, `filter`, `facts` and `add` read
// its lines, `numbers` says what they add up to, and `limit` asks how big its model's context is.

import { exec, setShared, shared, terminals, watchFolder } from "herdr";
import { claude } from "./claude.js";

const AGENTS = { claude };

const NONE = { state: "none" };
const EVERY = 2000;
const LIMITS = "agents.limits";
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
  }

  start(cx) {
    this.pass(cx);
    cx.timer.every(EVERY, (cx) => this.pass(cx));
  }

  shown(address) {
    const found = this.live.get(address)?.result ?? NONE;
    if (found.state !== "ready") return found;
    const { asked, used, ...rest } = found;
    const total = shared(LIMITS)?.[asked]?.total;
    // More used than the total means the total is wrong: no percent rather than a wrong one.
    const context = total >= used ? { used, total, percent: Math.round((used / total) * 100) } : { used };
    return { ...rest, context };
  }

  // A pass that's still reading is left alone; `reading` is a time because a stopped script
  // can't clear a flag.
  pass(cx) {
    if (Date.now() - (this.reading ?? 0) < 60000) return;
    this.reading = Date.now();
    cx.spawn(async (cx) => {
      const listed = terminals().filter((t) => t.state === "live" && hasSession(t) && (!this.only || t.address === this.only));
      for (const a of this.live.keys()) if (!listed.some((t) => t.address === a)) this.live.delete(a);
      for (const term of listed) await this.follow(term, cx);
      this.reading = 0;
    });
  }

  async follow(term, cx) {
    const agent = AGENTS[term.program.key];
    let session = this.live.get(term.address);
    try {
      const found = await agent.locate(term);
      if (found && found.id !== session?.id) {
        session = { ...found, facts: agent.facts(), block: 0, dirty: true };
        this.live.set(term.address, session);
      }
      if (!session || (!session.dirty && this.folders.has(session.folder))) return;
      session.dirty = false;
      const had = JSON.stringify(session.result);
      session.result = await this.read(session, agent);
      this.watch(session, cx);
      if (session.result.state === "ready" && !this.only) this.ask(agent, session.result.asked, cx);
      if (JSON.stringify(session.result) !== had) cx.notify();
    } catch {
      // The last result stands, and the next pass tries again.
      if (session) session.dirty = true;
    }
  }

  async read(session, agent) {
    for (;;) {
      const { code, stdout } = await exec("sh", ["-c", NEW_LINES, "sh", session.file, String(session.block), agent.filter]);
      if (code === 3) {
        session.dirty = true;
        return session.result ?? { state: "empty" };
      }
      const lines = stdout.split("\n");
      const size = Number(lines[0]);
      if (!lines[0] || !Number.isFinite(size)) throw new Error("no size");
      if (size < session.block * BLOCK) {
        session.facts = agent.facts();
        session.block = 0;
        continue;
      }
      for (let i = 1; i < lines.length; i++) {
        try {
          agent.add(session.facts, JSON.parse(lines[i]));
        } catch {}
      }
      const end = session.block + WINDOW;
      const last = Math.floor(size / BLOCK);
      session.block = Math.max(0, Math.min(end, last) - 1);
      if (end > last) break;
    }
    const numbers = agent.numbers(session.facts);
    return numbers ? { state: "ready", ...numbers } : { state: "empty" };
  }

  // Changes under a session's folder mark it for the next pass, so nothing is read more than
  // once per pass however fast it's written. A folder that can't be watched is read every pass.
  watch(session, cx) {
    const { folder } = session;
    if (this.folders.has(folder)) return;
    this.folders.add(folder);
    cx.spawn(async () => {
      try {
        for (;;) {
          const changed = await watchFolder(folder);
          for (const s of this.live.values()) if (changed.some((path) => path.includes(s.id))) s.dirty = true;
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
