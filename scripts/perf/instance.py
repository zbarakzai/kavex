"""One isolated Kavex: its own home, state, core session and app id.

The shell this runs in may itself be a terminal of the person's live Kavex, with
HC_TERMINAL_SOCKET and friends pointing at the live core. So the environment is
built from scratch for hc and the app, and `start_core` refuses to go on unless
what answers is a new core of its own. Every process is tracked by pid and
creation time; `stop` only ever ends those and what they started.
"""

import datetime
import glob
import json
import os
import secrets
import shutil
import struct
import subprocess
import threading
import time

import winapi as w

# Point at, or belong to, the session around us.
INHERITED = ("HC_", "HERDR", "KAVEX_", "TERM", "COLORTERM", "XDG_", "CARGO", "RUSTUP", "LIBCLANG", "ZIG", "DOCKER_HOST")
# Where an app that ended on its own leaves its evidence; clean_files never goes there.
CRASHES = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".scratch", "perf", "crashes")
# Windows Error Reporting's local dumps (on when LocalDumps is set up, as on the perf machine).
WER_DUMPS = os.path.join(os.environ.get("LOCALAPPDATA", ""), "CrashDumps")


def exit_text(code):
    """3221226505 reads as 0xC0000409 (fail-fast): what to search for."""
    if code is None:
        return "still running"
    known = {0xC0000409: "fail-fast (abort, stack buffer overrun)", 0xC0000005: "access violation", 0xC00000FD: "stack overflow",
             0x40010004: "terminated", 0xC000013A: "Ctrl+C", 101: "Rust panic in main", 1: "error"}
    unsigned = code & 0xFFFFFFFF
    return f"{code} (0x{unsigned:08X}, {known.get(unsigned, 'unknown')})"


class AppExited(SystemExit):
    """The app ended while it was expected to run; `kept` holds its evidence."""

    def __init__(self, message, code, kept):
        super().__init__(message)
        self.code = code
        self.kept = kept


def core_binary():
    found = shutil.which("hc")
    if not found:
        raise SystemExit("perf: hc is not on PATH")
    return os.path.realpath(found)


def application_error(pid):
    """Windows' Application Error (event 1000) and WER (1001) entries for `pid`
    from the last few minutes: they name the faulting module and offset."""
    query = "*[System[(EventID=1000 or EventID=1001) and TimeCreated[timediff(@SystemTime) <= 600000]]]"
    try:
        out = subprocess.run(["wevtutil", "qe", "Application", f"/q:{query}", "/f:text", "/rd:true", "/c:20"], capture_output=True,
                             text=True, errors="replace", timeout=15, creationflags=w.CREATE_NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired):
        return None
    hexpid = f"0x{pid:X}".lower()
    entries = [e.split("]:", 1)[-1].strip() for e in out.stdout.split("Event[") if e.strip()]
    return [e for e in entries if hexpid in e.lower() or f".{pid}.dmp" in e] or None


