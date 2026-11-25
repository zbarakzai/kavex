import { Buffer } from "buffer";

// These commands collect only numeric counters and process identity. They run locally
// as children of the desktop, which also gives us the exact desktop PID.
const PROBE = "kavex-system-monitor";

const LINUX = String.raw`
set -e
printf '%s %s %s\n' "$PPID" "$(getconf PAGESIZE)" "$(getconf _NPROCESSORS_ONLN)"
cat /proc/stat /proc/meminfo
printf '%s\n' --
for path in /proc/[0-9]*/stat; do
  if { IFS= read -r row < "$path"; } 2>/dev/null; then
    printf '%s\n' "$row"
  fi
done
`;

// Read the cumulative ticks behind iostat without spending a second inside the
// probe. Both supported macOS architectures use little-endian 32-bit Mach words.
const MACH_CPU = `
ObjC.import("Foundation");
ObjC.bindFunction("mach_host_self", ["uint32", []]);
ObjC.bindFunction("host_statistics", ["int", ["uint32", "int", "void *", "void *"]]);
const HOST_CPU_LOAD_INFO = 3;
const ticks = $.NSMutableData.dataWithLength(16);
// The input/output word count is initialized to 4 (user, system, idle, nice).
const count = $.NSMutableData.alloc.initWithBase64EncodedStringOptions("BAAAAA==", 0);
if ($.host_statistics($.mach_host_self(), HOST_CPU_LOAD_INFO, ticks.mutableBytes, count.mutableBytes) !== 0)
  throw new Error("Could not read Mach CPU counters");
ObjC.unwrap(ticks.base64EncodedStringWithOptions(0));
`;

const MACOS = String.raw`
set -e
export LC_ALL=C
printf '%s %s %s\n' "$PPID" "$(/usr/sbin/sysctl -n hw.memsize)" "$(/usr/sbin/sysctl -n hw.logicalcpu)"
if ticks=$(/usr/bin/osascript -l JavaScript -e "$1"); then
  printf 'cpu-ticks %s\n' "$ticks"
else
  /usr/sbin/iostat -d -C -n 0 -c 2 -w 1
fi
/usr/bin/vm_stat
printf '%s\n' --
/bin/ps -ax -o pid=,ppid=,rss=,time=,lstart=
`;

// CIM class names and raw counters work regardless of the display language.
const WINDOWS = String.raw`
$ErrorActionPreference = 'Stop'
$system = Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize,FreePhysicalMemory
$cpus = @(Get-CimInstance Win32_PerfRawData_Counters_ProcessorInformation -Property Name,Timestamp_Sys100NS,PercentProcessorTime)
$total = $cpus | Where-Object Name -eq '_Total'
$processes = @(Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess,CreatingProcessID,ElapsedTime,PercentProcessorTime,WorkingSet,Timestamp_Sys100NS)
$self = $processes | Where-Object IDProcess -eq $PID | Select-Object -First 1
@{
  appPid = $self.CreatingProcessID
  cores = @($cpus | Where-Object Name -match '^\d+,\d+$').Count
  total = [double]$system.TotalVisibleMemorySize * 1024
  available = [double]$system.FreePhysicalMemory * 1024
  clock = $total.Timestamp_Sys100NS
  processClock = $self.Timestamp_Sys100NS
  idle = $total.PercentProcessorTime
  processes = @($processes | Where-Object IDProcess -gt 0 | ForEach-Object {
    @{ pid = $_.IDProcess; parent = $_.CreatingProcessID; start = $_.ElapsedTime;
       cpu = $_.PercentProcessorTime; memory = $_.WorkingSet }
  })
} | ConvertTo-Json -Compress -Depth 4
`;

const fields = (text) => text.trim().split(/\s+/);
const numeric = (value) => Number.isFinite(value) && value >= 0;
const memory = (total, available) =>
  total > 0 && numeric(available) ? { total, available: Math.min(total, available) } : null;

