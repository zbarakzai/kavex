#!/usr/bin/env python3
"""Zaki's performance harness for Windows: one command, numbers you can compare.

    py -3.12 scripts/perf/perf.py run [--label NAME] [--only cold,open,...]
    py -3.12 scripts/perf/perf.py compare before.json after.json
    py -3.12 scripts/perf/perf.py live --pid 1234 [--seconds 20]
    py -3.12 scripts/perf/perf.py profile [--only idle,open,...]

`run` builds what ships (`cargo build --release --locked`), launches isolated
instances (see instance.py), drives them through their control socket and
messages posted to their own window, and writes .scratch/perf/<time>-<label>.json.
Needs cargo and hc on PATH. The test window opens on the real desktop; it never
takes the mouse or the keyboard from the person, and it's told it's active by a
message to itself, not by taking the foreground. See scripts/perf/README.md.
"""

import argparse
import datetime
import hashlib
import json
import os
import random
import re
import statistics
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
REPO = os.path.dirname(os.path.dirname(HERE))

import winapi as w  # noqa: E402
from instance import CoreClient, Instance, core_binary  # noqa: E402

RESULTS = os.path.join(REPO, ".scratch", "perf")
SCENARIOS = ("cold", "open", "input", "frames", "throughput", "idle", "overhead")
# Like an agent that reports and draws nothing (scripts/bench.py's REPORTS):
# `working` with no output, or a title that changes.
REPORTS = r"""
import sys, time, itertools
state = sys.argv[1]
sys.stdout.write(f"\033]7501;state={'idle' if state == 'idle' else 'working'}:app=pi\033\\")
sys.stdout.flush()
spin = itertools.cycle("abcdefghij")
while True:
    if state == "title":
        sys.stdout.write(f"\033]2;{next(spin)} working\007")
        sys.stdout.flush()
    time.sleep(0.5 if state == "title" else 1)
"""
# Frame event fields after the time: see src/bench/wndproc.rs and frame_counters.
FRAME = ("took", "msg", "window", "terminal", "grid", "rows", "render_us", "frame_us", "script_us", "materialize_us", "scripts")
# Writes to stdout as fast as it's taken, then says how long that took.
EMIT = r"""
import sys, time
total = int(sys.argv[1]) * 1024 * 1024
line = (b"the quick brown fox reads the diff and writes a careful patch for the failing test 0123456789" * 1)[:78] + b"\r\n"
block = line * (65536 // len(line))
out = sys.stdout.buffer
start = time.perf_counter()
done = 0
while done < total:
    out.write(block)
    out.flush()
    done += len(block)
took = time.perf_counter() - start
out.write(b"\r\nEMIT-DONE %d bytes in %.3f s\r\n" % (done, took))
out.flush()
time.sleep(float(sys.argv[2]) if len(sys.argv) > 2 else 3600)
"""
SCROLLBACK = "for i in range(1, 6001): print(f'{i:6} a line of scrollback to scroll through, long enough to fill most of the width')"


def stat(values, unit="ms"):
    v = sorted(float(x) for x in values if x is not None)
    if not v:
        return {"n": 0, "unit": unit}
    rank = lambda q: v[min(len(v) - 1, int(round(q * (len(v) - 1))))]
    return {"n": len(v), "unit": unit, "median": round(statistics.median(v), 3), "p95": round(rank(0.95), 3), "p99": round(rank(0.99), 3),
            "min": round(v[0], 3), "max": round(v[-1], 3), "iqr": round(rank(0.75) - rank(0.25), 3), "mean": round(statistics.fmean(v), 3)}


def one(value, unit):
    return stat([value], unit) | {"single": True}


class Events:
    """The app's event file, read as it grows."""

    def __init__(self, path):
        self.path, self.offset, self.items = path, 0, []

    def refresh(self):
        try:
            with open(self.path, "rb") as f:
                f.seek(self.offset)
                data = f.read()
        except FileNotFoundError:
            return
        end = data.rfind(b"\n") + 1
        self.offset += end
        for line in data[:end].splitlines():
            try:
                self.items.append(json.loads(line))
            except ValueError:
                pass

    def between(self, t0, t1=None, name=None, prefix=None):
        self.refresh()
        return [e for e in self.items if e["t"] >= t0 and (t1 is None or e["t"] <= t1) and (name is None or e["e"] == name) and (prefix is None or e["e"].startswith(prefix))]

    def wait(self, t0, test, timeout):
        """The first event from t0 on that passes `test`, or None."""
        end = time.monotonic() + timeout
        while True:
            for e in self.between(t0):
                if test(e):
                    return e
            if time.monotonic() > end:
                return None
            time.sleep(0.03)

    def frames(self, t0, t1=None):
        out = []
        for e in self.between(t0, t1, "frame"):
            frame = dict(zip(FRAME, e["v"]))
            frame["end"] = e["t"]
            frame["start"] = e["t"] - frame["took"]
            out.append(frame)
        return out


class Results:
    def __init__(self, meta):
        self.meta = meta
        self.metrics = {}
        self.notes = []

    def add(self, name, value):
        self.metrics[name] = value
        if value.get("n"):
            print(f"  {name}: {value.get('median')} {value.get('unit')} (p95 {value.get('p95')}, n {value['n']})", flush=True)

    def note(self, text):
        self.notes.append(text)
        print(f"  note: {text}", flush=True)


def frame_metrics(results, name, frames, seconds, hz):
    """Frame times for a stretch of interaction."""
    interval = 1000 / hz
    add = lambda key, value: results.add(f"{name}.{key}", value)
    add("frames_per_second", one(len(frames) / seconds, "fps"))
    add("frame_main_thread_ms", stat([f["took"] / 1000 for f in frames]))
    add("frame_render_ms", stat([f["render_us"] / 1000 for f in frames]))
    add("frame_render_to_paint_ms", stat([f["frame_us"] / 1000 for f in frames]))
    add("frame_after_paint_ms", stat([(f["took"] - f["frame_us"]) / 1000 for f in frames]))
    gaps = [(b["end"] - a["end"]) / 1000 for a, b in zip(frames, frames[1:]) if b["end"] - a["end"] < 200_000]
    add("frame_gap_ms", stat(gaps))
    dropped = sum(max(0, round(g / interval) - 1) for g in gaps)
    add("dropped_frames", one(dropped, "frames"))
    add("over_budget_frames", one(sum(f["took"] / 1000 > interval for f in frames), "frames"))
    script = sum(f["script_us"] for f in frames) / 1000
    add("mods_ms_per_frame", one(script / max(1, len(frames)), "ms"))
    add("materialize_ms_per_frame", one(sum(f["materialize_us"] for f in frames) / 1000 / max(1, len(frames)), "ms"))
    add("rows_rebuilt_per_frame", one(sum(f["rows"] for f in frames) / max(1, len(frames)), "rows"))


