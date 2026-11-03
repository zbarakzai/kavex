//! A sampling profiler for Windows x64, for machines where ETW needs an
//! elevation we don't have. On only with HERDR_APP_PROFILE=<file>.
//!
//! Each tick it suspends a thread, copies its registers and the top of its
//! stack, and resumes it; the unwinding happens afterwards on the copy. Nothing
//! that takes a lock runs while a thread is suspended, because that thread may
//! hold it (the heap's, the loader's). `scripts/perf/symbols.py` turns the
//! addresses into names.
//!
//! The file is a stream of u64, little-endian, one record per sample:
//! time in µs, thread id, flags (1: it used the CPU since the last tick),
//! depth, then `depth` return addresses, innermost first. `<file>.json` lists
//! the modules and threads for reading it.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HMODULE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::Debug::{
    CONTEXT, CONTEXT_CONTROL_AMD64, CONTEXT_INTEGER_AMD64, GetThreadContext, RtlLookupFunctionEntry, RtlVirtualUnwind,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::ProcessStatus::{K32EnumProcessModules, K32GetModuleFileNameExW, K32GetModuleInformation, MODULEINFO};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetCurrentThread, GetCurrentThreadId, GetThreadDescription, OpenThread, ResumeThread,
    SetThreadPriority, SuspendThread, THREAD_GET_CONTEXT, THREAD_PRIORITY_TIME_CRITICAL, THREAD_QUERY_INFORMATION, THREAD_SUSPEND_RESUME,
};

const HZ: u64 = 500;
/// About 25 µs of a 2 ms tick: well above what a suspend and resume add.
const ON_CPU_CYCLES: u64 = 100_000;
const MAX_DEPTH: usize = 128;
/// Stack copied per sample: deep enough for GPUI's element recursion.
const STACK_COPY: usize = 512 * 1024;

#[repr(C)]
struct ThreadBasicInformation {
    exit_status: i32,
    teb_base: *const usize,
    client_id: [usize; 2],
    affinity: usize,
    priority: i32,
    base_priority: i32,
}

#[link(name = "ntdll", kind = "raw-dylib")]
unsafe extern "system" {
    fn NtQueryInformationThread(thread: HANDLE, class: u32, info: *mut std::ffi::c_void, len: u32, returned: *mut u32) -> i32;
}

// In windows-sys it's behind another feature; one declaration is cheaper.
#[link(name = "kernel32", kind = "raw-dylib")]
unsafe extern "system" {
    fn QueryThreadCycleTime(thread: HANDLE, cycles: *mut u64) -> i32;
}

struct Thread {
    handle: HANDLE,
    /// Where its stack ends (the highest address).
    stack_base: usize,
    cycles: u64,
    name: String,
}

pub fn start(path: PathBuf) {
    let main = unsafe { GetCurrentThreadId() };
    let _ = std::thread::Builder::new().name("zaki-sampler".into()).spawn(move || run(path, main));
}

fn run(path: PathBuf, main: u32) {
    let Ok(mut out) = std::fs::File::create(&path).map(|f| std::io::BufWriter::with_capacity(1 << 20, f)) else { return };
    unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL) };
    let me = unsafe { GetCurrentThreadId() };
    let mut threads: HashMap<u32, Thread> = HashMap::new();
    let mut copy = vec![0u8; STACK_COPY];
    let tick = Duration::from_micros(1_000_000 / HZ);
    let mut next = Instant::now();
    let mut listed = Instant::now() - Duration::from_secs(10);
    loop {
        if listed.elapsed() >= Duration::from_secs(1) {
            listed = Instant::now();
            refresh(&mut threads, me);
            write_index(&path, &threads, main);
            let _ = out.flush();
        }
        let ids: Vec<u32> = threads.keys().copied().collect();
        for id in ids {
            let Some(t) = threads.get_mut(&id) else { continue };
            let mut cycles = 0;
            unsafe { QueryThreadCycleTime(t.handle, &mut cycles) };
            // Being suspended and resumed costs a waiting thread some cycles
            // itself, so only more than that counts as having run.
            let on_cpu = cycles.saturating_sub(t.cycles) > ON_CPU_CYCLES;
            t.cycles = cycles;
            // An idle background thread is just waiting; the main thread's
            // waits are what we're after, so it's always taken.
            if !on_cpu && id != main {
                continue;
            }
            let mut stack = [0u64; MAX_DEPTH];
            if let Some(depth) = sample(t, &mut copy, &mut stack) {
                let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0);
                for v in [at, id as u64, on_cpu as u64, depth as u64] {
                    let _ = out.write_all(&v.to_le_bytes());
                }
                for v in &stack[..depth] {
                    let _ = out.write_all(&v.to_le_bytes());
                }
            }
        }
        next += tick;
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else {
            next = now;
        }
    }
}

/// One stack, or None if the thread couldn't be read.
fn sample(t: &Thread, copy: &mut [u8], stack: &mut [u64; MAX_DEPTH]) -> Option<usize> {
    // SAFETY: CONTEXT is plain data; the kernel fills what ContextFlags asks for.
    let mut context: CONTEXT = unsafe { std::mem::zeroed() };
    context.ContextFlags = CONTEXT_CONTROL_AMD64 | CONTEXT_INTEGER_AMD64;
    if unsafe { SuspendThread(t.handle) } == u32::MAX {
        return None;
    }
    // Only registers and a memcpy between suspend and resume: no locks.
    let read = unsafe { GetThreadContext(t.handle, &mut context) } != 0;
    let sp = context.Rsp as usize;
    let len = if read && sp != 0 && sp < t.stack_base { (t.stack_base - sp).min(copy.len()) } else { 0 };
    if len > 0 {
        // SAFETY: from a suspended thread's stack pointer up to its stack's end.
        unsafe { std::ptr::copy_nonoverlapping(sp as *const u8, copy.as_mut_ptr(), len) };
    }
    unsafe { ResumeThread(t.handle) };
    (len > 0).then(|| unwind(context, sp, t.stack_base, &copy[..len], stack))
}

