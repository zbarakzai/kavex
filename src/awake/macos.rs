use std::process::{Child, Command, Stdio};

/// The same open-lid idle and AC sleep assertions that Orca requests.
pub struct Assertion {
    caffeinate: Option<Child>,
    fallback: Option<u32>,
}

impl Assertion {
    pub fn take() -> Result<Self, String> {
        if let Some(child) = start_helper() {
            return Ok(Self {
                caffeinate: Some(child),
                fallback: None,
            });
        }
        Ok(Self {
            caffeinate: None,
            fallback: Some(display_assertion()?),
        })
    }

    pub fn held(&mut self) -> bool {
        let Some(child) = &mut self.caffeinate else {
            if let Some(child) = start_helper() {
                self.caffeinate = Some(child);
                self.release_fallback();
                return true;
            }
            return self.fallback.is_some();
        };
        if matches!(child.try_wait(), Ok(None)) {
            return true;
        }
        self.stop_helper();
        self.fallback = display_assertion().ok();
        self.fallback.is_some()
    }

    fn stop_helper(&mut self) {
        if let Some(mut child) = self.caffeinate.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn release_fallback(&mut self) {
        if let Some(id) = self.fallback.take() {
            // This id came from IOPMAssertionCreateWithName in this process.
            unsafe { IOPMAssertionRelease(id) };
        }
    }
}

impl Drop for Assertion {
    fn drop(&mut self) {
        self.stop_helper();
        self.release_fallback();
    }
}

fn start_helper() -> Option<Child> {
    let mut child = Command::new("/usr/bin/caffeinate")
        .args(["-i", "-s", "-w", &std::process::id().to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    if matches!(child.try_wait(), Ok(None)) {
        return Some(child);
    }
    let _ = child.kill();
    let _ = child.wait();
    None
}

fn display_assertion() -> Result<u32, String> {
    const UTF8: u32 = 0x0800_0100;
    const ON: u32 = 255;
    let mut id = 0;
    // Own both created strings until IOKit has consumed them.
    let code = unsafe {
        let kind = CFStringCreateWithCString(
            std::ptr::null(),
            c"PreventUserIdleDisplaySleep".as_ptr(),
            UTF8,
        );
        let reason = CFStringCreateWithCString(
            std::ptr::null(),
            c"Kavex Keep computer awake".as_ptr(),
            UTF8,
        );
        let code = if kind.is_null() || reason.is_null() {
            -1
        } else {
            IOPMAssertionCreateWithName(kind, ON, reason, &mut id)
        };
        for value in [kind, reason] {
            if !value.is_null() {
                CFRelease(value);
            }
        }
        code
    };
    if code == 0 {
        Ok(id)
    } else {
        Err(format!("macOS power assertion failed ({code})"))
    }
}

use std::ffi::{c_char, c_void};

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringCreateWithCString(
        allocator: *const c_void,
        value: *const c_char,
        encoding: u32,
    ) -> *const c_void;
    fn CFRelease(value: *const c_void);
}

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOPMAssertionCreateWithName(
        kind: *const c_void,
        level: u32,
        reason: *const c_void,
        id: *mut u32,
    ) -> i32;
    fn IOPMAssertionRelease(id: u32) -> i32;
}