def main_blocked(results, name, events, t0, t1):
    """Stalls of the main thread in a stretch, by what was running."""
    spans = {}
    for e in events.between(t0, t1):
        if len(e["v"]) == 2 and (e["e"].startswith(("ui:", "rpc:", "exec:", "cmd:", "start:"))) and e["v"][1] == 1:
            spans.setdefault(e["e"], []).append(e["v"][0] / 1000)
    for span, times in spans.items():
        results.add(f"{name}.main.{span}", stat(times))
    tasks = [e["v"][0] / 1000 for e in events.between(t0, t1, "task")]
    results.add(f"{name}.main.long_tasks_ms", stat(tasks))


class Usage:
    """CPU, wakeups and memory of an instance over a stretch of time."""

    def __init__(self, instance):
        self.instance = instance
        # Holders come and go with terminals: ask the core who they are now.
        status = instance.core_status()
        if status:
            instance.note_core(status)
        self.before = w.snapshot()
        self.t0 = time.perf_counter()

    def group(self, processes):
        i = self.instance
        tree = i.tree(processes)
        groups = {"app": set(), "connect": set(), "core": set(), "holder": set(), "conpty": set(), "shells": set()}
        for pid in tree:
            p = processes[pid]
            low = p.name.lower()
            if i.app and pid == i.app.pid:
                groups["app"].add(pid)
            elif pid == i.core_pid:
                groups["core"].add(pid)
            elif pid in i.holders:
                groups["holder"].add(pid)
            elif low in ("herdr-core.exe", "hc.exe") and i.app and p.ppid == i.app.pid:
                groups["connect"].add(pid)
            elif low in ("openconsole.exe", "conhost.exe"):
                groups["conpty"].add(pid)
            else:
                groups["shells"].add(pid)
        return groups

    def finish(self, results, name):
        after = w.snapshot()
        seconds = time.perf_counter() - self.t0
        groups = self.group(after)
        ours = set().union(*groups.values())
        for label, pids in groups.items():
            cpu = switches = kernel = 0
            for pid in pids:
                a, b = after[pid], self.before.get(pid)
                if b is None or b.created != a.created:
                    cpu += a.cpu
                    kernel += a.kernel / w.TICKS_PER_SECOND
                    switches += a.switches
                else:
                    cpu += a.cpu - b.cpu
                    kernel += (a.kernel - b.kernel) / w.TICKS_PER_SECOND
                    # Per thread: a thread that ended takes its count with it.
                    old = {t.tid: t.switches for t in b.threads}
                    switches += sum(t.switches - old.get(t.tid, 0) for t in a.threads)
            results.add(f"{name}.{label}.cpu_percent", one(100 * cpu / seconds, "% of a core"))
            results.add(f"{name}.{label}.kernel_percent", one(100 * kernel / seconds, "% of a core"))
            results.add(f"{name}.{label}.wakeups_per_second", one(switches / seconds, "/s"))
        app = next(iter(groups["app"]), None)
        if app in after:
            p = after[app]
            results.add(f"{name}.app.working_set_mb", one(p.working_set / 2**20, "MB"))
            results.add(f"{name}.app.private_mb", one(p.private / 2**20, "MB"))
            results.add(f"{name}.app.threads", one(len(p.threads), "threads"))
            results.add(f"{name}.app.handles", one(p.handles, "handles"))
        total = sum(q.cpu - self.before[pid].cpu for pid, q in after.items() if pid in self.before and pid not in ours and pid != 0 and self.before[pid].created == q.created)
        results.add(f"{name}.machine_other_load", one(100 * total / seconds, "% of a core"))
        return groups


def thread_table(pid, seconds):
    """CPU and wakeups per thread of any process, read-only."""
    before = w.snapshot(pids={pid}).get(pid)
    time.sleep(seconds)
    after = w.snapshot(pids={pid}).get(pid)
    if not before or not after or before.created != after.created:
        return []
    old = {t.tid: t for t in before.threads}
    rows = []
    for t in after.threads:
        o = old.get(t.tid)
        if not o:
            continue
        rows.append({"tid": t.tid, "name": w.thread_name(t.tid), "cpu_percent": round(100 * (t.cpu - o.cpu) / seconds, 2),
                     "kernel_percent": round(100 * (t.kernel - o.kernel) / w.TICKS_PER_SECOND / seconds, 2), "wakeups_per_second": round((t.switches - o.switches) / seconds, 1)})
    return sorted(rows, key=lambda r: (-r["cpu_percent"], -r["wakeups_per_second"]))


def gpu_counters(pid):
    """Video memory and which adapter a process uses, from Windows' counters."""
    script = (
        f"$ErrorActionPreference='SilentlyContinue';"
        f"$m=Get-Counter '\\GPU Process Memory(pid_{pid}_*)\\*';"
        f"$e=Get-Counter '\\GPU Engine(pid_{pid}_*)\\Utilization Percentage';"
        "@($m.CounterSamples)+@($e.CounterSamples)|ForEach-Object{[pscustomobject]@{p=$_.Path;v=$_.CookedValue}}|ConvertTo-Json -Compress"
    )
    out = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True, timeout=40, creationflags=w.CREATE_NO_WINDOW)
    try:
        rows = json.loads(out.stdout or "[]")
    except ValueError:
        return {}
    rows = rows if isinstance(rows, list) else [rows]
    memory, engines = {}, {}
    for r in rows:
        path, value = r["p"], r["v"] or 0
        luid = re.search(r"luid_(0x[0-9a-f]+_0x[0-9a-f]+)", path)
        luid = luid.group(1) if luid else "?"
        if "gpu process memory" in path:
            kind = path.rsplit("\\", 1)[1]
            memory.setdefault(luid, {})[kind] = value
        else:
            engine = re.search(r"engtype_([^)]*)", path)
            key = f"{luid}:{engine.group(1) if engine else '?'}"
            engines[key] = max(engines.get(key, 0), value)
    return {"memory": memory, "engines": engines}


