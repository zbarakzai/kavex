const percent = (fraction) => Math.max(0, Math.min(100, fraction * 100));

function hostCpu(before, current) {
  if (Number.isFinite(current?.percent)) return percent(current.percent / 100);
  if (!Number.isFinite(before?.total) || !Number.isFinite(current?.total)
    || current.total <= before.total || current.busy < before.busy) return null;
  return percent((current.busy - before.busy) / (current.total - before.total));
}

const isLocalAgent = (term) => typeof term.address === "string" && !term.address.includes("/")
  && term.state === "live" && (term.report?.app || term.program?.agent);

export const hasLocalAgentPid = (records) => records.some((term) => isLocalAgent(term) && term.pid > 0);

function agentRoots(records) {
  const seen = new Set();
  const roots = [];
  for (const term of records) {
    if (!isLocalAgent(term)) continue;
    if (term.pid > 0 && seen.has(term.pid)) continue;
    if (term.pid > 0) seen.add(term.pid);
    const program = term.program?.name ?? term.report?.app ?? "Agent";
    const name = term.name && term.name !== program ? `${program} · ${term.name}` : program;
    roots.push({ address: term.address, name, pid: term.pid, created: term.created_ms });
  }
  return roots;
}

export function measure(before, current, records, bindings = new Map()) {
  const roots = agentRoots(records);
  const hasAgentPids = roots.some(({ pid }) => pid > 0 && pid !== current.appPid);
  const capacity = current.capacity - before?.capacity;
  const processes = hasAgentPids ? new Map(current.processes.map((row) => [row.pid, row])) : null;
  const previous = hasAgentPids && capacity > 0 ? new Map(before.processes.map((row) => [row.pid, row])) : null;

  const processCpu = (row) => {
    if (!(capacity > 0)) return 0;
    const old = previous ? previous.get(row.pid) : before.processes.find(({ pid }) => pid === row.pid);
    return old && old.start === row.start ? Math.max(0, row.cpu - old.cpu) : 0;
  };
  const cpuShare = (ticks) => capacity > 0 ? percent(ticks / capacity) : null;
  const desktop = processes ? processes.get(current.appPid) : current.processes.find(({ pid }) => pid === current.appPid);
  const live = new Set(roots.map((root) => root.address));
  for (const address of bindings.keys()) {
    if (!live.has(address)) bindings.delete(address);
  }

  const attributed = new Map();
  for (const { address, pid, created } of roots) {
    const row = processes?.get(pid);
    if (!row || pid === current.appPid) continue;
    const bound = bindings.get(address);
    if (bound?.pid === pid && bound.created === created && bound.start !== row.start) continue;
    bindings.set(address, { pid, created, start: row.start });
    attributed.set(address, row);
  }
  const children = new Map();
  if (attributed.size) {
    for (const row of processes.values()) {
      const parent = processes.get(row.parent);
      // On Windows the parent PID can outlive the original parent in the child record.
      if (!parent || (typeof row.start === "number" && parent.start > row.start)) continue;
      if (!children.has(row.parent)) children.set(row.parent, []);
      children.get(row.parent).push(row);
    }
  }
  const claimed = new Set([current.appPid, ...Array.from(attributed.values(), (row) => row.pid)]);
  let agentMemory = 0, agentTicks = 0, measured = 0;
  const sessions = roots.map(({ address, name }) => {
    const root = attributed.get(address);
    if (!root) return { address, name, memory: null, cpu: null };
    let memory = 0, ticks = 0;
    const queue = [root];
    for (const row of queue) {
      memory += row.memory;
      ticks += processCpu(row);
      for (const child of children.get(row.pid) ?? []) {
        if (claimed.has(child.pid)) continue;
        claimed.add(child.pid);
        queue.push(child);
      }
    }
    agentMemory += memory;
    agentTicks += ticks;
    measured++;
    return { address, name, memory, cpu: cpuShare(ticks) };
  });

  const memory = current.memory && { ...current.memory, used: current.memory.total - current.memory.available,
    percent: percent(1 - current.memory.available / current.memory.total) };
  return {
    memory, cpu: hostCpu(before?.cpu, current.cpu), cores: current.cores,
    desktop: desktop ? { memory: desktop.memory, cpu: cpuShare(processCpu(desktop)) } : { memory: null, cpu: null },
    agents: measured || !roots.length ? { memory: agentMemory, cpu: cpuShare(agentTicks) } : { memory: null, cpu: null },
    sessions,
  };
}
