// Windows: a window app, no console of its own (see `attach_console`).
#![cfg_attr(windows, windows_subsystem = "windows")]

mod bench;
mod commands;
mod control;
mod core_bin;
mod files;
mod hc;
mod keys;
mod layout;
mod layout_sync;
mod links;
mod markdown_refs;
mod model;
mod mirror;
mod mirror_sync;
mod place;
mod persist;
#[cfg(target_os = "macos")]
mod macos;
mod mods;
mod mod_files;
mod process_cwd;
mod programs;
mod settings;
mod setup;
mod sound;
mod spawn;
mod sprites;
mod telemetry;
mod feedback;
mod terminal;
mod update;
mod update_notes;
mod vt;
mod win32_keys;
mod window;

use gpui::*;

const HELP: &str = "\
zaki: the Zaki desktop app. With no arguments it opens the window.

Usage:
  zaki                        open the window
  zaki ls                     spaces, their tabs and terminals, in the open window
  zaki do <command> [args]    run a command: --name api --argv '[\"pi\"]', or one JSON object
  zaki feedback <text>        draft feedback for the person to review and send
  zaki commands               every command, its arguments, what it does
  zaki status                 what the window shows, and any errors
  zaki shot [file.png]        save the last window frame (default: zaki-shot.png)
  zaki check <mod folder>     load a mod once and report what's wrong
  zaki --skill                Agent Skill: driving the window, and where hc fits
  zaki --version

The terminals run in herdr-core (`hc`), which keeps them alive when the
window closes. `hc --help`: start, read, wait on and talk to terminals and
agents. The app shows them and arranges them in spaces and tabs.

Home: ~/.config/zaki (HERDR_APP_HOME picks another).
";

/// A Windows window app has no console: answers to `zaki ls` and the
/// like go to the terminal it was started from. Output already piped (agents,
/// scripts) keeps its pipes.
#[cfg(windows)]
fn attach_console() {
    use windows_sys::Win32::System::Console::{ATTACH_PARENT_PROCESS, AttachConsole, GetStdHandle, STD_OUTPUT_HANDLE};
    // Attaching would point the output at the console instead of the pipe or file.
    let out = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    if out.is_null() || out == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    #[cfg(windows)]
    if args.len() > 1 {
        attach_console();
    }
    // `zaki check <mod>` / `zaki types <mod>`: gpui-shell's own checker, with Zaki's module installed.
    if matches!(args.get(1).map(String::as_str), Some("check" | "types")) {
        mods::install_policy();
        gpui_shell::host::main_with_components(gpui_shell::FrozenComponentRegistry::default());
        return;
    }
    if matches!(args.get(1).map(String::as_str), Some("do" | "status" | "ls" | "commands" | "feedback" | "shot")) {
        std::process::exit(control::client(&args[1..]));
    }
    // Anything else from a shell answers in the shell; only a bare launch opens the window.
    match args.get(1).map(String::as_str) {
        // Already open on this home: that window comes to the front.
        None if control::raise_running() => return,
        None => {}
        Some("-h" | "--help" | "help") => return print!("{HELP}"),
        Some("--skill") => return print!("{}", include_str!("SKILL.md")),
        Some("-V" | "--version" | "version") => return println!("zaki {}", env!("CARGO_PKG_VERSION")),
        Some(other) => {
            eprint!("zaki: unknown argument {other:?}\n\n{HELP}");
            std::process::exit(2);
        }
    }

    bench::init();
    #[cfg(target_os = "macos")]
    core_bin::fill_path();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("HERDR_APP_LOG")
                .unwrap_or_else(|_| "warn,zaki=info,gpui_shell=info".into()),
        )
        .init();

    if update::apply_on_startup() {
        return;
    }

    // The home's shipped files are written beside finding and connecting the
    // core and the platform's start, and waited for before anything reads them.
    let installs = start_installs(mods::app_dir());

    telemetry::clock();
    // A first start sizes the app to the screen and the system's text size.
    let fresh = !settings::path().exists();
    // The core people installed; without one, the setup screen installs it.
    let person = settings::load_person();
    let configured = person.as_ref().ok().and_then(|p| p.core.clone());
    let found = {
        let _span = bench::span("start:core_find");
        core_bin::find(configured.as_deref())
    };
    let core: Result<std::sync::Arc<hc::Core>, setup::Need> = match found {
        None => Err(setup::Need::Install),
        Some(bin) => {
            core_bin::use_core(bin);
            let _span = bench::span("start:core_connect");
            match hc::Core::connect() {
                // One that can't serve this app gets the screen that fixes it.
                Ok(core) => hc::check(&core.hello).map(|()| core).map_err(setup::Need::Fix),
                Err(e) => {
                    eprintln!("zaki: {e:#}");
                    Err(setup::Need::Install)
                }
            }
        }
    };
    #[cfg(target_os = "macos")]
    core_bin::install_cli_link();
    if core.is_ok() {
        update::after_update();
    }
    update::start();
    telemetry::start(settings::telemetry_setting(&person));
    bench::start();

    bench::mark("start:platform");
    gpui_platform::application()
        .with_assets(gpui_shell::AppAssets::new(mods::app_dir()))
        .run(move |cx| {
            bench::mark("start:app_running");
            {
                let _span = bench::span("start:installs_wait");
                for install in installs {
                    if let Err(e) = install() {
                        eprintln!("zaki: cannot write {}: {e}", mods::app_dir().display());
                    }
                }
            }
            {
                let _span = bench::span("start:fonts");
                let fonts = settings::BUNDLED_FONTS.iter().map(|f| std::borrow::Cow::Borrowed(*f)).collect();
                if let Err(e) = cx.text_system().add_fonts(fonts) {
                    tracing::warn!("bundled fonts not loaded: {e:#}");
                }
                settings::note_fonts(cx.text_system().all_font_names());
                settings::load_home_fonts(cx);
            }
            {
                let _span = bench::span("start:mods_init");
                mods::init(cx);
            }
            // Not restarted for it: the update goes in when the app quits.
            cx.on_app_quit(|cx| {
                let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
                // Where the window was, for the next start (a quit never asks the window).
                for w in cx.windows() {
                    if let Some(w) = w.downcast::<window::AppWindow>() {
                        let _ = w.update(cx, |this, window, cx| {
                            this.drain_documents(window, cx);
                            this.close_mods_now(deadline, window, cx);
                            place::save(window, cx);
                        });
                    }
                }
                mods::finish_shared();
                telemetry::quit();
                update::apply();
                async {}
            })
            .detach();
            #[cfg(target_os = "macos")]
            macos::init(cx);
            if fresh {
                let width = cx.primary_display().map(|d| f32::from(d.bounds().size.width));
                let zoom = settings::first_zoom(width);
                if zoom != 1.0 {
                    let _ = settings::write_person(&settings::Person { zoom, ..Default::default() });
                }
            }
            let requests = mods::install_policy();
            if let Some(tx) = mods::request_sender() {
                control::listen(tx);
            }
            match core {
                Ok(core) => open_main(core, requests, cx),
                Err(need) => setup::open(need, requests, cx),
            }
        });
}