def adapters():
    out = subprocess.run(["powershell", "-NoProfile", "-Command",
                          "Get-CimInstance Win32_VideoController|Select-Object Name,DriverVersion,CurrentRefreshRate,CurrentHorizontalResolution,CurrentVerticalResolution|ConvertTo-Json -Compress"],
                         capture_output=True, text=True, timeout=40, creationflags=w.CREATE_NO_WINDOW)
    try:
        rows = json.loads(out.stdout)
        return rows if isinstance(rows, list) else [rows]
    except ValueError:
        return []


def power_plan():
    out = subprocess.run(["powercfg", "/getactivescheme"], capture_output=True, text=True, creationflags=w.CREATE_NO_WINDOW)
    return out.stdout.strip()


def git(*args):
    return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True).stdout.strip()


def file_sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def meta_for(binary, label):
    return {
        "label": label,
        "time": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "commit": git("rev-parse", "HEAD"),
        "dirty": bool(git("status", "--porcelain", "--", "src", "defaults", "vendor", "Cargo.toml", "Cargo.lock")),
        "binary": binary,
        "binary_sha256": file_sha(binary),
        "binary_mb": round(os.path.getsize(binary) / 2**20, 1),
        "power": w.power_status(),
        "power_plan": power_plan(),
        "logical_cpus": os.cpu_count(),
        "refresh_hz_primary": w.refresh_hz(),
        "adapters": adapters(),
        "core_version": subprocess.run([core_binary(), "--version"], capture_output=True, text=True).stdout.strip(),
    }


def live_identity():
    """Who the live cores are, and every process that must survive this run."""
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(("HC_", "XDG_"))}
    ids = set()
    out = subprocess.run([core_binary(), "server", "status", "--json"], env=env, capture_output=True, text=True, creationflags=w.CREATE_NO_WINDOW)
    try:
        ids.add(json.loads(out.stdout)["core"]["id"])
    except (ValueError, KeyError):
        pass
    survivors = {pid: p.created for pid, p in w.snapshot({"zaki.exe", "herdr.exe", "herdr-core.exe", "hc.exe"}).items()}
    return ids, survivors


def herdr_load(seconds=5):
    """Background noise from other programs, Herdr 1.x servers above all
    (about 90% of a core on this machine when last looked): CPU of every
    herdr.exe, and of the whole machine, over a few seconds."""
    a = w.snapshot()
    time.sleep(seconds)
    b = w.snapshot()
    busy = lambda names: sum(b[p].cpu - a[p].cpu for p in b if p in a and a[p].created == b[p].created and p != 0 and (names is None or b[p].name.lower() in names))
    return {"herdr_exe_percent_of_a_core": round(100 * busy({"herdr.exe"}) / seconds, 1),
            "herdr_exe_processes": sum(1 for p in b.values() if p.name.lower() == "herdr.exe"),
            "machine_busy_percent_of_a_core": round(100 * busy(None) / seconds, 1)}


def check_survivors(results, survivors, ours):
    """Long-lived processes from before the run: still there? Short-lived `hc`
    calls by others come and go, so this names what's missing instead of failing."""
    now = w.snapshot()
    gone = [pid for pid, created in survivors.items() if pid not in ours and (pid not in now or now[pid].created != created)]
    if gone:
        results.note(f"processes from before the run are gone (not by this harness: it only ends its own pids): {gone}")


def build(args):
    if args.no_build:
        return
    # 8 jobs: a full build with one per CPU ran this 32 GB laptop out of memory.
    print(f"perf: building (cargo build --release --locked -j {args.jobs})...", flush=True)
    subprocess.run(["cargo", "build", "--release", "--locked", "-j", str(args.jobs), "--bin", "zaki"], cwd=REPO, check=True, env={k: v for k, v in os.environ.items() if k != "HERDR_APP_RELEASE"})


def first_ink(events, t0, channel=None, timeout=30):
    """When a terminal first showed text: its `ink` mark, then the frame that held it."""
    ink = events.wait(t0, lambda e: e["e"] == "ink" and e["v"][1] > 0 and (channel is None or e["v"][0] == channel), timeout)
    if not ink:
        return None, None
    # The frame's line comes when its message returns.
    frame = events.wait(ink["t"], lambda e: e["e"] == "frame", 2)
    return ink, frame


def empty_home(results, home, rep):
    """A first-run home. A file the app just closed can still be held for a
    moment (a virus scan), so deleting is retried, then the folder moved aside."""
    import shutil
    for _ in range(20):
        shutil.rmtree(home, ignore_errors=True)
        if not os.path.exists(home):
            break
        time.sleep(0.25)
    else:
        os.replace(home, f"{home}-old-{rep}")
    os.makedirs(home, exist_ok=True)
    if os.listdir(home):
        results.note(f"cold fresh rep {rep}: the home could not be emptied")


def cold(results, args, work, live_ids, survivors):
    def launch_once(instance, has_terminal):
        events = Events(instance.events_path)
        if os.path.exists(instance.events_path):
            events.offset = os.path.getsize(instance.events_path)
        t0 = instance.launch()
        instance.window(timeout=30)
        events.wait(t0, lambda e: e["e"] == "first_paint", 30)
        ink, frame = first_ink(events, t0, timeout=25) if has_terminal else (None, None)
        instance.wait_ready()
        ready = w.now_us()
        time.sleep(0.5)
        marks = {}
        for e in events.between(t0):
            if e["e"] == "main" or e["e"] == "first_render" or e["e"] == "first_paint" or e["e"] == "start:platform" or e["e"] == "start:app_running":
                marks.setdefault(e["e"], (e["t"] - t0) / 1000)
            elif e["e"].startswith("start:") or e["e"] in ("ui:mod_load",):
                marks.setdefault(e["e"], 0)
                if len(e["v"]) == 2:
                    marks[e["e"]] += e["v"][0] / 1000
        marks["first_ink"] = (ink["t"] - t0) / 1000 if ink else None
        marks["first_ink_frame"] = (frame["t"] - t0) / 1000 if frame else None
        marks["control_ready"] = (ready - t0) / 1000 if ready else None
        return marks

    variants = (("warm", "home and core ready, one terminal: reopening the app"), ("core_down", "home ready, core has to start, one kept terminal"),
                ("fresh", "empty home, no terminal: first run, core ready"))
    for kind, about in variants:
        print(f"cold {kind}: {about}", flush=True)
        rows = []
        reps = args.cold_reps
        instance = Instance(work, f"cold-{kind}", args.binary)
        instance.seed_home()
        instance.start_core(live_ids)
        try:
            for rep in range(reps + 1):
                if kind == "fresh":
                    empty_home(results, os.path.join(instance.root, "home"), rep)
                    instance.seed_home()
                if kind == "core_down" and rep > 0:
                    instance.hc("server", "stop")
                    time.sleep(0.3)
                marks = launch_once(instance, kind != "fresh" and rep > 0)
                status = instance.core_status()
                if status:
                    instance.note_core(status)
                if rep > 0 or kind == "fresh":  # the first run primes the home
                    rows.append(marks)
                if rep == 0 and kind != "fresh":
                    # One space with the default shell: later starts reattach it.
                    instance.do("space.new", {"folder": instance.folder})
                    first_ink(Events(instance.events_path), w.now_us() - 2_000_000, timeout=20)
                    time.sleep(2)
                instance.quit_app()
                time.sleep(0.4)
        finally:
            instance.stop()
            instance.clean_files()
        for key in sorted({k for r in rows for k in r}):
            results.add(f"cold.{kind}.{key}_ms", stat([r.get(key) for r in rows]))