class Instance:
    def __init__(self, work, name, binary, core=None, profile=None, log="warn", events=True):
        self.events = events
        self.root = os.path.join(work, name)
        self.binary = binary
        self.hc_path = core or core_binary()
        self.session = "zp" + secrets.token_hex(3)
        self.profile = profile
        self.log = log
        self.owned = {}  # pid -> creation time
        self.app = None
        self.log_file = None
        self.err_file = None
        self.launched = 0  # starts so far, for the evidence folder's name
        self.kept = []  # evidence folders of starts that ended on their own
        self.kept_start = 0  # the start whose evidence was kept last
        self.core_pid = None
        self.holders = []
        for folder in ("home", "state", "config", "work"):
            os.makedirs(os.path.join(self.root, folder), exist_ok=True)
        self.events_path = os.path.join(self.root, "events.jsonl")
        self.folder = os.path.join(self.root, "work")

    def env(self):
        e = {k: v for k, v in os.environ.items() if not k.upper().startswith(INHERITED)}
        e.update(
            HC_SESSION=self.session,
            HERDR_APP_HOME=os.path.join(self.root, "home"),
            HERDR_APP_ID="kavex-perf",
            HERDR_APP_NO_SOUND="1",
            HERDR_APP_BENCH_EVENTS=self.events_path,
            # Pointer moves are posted with the real cursor elsewhere: see src/bench/wndproc.rs.
            HERDR_APP_BENCH_POSTED_POINTER="1",
            HERDR_APP_LOG=self.log,
            HERDR_CORE_DIRS=os.path.dirname(self.hc_path),
            XDG_STATE_HOME=os.path.join(self.root, "state"),
            XDG_CONFIG_HOME=os.path.join(self.root, "config"),
            PYTHONIOENCODING="utf-8",
            # A panic's stderr then says where it came from.
            RUST_BACKTRACE="1",
        )
        if self.profile:
            e["HERDR_APP_PROFILE"] = self.profile
        if not self.events:
            del e["HERDR_APP_BENCH_EVENTS"]
        return e

    def seed_home(self):
        """A person past the welcome, on the main layout, same window every run.

        usage.enabled false: the usage footer would otherwise run the person's
        real `claude -p /usage` and `codex app-server` from this test instance.
        """
        home = os.path.join(self.root, "home")
        with open(os.path.join(home, "shared.json"), "w") as f:
            json.dump({"frame.welcomed": True, "layout": "main", "usage.enabled": False}, f)
        with open(os.path.join(home, "settings.json"), "w") as f:
            json.dump({"zoom": 1.0}, f)
        with open(os.path.join(home, "window.json"), "w") as f:
            json.dump({"state": "windowed", "bounds": [40, 40, 1280, 820]}, f)

    def hc(self, *args, timeout=15):
        return subprocess.run([self.hc_path, *args], env=self.env(), capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout, creationflags=w.CREATE_NO_WINDOW, stdin=subprocess.DEVNULL)

    def track(self, pid):
        p = w.snapshot(pids={pid}).get(pid)
        if p:
            self.owned[pid] = p.created

    def core_status(self):
        out = self.hc("server", "status", "--json")
        if out.returncode != 0:
            return None
        return json.loads(out.stdout or "null")

    def start_core(self, live_core_ids):
        """Starts this instance's core and proves it isn't anyone else's.

        `live_core_ids` is what the default session's core calls itself."""
        if self.core_status() is not None:
            raise SystemExit(f"perf: session {self.session} already has a core; refusing to share it")
        before = set(w.snapshot({"hc.exe", "herdr-core.exe"}))
        started = self.hc("server", "start")
        if started.returncode != 0:
            raise SystemExit(f"perf: core start failed: {started.stdout}{started.stderr}")
        status = self.core_status()
        if not status:
            raise SystemExit("perf: the core started but doesn't answer")
        self.note_core(status)
        if self.core_pid in before:
            raise SystemExit(f"perf: core pid {self.core_pid} existed before we started it: not ours")
        if status.get("core", {}).get("id") in live_core_ids:
            raise SystemExit("perf: this core has the live core's id: state isn't isolated")
        if status.get("live"):
            raise SystemExit(f"perf: a new core has {status['live']} live terminals: not isolated")

    def note_core(self, status):
        self.core_pid = status.get("pid")
        self.holders = [h["pid"] for h in status.get("holders", [])]
        for pid in [self.core_pid, *self.holders]:
            if pid:
                self.track(pid)

    def launch(self):
        """Opens the window. Returns the clock reading just before the process.

        The app's log (stdout) goes to app.log and stderr (panics) to stderr.log,
        each with a line saying which start follows."""
        self.launched += 1
        self.log_file = open(os.path.join(self.root, "app.log"), "ab")
        self.err_file = open(os.path.join(self.root, "stderr.log"), "ab")
        stamp = f"--- start {self.launched} at {datetime.datetime.now().isoformat(timespec='milliseconds')}\n".encode()
        for f in (self.log_file, self.err_file):
            f.write(stamp)
            f.flush()
        at = w.now_us()
        self.app = subprocess.Popen([self.binary], env=self.env(), stdin=subprocess.DEVNULL, stdout=self.log_file, stderr=self.err_file, cwd=self.folder)
        self.track(self.app.pid)
        return at

    def exited(self, doing):
        """The app is gone while it should run: keep its evidence, then raise."""
        code = self.app.returncode
        kept = self.keep_evidence(f"exited with {exit_text(code)} while {doing}")
        raise AppExited(f"perf: the app exited with {exit_text(code)} while {doing}; evidence kept in {kept}", code, kept)

    def keep_evidence(self, why):
        """Copies what tells why this start ended (app.log, stderr.log, the
        events' tail, the exit code, a WER crash dump and Windows' Application
        Error entry for its pid) out of the instance, before anything cleans it."""
        pid = self.app.pid if self.app else None
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        dest = os.path.join(CRASHES, f"{stamp}-{os.path.basename(self.root)}-start{self.launched}")
        os.makedirs(dest, exist_ok=True)
        # Evidence (dumps are big) is for this machine: kept here, never committed.
        ignore = os.path.join(CRASHES, ".gitignore")
        if not os.path.exists(ignore):
            with open(ignore, "w") as f:
                f.write("*\n")
        for f in (self.log_file, self.err_file):
            if f:
                f.flush()
        for name in ("app.log", "stderr.log"):
            src = os.path.join(self.root, name)
            if os.path.exists(src):
                shutil.copy(src, dest)
        if os.path.exists(self.events_path):
            with open(self.events_path, "rb") as f:
                f.seek(max(0, os.path.getsize(self.events_path) - 64_000))
                tail = f.read()
            with open(os.path.join(dest, "events-tail.jsonl"), "wb") as f:
                f.write(tail)
        info = {"why": why, "binary": self.binary, "pid": pid, "start": self.launched, "session": self.session,
                "exit_code": self.app.returncode if self.app else None, "exit": exit_text(self.app.returncode if self.app else None)}
        # WER writes the dump a few seconds after the process ends.
        dumps = []
        if pid:
            end = time.monotonic() + (15 if info["exit_code"] not in (None, 0, 1) else 0)
            while True:
                dumps = glob.glob(os.path.join(WER_DUMPS, f"{os.path.basename(self.binary)}.{pid}.dmp"))
                if dumps or time.monotonic() >= end:
                    break
                time.sleep(0.5)
            time.sleep(1 if dumps else 0)  # let WER finish the file
            for d in dumps:
                shutil.copy(d, dest)
            info["dump"] = [os.path.basename(d) for d in dumps]
            info["application_error"] = application_error(pid)
        with open(os.path.join(dest, "exit.json"), "w") as f:
            json.dump(info, f, indent=1)
        self.kept.append(dest)
        self.kept_start = self.launched
        print(f"perf: {os.path.basename(self.root)} start {self.launched} {why}; evidence kept in {dest}", flush=True)
        return dest

    def client(self, *args, timeout=40):
        return subprocess.run([self.binary, *args], env=self.env(), capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout, creationflags=w.CREATE_NO_WINDOW, stdin=subprocess.DEVNULL)

    def do(self, command, args=None, tolerate=False):
        cmd = ["do", command] + ([json.dumps(args)] if args else [])
        for _ in range(100):
            out = self.client(*cmd)
            text = out.stdout + out.stderr
            if out.returncode == 0 or "unavailable" not in text:
                break
            time.sleep(0.1)
        if out.returncode != 0:
            if tolerate:
                return None
            raise RuntimeError(f"{command} failed: {out.stdout}{out.stderr}")
        return json.loads(out.stdout or "{}")

    def wait_ready(self, timeout=40):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if self.app.poll() is not None:
                self.exited("starting (waiting for it to accept commands)")
            try:
                if self.client("status", timeout=4).returncode == 0:
                    return True
            except subprocess.TimeoutExpired:
                pass
            time.sleep(0.05)
        raise SystemExit(f"perf: the app did not answer in {timeout} s; see {self.root}\\app.log")

    def window(self, timeout=10):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            hwnd = w.app_window(self.app.pid)
            if hwnd:
                return hwnd
            if self.app.poll() is not None:
                self.exited("starting (before its window)")
            time.sleep(0.02)
        raise SystemExit("perf: no window found for the test instance")

    def tree(self, processes=None):
        """Our tracked processes and everything below them, right now."""
        processes = processes if processes is not None else w.snapshot()
        alive = {pid for pid, created in self.owned.items() if pid in processes and processes[pid].created == created}
        return w.descendants(alive, processes)

    def quit_app(self):
        """Ends the window, not the core: what a person closing the app leaves running."""
        if not self.app:
            return
        why = None
        if self.app.poll() is None:
            self.do("window.close", tolerate=True)
            try:
                self.app.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.end_owned(self.app.pid)
                self.app.wait(timeout=5)
                why = "did not close in 3 s and was ended"
            if why is None and self.app.returncode != 0:
                why = f"closed with {exit_text(self.app.returncode)}"
        elif self.app.returncode != 0 and self.kept_start != self.launched:
            # Gone before we asked it to close, and not kept yet.
            why = f"had already exited with {exit_text(self.app.returncode)}"
        if why:
            self.keep_evidence(why)
        self.owned.pop(self.app.pid, None)
        self.app = None
        for f in (self.log_file, self.err_file):
            if f:
                f.close()
        self.log_file = self.err_file = None

    def end_owned(self, pid):
        """TerminateProcess, only for a pid this instance tracks, and only while
        it's the same process (pids are reused)."""
        created = self.owned.get(pid)
        now = w.snapshot(pids={pid}).get(pid)
        if created is None or now is None or now.created != created:
            return False
        return w.terminate(pid)

    def stop(self):
        """Everything of this instance goes; nothing else is touched."""
        self.quit_app()
        status = self.core_status()
        if status:
            self.note_core(status)
        listed = self.hc("ls", "--json")
        try:
            for t in json.loads(listed.stdout or "{}").get("terminals", []):
                self.hc("kill", t["address"])
        except (ValueError, KeyError):
            pass
        self.hc("server", "stop")
        time.sleep(0.5)
        processes = w.snapshot()
        left = self.tree(processes)
        # Children of a holder that are gone by now are out of the tree; what's
        # left under our pids is ours by descent.
        for pid in left:
            if pid not in self.owned:
                self.owned[pid] = processes[pid].created
        for pid in sorted(left):
            self.end_owned(pid)
        return sorted(left)

    def clean_files(self):
        shutil.rmtree(self.root, ignore_errors=True)


