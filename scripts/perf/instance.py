"""One isolated Zaki: its own home, state, core session and app id.

The shell this runs in may itself be a terminal of the person's live Zaki, with
HC_TERMINAL_SOCKET and friends pointing at the live core. So the environment is
built from scratch for hc and the app, and `start_core` refuses to go on unless
what answers is a new core of its own. Every process is tracked by pid and
creation time; `stop` only ever ends those and what they started.
"""

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
INHERITED = ("HC_", "HERDR", "ZAKI_", "TERM", "COLORTERM", "XDG_", "CARGO", "RUSTUP", "LIBCLANG", "ZIG", "DOCKER_HOST")


def core_binary():
    found = shutil.which("hc")
    if not found:
        raise SystemExit("perf: hc is not on PATH")
    return os.path.realpath(found)


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
            HERDR_APP_ID="zaki-perf",
            HERDR_APP_NO_SOUND="1",
            HERDR_APP_BENCH_EVENTS=self.events_path,
            HERDR_APP_LOG=self.log,
            HERDR_CORE_DIRS=os.path.dirname(self.hc_path),
            XDG_STATE_HOME=os.path.join(self.root, "state"),
            XDG_CONFIG_HOME=os.path.join(self.root, "config"),
            PYTHONIOENCODING="utf-8",
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
        """Opens the window. Returns the clock reading just before the process."""
        self.log_file = open(os.path.join(self.root, "app.log"), "ab")
        at = w.now_us()
        self.app = subprocess.Popen([self.binary], env=self.env(), stdin=subprocess.DEVNULL, stdout=self.log_file, stderr=self.log_file, cwd=self.folder)
        self.track(self.app.pid)
        return at

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
                raise SystemExit(f"perf: the app exited with {self.app.returncode}; see {self.root}\\app.log")
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
        if self.app.poll() is None:
            self.do("window.close", tolerate=True)
            try:
                self.app.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.end_owned(self.app.pid)
                self.app.wait(timeout=5)
        self.owned.pop(self.app.pid, None)
        self.app = None
        if self.log_file:
            self.log_file.close()
            self.log_file = None

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