def new_terminal(instance, events, command, args):
    """Runs a command that makes a terminal; returns its timings, or None."""
    t0 = w.now_us()
    reply = instance.do(command, args)
    returned = w.now_us()
    attached = events.wait(t0, lambda e: e["e"] == "attached", 10)
    if not attached:
        return None, reply
    channel = attached["v"][0]
    output = events.wait(t0, lambda e: e["e"] == "output" and e["v"][0] == channel, 20)
    ink, frame = first_ink(events, t0, channel, 25)
    # Wait for the shell to go quiet: the prompt is complete by then.
    last = ink["t"] if ink else t0
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        time.sleep(0.25)
        newest = [e["t"] for e in events.between(last, name="output") if e["v"][0] == channel]
        if newest and newest[-1] > last:
            last = newest[-1]
        elif (w.now_us() - last) > 600_000:
            break
    control = events.between(t0, name="control")
    came_in = control[0]["t"] if control else t0
    spans = {e["e"]: e["v"][0] / 1000 for e in events.between(t0, last + 1) if len(e["v"]) == 2 and e["e"] in ("ui:spawn_terminal", "rpc:terminal.run", "rpc:terminal.attach", "ui:sync", "ui:save", "ui:flush_documents")}
    command_span = [e for e in events.between(t0, last + 1) if e["e"] == f"cmd:{command}"]
    row = {
        "total_visible_ms": (frame["t"] - t0) / 1000 if frame else None,
        "from_app_visible_ms": (frame["t"] - came_in) / 1000 if frame else None,
        "cli_to_app_ms": (came_in - t0) / 1000,
        "command_on_main_thread_ms": command_span[0]["v"][0] / 1000 if command_span else None,
        "reply_ms": (returned - t0) / 1000,
        "attached_ms": (attached["t"] - t0) / 1000,
        "first_output_ms": (output["t"] - t0) / 1000 if output else None,
        "first_output_to_ink_ms": (ink["t"] - output["t"]) / 1000 if ink and output else None,
        "shell_quiet_ms": (last - t0) / 1000,
    }
    row.update({f"{k}_ms": v for k, v in spans.items()})
    return row, reply


def strip_vt(data):
    data = re.sub(rb"\x1b\][^\x07\x1b]*(\x07|\x1b\\)", b"", data)
    # CSI: any parameter bytes (0x30-0x3F covers `?`, `=`, `<`, `>`), then intermediates.
    data = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", data)
    data = re.sub(rb"\x1b[@-_]", b"", data)
    return re.sub(rb"[\x00-\x1f]", b"", data)


def core_only(instance, argv, cwd):
    """Time from asking the core to the program's first text, no app involved."""
    client = core_only.client
    env = {"TERM": "xterm-256color", "COLORTERM": "truecolor", "TERM_PROGRAM": "zaki"}
    t0 = w.now_us()
    made = client.call("terminal.run", {"argv": argv, "cwd": cwd, "env": env, "labels": {}, "keep": True})
    ran = w.now_us()
    address = made["address"]
    display = {"fg": "#ffffff", "bg": "#000000", "cursor": "#ffffff", "cell": [10, 20]}
    attached = client.call("terminal.attach", {"terminal": address, "cols": 120, "rows": 40, "history": 2000, "display": display})
    channel = attached["channel"]
    at = w.now_us()
    first, text = None, None
    seen = b""
    end = time.monotonic() + 20
    while time.monotonic() < end and text is None:
        with client.frame_ready:
            client.frame_ready.wait(0.2)
            frames = [f for f in client.frames if f[1] == channel]
        for when, _, data in frames:
            first = first or when
        seen = b"".join(f[2] for f in frames)
        if re.search(rb"[A-Za-z0-9>]", strip_vt(seen)):
            text = frames[-1][0]
    client.call("terminal.kill", {"terminal": address})
    return {"run_ms": (ran - t0) / 1000, "attach_ms": (at - ran) / 1000, "first_bytes_ms": (first - t0) / 1000 if first else None, "first_text_ms": (text - t0) / 1000 if text else None}


