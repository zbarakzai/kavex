"""Where the time goes: runs scenarios under the app's sampler (src/bench/sampler.rs)
and writes folded stacks and top-function tables per scenario.

Folded stacks (`a;b;c 12`) are what flamegraph tools read. Our own code is named
from the PDB of a build with line tables (`target/symbols/release/kavex.exe`, see
README.md) by llvm-symbolizer; system DLLs by their export tables, which
is enough to tell a wait from a syscall from the GPU driver.
"""

import bisect
import collections
import gzip
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import time

import winapi as w
from instance import Instance


def symbolizer():
    for folder in (os.environ.get("LIBCLANG_PATH", ""), os.path.join(os.environ.get("LOCALAPPDATA", ""), "kavex-perf", "llvm", "bin")):
        path = os.path.join(folder, "llvm-symbolizer.exe")
        if os.path.exists(path):
            return path
    raise SystemExit("perf: llvm-symbolizer.exe not found (dot-source the perf environment)")


def read_samples(path):
    with open(path, "rb") as f:
        data = f.read()
    samples = []
    at, end = 0, len(data)
    while at + 32 <= end:
        when, thread, flags, depth = struct.unpack_from("<QQQQ", data, at)
        at += 32
        if depth > 256 or at + depth * 8 > end:
            break
        samples.append((when, thread, flags & 1, struct.unpack_from(f"<{depth}Q", data, at)))
        at += depth * 8
    return samples


class Exports:
    """Names from a DLL's export table, by nearest address below."""

    def __init__(self, path):
        self.rvas, self.names = [], []
        try:
            with open(path, "rb") as f:
                data = f.read()
            pe = struct.unpack_from("<I", data, 0x3C)[0]
            sections = struct.unpack_from("<H", data, pe + 6)[0]
            optional = struct.unpack_from("<H", data, pe + 20)[0]
            table = pe + 24 + optional
            rva, _ = struct.unpack_from("<II", data, pe + 24 + 112)
            spans = [struct.unpack_from("<IIII", data, table + i * 40 + 8) for i in range(sections)]

            def offset(v):
                for size, address, _, raw in spans:
                    if address <= v < address + size:
                        return v - address + raw
                return None

            at = offset(rva)
            if at is None:
                return
            count_functions, count_names, functions, names, ordinals = struct.unpack_from("<IIIII", data, at + 20)
            found = []
            for i in range(count_names):
                name_at = offset(struct.unpack_from("<I", data, offset(names) + i * 4)[0])
                ordinal = struct.unpack_from("<H", data, offset(ordinals) + i * 2)[0]
                function = struct.unpack_from("<I", data, offset(functions) + ordinal * 4)[0]
                found.append((function, data[name_at:data.index(b"\0", name_at)].decode("ascii", "replace")))
            found.sort()
            self.rvas = [f[0] for f in found]
            self.names = [f[1] for f in found]
        except (OSError, struct.error, ValueError, TypeError):
            pass

    def name(self, rva):
        i = bisect.bisect_right(self.rvas, rva) - 1
        return self.names[i] if i >= 0 else None


def clean(name):
    name = re.sub(r"::h[0-9a-f]{16}$", "", name)
    name = re.sub(r"\$u[0-9a-f]+\$", "", name)
    return name.replace(";", ",")


def symbolize(modules, addresses, binary):
    """{address: [frame names, innermost first]}"""
    modules = sorted(modules, key=lambda m: m["base"])
    bases = [m["base"] for m in modules]
    ours = os.path.basename(binary).lower()
    names, by_module = {}, collections.defaultdict(list)
    for address in addresses:
        i = bisect.bisect_right(bases, address) - 1
        m = modules[i] if i >= 0 else None
        if m is None or address >= m["base"] + m["size"]:
            names[address] = ["[unknown or JIT]"]
            continue
        by_module[i].append(address)
    for i, found in by_module.items():
        m = modules[i]
        short = os.path.basename(m["path"])
        if short.lower() == ours:
            image = 0x140000000
            text = "\n".join(hex(a - m["base"] + image) for a in found) + "\n"
            out = subprocess.run([symbolizer(), f"--obj={binary}", "--functions=linkage", "--inlines", "--demangle"], input=text, capture_output=True, text=True, errors="replace")
            blocks = out.stdout.replace("\r\n", "\n").split("\n\n")
            for address, block in zip(found, blocks):
                lines = block.strip().split("\n")
                frames = [clean(l) for l in lines[0::2] if l and l != "??"]
                names[address] = frames or [f"{short}!+{address - m['base']:#x}"]
        else:
            exports = Exports(m["path"])
            for address in found:
                name = exports.name(address - m["base"])
                names[address] = [f"{short}!{name}" if name else f"{short}!?"]
    return names