/// Walks the copied stack. Registers that point into the stack are moved to
/// point into the copy, so RtlVirtualUnwind reads that and not the live stack.
fn unwind(mut context: CONTEXT, sp: usize, base: usize, copy: &[u8], stack: &mut [u64; MAX_DEPTH]) -> usize {
    let (real, moved) = (sp as u64, copy.as_ptr() as u64);
    let shift = |v: u64| if v >= real && v < base as u64 { v - real + moved } else { v };
    let inside = |v: u64| v >= moved && v + 16 <= moved + copy.len() as u64;
    context.Rsp = moved;
    context.Rbp = shift(context.Rbp);
    let mut depth = 0;
    while depth < MAX_DEPTH {
        let pc = context.Rip;
        if pc == 0 {
            break;
        }
        stack[depth] = pc;
        depth += 1;
        let mut image = 0u64;
        let entry = unsafe { RtlLookupFunctionEntry(pc, &mut image, std::ptr::null_mut()) };
        if entry.is_null() {
            // A leaf, or JIT code with no unwind data: treat it as a leaf.
            if !inside(context.Rsp) {
                break;
            }
            // SAFETY: bounds checked just above; the copy has no alignment guarantee.
            context.Rip = unsafe { (context.Rsp as *const u64).read_unaligned() };
            context.Rsp += 8;
            continue;
        }
        let (mut data, mut frame) = (std::ptr::null_mut(), 0u64);
        unsafe { RtlVirtualUnwind(0, image, pc, entry, &mut context, &mut data, &mut frame, std::ptr::null_mut()) };
        context.Rbp = shift(context.Rbp);
        if !inside(context.Rsp) {
            break;
        }
    }
    depth
}

fn refresh(threads: &mut HashMap<u32, Thread>, me: u32) {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return;
    }
    let pid = unsafe { GetCurrentProcessId() };
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<THREADENTRY32>() as u32;
    let mut alive = Vec::new();
    let mut more = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while more {
        if entry.th32OwnerProcessID == pid && entry.th32ThreadID != me {
            alive.push(entry.th32ThreadID);
        }
        more = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    threads.retain(|id, t| {
        let keep = alive.contains(id);
        if !keep {
            unsafe { CloseHandle(t.handle) };
        }
        keep
    });
    for id in alive {
        if threads.contains_key(&id) {
            continue;
        }
        let handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION, 0, id) };
        if handle.is_null() {
            continue;
        }
        let Some(stack_base) = stack_base(handle) else {
            unsafe { CloseHandle(handle) };
            continue;
        };
        threads.insert(id, Thread { handle, stack_base, cycles: 0, name: name(handle) });
    }
}

fn stack_base(handle: HANDLE) -> Option<usize> {
    let mut info: ThreadBasicInformation = unsafe { std::mem::zeroed() };
    let status = unsafe { NtQueryInformationThread(handle, 0, (&raw mut info).cast(), size_of::<ThreadBasicInformation>() as u32, std::ptr::null_mut()) };
    if status != 0 || info.teb_base.is_null() {
        return None;
    }
    // SAFETY: the TEB starts with NT_TIB: exception list, then StackBase.
    Some(unsafe { *info.teb_base.add(1) })
}

fn name(handle: HANDLE) -> String {
    let mut text = std::ptr::null_mut();
    if unsafe { GetThreadDescription(handle, &mut text) } < 0 || text.is_null() {
        return String::new();
    }
    let len = (0..512).take_while(|i| unsafe { *text.add(*i) } != 0).count();
    let name = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
    unsafe { windows_sys::Win32::Foundation::LocalFree(text.cast()) };
    name
}

fn write_index(path: &std::path::Path, threads: &HashMap<u32, Thread>, main: u32) {
    let names: serde_json::Map<String, serde_json::Value> =
        threads.iter().map(|(id, t)| (id.to_string(), t.name.clone().into())).collect();
    let index = serde_json::json!({ "main": main, "threads": names, "modules": modules() });
    let mut file = path.as_os_str().to_owned();
    file.push(".json");
    let _ = crate::persist::write_atomic(std::path::Path::new(&file), index.to_string());
}

fn modules() -> Vec<serde_json::Value> {
    let process = unsafe { GetCurrentProcess() };
    let mut handles: Vec<HMODULE> = vec![std::ptr::null_mut(); 1024];
    let mut needed = 0;
    let bytes = (handles.len() * size_of::<HMODULE>()) as u32;
    if unsafe { K32EnumProcessModules(process, handles.as_mut_ptr(), bytes, &mut needed) } == 0 {
        return Vec::new();
    }
    handles.truncate((needed as usize / size_of::<HMODULE>()).min(handles.len()));
    handles
        .into_iter()
        .filter_map(|module| {
            let mut info: MODULEINFO = unsafe { std::mem::zeroed() };
            if unsafe { K32GetModuleInformation(process, module, &mut info, size_of::<MODULEINFO>() as u32) } == 0 {
                return None;
            }
            let mut name = [0u16; 1024];
            let len = unsafe { K32GetModuleFileNameExW(process, module, name.as_mut_ptr(), name.len() as u32) } as usize;
            Some(serde_json::json!({
                "base": info.lpBaseOfDll as usize,
                "size": info.SizeOfImage,
                "path": String::from_utf16_lossy(&name[..len]),
            }))
        })
        .collect()
}