def open_terminals(results, args, instance, events):
    shells = {"default": None, "noprofile": ["powershell.exe", "-NoLogo", "-NoProfile"], "cmd": ["cmd.exe"]}
    reps = args.open_reps
    for kind, argv in shells.items():
        for how, command, make in (
            ("tab", "tab.new", lambda: {"folder": instance.folder, **({"argv": argv} if argv else {})}),
            ("split", "pane.split", lambda: {"direction": "right", **({"argv": argv} if argv else {})}),
            ("space", "space.new", lambda: {"folder": instance.folder, **({"argv": argv} if argv else {})}),
        ):
            if kind != "default" and how != "tab":
                continue
            rows = []
            print(f"open {how} with {kind}", flush=True)
            for rep in range(reps):
                row, reply = new_terminal(instance, events, command, make())
                if row:
                    rows.append(row)
                if how == "tab":
                    instance.do("tab.close", {"confirmed": True}, tolerate=True)
                elif how == "split":
                    instance.do("pane.close", tolerate=True)
                else:
                    instance.do("space.close", {"confirmed": True}, tolerate=True)
                time.sleep(0.25)
            for key in sorted({k for r in rows for k in r}):
                results.add(f"open.{how}.{kind}.{key}", stat([r.get(key) for r in rows]))
    print("core with no app", flush=True)
    core_only.client = CoreClient(instance)
    for kind, argv in shells.items():
        rows = []
        for rep in range(reps):
            rows.append(core_only(instance, argv or [], instance.folder))
            time.sleep(0.2)
        for key in rows[0]:
            results.add(f"open.core_alone.{kind}.{key}", stat([r[key] for r in rows]))
    core_only.client.close()
    print("shells with no terminal", flush=True)
    for kind, cmd in (("powershell_profile", ["powershell.exe", "-NoLogo", "-Command", "exit"]), ("powershell_noprofile", ["powershell.exe", "-NoLogo", "-NoProfile", "-Command", "exit"]), ("cmd", ["cmd.exe", "/c", "exit"])):
        times = []
        for rep in range(reps):
            t = time.perf_counter()
            subprocess.run(cmd, env=instance.env(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=w.CREATE_NO_WINDOW)
            times.append((time.perf_counter() - t) * 1000)
        results.add(f"open.bare_process.{kind}_ms", stat(times))


def typing(results, args, instance, events, hwnd):
    for kind, argv in (("cmd", ["cmd.exe"]), ("default", None)):
        print(f"typing in {kind}", flush=True)
        row, _ = new_terminal(instance, events, "tab.new", {"folder": instance.folder, **({"argv": argv} if argv else {})})
        w.activate(hwnd)
        time.sleep(1)
        attached = events.between(w.now_us() - 12_000_000, name="attached")
        channel = attached[-1]["v"][0]
        posted = []
        for i in range(args.key_reps):
            at = w.now_us()
            w.post_key(hwnd, ord("X"))
            posted.append(at)
            time.sleep(random.uniform(0.12, 0.26))  # lands anywhere in the frame
            if i % 16 == 15:
                for _ in range(16):
                    w.post_key(hwnd, w.VK_BACK)
                    time.sleep(0.03)
                time.sleep(0.3)
        time.sleep(0.6)
        rows = {"total": [], "app_in": [], "core_round_trip": [], "wait_for_frame": [], "frame": []}
        for t in posted:
            sent = next((e for e in events.between(t, t + 500_000, "input") if e["v"][0] == channel), None)
            if not sent:
                continue
            out = next((e for e in events.between(sent["t"], sent["t"] + 800_000, "output") if e["v"][0] == channel), None)
            if not out:
                continue
            frame = next((f for f in events.frames(out["t"], out["t"] + 500_000) if f["grid"]), None)
            if not frame:
                continue
            rows["total"].append((frame["end"] - t) / 1000)
            rows["app_in"].append((sent["t"] - t) / 1000)
            rows["core_round_trip"].append((out["t"] - sent["t"]) / 1000)
            rows["wait_for_frame"].append((frame["start"] - out["t"]) / 1000)
            rows["frame"].append(frame["took"] / 1000)
        if not rows["total"]:
            results.note(f"typing in {kind}: no key reached the terminal; the test window may not have keyboard focus")
        for key, values in rows.items():
            results.add(f"input.{kind}.{key}_ms", stat(values))
        instance.do("tab.close", {"confirmed": True}, tolerate=True)
        time.sleep(0.3)


def frames(results, args, instance, events, hwnd):
    hz = args.hz
    dpi = w.window_state(hwnd)["dpi"] / 96
    px = lambda v: int(v * dpi)
    for i in range(6):
        instance.do("space.new", {"name": f"s{i}", "folder": instance.folder, "argv": ["cmd.exe"]})
    for i in range(6):
        instance.do("tab.new", {"folder": instance.folder, "argv": ["cmd.exe"]})
    time.sleep(2)
    w.activate(hwnd)
    time.sleep(0.5)
    width, height = w.client_size(hwnd)
    results.meta["window"] = w.window_state(hwnd)

    def stretch(name, action, seconds):
        print(f"frames: {name}", flush=True)
        t0 = w.now_us()
        usage = Usage(instance)
        end = time.monotonic() + seconds
        action(end)
        usage.finish(results, f"frames.{name}")
        t1 = w.now_us()
        time.sleep(0.3)
        frame_metrics(results, f"frames.{name}", events.frames(t0, t1), (t1 - t0) / 1e6, hz)
        main_blocked(results, f"frames.{name}", events, t0, t1)

    def sweep(x_of, y_of):
        def run(end):
            step = 0
            while time.monotonic() < end:
                w.post_mouse_move(hwnd, x_of(step), y_of(step))
                step += 1
                time.sleep(0.008)
        return run

    rows = max(px(400), 1)
    stretch("hover_sidebar", sweep(lambda s: px(115), lambda s: px(60) + abs((s * 6) % (2 * rows) - rows)), args.stretch)
    tab_span = max(width - px(300), 1)
    stretch("hover_tabs", sweep(lambda s: px(260) + abs((s * 9) % (2 * tab_span) - tab_span), lambda s: px(24)), args.stretch)
    w.post_mouse_move(hwnd, px(700), px(500))

    def switching(end):
        forward = True
        while time.monotonic() < end:
            instance.do("tab.next" if forward else "tab.prev")
            forward = not forward
            time.sleep(0.15)

    stretch("tab_switch", switching, args.stretch)
    t0 = w.now_us()
    latencies = []
    for i in range(args.switch_reps):
        at = w.now_us()
        instance.do("tab.next")
        came = events.wait(at, lambda e: e["e"] == "control", 2)
        frame = events.wait(came["t"] if came else at, lambda e: e["e"] == "frame", 2)
        if came and frame:
            latencies.append((frame["t"] - came["t"]) / 1000)
        time.sleep(0.2)
    results.add("frames.tab_switch.command_to_frame_ms", stat(latencies))

    original = w.client_size(hwnd)
    rect_w, rect_h = 1280, 820

    def resizing(end):
        grow = 0
        calls = []
        while time.monotonic() < end:
            grow = (grow + 12) % 240
            t = time.perf_counter()
            w.resize(hwnd, int((rect_w - abs(grow - 120)) * dpi), int(rect_h * dpi))
            calls.append((time.perf_counter() - t) * 1000)
            time.sleep(0.008)
        results.add("frames.resize.set_window_pos_ms", stat(calls))

    stretch("resize", resizing, args.stretch)
    w.resize(hwnd, int(rect_w * dpi), int(rect_h * dpi))
    time.sleep(0.5)

    instance.do("tab.new", {"folder": instance.folder, "argv": [sys.executable, "-c", SCROLLBACK + "\nimport time\ntime.sleep(3600)"]})
    time.sleep(3)
    center = (px(700), px(450))

    def scrolling(end):
        direction, count = 1, 0
        while time.monotonic() < end:
            w.post_wheel(hwnd, *center, direction)
            count += 1
            if count % 200 == 0:
                direction = -direction
            time.sleep(0.016)

    stretch("scrollback", scrolling, args.stretch)

    def overlays(command, args_for=None):
        def run(end):
            while time.monotonic() < end:
                instance.do(command, args_for)
                time.sleep(0.25)
                instance.do("overlay.close", tolerate=True)
                time.sleep(0.25)
        return run

    stretch("palette", overlays("app.palette"), args.stretch)
    stretch("settings", overlays("app.settings"), args.stretch)
    stretch("help", overlays("app.help"), args.stretch)
    latency = []
    for i in range(args.switch_reps):
        at = w.now_us()
        instance.do("app.palette")
        time.sleep(0.45)
        settled = events.frames(at, at + 450_000)
        came = events.between(at, name="control")
        if came and settled:
            latency.append((settled[-1]["end"] - came[0]["t"]) / 1000)
        instance.do("overlay.close", tolerate=True)
        time.sleep(0.2)
    results.add("frames.palette.open_settled_ms", stat(latency))


def throughput(results, args, instance, events, hwnd):
    script = os.path.join(instance.root, "emit.py")
    with open(script, "w") as f:
        f.write(EMIT)
    size = args.throughput_mb

    def ticks(t0):
        rows = events.between(t0, name="tick")
        return rows[-1]["v"] if rows else None

    for kind in ("visible", "hidden"):
        print(f"throughput {kind}", flush=True)
        times, rates, parse = [], [], []
        for rep in range(args.throughput_reps):
            t0 = w.now_us()
            usage = Usage(instance)
            base = events.between(t0 - 3_000_000, name="tick")
            base = base[-1]["v"] if base else [0, 0, 0, 0]
            reply = instance.do("tab.new", {"folder": instance.folder, "argv": [sys.executable, "-u", script, str(size), "3600"]})
            if kind == "hidden":
                instance.do("tab.prev")
            address = reply.get("terminal")
            end = time.monotonic() + 300
            done = None
            while time.monotonic() < end:
                time.sleep(0.5)
                text = instance.hc("read", address, "--lines", "4").stdout
                found = re.search(r"EMIT-DONE (\d+) bytes in ([0-9.]+) s", text)
                if found:
                    done = (int(found.group(1)), float(found.group(2)))
                    break
            t1 = w.now_us()
            time.sleep(1.2)
            usage.finish(results, f"throughput.{kind}.rep{rep}")
            if done:
                times.append(done[1])
                rates.append(done[0] / 2**20 / done[1])
                now = ticks(t0)
                if now:
                    parse.append((now[1] - base[1]) / 1000)
            frame_metrics(results, f"throughput.{kind}.rep{rep}", events.frames(t0, t1), (t1 - t0) / 1e6, args.hz)
            main_blocked(results, f"throughput.{kind}.rep{rep}", events, t0, t1)
            if kind == "hidden":
                instance.do("tab.next")
            instance.hc("kill", address)
            time.sleep(1)
        results.add(f"throughput.{kind}.seconds", stat(times, "s"))
        results.add(f"throughput.{kind}.mb_per_second", stat(rates, "MB/s"))
        results.add(f"throughput.{kind}.vt_parse_ms_total", stat(parse))

    print("throughput with no app", flush=True)
    client = CoreClient(instance)
    rates = []
    for rep in range(args.throughput_reps):
        made = client.call("terminal.run", {"argv": [sys.executable, "-u", script, str(size), "3600"], "cwd": instance.folder, "env": {"TERM": "xterm-256color"}, "labels": {}, "keep": False})
        attached = client.call("terminal.attach", {"terminal": made["address"], "cols": 120, "rows": 40, "history": 2000, "display": {"fg": "#ffffff", "bg": "#000000", "cursor": "#ffffff", "cell": [10, 20]}})
        end = time.monotonic() + 300
        while time.monotonic() < end:
            time.sleep(0.25)
            with client.frame_ready:
                tail = b"".join(f[2] for f in client.frames[-3:] if f[1] == attached["channel"])
                client.frames.clear()
            found = re.search(rb"EMIT-DONE (\d+) bytes in ([0-9.]+) s", tail)
            if found:
                rates.append(int(found.group(1)) / 2**20 / float(found.group(2)))
                break
        client.call("terminal.kill", {"terminal": made["address"]})
    client.close()
    results.add("throughput.core_alone.mb_per_second", stat(rates, "MB/s"))


def idle(results, args, instance, events, hwnd, name="idle.fresh"):
    time.sleep(args.settle)
    table = None
    for rep in range(args.idle_reps):
        t0 = w.now_us()
        usage = Usage(instance)
        time.sleep(args.idle_seconds)
        usage.finish(results, f"{name}.rep{rep}")
        t1 = w.now_us()
        ticks = events.between(t0, t1, "tick")
        if len(ticks) >= 2:
            idle_paints = ticks[-1]["v"][2] - ticks[0]["v"][2]
            seconds = (ticks[-1]["t"] - ticks[0]["t"]) / 1e6
            results.add(f"{name}.rep{rep}.idle_paints_per_second", one(idle_paints / seconds, "/s"))
            results.add(f"{name}.rep{rep}.idle_paint_ms_each", one((ticks[-1]["v"][3] - ticks[0]["v"][3]) / 1000 / max(1, idle_paints), "ms"))
        frames_now = events.frames(t0, t1)
        results.add(f"{name}.rep{rep}.frames_drawn_per_second", one(len(frames_now) / max(1, (t1 - t0) / 1e6), "fps"))
        main_blocked(results, f"{name}.rep{rep}", events, t0, t1)
    table = thread_table(instance.app.pid, 5)
    main = w.window_thread(hwnd)
    for row in table:
        if row["tid"] == main:
            row["name"] = (row["name"] + " [window thread]").strip()
            results.add(f"{name}.main_thread.cpu_percent", one(row["cpu_percent"], "% of a core"))
            results.add(f"{name}.main_thread.wakeups_per_second", one(row["wakeups_per_second"], "/s"))
        if row["name"] == "VSyncProvider":
            results.add(f"{name}.vsync_thread.cpu_percent", one(row["cpu_percent"], "% of a core"))
            results.add(f"{name}.vsync_thread.wakeups_per_second", one(row["wakeups_per_second"], "/s"))
    results.meta[f"{name}.threads"] = table[:14]
    results.meta[f"{name}.gpu"] = gpu_counters(instance.app.pid)


def agents(results, args, instance, events, hwnd):
    """A tab of an agent working with no output, then one whose title changes."""
    script = os.path.join(instance.root, "reports.py")
    with open(script, "w") as f:
        f.write(REPORTS)
    for state in ("working", "title"):
        print(f"idle with an agent: {state}", flush=True)
        reply = instance.do("tab.new", {"folder": instance.folder, "argv": [sys.executable, "-u", script, state]})
        time.sleep(4)
        t0 = w.now_us()
        usage = Usage(instance)
        time.sleep(args.idle_seconds)
        usage.finish(results, f"idle.agent_{state}")
        t1 = w.now_us()
        frames_now = events.frames(t0, t1)
        seconds = (t1 - t0) / 1e6
        results.add(f"idle.agent_{state}.frames_drawn_per_second", one(len(frames_now) / seconds, "fps"))
        results.add(f"idle.agent_{state}.mods_ms_per_second", one(sum(f["script_us"] for f in frames_now) / 1000 / seconds, "ms/s"))
        results.add(f"idle.agent_{state}.materialize_ms_per_second", one(sum(f["materialize_us"] for f in frames_now) / 1000 / seconds, "ms/s"))
        results.add(f"idle.agent_{state}.main_thread_frame_ms_per_second", one(sum(f["took"] for f in frames_now) / 1000 / seconds, "ms/s"))
        refreshes = events.between(t0, t1, "ui:refresh_mods")
        results.add(f"idle.agent_{state}.mod_refreshes_per_second", one(len(refreshes) / seconds, "/s"))
        main_blocked(results, f"idle.agent_{state}", events, t0, t1)
        instance.hc("kill", reply["terminal"])
        time.sleep(1.5)


def overhead(results, args, work, live_ids):
    """The instrumentation's own cost: the same build idle and streaming output,
    with the events file off and on. Off does strictly less than on (one relaxed
    load per call), so on minus off bounds what an instrumented build pays."""
    script = os.path.join(work, "emit.py")
    with open(script, "w") as f:
        f.write(EMIT)
    for mode in ("off", "on", "off2", "on2"):
        print(f"overhead: events {mode}", flush=True)
        instance = Instance(work, f"overhead-{mode}", args.binary, events=mode.startswith("on"))
        instance.seed_home()
        instance.start_core(live_ids)
        try:
            instance.launch()
            instance.window(timeout=30)
            instance.wait_ready()
            instance.do("space.new", {"folder": instance.folder})
            time.sleep(args.settle)
            usage = Usage(instance)
            time.sleep(args.idle_seconds)
            usage.finish(results, f"overhead.{mode}.idle")
            reply = instance.do("tab.new", {"folder": instance.folder, "argv": [sys.executable, "-u", script, str(args.throughput_mb), "3600"]})
            usage = Usage(instance)
            end = time.monotonic() + 300
            while time.monotonic() < end:
                time.sleep(0.5)
                found = re.search(r"EMIT-DONE (\d+) bytes in ([0-9.]+) s", instance.hc("read", reply["terminal"], "--lines", "4").stdout)
                if found:
                    results.add(f"overhead.{mode}.output_mb_per_second", one(int(found.group(1)) / 2**20 / float(found.group(2)), "MB/s"))
                    break
            usage.finish(results, f"overhead.{mode}.output")
        finally:
            instance.stop()
            instance.clean_files()


def run(args):
    build(args)
    args.binary = os.path.abspath(args.bin)
    if not os.path.exists(args.binary):
        raise SystemExit(f"perf: no binary at {args.binary}")
    if args.only:
        wanted = set(args.only.split(","))
        unknown = wanted - set(SCENARIOS)
        if unknown:
            raise SystemExit(f"perf: unknown scenarios {sorted(unknown)}; there are {SCENARIOS}")
    else:
        wanted = set(SCENARIOS)
    label = args.label or git("rev-parse", "--short", "HEAD")
    meta = meta_for(args.binary, label)
    results = Results(meta)
    args.hz = args.hz or meta["refresh_hz_primary"] or 60
    live_ids, survivors = live_identity()
    if not live_ids:
        results.note("no live default core answered; isolation is checked against nothing")
    work = tempfile.mkdtemp(prefix="zp-")
    print(f"perf: work folder {work}", flush=True)
    ours = set()
    started = time.monotonic()
    try:
        meta["herdr_background_load"] = herdr_load()
        if "cold" in wanted:
            cold(results, args, work, live_ids, survivors)
        if "overhead" in wanted:
            overhead(results, args, work, live_ids)
        rest = wanted - {"cold", "overhead"}
        if rest:
            instance = Instance(work, "main", args.binary, log="warn,gpui_windows=info,zaki=info")
            instance.seed_home()
            instance.start_core(live_ids)
            try:
                instance.launch()
                events = Events(instance.events_path)
                hwnd = instance.window(timeout=30)
                instance.wait_ready()
                status = instance.core_status()
                instance.note_core(status)
                print(f"perf: test core pid {instance.core_pid}, holders {instance.holders}, app pid {instance.app.pid}, session {instance.session}", flush=True)
                w.activate(hwnd)
                meta["window"] = w.window_state(hwnd)
                time.sleep(args.settle)
                if "idle" in rest:
                    # No space yet: the start screen, which animates.
                    usage = Usage(instance)
                    t0 = w.now_us()
                    time.sleep(args.idle_seconds)
                    usage.finish(results, "idle.start_screen")
                    t1 = w.now_us()
                    frame_metrics(results, "idle.start_screen", events.frames(t0, t1), (t1 - t0) / 1e6, args.hz)
                t0 = w.now_us()
                instance.do("space.new", {"folder": instance.folder})
                first_ink(events, t0, timeout=25)
                if "idle" in rest:
                    idle(results, args, instance, events, hwnd)
                    agents(results, args, instance, events, hwnd)
                if "open" in rest:
                    open_terminals(results, args, instance, events)
                if "input" in rest:
                    typing(results, args, instance, events, hwnd)
                if "frames" in rest:
                    frames(results, args, instance, events, hwnd)
                if "idle" in rest:
                    for i in range(max(0, 12 - 7)):
                        instance.do("tab.new", {"folder": instance.folder})
                    for i in range(3):
                        instance.do("pane.split", {"direction": "right" if i % 2 else "down"})
                    meta["idle.many.terminals"] = len(json.loads(instance.hc("ls", "--json").stdout or "{}").get("terminals", []))
                    idle(results, args, instance, events, hwnd, "idle.many")
                if "throughput" in rest:
                    throughput(results, args, instance, events, hwnd)
                log = os.path.join(instance.root, "app.log")
                if os.path.exists(log):
                    with open(log, errors="replace") as f:
                        text = f.read()
                    meta["gpu_log"] = re.findall(r"Using GPU: [^\r\n]*|Direct Composition[^\r\n]*|Direct3D[^\r\n]*feature level[^\r\n]*", text)[:6]
            finally:
                left = instance.stop()
                ours.update(left)
                ours.update(instance.owned)
                instance.clean_files()
    finally:
        try:
            os.rmdir(work)
        except OSError:
            pass
        check_survivors(results, survivors, ours)
        meta["herdr_background_load_after"] = herdr_load()
        meta["minutes"] = round((time.monotonic() - started) / 60, 1)
        os.makedirs(RESULTS, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        path = os.path.join(RESULTS, f"{stamp}-{re.sub(r'[^A-Za-z0-9_.-]', '-', label)}.json")
        with open(path, "w") as f:
            json.dump({"meta": meta, "metrics": results.metrics, "notes": results.notes}, f, indent=1)
        print(f"perf: wrote {path}", flush=True)


def compare(args):
    with open(args.before) as f:
        a = json.load(f)
    with open(args.after) as f:
        b = json.load(f)
    print(f"before: {a['meta']['label']} {a['meta']['time']} {a['meta']['commit'][:9]}{'+' if a['meta']['dirty'] else ''}")
    print(f"after:  {b['meta']['label']} {b['meta']['time']} {b['meta']['commit'][:9]}{'+' if b['meta']['dirty'] else ''}")
    for key in ("power", "power_plan"):
        if a["meta"].get(key) != b["meta"].get(key):
            print(f"warning: {key} differs: {a['meta'].get(key)} vs {b['meta'].get(key)}")
    rows = []
    for name in sorted(set(a["metrics"]) & set(b["metrics"])):
        x, y = a["metrics"][name], b["metrics"][name]
        if not x.get("n") or not y.get("n") or args.grep and not re.search(args.grep, name):
            continue
        p, q = x["median"], y["median"]
        change = (q - p) / p * 100 if p else 0.0
        if x.get("single") or y.get("single"):
            # One reading each (a CPU % over a stretch): no spread to judge by,
            # so only a big change of something not near zero counts, as "?".
            real = "?" if abs(change) >= max(25, args.threshold) and max(abs(p), abs(q)) >= args.floor else ""
        else:
            spread = max(x.get("iqr", 0), y.get("iqr", 0))
            real = "*" if abs(q - p) > spread and abs(change) >= args.threshold else ""
        rows.append((name, p, q, change, x.get("p95"), y.get("p95"), x.get("unit"), real))
    shown = rows if args.all else [r for r in rows if r[7]]
    print(f"\n{len(rows)} metrics in both: {sum(r[7] == '*' for r in rows)} moved beyond their spread and {args.threshold:g}% (*), "
          f"{sum(r[7] == '?' for r in rows)} single readings moved 25%+ (?, check by repeating):\n")
    print(f"{'metric':64} {'before':>10} {'after':>10} {'change':>8}  {'p95 before':>10} {'p95 after':>10}")
    for name, p, q, change, p95a, p95b, unit, real in sorted(shown, key=lambda r: (r[7] != "*", -abs(r[3]))):
        mark = real or " "
        print(f"{name[:64]:64} {p:10.2f} {q:10.2f} {change:+7.1f}%{mark} {p95a or 0:10.2f} {p95b or 0:10.2f}  {unit}")
    only = sorted(set(a["metrics"]) ^ set(b["metrics"]))
    if only:
        print(f"\n{len(only)} metrics are in only one file.")


def live(args):
    """Read-only: what a running process costs, thread by thread."""
    out = {}
    processes = w.snapshot(pids={args.pid})
    if args.pid not in processes:
        raise SystemExit(f"perf: no process {args.pid}")
    p = processes[args.pid]
    before = p.cpu
    table = thread_table(args.pid, args.seconds)
    now = w.snapshot(pids={args.pid})[args.pid]
    out = {"name": p.name, "cpu_percent": round(100 * (now.cpu - before) / args.seconds, 1), "working_set_mb": round(now.working_set / 2**20, 1), "private_mb": round(now.private / 2**20, 1),
           "threads": len(now.threads), "handles": now.handles, "total_cpu_seconds": round(now.cpu, 1), "top": table[:args.top], "gpu": gpu_counters(args.pid)}
    print(json.dumps(out, indent=1))


def profile(args):
    import symbols
    symbols.profile(args, sys.modules[__name__])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    r = sub.add_parser("run")
    r.add_argument("--bin", default=os.path.join(REPO, "target", "release", "zaki.exe"))
    r.add_argument("--no-build", action="store_true")
    r.add_argument("--jobs", type=int, default=8, help="cargo build jobs (default 8, to keep memory in hand)")
    r.add_argument("--label")
    r.add_argument("--only", help="comma-separated: " + ",".join(SCENARIOS))
    r.add_argument("--hz", type=int, help="display refresh rate (default: what Windows reports)")
    r.add_argument("--cold-reps", type=int, default=12)
    r.add_argument("--open-reps", type=int, default=12)
    r.add_argument("--key-reps", type=int, default=120)
    r.add_argument("--stretch", type=float, default=8, help="seconds per frame-time scenario")
    r.add_argument("--switch-reps", type=int, default=20)
    r.add_argument("--throughput-mb", type=int, default=64)
    r.add_argument("--throughput-reps", type=int, default=3)
    r.add_argument("--idle-seconds", type=float, default=20)
    r.add_argument("--idle-reps", type=int, default=3)
    r.add_argument("--settle", type=float, default=8)
    c = sub.add_parser("compare")
    c.add_argument("before")
    c.add_argument("after")
    c.add_argument("--threshold", type=float, default=5, help="ignore changes under this percent")
    c.add_argument("--all", action="store_true", help="show every metric, marking real changes with *")
    c.add_argument("--floor", type=float, default=2, help="single readings below this (in their unit) are noise")
    c.add_argument("--grep", help="only metrics matching this regex")
    l = sub.add_parser("live")
    l.add_argument("--pid", type=int, required=True)
    l.add_argument("--seconds", type=float, default=20)
    l.add_argument("--top", type=int, default=12)
    p = sub.add_parser("profile")
    p.add_argument("--bin", default=os.path.join(REPO, "target", "symbols", "release", "zaki.exe"))
    p.add_argument("--only", help="comma-separated: startup,idle,hover,open,typing,scroll,output")
    p.add_argument("--out", default=os.path.join(RESULTS, "profiles"))
    p.add_argument("--seconds", type=float, default=12)
    args = ap.parse_args()
    {"run": run, "compare": compare, "live": live, "profile": profile}[args.command](args)


if __name__ == "__main__":
    main()