IDLE = ("NtUserGetMessage", "NtUserMsgWaitForMultipleObjects", "NtUserWaitMessage")
# A thread whose innermost frame is one of these is waiting, whatever its
# cycle counter says (suspending it for the sample costs it a few cycles).
WAITS = ("NtWaitFor", "ZwWaitFor", "NtRemoveIoCompletion", "ZwRemoveIoCompletion", "NtDelayExecution", "ZwDelayExecution",
         "NtUserGetMessage", "NtUserMsgWaitFor", "NtUserWaitMessage", "ZwWaitForAlertByThreadId", "NtWaitForAlertByThreadId",
         "NtReadFile", "ZwReadFile", "NtFsControlFile", "ZwFsControlFile", "NtDeviceIoControlFile", "ZwDeviceIoControlFile",
         "ZwSignalAndWaitForSingleObject", "NtSignalAndWaitForSingleObject", "NtWaitForWorkViaWorkerFactory", "ZwWaitForWorkViaWorkerFactory",
         "DwmFlush", "NtGdiDdDDIWaitFor", "ZwWaitLowEventPair", "NtAlertThreadByThreadId", "AlpcSendWaitReceivePort")


def waiting(leaf):
    return any(w in leaf for w in WAITS)


def summarize(samples, index, names, spans, out_dir, label):
    threads = {int(k): v for k, v in index.get("threads", {}).items()}
    main = index.get("main")
    os.makedirs(out_dir, exist_ok=True)
    summary = {}
    for scenario, (t0, t1) in spans.items():
        folded = {"main_cpu": collections.Counter(), "main_blocked": collections.Counter(), "background_cpu": collections.Counter()}
        self_time = {k: collections.Counter() for k in folded}
        inclusive = {k: collections.Counter() for k in folded}
        by_thread = collections.Counter()
        total_main = idle = 0
        for when, thread, on_cpu, stack in samples:
            if when < t0 or when > t1:
                continue
            frames = [f for a in stack for f in names.get(a, ["?"])]
            name = threads.get(thread) or str(thread)
            leaf = frames[0] if frames else ""
            on_cpu = on_cpu and not waiting(leaf)
            if thread == main:
                total_main += 1
                if any(i in leaf for i in IDLE):
                    idle += 1
                    continue
                kind = "main_cpu" if on_cpu else "main_blocked"
            elif on_cpu:
                kind = "background_cpu"
                by_thread[name] += 1
            else:
                continue
            path = list(reversed(frames))
            if kind == "background_cpu":
                path.insert(0, f"thread {name}")
            folded[kind][";".join(path)] += 1
            if frames:
                self_time[kind][frames[0]] += 1
            for f in set(frames):
                inclusive[kind][f] += 1
        row = {"seconds": round((t1 - t0) / 1e6, 2), "main_samples": total_main, "main_idle_samples": idle}
        for kind, stacks in folded.items():
            # Gzipped: Rust names make these tens of MB; `gzip -dc` feeds a flamegraph tool.
            with gzip.open(os.path.join(out_dir, f"{label}-{scenario}-{kind}.folded.gz"), "wt", encoding="utf-8") as f:
                for stack, count in stacks.most_common():
                    f.write(f"{stack} {count}\n")
            row[kind] = {"samples": sum(stacks.values()), "self": self_time[kind].most_common(30), "inclusive": inclusive[kind].most_common(60)}
        row["background_threads"] = by_thread.most_common(15)
        summary[scenario] = row
    with open(os.path.join(out_dir, f"{label}-summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=1)
    return summary


def profile(args, perf):
    binary = os.path.abspath(args.bin)
    if not os.path.exists(binary):
        raise SystemExit(f"perf: no symbols build at {binary} (see scripts/perf/README.md)")
    wanted = set(args.only.split(",")) if args.only else {"startup", "idle", "hover", "tabs", "open", "typing", "scroll", "output"}
    live_ids, _ = perf.live_identity()
    work = tempfile.mkdtemp(prefix="zp-")
    trace = os.path.join(work, "profile.bin")
    instance = Instance(work, "main", binary, profile=trace)
    instance.seed_home()
    instance.start_core(live_ids)
    spans = {}
    samples = []
    try:
        t0 = instance.launch()
        events = perf.Events(instance.events_path)
        hwnd = instance.window(timeout=30)
        events.wait(t0, lambda e: e["e"] == "first_paint", 30)
        instance.wait_ready()
        spans["startup"] = (t0, w.now_us())
        made = w.now_us()
        instance.do("space.new", {"folder": instance.folder})
        perf.first_ink(events, made, timeout=25)
        instance.note_core(instance.core_status())
        w.activate(hwnd)
        time.sleep(6)

        def timed(name, action):
            if name in wanted:
                print(f"profile: {name}", flush=True)
                start = w.now_us()
                action()
                spans[name] = (start, w.now_us())

        timed("idle", lambda: time.sleep(args.seconds))
        for i in range(5):
            instance.do("space.new", {"name": f"s{i}", "folder": instance.folder, "argv": ["cmd.exe"]})
        for i in range(5):
            instance.do("tab.new", {"folder": instance.folder, "argv": ["cmd.exe"]})
        time.sleep(1)
        dpi = w.window_state(hwnd)["dpi"] / 96

        def hover():
            end, step = time.monotonic() + args.seconds, 0
            while time.monotonic() < end:
                w.post_mouse_move(hwnd, int(115 * dpi), int((60 + abs(step * 6 % 800 - 400)) * dpi))
                step += 1
                time.sleep(0.008)

        def tabs():
            end, forward = time.monotonic() + args.seconds, True
            while time.monotonic() < end:
                instance.do("tab.next" if forward else "tab.prev")
                forward = not forward
                time.sleep(0.12)

        def opening():
            for i in range(8):
                perf.new_terminal(instance, events, "tab.new", {"folder": instance.folder})
                instance.do("tab.close", {"confirmed": True}, tolerate=True)

        def typing():
            instance.do("tab.new", {"folder": instance.folder, "argv": ["cmd.exe"]})
            time.sleep(1)
            w.activate(hwnd)
            for i in range(int(args.seconds * 5)):
                w.post_key(hwnd, ord("X"))
                time.sleep(0.2)
            instance.do("tab.close", {"confirmed": True}, tolerate=True)

        def scroll():
            instance.do("tab.new", {"folder": instance.folder, "argv": [sys.executable, "-c", perf.SCROLLBACK + "\nimport time\ntime.sleep(3600)"]})
            time.sleep(3)
            w.post_mouse_move(hwnd, int(700 * dpi), int(450 * dpi))
            end, direction, count = time.monotonic() + args.seconds, 1, 0
            while time.monotonic() < end:
                w.post_wheel(hwnd, int(700 * dpi), int(450 * dpi), direction)
                count += 1
                direction = -direction if count % 200 == 0 else direction
                time.sleep(0.016)

        def output():
            script = os.path.join(instance.root, "emit.py")
            with open(script, "w") as f:
                f.write(perf.EMIT)
            reply = instance.do("tab.new", {"folder": instance.folder, "argv": [sys.executable, "-u", script, "48", "3600"]})
            end = time.monotonic() + 120
            while time.monotonic() < end:
                time.sleep(0.5)
                if "EMIT-DONE" in instance.hc("read", reply["terminal"], "--lines", "4").stdout:
                    break

        for name, action in (("hover", hover), ("tabs", tabs), ("open", opening), ("typing", typing), ("scroll", scroll), ("output", output)):
            timed(name, action)
        time.sleep(1.5)
    finally:
        instance.stop()
    samples = read_samples(trace)
    with open(trace + ".json", encoding="utf-8") as f:
        index = json.load(f)
    addresses = {a for s in samples for a in s[3]}
    print(f"profile: {len(samples)} samples, {len(addresses)} addresses; symbolizing", flush=True)
    names = symbolize(index["modules"], addresses, binary)
    label = time.strftime("%Y%m%d-%H%M%S")
    summary = summarize(samples, index, names, spans, args.out, label)
    instance.clean_files()
    print(f"profile: wrote {args.out}\\{label}-*", flush=True)
    for scenario, row in summary.items():
        print(f"{scenario}: {row['seconds']} s, main cpu {row['main_cpu']['samples']}, main blocked {row['main_blocked']['samples']}, background {row['background_cpu']['samples']} samples")
