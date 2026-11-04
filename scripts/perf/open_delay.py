"""Why a terminal Zaki opens with an argv takes about 1.3 s to show its prompt.

    py -3.12 scripts/perf/open_delay.py [target/release/zaki.exe]

Starts cmd.exe four ways on one isolated core, with the app running on it:
`hc run --bg`, this script's own connection (instance.CoreClient), the same
connection with the argv the app sends (`agent_argv`: the program run inside
the person's PowerShell, `-NoExit`), and the app's `terminal.open`. A second
viewer attaches as soon as the core announces each terminal, so the time is
when the core sent the prompt, not when the app drew it. Measured 2026-11-03:
about 0.2-0.3 s, 0.1 s, 1.2 s and 1.2-1.4 s. The wait is PowerShell and its profile
starting before the program, not the app's connection or the core.
"""
import sys, os, time, tempfile, json, threading
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import winapi as w
import perf
from instance import Instance, CoreClient

live_ids, _ = perf.live_identity()
work = tempfile.mkdtemp(prefix="zp-")
binary = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "..", "target", "release", "zaki.exe")
i = Instance(work, "open-delay", os.path.abspath(binary))
i.seed_home()
i.start_core(live_ids)
facts = {"fg": "#ffffff", "bg": "#000000", "cursor": "#ffffff", "cell": [18, 38]}
try:
    i.launch()
    i.window(30)
    i.wait_ready()
    made = i.do("space.new", {"folder": i.folder, "argv": ["cmd.exe"]})
    time.sleep(3)
    c = CoreClient(i)
    sub = c.call("events.subscribe", {})
    c.send(sub["channel"], 1, (1 << 20).to_bytes(4, "little"))

    def timed(start):
        c.frames.clear()
        t0 = w.now_us()
        threading.Thread(target=start, daemon=True).start()
        ch, prompt = None, None
        end = time.monotonic() + 6
        while time.monotonic() < end and prompt is None:
            time.sleep(0.003)
            for when, chan, data in list(c.frames):
                if ch is None and chan == sub["channel"] and b'"created"' in data:
                    for line in data.split(b"\n"):
                        try:
                            p = json.loads(line).get("params", {})
                        except ValueError:
                            continue
                        if p.get("type") == "created":
                            timed.address = p["terminal"]
                            ch = c.call("terminal.attach", {"terminal": p["terminal"], "cols": 120, "rows": 40, "history": 2000, "display": facts})["channel"]
                if ch is not None and chan == ch and b"work>" in data:
                    prompt = when
        result = (prompt - t0) / 1000 if prompt else -1
        c.call("terminal.kill", {"terminal": timed.address})
        time.sleep(1)
        return result

    for rep in range(3):
        cli = timed(lambda: i.hc("run", "--bg", "--json", "--cwd", i.folder, "--", "cmd.exe"))
        ours = timed(lambda: c.call("terminal.run", {"argv": ["cmd.exe"], "cwd": i.folder, "env": {"TERM": "xterm-256color"}, "labels": {}, "keep": True}))
        wrapped = timed(lambda: c.call("terminal.run", {"argv": ["powershell.exe", "-NoExit", "-Command", "& 'cmd.exe'"], "cwd": i.folder, "env": {"TERM": "xterm-256color"}, "labels": {}, "keep": True}))
        app = timed(lambda: i.do("terminal.open", {"argv": ["cmd.exe"], "folder": i.folder}))
        print(f"rep {rep}: hc run --bg {cli:7.1f} ms   our client {ours:7.1f} ms   our client, app's argv {wrapped:7.1f} ms   app terminal.open {app:7.1f} ms")
    c.close()
finally:
    i.stop()
    i.clean_files()
