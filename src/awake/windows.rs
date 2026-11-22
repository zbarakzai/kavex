use windows_sys::Win32::System::Power::{
    ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
};

// Owned by the keep-awake thread, since Windows attaches the request to that thread.
pub struct Assertion;

impl Assertion {
    pub fn take() -> Result<Self, String> {
        let previous = unsafe {
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
        };
        if previous == 0 {
            return Err("Windows rejected the system and display request".into());
        }
        Ok(Self)
    }

    pub fn held(&mut self) -> bool {
        true
    }
}

impl Drop for Assertion {
    fn drop(&mut self) {
        unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    }
}

#[cfg(test)]
#[test]
fn holds_system_and_display_and_restores_thread_policy() {
    std::thread::spawn(|| {
        let held = Assertion::take().unwrap();
        let previous = unsafe {
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
        };
        assert_ne!(previous & ES_SYSTEM_REQUIRED, 0);
        assert_ne!(previous & ES_DISPLAY_REQUIRED, 0);
        drop(held);
        let previous = unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        assert_eq!(previous & (ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED), 0);
    })
    .join()
    .unwrap();
}
