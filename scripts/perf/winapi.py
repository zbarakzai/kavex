"""The Windows calls the perf harness needs, through ctypes (no packages).

Reading is system-wide (`snapshot` sees every process, as Task Manager does).
Anything that acts takes the test window's own HWND or a process the harness
started: there is no SendInput and no mouse movement here.
"""

import ctypes
import struct
from ctypes import wintypes

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
user32 = ctypes.WinDLL("user32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll")

WM_ACTIVATE = 0x0006
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_MOUSEMOVE = 0x0200
WM_MOUSEWHEEL = 0x020A
VK_BACK = 0x08
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_NOMOVE = 0x0002
CREATE_NO_WINDOW = 0x08000000
PROCESS_TERMINATE = 0x0001
PROCESS_QUERY_LIMITED = 0x1000
THREAD_QUERY_LIMITED = 0x0800
TICKS_PER_SECOND = 10_000_000


def now_us():
    """Microseconds since the Unix epoch, on the same clock as the app's marks."""
    ticks = ctypes.c_ulonglong()
    kernel32.GetSystemTimePreciseAsFileTime(ctypes.byref(ticks))
    return (ticks.value - 116444736000000000) // 10


class Thread:
    __slots__ = ("tid", "kernel", "user", "switches", "state", "wait_reason", "start_address")

    def __init__(self, tid, kernel, user, switches, state, wait_reason, start_address):
        self.tid, self.kernel, self.user, self.switches = tid, kernel, user, switches
        self.state, self.wait_reason, self.start_address = state, wait_reason, start_address

    @property
    def cpu(self):
        return (self.kernel + self.user) / TICKS_PER_SECOND


class Process:
    __slots__ = ("pid", "ppid", "name", "created", "kernel", "user", "handles", "working_set", "private", "threads", "reads", "writes", "others", "faults")

    @property
    def cpu(self):
        return (self.kernel + self.user) / TICKS_PER_SECOND

    @property
    def switches(self):
        return sum(t.switches for t in self.threads)


def snapshot(names=None, pids=None):
    """Every process, or those matching `names` or `pids`: {pid: Process}.

    SYSTEM_PROCESS_INFORMATION, as ntdll fills it on x64. `names` are lowercase.
    """
    size = 4 << 20
    while True:
        buffer = ctypes.create_string_buffer(size)
        returned = wintypes.ULONG()
        status = ntdll.NtQuerySystemInformation(5, buffer, size, ctypes.byref(returned))
        if status == 0:
            break
        if status & 0xFFFFFFFF != 0xC0000004:  # STATUS_INFO_LENGTH_MISMATCH
            raise OSError(f"NtQuerySystemInformation: {status & 0xFFFFFFFF:#x}")
        size *= 2
    raw = buffer.raw
    found = {}
    offset = 0
    while True:
        next_entry, thread_count = struct.unpack_from("<II", raw, offset)
        created, user, kernel = struct.unpack_from("<qqq", raw, offset + 32)
        name_len, _, name_ptr = struct.unpack_from("<HHxxxxQ", raw, offset + 56)
        pid, ppid = struct.unpack_from("<QQ", raw, offset + 80)
        name = ctypes.wstring_at(name_ptr, name_len // 2) if name_ptr else "System Idle Process"
        if (names is None and pids is None) or (names is not None and name.lower() in names) or (pids is not None and pid in pids):
            p = Process()
            p.pid, p.ppid, p.name, p.created, p.kernel, p.user = pid, ppid, name, created, kernel, user
            p.handles = struct.unpack_from("<I", raw, offset + 96)[0]
            p.faults = struct.unpack_from("<I", raw, offset + 128)[0]
            p.working_set = struct.unpack_from("<Q", raw, offset + 144)[0]
            p.private = struct.unpack_from("<Q", raw, offset + 184)[0]
            p.reads, p.writes, p.others = struct.unpack_from("<qqq", raw, offset + 208)
            p.threads = []
            for i in range(thread_count):
                at = offset + 256 + i * 80
                t_kernel, t_user = struct.unpack_from("<qq", raw, at)
                start = struct.unpack_from("<Q", raw, at + 32)[0]
                tid = struct.unpack_from("<Q", raw, at + 48)[0]
                switches, state, reason = struct.unpack_from("<III", raw, at + 64)
                p.threads.append(Thread(tid, t_kernel, t_user, switches, state, reason, start))
            found[pid] = p
        if next_entry == 0:
            return found
        offset += next_entry


def descendants(roots, processes=None):
    """`roots` and every process below them. Children outlive parents, so the
    parent id is only trusted when the parent is older than the child."""
    processes = processes if processes is not None else snapshot()
    keep = {pid for pid in roots if pid in processes}
    changed = True
    while changed:
        changed = False
        for p in processes.values():
            parent = processes.get(p.ppid)
            if p.pid not in keep and p.ppid in keep and parent is not None and parent.created <= p.created:
                keep.add(p.pid)
                changed = True
    return keep


def thread_name(tid):
    """A thread's description, read-only; '' when it has none or can't be opened."""
    kernel32.OpenThread.restype = wintypes.HANDLE
    kernel32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    handle = kernel32.OpenThread(THREAD_QUERY_LIMITED, False, tid)
    if not handle:
        return ""
    text = wintypes.LPWSTR()
    kernel32.GetThreadDescription.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.LPWSTR)]
    kernel32.GetThreadDescription.restype = ctypes.c_long
    name = ""
    if kernel32.GetThreadDescription(handle, ctypes.byref(text)) >= 0 and text:
        name = text.value or ""
        kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
        kernel32.LocalFree(ctypes.cast(text, wintypes.HLOCAL))
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle(handle)
    return name