export function parseLinux(text) {
  const [header, table = ""] = text.split(/\r?\n--\r?\n/, 2);
  const [identity, ...lines] = header.trim().split("\n");
  const [appPid, pageSize, cores] = fields(identity).map(Number);
  const ticks = fields(lines.find((line) => line.startsWith("cpu ")) ?? "").slice(1, 9).map(Number);
  const total = ticks.reduce((sum, n) => sum + n, 0);
  const cpu = ticks.length === 8 && ticks.every(numeric) ? { total, busy: total - ticks[3] - ticks[4] } : null;
  const mem = Object.fromEntries(Array.from(header.matchAll(/^(\w+):\s+(\d+) kB/gm), ([, key, count]) => [key, Number(count) * 1024]));
  const available = mem.MemAvailable ?? (mem.MemFree + (mem.Buffers ?? 0) + (mem.Cached ?? 0)
    + (mem.SReclaimable ?? 0) - (mem.Shmem ?? 0));
  const processes = [];
  for (const row of table.trim().split("\n")) {
    // Linux puts the process name in parentheses and permits parentheses inside it.
    const end = row.lastIndexOf(")");
    if (end < 0) continue;
    const pid = Number(row.slice(0, row.indexOf(" ")));
    const columns = fields(row.slice(end + 1));
    const parent = Number(columns[1]), start = Number(columns[19]);
    const cpu = Number(columns[11]) + Number(columns[12]);
    const memory = Number(columns[21]) * pageSize;
    if (pid > 0 && [parent, start, cpu, memory].every(numeric)) processes.push({ pid, parent, start, cpu, memory });
  }
  return { appPid, cores, capacity: cpu?.total, cpu, memory: memory(mem.MemTotal, available), processes };
}

function macCpu(header) {
  const ticks = Buffer.from(header.match(/^cpu-ticks ([A-Za-z0-9+/=]+)$/m)?.[1] ?? "", "base64");
  if (ticks.length === 16) {
    const view = new DataView(ticks.buffer, ticks.byteOffset, ticks.byteLength);
    const busy = view.getUint32(0, true) + view.getUint32(4, true) + view.getUint32(12, true);
    return { total: busy + view.getUint32(8, true), busy };
  }
  // The fallback iostat reports a boot average first and interval CPU second.
  const idle = Array.from(header.matchAll(/^[ \t]*\d+[ \t]+\d+[ \t]+(\d+)[ \t]*$/gm), (match) => Number(match[1]));
  return idle.length > 1 ? { percent: 100 - idle.at(-1) } : null;
}

export function parseMac(text, now) {
  const [header, table = ""] = text.split(/\r?\n--\r?\n/, 2);
  const [appPid, total, cores] = fields(header.split("\n", 1)[0]).map(Number);
  const pageSize = Number(header.match(/page size of (\d+) bytes/)?.[1]);
  const pages = Object.fromEntries(Array.from(header.matchAll(/^([^:\n]+):\s+(\d+)\.$/gm), ([, key, count]) => [key, Number(count)]));
  // Approximate Activity Monitor's app + wired + compressed memory. File cache
  // can be reclaimed. Compressor occupancy is physical pages, not stored pages.
  const used = (pages["Anonymous pages"] + pages["Pages wired down"] + pages["Pages occupied by compressor"]
    - (pages["Pages purgeable"] ?? 0)) * pageSize;
  const processes = [];
  for (const row of table.trim().split("\n")) {
    const match = row.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?::\d+){1,2}\.\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const [, pid, parent, rss, time, start] = match;
    const cpu = time.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000;
    processes.push({ pid: Number(pid), parent: Number(parent), start, cpu, memory: Number(rss) * 1024 });
  }
  return { appPid, cores, capacity: now * cores, cpu: macCpu(header), memory: memory(total, Math.max(0, total - used)), processes };
}

export function parseWindows(text) {
  const { appPid, cores, total, available, clock, processClock, idle, processes } = JSON.parse(text);
  return { appPid, cores, capacity: processClock * cores, cpu: { total: clock, busy: clock - idle },
    memory: memory(total, available), processes };
}

export async function readSnapshot(platform, exec) {
  if (platform === "windows") {
    const { code, stdout } = await exec("powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS]);
    if (code === 0) return parseWindows(stdout);
  } else if (platform === "linux" || platform === "macos") {
    const args = platform === "linux" ? ["-c", LINUX, PROBE] : ["-c", MACOS, PROBE, MACH_CPU];
    const { code, stdout } = await exec("/bin/sh", args);
    if (code === 0) return platform === "linux" ? parseLinux(stdout) : parseMac(stdout, Date.now());
  }
  throw new Error("Could not sample this computer");
}
