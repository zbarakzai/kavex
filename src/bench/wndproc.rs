//! Windows: times what the main thread does for its windows, by wrapping
//! their window procedures. Attached only with HERDR_APP_BENCH_EVENTS.
//!
//! A drawn frame is one line with the whole message's time (render, layout,
//! paint, GPU submission and Present). Anything else over `SLOW_US` gets a
//! line too. Paints with nothing to draw (every vsync on Windows) are only
//! counted.
//!
//! With HERDR_APP_BENCH_POSTED_POINTER too (the harness sets it), the window
//! never hears WM_MOUSELEAVE. The harness posts its pointer moves while the
//! real cursor is elsewhere, and Windows answers the TrackMouseEvent each move
//! asks for with an immediate leave, so the window would flip between hovered
//! and not on every move and redraw for each flip. A real pointer is over the
//! window when it moves, so it never sees that.

use super::{frame_counters, mark_with};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering::Relaxed};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, FindWindowExW, GWLP_WNDPROC, GetWindowThreadProcessId, HWND_MESSAGE, SetWindowLongPtrW, WM_PAINT,
};

/// Messages under this aren't worth a line of their own.
const SLOW_US: u64 = 500;

static WINDOW_PROC: AtomicIsize = AtomicIsize::new(0);
static PLATFORM_PROC: AtomicIsize = AtomicIsize::new(0);
static IDLE_PAINTS: AtomicU64 = AtomicU64::new(0);
static IDLE_PAINT_US: AtomicU64 = AtomicU64::new(0);
static POSTED_POINTER: AtomicBool = AtomicBool::new(false);

const WM_MOUSELEAVE: u32 = 0x02A3;

/// Whether the window procedure should not see this message.
fn dropped(msg: u32, posted_pointer: bool) -> bool {
    posted_pointer && msg == WM_MOUSELEAVE
}

/// Paints that drew nothing, and their total time, so far.
pub fn idle_paints() -> (u64, u64) {
    (IDLE_PAINTS.load(Relaxed), IDLE_PAINT_US.load(Relaxed))
}

pub fn attach(window: &gpui::Window) {
    POSTED_POINTER.store(std::env::var_os("HERDR_APP_BENCH_POSTED_POINTER").is_some(), Relaxed);
    if let Ok(handle) = HasWindowHandle::window_handle(window)
        && let RawWindowHandle::Win32(h) = handle.as_raw()
    {
        let hwnd = h.hwnd.get() as HWND;
        let old = unsafe { SetWindowLongPtrW(hwnd, GWLP_WNDPROC, window_proc as *const () as isize) };
        WINDOW_PROC.store(old, Relaxed);
    }
    // GPUI's main-thread tasks arrive at its message-only window.
    let class: Vec<u16> = "Zed::PlatformWindow\0".encode_utf16().collect();
    let mut after: HWND = std::ptr::null_mut();
    loop {
        let found = unsafe { FindWindowExW(HWND_MESSAGE, after, class.as_ptr(), std::ptr::null()) };
        if found.is_null() {
            return;
        }
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(found, &mut pid) };
        if pid == std::process::id() {
            let old = unsafe { SetWindowLongPtrW(found, GWLP_WNDPROC, platform_proc as *const () as isize) };
            PLATFORM_PROC.store(old, Relaxed);
            return;
        }
        after = found;
    }
}

fn call(proc_slot: &AtomicIsize, hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let old = proc_slot.load(Relaxed);
    // SAFETY: the slot holds what SetWindowLongPtrW returned for this window.
    unsafe { CallWindowProcW(std::mem::transmute::<isize, windows_sys::Win32::UI::WindowsAndMessaging::WNDPROC>(old), hwnd, msg, wparam, lparam) }
}

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if dropped(msg, POSTED_POINTER.load(Relaxed)) {
        return 0;
    }
    let before = frame_counters();
    let start = std::time::Instant::now();
    let result = call(&WINDOW_PROC, hwnd, msg, wparam, lparam);
    let took = start.elapsed().as_micros() as u64;
    let after = frame_counters();
    if after[0] != before[0] {
        let mut values = vec![took, msg as u64];
        values.extend(after.iter().zip(before).map(|(a, b)| a.saturating_sub(b)));
        mark_with("frame", &values);
    } else if msg == WM_PAINT {
        IDLE_PAINTS.fetch_add(1, Relaxed);
        IDLE_PAINT_US.fetch_add(took, Relaxed);
    } else if took >= SLOW_US {
        mark_with("msg", &[took, msg as u64]);
    }
    result
}

unsafe extern "system" fn platform_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let start = std::time::Instant::now();
    let result = call(&PLATFORM_PROC, hwnd, msg, wparam, lparam);
    let took = start.elapsed().as_micros() as u64;
    if took >= SLOW_US {
        mark_with("task", &[took, msg as u64]);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_posted_pointer_loses_its_leave() {
        assert!(dropped(WM_MOUSELEAVE, true));
        assert!(!dropped(WM_MOUSELEAVE, false));
        assert!(!dropped(WM_PAINT, true));
        assert!(!dropped(0x0200, true)); // WM_MOUSEMOVE
    }
}