class CoreClient:
    """Speaks the app's own protocol (src/hc.rs) to this instance's core, with no
    app in between: what the core, ConPTY and the shell cost by themselves."""

    def __init__(self, instance):
        self.instance = instance
        self.proc = subprocess.Popen([instance.hc_path, "connect"], env=instance.env(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, creationflags=w.CREATE_NO_WINDOW)
        instance.track(self.proc.pid)
        self.proc.stdin.write(b'{"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true}}\n')
        self.proc.stdin.flush()
        self.hello = json.loads(self.proc.stdout.readline())
        self.lock = threading.Lock()
        self.replies = {}
        self.ready = threading.Condition(self.lock)
        self.next_id = 1
        self.frames = []  # (time, channel, bytes)
        self.frame_ready = threading.Condition()
        threading.Thread(target=self.read, daemon=True).start()

    def send(self, channel, kind, payload):
        self.proc.stdin.write(struct.pack("<IBI", channel, kind, len(payload)) + payload)
        self.proc.stdin.flush()

    def read(self):
        stream = self.proc.stdout
        while True:
            header = stream.read(9)
            if len(header) < 9:
                return
            channel, kind, length = struct.unpack("<IBI", header)
            payload = stream.read(length) if length else b""
            if channel == 0:
                message = json.loads(payload)
                with self.lock:
                    self.replies[message.get("id")] = message
                    self.ready.notify_all()
            elif kind == 0:
                at = w.now_us()
                self.send(channel, 1, struct.pack("<I", length))
                with self.frame_ready:
                    self.frames.append((at, channel, payload))
                    self.frame_ready.notify_all()

    def call(self, method, params, timeout=15):
        with self.lock:
            call_id = self.next_id
            self.next_id += 1
        self.send(0, 0, json.dumps({"jsonrpc": "2.0", "id": call_id, "method": method, "params": params}).encode())
        with self.lock:
            end = time.monotonic() + timeout
            while call_id not in self.replies:
                if not self.ready.wait(max(0, end - time.monotonic())):
                    raise TimeoutError(method)
            reply = self.replies.pop(call_id)
        if "error" in reply:
            raise RuntimeError(f"{method}: {reply['error']}")
        return reply.get("result")

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            self.instance.end_owned(self.proc.pid)