/// Starts writing what ships into the home `home`, each part on its own
/// thread (on Windows creating a file is slow, and these are hundreds). Each
/// returned call waits for its part, or does it now if its thread didn't start.
fn start_installs(home: std::path::PathBuf) -> Vec<Box<dyn FnOnce() -> std::io::Result<()>>> {
    type Part = fn(&std::path::Path) -> std::io::Result<()>;
    let parts: [(&str, &'static str, Part); 2] = [
        ("workspace", "start:write_workspace", mods::write_workspace),
        ("themes-icons", "start:install_themes_icons", |home| {
            settings::install_themes(home);
            programs::install_icons(home);
            Ok(())
        }),
    ];
    parts.into_iter().map(|(name, span, part)| {
        let at = home.clone();
        let thread = std::thread::Builder::new().name(name.into()).spawn(move || {
            let _span = bench::span(span);
            part(&at)
        });
        let home = home.clone();
        Box::new(move || match thread {
            Ok(thread) => thread.join().unwrap_or_else(|_| Err(std::io::Error::other(format!("{name} stopped")))),
            Err(_) => part(&home),
        }) as Box<dyn FnOnce() -> std::io::Result<()>>
    }).collect()
}

/// The main window, on a connected core.
pub fn open_main(core: std::sync::Arc<hc::Core>, requests: async_channel::Receiver<mods::Request>, cx: &mut App) {
            let (window_bounds, display_id) = place::initial(cx);
            let options = WindowOptions {
                window_bounds: Some(window_bounds),
                display_id,
                // macOS: always see-through, so a layout can draw its own title bar
                // live; the app drags the window (window/titlebar.rs).
                titlebar: Some(TitlebarOptions {
                    title: Some("Zaki".into()),
                    // Windows: hidden for good (it can't change live); the app draws it.
                    appears_transparent: cfg!(any(target_os = "macos", windows)),
                    traffic_light_position: cfg!(target_os = "macos").then(|| point(px(12.0), px(7.0))),
                }),
                app_owns_titlebar_drag: cfg!(target_os = "macos"),
                // Zaki Dev and other side-by-side builds get their own dock icon.
                app_id: Some(std::env::var("HERDR_APP_ID").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "zaki".into())),
                ..Default::default()
            };
            let _span = bench::span("start:open_window");
            cx.open_window(options, |window, cx| cx.new(|cx| window::AppWindow::new(core, requests, window, cx)))
                .expect("cannot open the Zaki window");
            cx.activate(true);
}