def terminate(pid):
    """Ends one process. Callers pass only pids the harness tracks as its own."""
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    handle = kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
    if not handle:
        return False
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    done = bool(kernel32.TerminateProcess(handle, 1))
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle(handle)
    return done


WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsIconic.argtypes = [wintypes.HWND]
user32.GetForegroundWindow.restype = wintypes.HWND
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
user32.GetDpiForWindow.argtypes = [wintypes.HWND]
user32.GetDpiForWindow.restype = wintypes.UINT
user32.MapVirtualKeyW.argtypes = [wintypes.UINT, wintypes.UINT]
user32.MapVirtualKeyW.restype = wintypes.UINT


def app_window(pid):
    """The app's main window (GPUI's class), or None."""
    found = []

    def visit(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid:
            name = ctypes.create_unicode_buffer(64)
            user32.GetClassNameW(hwnd, name, 64)
            if name.value == "Zed::Window" and user32.IsWindowVisible(hwnd):
                found.append(hwnd)
        return True

    user32.EnumWindows(WNDENUMPROC(visit), 0)
    return found[0] if found else None


def window_thread(hwnd):
    """The thread that owns a window: GPUI's main thread."""
    return user32.GetWindowThreadProcessId(hwnd, None)


def post(hwnd, message, wparam=0, lparam=0):
    if not user32.PostMessageW(hwnd, message, wparam, lparam):
        raise ctypes.WinError(ctypes.get_last_error())


def client_size(hwnd):
    rect = wintypes.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(rect))
    return rect.right, rect.bottom


def client_to_screen(hwnd, x, y):
    point = wintypes.POINT(x, y)
    user32.ClientToScreen(hwnd, ctypes.byref(point))
    return point.x, point.y


def post_mouse_move(hwnd, x, y):
    post(hwnd, WM_MOUSEMOVE, 0, ((y & 0xFFFF) << 16) | (x & 0xFFFF))


def post_wheel(hwnd, x, y, notches):
    """Wheel messages carry screen coordinates. Delta is the high word of wparam."""
    sx, sy = client_to_screen(hwnd, x, y)
    post(hwnd, WM_MOUSEWHEEL, ((notches * 120) & 0xFFFF) << 16, ((sy & 0xFFFF) << 16) | (sx & 0xFFFF))


def key_lparam(vk, up=False):
    scan = user32.MapVirtualKeyW(vk, 0)
    value = 1 | (scan << 16)
    if up:
        value |= (1 << 30) | (1 << 31)
    return value


def post_key(hwnd, vk):
    post(hwnd, WM_KEYDOWN, vk, key_lparam(vk))
    post(hwnd, WM_KEYUP, vk, key_lparam(vk, up=True))


def activate(hwnd):
    """Tells the window it's active, without touching the real foreground
    window: frames are then paced as for the window a person is using."""
    post(hwnd, WM_ACTIVATE, 1, 0)


def resize(hwnd, width, height):
    user32.SetWindowPos(hwnd, None, 0, 0, width, height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOMOVE)


def window_state(hwnd):
    return {
        "foreground": user32.GetForegroundWindow() == hwnd,
        "iconic": bool(user32.IsIconic(hwnd)),
        "visible": bool(user32.IsWindowVisible(hwnd)),
        "dpi": user32.GetDpiForWindow(hwnd),
        "client": client_size(hwnd),
    }


def power_status():
    class Status(ctypes.Structure):
        _fields_ = [("ac", ctypes.c_ubyte), ("battery_flag", ctypes.c_ubyte), ("percent", ctypes.c_ubyte), ("saver", ctypes.c_ubyte),
                    ("life", wintypes.DWORD), ("full", wintypes.DWORD)]

    s = Status()
    kernel32.GetSystemPowerStatus(ctypes.byref(s))
    return {"on_ac": s.ac == 1, "battery_percent": s.percent, "battery_saver": bool(s.saver)}


def refresh_hz():
    """Windows' reported refresh rate for the primary display."""
    gdi = ctypes.WinDLL("gdi32")
    user32.GetDC.restype = wintypes.HDC
    user32.GetDC.argtypes = [wintypes.HWND]
    gdi.GetDeviceCaps.argtypes = [wintypes.HDC, ctypes.c_int]
    user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    dc = user32.GetDC(None)
    hz = gdi.GetDeviceCaps(dc, 116)
    user32.ReleaseDC(None, dc)
    return hz
