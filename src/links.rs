//! Links in terminal text: Ghostty's URL and file path pattern, what a match
//! points to, and handing it to the system to open.

use crate::windows_paths;
use fancy_regex::Regex;
use std::ffi::{OsStr, OsString};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;

/// The URL half of Ghostty's pattern. A URL reads the same on every system.
pub(crate) fn scheme_url() -> String {
    let schemes = r"https?://|mailto:|ftp://|file:|ssh:|git://|ssh://|tel:|magnet:|ipfs://|ipns://|gemini://|gopher://|news:";
    let ipv6 = r"(?:\[[:0-9a-fA-F]+(?:[:0-9a-fA-F]*)+\](?::[0-9]+)?)";
    let scheme_chars = r"[\w\-.~:/?#@!$&*+,;=%]";
    let bracketed = r"(?:[\(\[]\w*[\)\]])?";
    let no_trailing_punctuation = r"(?<![,.])";
    format!("(?:{schemes})(?:{ipv6}|{scheme_chars}+{bracketed})+{no_trailing_punctuation}")
}

/// Ghostty's default link pattern (`src/config/url.zig`), unchanged.
static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    let path_chars = r"[\w\-.~:\/?#@!$&*+;=%]";
    let no_trailing_colon = r"(?<!:)";
    let dotted = r"(?=[\w\-.~:\/?#@!$&*+;=%]*\.)";
    let undotted = r"(?![\w\-.~:\/?#@!$&*+;=%]*\.)";
    let dotted_spaces = r"(?:(?<!:) (?!\w+:\/\/)(?!\.{0,2}\/)(?!~\/)[\w\-.~:\/?#@!$&*+;=%]*[\/.])*";
    let any_spaces = r"(?:(?<!:) (?!\w+:\/\/)(?!\.{0,2}\/)(?!~\/)[\w\-.~:\/?#@!$&*+;=%]+)*";
    let rooted = r"(?:\.\.\/|\.\/|(?<!\w)~\/|(?:[\w][\w\-.]*\/)*(?<!\w)\$[A-Za-z_]\w*\/|\.[\w][\w\-.]*\/|(?<![\w~\/])\/(?!\/))";
    let rooted_path = format!(
        "{rooted}(?:{dotted}{path_chars}+{dotted_spaces}{no_trailing_colon}|{undotted}{path_chars}+{any_spaces}{no_trailing_colon})"
    );
    let bare_path = format!(r"{dotted}(?<!\$\d*)(?<!\w)[\w][\w\-.]*\/{path_chars}+{no_trailing_colon}");
    Regex::new(&format!("{}|{rooted_path}|{bare_path}", scheme_url())).expect("link pattern")
});

/// How a terminal's text writes paths. That goes by where the terminal runs, so
/// a Linux machine seen from Windows still says `/srv/app/x.md`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PathStyle {
    Posix,
    Windows,
}

impl PathStyle {
    pub fn of(remote: bool) -> Self {
        // Tools on Windows print `src\main.rs` and `C:\x\y.py`, which Ghostty's pattern never matches.
        if cfg!(windows) && !remote { Self::Windows } else { Self::Posix }
    }
}

/// The link in `text` that covers byte `at`.
pub fn find(style: PathStyle, text: &str, at: usize) -> Option<Range<usize>> {
    let pattern = match style {
        PathStyle::Posix => &PATTERN,
        PathStyle::Windows => &windows_paths::PATTERN,
    };
    for m in pattern.find_iter(text) {
        let m = m.ok()?;
        if m.start() > at {
            return None;
        }
        if at < m.end() {
            return Some(m.range());
        }
    }
    None
}

/// The address-shaped word under the pointer, excluding surrounding punctuation.
pub fn word(text: &str, at: usize) -> Option<Range<usize>> {
    let allowed = |c: char| c.is_alphanumeric() || matches!(c, '-' | '_' | '/' | '.');
    if !text.get(at..)?.chars().next().is_some_and(allowed) {
        return None;
    }
    let start = text[..at].char_indices().rev().find(|(_, c)| !allowed(*c)).map_or(0, |(i, c)| i + c.len_utf8());
    let end = text[at..].char_indices().find(|(_, c)| !allowed(*c)).map_or(text.len(), |(i, _)| at + i);
    let trimmed = text[start..end].trim_matches('.');
    let start = start + text[start..end].len() - text[start..end].trim_start_matches('.').len();
    let end = start + trimmed.len();
    (start <= at && at < end).then_some(start..end)
}

/// Bare addresses refer to the hovered terminal's machine, never its names.
pub fn terminal_address<'a>(word: &str, source: &str, live: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let address = if word.contains('/') {
        word.to_owned()
    } else {
        crate::mirror::qualify(word, source.split_once('/').map(|(machine, _)| machine))
    };
    live.into_iter().any(|a| a == address).then_some(address)
}

const MARKDOWN: [&str; 5] = ["md", "markdown", "mdown", "mkd", "mdx"];
const FILE_SCHEME: &str = "file:";

pub fn is_markdown(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| MARKDOWN.iter().any(|m| e.eq_ignore_ascii_case(m)))
}

/// Words in `text` that could be paths, without the punctuation around them.
fn path_words(style: PathStyle, text: &str) -> Vec<Range<usize>> {
    let windows = style == PathStyle::Windows;
    let allowed = |c: char| c.is_alphanumeric() || matches!(c, '-' | '_' | '/' | '.' | '~' | '$' | '+' | '@' | '%') || (windows && c == '\\');
    let mut words = Vec::new();
    let mut start = None;
    for (at, c) in text.char_indices().chain([(text.len(), ' ')]) {
        match (allowed(c), start) {
            (true, None) => start = Some(at),
            (false, Some(from)) => {
                start = None;
                let word = text[from..at].trim_end_matches('.');
                let name = word.trim_start_matches(['@', '+', '%']);
                let begin = from + word.len() - name.len();
                // `//` is what's left of a URL once its scheme ended the last word.
                // On Windows two slashes of either kind can also be a share.
                let url = if windows { windows_paths::names_share(name) } else { name.starts_with("//") };
                let file_link = url && text[..begin].ends_with(FILE_SCHEME);
                if !url || file_link {
                    let begin = if file_link { begin - FILE_SCHEME.len() } else { begin };
                    let begin = if windows { windows_paths::with_drive(text, begin) } else { begin };
                    words.push(begin..from + word.len());
                }
            }
            _ => {}
        }
    }
    words
}

/// Words in `text` naming a Markdown file. Agents write bare names (`README.md`,
/// `@docs/plan.md`) that Ghostty's pattern, which wants a slash, leaves out.
pub fn markdown_words(style: PathStyle, text: &str) -> Vec<Range<usize>> {
    let markdown = |word: &Range<usize>| is_markdown(Path::new(&text[word.clone()]));
    let mut words: Vec<_> = path_words(style, text).into_iter().filter(markdown).collect();
    if style == PathStyle::Windows && words.iter().any(|word| windows_paths::spaced_path_ends(text, word.start)) {
        // A folder with a space in it is an everyday thing there, and more than a word.
        let spaced = windows_paths::PATTERN.find_iter(text).flatten().filter(|m| m.as_str().contains(' '));
        words.extend(spaced.map(|m| m.start()..m.start() + without_place(m.as_str()).len()).filter(markdown));
    }
    words
}

/// The word at byte `at` if it can name a file with no help from a slash:
/// Markdown, and on Windows any `name.ext`. That costs the look at the disk
/// Markdown already gets, and only while the link key is held.
fn file_word(style: PathStyle, text: &str, at: usize) -> Option<Range<usize>> {
    let word = path_words(style, text).into_iter().find(|r| r.contains(&at))?;
    let name = Path::new(&text[word.clone()]);
    (is_markdown(name) || (style == PathStyle::Windows && name.extension().is_some())).then_some(word)
}

/// What a pointer at byte `at` of a terminal's text is on, and where that shows.
/// `remote` says the terminal is on another machine.
pub fn target_at(text: &str, at: usize, cwd: Option<&Path>, remote: bool) -> Option<(Range<usize>, Target)> {
    let style = PathStyle::of(remote);
    // On another machine `~` and variables aren't this one's.
    if let Some(range) = find(style, text, at)
        && !(remote && text[range.clone()].starts_with(['~', '$']))
        && let Some(link) = resolve(&text[range.clone()], cwd)
    {
        return Some((range, link));
    }
    let range = file_word(style, text, at)?;
    let word = &text[range.clone()];
    let link = if remote { remote_path(word, cwd).map(Target::File) } else { resolve(word, cwd) };
    Some((range, link?))
}

/// A path on another machine: its files can't be checked from here. Only that
/// machine knows its home, so `~/` stays as it is until someone clicks
/// ([`under_home`]); any other variable has no value to be had.
pub fn remote_path(word: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    if let Some(rest) = word.strip_prefix("$PWD/") {
        return Some(remote_join(cwd?, Path::new(rest)));
    }
    if under_home(Path::new(word)).is_some() || word.starts_with('/') {
        return Some(PathBuf::from(word));
    }
    if word.starts_with(['~', '$']) { None } else { Some(remote_join(cwd?, Path::new(word))) }
}

/// A path under a folder on another machine. Windows' `join` writes a backslash,
/// which to a Linux machine is part of a name.
pub fn remote_join(folder: &Path, rest: &Path) -> PathBuf {
    match folder.to_str() {
        Some(posix) if cfg!(windows) && posix.starts_with('/') && !rest.has_root() => PathBuf::from(format!("{}/{}", posix.trim_end_matches('/'), rest.display())),
        _ => folder.join(rest),
    }
}

/// What follows the home folder in a path that names it instead of saying where it is.
pub fn under_home(path: &Path) -> Option<&Path> {
    path.strip_prefix("~").or_else(|_| path.strip_prefix("$HOME")).ok()
}

/// The Markdown file a link points to, `file://` links (OSC 8) included.
/// `remote` says the link came from a terminal on another machine.
pub fn markdown_file(target: &Target, remote: bool) -> Option<PathBuf> {
    let path = match target {
        Target::File(path) => path.clone(),
        Target::Url(url) => file_url(url, remote)?,
    };
    is_markdown(&path).then_some(path)
}

fn file_url(url: &str, remote: bool) -> Option<PathBuf> {
    let (host, path) = gpui_shell::file_url(url)?;
    let path = PathBuf::from(path);
    // `ls --hyperlink` names the machine. Another machine's terminal means that
    // machine; here, a name we can't place counts only if the file is on this disk.
    (matches!(host, "" | "localhost") || remote || path.exists()).then_some(path)
}

/// Whether a name from a terminal's text is a Markdown file on this disk.
pub fn on_disk(word: &str, cwd: Option<&Path>) -> bool {
    resolve(word, cwd).and_then(|target| markdown_file(&target, false)).is_some_and(|path| path.exists())
}

#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    Url(String),
    File(PathBuf),
}

/// What a link opens. File paths count only when they exist here; relative
/// ones need the terminal's folder.
pub fn resolve(link: &str, cwd: Option<&Path>) -> Option<Target> {
    let scheme = link.split_once(':').is_some_and(|(s, _)| {
        s.len() > 1 && s.starts_with(|c: char| c.is_ascii_alphabetic()) && s.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    });
    if scheme {
        return Some(Target::Url(link.to_owned()));
    }
    // `~\x` and `$PWD\x` are read below by their `/`, which Windows takes as well.
    let link = if cfg!(windows) { link.replace('\\', "/") } else { link.to_owned() };
    let home = std::env::home_dir();
    let expanded = if let Some(rest) = link.strip_prefix("~/") {
        home?.join(rest)
    } else if let Some(var) = link.strip_prefix('$') {
        let (name, rest) = var.split_once('/').unwrap_or((var, ""));
        let base = match name {
            "PWD" => cwd?.to_path_buf(),
            "HOME" => home?,
            _ => PathBuf::from(std::env::var_os(name)?),
        };
        base.join(rest)
    } else {
        PathBuf::from(&link)
    };
    let full = if expanded.is_absolute() { expanded } else { cwd?.join(expanded) };
    // Windows ignores a trailing period when checking whether a path exists.
    if !(cfg!(windows) && full.extension().is_some_and(|ext| ext.is_empty())) && full.exists() {
        return Some(Target::File(windows_paths::native(full)));
    }
    let bare = without_place(full.to_str()?);
    Path::new(bare).exists().then(|| Target::File(windows_paths::native(PathBuf::from(bare))))
}

/// A path without the period ending a sentence, or the `:42` / `:42:7` naming a
/// place in the file.
fn without_place(path: &str) -> &str {
    let mut bare = path.strip_suffix('.').unwrap_or(path);
    for _ in 0..2 {
        match bare.rsplit_once(':') {
            Some((head, n)) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => bare = head,
            _ => break,
        }
    }
    bare
}

/// What `PATHEXT` holds when it isn't set: Windows' own list.
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL";
/// What Windows runs, installs or follows when opened, whatever `PATHEXT` says.
const RUNNABLE: [&str; 25] = [
    "exe", "bat", "cmd", "com", "ps1", "psm1", "msi", "msp", "reg", "lnk", "url", "scr", "hta", "cpl", "jar", "appref-ms", "vbs", "vbe", "js", "jse", "wsf",
    "wsh", "msc", "pif", "application",
];

/// Whether Windows, asked to open the file at `path`, would run it. `pathext` is
/// the `PATHEXT` variable.
fn runnable(path: &Path, pathext: Option<&str>) -> bool {
    let Some(ext) = extension(path) else { return false };
    let pathext = pathext.filter(|p| !p.trim().is_empty()).unwrap_or(DEFAULT_PATHEXT);
    let listed = pathext.split(';').map(|e| e.trim().trim_start_matches('.')).filter(|e| !e.is_empty());
    RUNNABLE.into_iter().chain(listed).any(|e| e.eq_ignore_ascii_case(&ext))
}

/// The extension Windows reads in a file's name, without its dot.
fn extension(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy();
    // `x.exe::$DATA` is x.exe itself, and Windows drops a name's trailing dots and spaces.
    let name = name.split(':').next().unwrap_or_default().trim_end_matches(['.', ' ']);
    name.rsplit_once('.').map(|(_, ext)| ext.to_owned()).filter(|ext| !ext.is_empty())
}

/// Whether a click shows the file at `path` in its folder rather than opening it.
/// `opens_with` names the program an extension opens with, for a script whose
/// default app runs it (`.py` with Python, not with an editor).
fn shown_in_folder(path: &Path, pathext: Option<&str>, opens_with: impl Fn(&str) -> Option<PathBuf>) -> bool {
    !path.is_dir() && (runnable(path, pathext) || extension(path).and_then(|ext| opens_with(&ext)).is_some_and(|program| interpreter(&program)))
}

/// Programs that run the file they open.
const INTERPRETERS: [&str; 20] = [
    "python", "pythonw", "py", "pyw", "node", "ruby", "rubyw", "perl", "php", "wscript", "cscript", "mshta", "powershell", "pwsh", "cmd", "java", "javaw", "bash",
    "sh", "wsl",
];

/// Whether `program` runs the files it opens. A version in its name
/// (`python3.12.exe`) doesn't change that.
fn interpreter(program: &Path) -> bool {
    let Some(stem) = program.file_stem().map(|s| s.to_string_lossy()) else { return false };
    let name = stem.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
    INTERPRETERS.iter().any(|i| i.eq_ignore_ascii_case(name))
}

/// The program Windows opens files with this extension (no dot) with, from
/// its file associations. Asks the registry, so it waits for a click.
#[cfg(windows)]
fn opens_with(ext: &str) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::UI::Shell::{ASSOCF_NONE, ASSOCSTR_EXECUTABLE, AssocQueryStringW};
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let (assoc, verb) = (wide(&format!(".{ext}")), wide("open"));
    let mut out = vec![0u16; 4096];
    let mut len = out.len() as u32;
    let found = unsafe { AssocQueryStringW(ASSOCF_NONE, ASSOCSTR_EXECUTABLE, assoc.as_ptr(), verb.as_ptr(), out.as_mut_ptr(), &mut len) };
    let end = out.iter().position(|&c| c == 0)?;
    (found == 0 && end > 0).then(|| PathBuf::from(OsString::from_wide(&out[..end])))
}

#[cfg(not(windows))]
fn opens_with(_ext: &str) -> Option<PathBuf> {
    None
}

/// The file a `file:` URL names on this machine.
fn local_file(url: &str) -> Option<PathBuf> {
    let (host, path) = gpui_shell::file_url(url)?;
    matches!(host, "" | "localhost").then(|| windows_paths::native(PathBuf::from(path)))
}

/// explorer.exe's command line for showing `path` selected in its folder.
/// Explorer reads `/select,` itself rather than the way programs usually split
/// their arguments, so the path is one quoted run after the comma, which keeps
/// its spaces, commas and parentheses. No Windows name holds a `"`.
fn explorer_select(path: &Path) -> Option<OsString> {
    if path.as_os_str().to_string_lossy().contains('"') {
        return None;
    }
    let mut select = OsString::from("/select,\"");
    select.push(path.as_os_str());
    select.push("\"");
    Some(select)
}

/// The command that opens `target`. `reveal` says a file should be shown in its
/// folder rather than opened.
fn command(target: &Target, reveal: impl Fn(&Path) -> bool) -> Option<Command> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer.exe"
    } else {
        "xdg-open"
    };
    let mut command = Command::new(opener);
    let file = match target {
        Target::File(path) => Some(path.clone()),
        Target::Url(url) => local_file(url),
    };
    match file {
        // Explorer does a file's default action, which for a program or script is to run it,
        // and the path is whatever a program in the terminal printed. Open and xdg-open don't
        // run what they're handed.
        Some(path) if cfg!(windows) && reveal(&path) => as_written(&mut command, &explorer_select(&path)?),
        _ => command.arg(match target {
            Target::Url(url) => OsStr::new(url),
            Target::File(path) => path.as_os_str(),
        }),
    };
    Some(command)
}

/// Puts `arg` on the command line exactly as written, for a program that reads
/// its own (only Windows lets one).
fn as_written<'a>(command: &'a mut Command, arg: &OsStr) -> &'a mut Command {
    #[cfg(windows)]
    return std::os::windows::process::CommandExt::raw_arg(command, arg);
    #[cfg(not(windows))]
    command.arg(arg)
}

/// Hands the target to the system (xdg-open, open on macOS, explorer on Windows).
/// On Windows a file that would run, by path or `file:` link, is shown selected
/// in its folder instead.
pub fn open(target: &Target) {
    let pathext = std::env::var("PATHEXT").ok();
    let Some(mut command) = command(target, |path| shown_in_folder(path, pathext.as_deref(), opens_with)) else {
        return tracing::warn!("not opening {target:?}: explorer can't be asked to show it");
    };
    let opener = command.get_program().to_string_lossy().into_owned();
    let spawned = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match spawned {
        // Reaped off the UI thread so it never lingers as a zombie.
        Ok(mut child) => drop(std::thread::spawn(move || child.wait())),
        Err(e) => tracing::warn!("cannot run {opener}: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first(text: &str) -> Option<&str> {
        PATTERN.find(text).unwrap().map(|m| m.as_str())
    }

    fn first_on_windows(text: &str) -> Option<&str> {
        windows_paths::PATTERN.find(text).unwrap().map(|m| m.as_str())
    }

    /// Ghostty's own cases (`src/config/url.zig`). Windows' pattern keeps them.
    #[test]
    fn matches_like_ghostty() {
        let cases = [
            ("hello https://example.com world", "https://example.com"),
            ("https://example.com/foo(bar) more", "https://example.com/foo(bar)"),
            ("https://example.com/foo(bar)baz more", "https://example.com/foo(bar)baz"),
            ("Link inside (https://example.com) parens", "https://example.com"),
            ("Link period https://example.com. More text.", "https://example.com"),
            ("Link trailing comma https://example.com, more text.", "https://example.com"),
            ("Link in double quotes \"https://example.com\" and more", "https://example.com"),
            ("Link in single quotes 'https://example.com' and more", "https://example.com"),
            ("some file with https://google.com https://duckduckgo.com links.", "https://google.com"),
            ("and links in it. links https://yahoo.com mailto:test@example.com ssh://1.2.3.4", "https://yahoo.com"),
            ("also match http://example.com non-secure links", "http://example.com"),
            ("match tel://+12123456789 phone numbers", "tel://+12123456789"),
            ("match with query url https://example.com?query=1&other=2 and more text.", "https://example.com?query=1&other=2"),
            (
                "url with dashes [mode 2027](https://github.com/contour-terminal/terminal-unicode-core) for better unicode support",
                "https://github.com/contour-terminal/terminal-unicode-core",
            ),
            ("dot.http://example.com", "http://example.com"),
            ("weird characters https://example.com/~user/?query=1&other=2#hash and more", "https://example.com/~user/?query=1&other=2#hash"),
            ("square brackets https://example.com/[foo] and more", "https://example.com/[foo]"),
            (
                "[13]:TooManyStatements: TempFile#assign_temp_file_to_entity has approx 7 statements [https://example.com/docs/Too-Many-Statements.md]",
                "https://example.com/docs/Too-Many-Statements.md",
            ),
            ("match ftp://example.com ftp links", "ftp://example.com"),
            ("match file://example.com file links", "file://example.com"),
            ("match ssh://example.com ssh links", "ssh://example.com"),
            ("match git://example.com git links", "git://example.com"),
            ("/tmp/test.txt http://www.google.com", "/tmp/test.txt"),
            ("match tel:+18005551234 tel links", "tel:+18005551234"),
            ("match magnet:?xt=urn:btih:1234567890 magnet links", "magnet:?xt=urn:btih:1234567890"),
            ("match ipfs://QmSomeHashValue ipfs links", "ipfs://QmSomeHashValue"),
            ("match ipns://QmSomeHashValue ipns links", "ipns://QmSomeHashValue"),
            ("match gemini://example.com gemini links", "gemini://example.com"),
            ("match gopher://example.com gopher links", "gopher://example.com"),
            ("match news:comp.infosystems.www.servers.unix news links", "news:comp.infosystems.www.servers.unix"),
            ("/Users/ghostty.user/code/example.py", "/Users/ghostty.user/code/example.py"),
            ("/Users/ghostty.user/code/../example.py", "/Users/ghostty.user/code/../example.py"),
            ("/Users/ghostty.user/code/../example.py hello world", "/Users/ghostty.user/code/../example.py"),
            ("../example.py", "../example.py"),
            ("../example.py ", "../example.py"),
            ("first time ../example.py contributor ", "../example.py"),
            ("[link](/home/user/ghostty.user/example)", "/home/user/ghostty.user/example"),
            ("Serving HTTP on :: port 8000 (http://[::]:8000/)", "http://[::]:8000/"),
            ("IPv6 address https://[2001:db8::1]:8080/path", "https://[2001:db8::1]:8080/path"),
            ("IPv6 localhost http://[::1]:3000", "http://[::1]:3000"),
            ("Complex IPv6 https://[2001:db8:85a3:8d3:1319:8a2e:370:7348]:443/", "https://[2001:db8:85a3:8d3:1319:8a2e:370:7348]:443/"),
            ("IPv6 with path https://[2001:db8::1]/path/to/resource", "https://[2001:db8::1]/path/to/resource"),
            ("IPv6 with query https://[2001:db8::1]:8080/api?param=value&other=123", "https://[2001:db8::1]:8080/api?param=value&other=123"),
            ("IPv6 compressed http://[2001:db8::]:80/", "http://[2001:db8::]:80/"),
            ("IPv6 multiple zeros http://[2001:0:0:0:0:0:0:1]", "http://[2001:0:0:0:0:0:0:1]"),
            ("IPv6 link-local https://[fe80::1234:5678:9abc]", "https://[fe80::1234:5678:9abc]"),
            ("IPv6 multicast http://[ff02::1]/stream", "http://[ff02::1]/stream"),
            ("IPv6 in markdown [link](http://[2001:db8::1]/docs)", "http://[2001:db8::1]/docs"),
            ("./spaces-end.   ", "./spaces-end."),
            ("./space middle", "./space middle"),
            ("../test folder/file.txt", "../test folder/file.txt"),
            ("/tmp/test folder/file.txt", "/tmp/test folder/file.txt"),
            ("/tmp/test  folder/file.txt", "/tmp/test"),
            ("diff --git a/src/font/shaper/harfbuzz.zig b/src/font/shaper/harfbuzz.zig", "a/src/font/shaper/harfbuzz.zig"),
            ("/tmp/foo /tmp/bar", "/tmp/foo"),
            ("/tmp/foo.txt /tmp/bar.txt", "/tmp/foo.txt"),
            ("src/config/url.zig", "src/config/url.zig"),
            ("app/folder/file.rb:1", "app/folder/file.rb:1"),
            ("modified:   src/config/url.zig", "src/config/url.zig"),
            ("lib/ghostty/terminal.zig:42:10", "lib/ghostty/terminal.zig:42:10"),
            ("some-pkg/src/file.txt more text", "some-pkg/src/file.txt"),
            ("src/foo.c,baz.txt", "src/foo.c"),
            ("~/foo/bar.txt", "~/foo/bar.txt"),
            ("open ~/Documents/notes.md please", "~/Documents/notes.md"),
            ("~/.config/ghostty/config", "~/.config/ghostty/config"),
            ("directory: ~/src/ghostty-org/ghostty", "~/src/ghostty-org/ghostty"),
            ("$HOME/src/config/url.zig", "$HOME/src/config/url.zig"),
            ("space dir: $PWD/src/ghostty/main.zig", "$PWD/src/ghostty/main.zig"),
            ("foo/$BAR/baz", "foo/$BAR/baz"),
            (".foo/bar/$VAR", ".foo/bar/$VAR"),
            (".config/ghostty/config", ".config/ghostty/config"),
            ("loaded from .local/share/ghostty/state.db now", ".local/share/ghostty/state.db"),
            ("../some/where", "../some/where"),
            ("  - shared/src/foo/SomeItem.m:12, shared/src/", "shared/src/foo/SomeItem.m:12"),
            ("foo.local/share", "foo.local/share"),
            ("2024/report.txt", "2024/report.txt"),
            ("./foo bar,baz", "./foo bar"),
            ("/tmp/foo bar,baz", "/tmp/foo bar"),
            ("./.config/ghostty: Needs upstream (main)", "./.config/ghostty"),
            ("./Downloads: Operation not permitted", "./Downloads"),
        ];
        for (input, expect) in cases {
            assert_eq!(first(input), Some(expect), "{input:?}");
            assert_eq!(first_on_windows(input), Some(expect), "on Windows: {input:?}");
        }
        for input in ["input/output", "foo/bar", "$10/bar", "$10/$20", "$10/bar.txt", "foo/bar,baz.txt", "foo$BAR/baz.txt", "foo~/bar.txt", "// foo bar", "//foo"] {
            assert_eq!(first(input), None, "{input:?}");
            assert_eq!(first_on_windows(input), None, "on Windows: {input:?}");
        }
    }

    #[test]
    fn windows_paths_match_whole() {
        for (input, expect) in [
            (r"python\tools\x.py", r"python\tools\x.py"),
            (r"Update(python\tools\tests\real_client_check.py)", r"python\tools\tests\real_client_check.py"),
            (r"docs\plan.md", r"docs\plan.md"),
            (r"@docs\plan.md", r"docs\plan.md"),
            (r"src\mixed/seps.rs", r"src\mixed/seps.rs"),
            (r"C:\a\b.py", r"C:\a\b.py"),
            ("C:/a/b.py", "C:/a/b.py"),
            (r"D:\a\b.md", r"D:\a\b.md"),
            (r"open d:\a\b.md now", r"d:\a\b.md"),
            (r".\x.py", r".\x.py"),
            (r"..\x.py", r"..\x.py"),
            (r"..\..\deep\x.py", r"..\..\deep\x.py"),
            (r"~\docs\x.py", r"~\docs\x.py"),
            (r"$PWD\src\x.py", r"$PWD\src\x.py"),
            (r"src\x.py:42", r"src\x.py:42"),
            (r"src\x.py:42:7", r"src\x.py:42:7"),
            (r"C:\a\b.py:42", r"C:\a\b.py:42"),
            (r"C:\a\b.py:42:7", r"C:\a\b.py:42:7"),
            (r"C:\a\b.py: error", r"C:\a\b.py"),
            (r"see src\x.py, then", r"src\x.py"),
            (r"src\x.py.", r"src\x.py."),
            (r"**src\x.py**", r"src\x.py"),
            (r"did you read C:\a\b.py?", r"C:\a\b.py"),
            (r"'src\x.py'", r"src\x.py"),
            ("\"C:\\a\\b.py\"", r"C:\a\b.py"),
            (r"`src\x.py`", r"src\x.py"),
            (r"(C:\a\b.py)", r"C:\a\b.py"),
            (r"[C:\a\b.py]", r"C:\a\b.py"),
            (r"C:\a.py D:\b.py", r"C:\a.py"),
            (r"modified:   src\config\url.zig", r"src\config\url.zig"),
            (r"PS C:\Users\me> ls", r"C:\Users\me"),
        ] {
            assert_eq!(first_on_windows(input), Some(expect), "{input:?}");
        }
    }

    #[test]
    fn windows_paths_with_spaces_end_at_their_file() {
        for (input, expect) in [
            (r"C:\a b\c.py", r"C:\a b\c.py"),
            (r"wrote C:\a b\c.py and more text", r"C:\a b\c.py"),
            (r"C:\a b\c.py:42:7 and more", r"C:\a b\c.py:42:7"),
            (r"C:\a b\c.py.", r"C:\a b\c.py"),
            (r"C:\a b\c.py: error", r"C:\a b\c.py"),
            (r"Update(C:\a b\c.py)", r"C:\a b\c.py"),
            (r"`C:\a b\c.py`", r"C:\a b\c.py"),
            (r"C:\Users\Kavex\Digital Twin Research\Neuvix\prototype\x.py then", r"C:\Users\Kavex\Digital Twin Research\Neuvix\prototype\x.py"),
            (r"C:\Program Files (x86)\Tool\x.py", r"C:\Program Files (x86)\Tool\x.py"),
            (r"Update(C:\Program Files (x86)\Tool\x.py)", r"C:\Program Files (x86)\Tool\x.py"),
            (r".\my docs\x.py and more", r".\my docs\x.py"),
            (r"..\my docs\x.py", r"..\my docs\x.py"),
            (r"C:\my.app\Program Files\x.py more", r"C:\my.app\Program Files\x.py"),
            (r"C:\a b\c.py D:\d e\f.py", r"C:\a b\c.py"),
            (r"C:\a b\c.py https://a.com", r"C:\a b\c.py"),
        ] {
            assert_eq!(first_on_windows(input), Some(expect), "{input:?}");
        }
    }

    #[test]
    fn windows_links_end_where_the_path_does() {
        use PathStyle::Windows;
        let text = r"Update(python\tools\x.py) and C:\a.py";
        let path = text.find("python").unwrap();
        assert_eq!(find(Windows, text, path - 1), None, "the opening paren");
        assert_eq!(find(Windows, text, path).map(|r| &text[r]), Some(r"python\tools\x.py"));
        assert_eq!(find(Windows, text, text.find(')').unwrap()), None, "the closing paren");
        assert_eq!(find(Windows, text, text.find("C:").unwrap()).map(|r| &text[r]), Some(r"C:\a.py"), "from its drive");
    }

    #[test]
    fn a_url_stays_a_url_on_windows() {
        use PathStyle::Windows;
        let text = "https://a.com/x/y.py and file:///C:/a/b.md";
        assert_eq!(find(Windows, text, 2).map(|r| &text[r]), Some("https://a.com/x/y.py"));
        assert_eq!(find(Windows, text, text.len() - 3).map(|r| &text[r]), Some("file:///C:/a/b.md"));
    }

    #[test]
    fn only_a_windows_terminal_reads_windows_paths() {
        assert_eq!(PathStyle::of(true), PathStyle::Posix, "a terminal on another machine");
        #[cfg(not(windows))]
        assert_eq!(PathStyle::of(false), PathStyle::Posix);
        #[cfg(windows)]
        assert_eq!(PathStyle::of(false), PathStyle::Windows);
    }

    #[test]
    fn posix_text_is_read_as_it_always_was() {
        use PathStyle::Posix;
        let text = r"docs\plan.md C:\a\b.py";
        assert_eq!(find(Posix, text, 2), None);
        assert_eq!(find(Posix, text, text.find('C').unwrap()), None);
        let words = markdown_words(Posix, text).into_iter().map(|r| &text[r]).collect::<Vec<_>>();
        assert_eq!(words, ["plan.md"]);
        assert_eq!(file_word(Posix, "open main.rs now", 7), None, "only Markdown goes without a slash");
    }

    #[test]
    fn a_bare_name_needs_an_extension_on_windows() {
        use PathStyle::Windows;
        let word = |text: &'static str, at| file_word(Windows, text, at).map(|r| &text[r]);
        assert_eq!(word("open main.rs now", 7), Some("main.rs"));
        assert_eq!(word("(main.rs)", 3), Some("main.rs"));
        assert_eq!(word("main.rs:42", 2), Some("main.rs"));
        assert_eq!(word("real_check.test.ts", 2), Some("real_check.test.ts"));
        assert_eq!(word("open Makefile now", 7), None);
        assert_eq!(word("sentence ends. here", 3), None);
    }

    #[test]
    fn finds_the_link_under_the_pointer() {
        let text = "see https://a.com and /tmp/x.txt.";
        let find = |at| find(PathStyle::Posix, text, at);
        assert_eq!(find(0), None);
        assert_eq!(find(4).map(|r| &text[r]), Some("https://a.com"));
        assert_eq!(find(16).map(|r| &text[r]), Some("https://a.com"));
        assert_eq!(find(17), None);
        assert_eq!(find(25).map(|r| &text[r]), Some("/tmp/x.txt."));
    }

    #[test]
    fn extracts_address_words_at_the_pointer() {
        for (text, expected) in [
            ("<t1hg>", "t1hg"),
            ("[\"macbook/t2w\"]", "macbook/t2w"),
            ("terminal=t1hg,", "t1hg"),
            ("'my-machine_2/t2w'.", "my-machine_2/t2w"),
            ("before t1hg after", "t1hg"),
            ("é t1hg", "t1hg"),
            ("<build.box/t1>.", "build.box/t1"),
            ("1.2.3.4/t1", "1.2.3.4/t1"),
            ("...t1hg.", "t1hg"),
        ] {
            let at = text.find(expected).unwrap();
            for (i, _) in expected.char_indices() {
                assert_eq!(word(text, at + i).map(|r| &text[r]), Some(expected), "{text}");
            }
        }
        for (text, at) in [("<t1>", 0), ("t1 ", 2), ("", 0), ("t1", 2), ("é", 1)] {
            assert_eq!(word(text, at), None);
        }
    }

    #[test]
    fn matches_only_live_addresses_relative_to_the_source_machine() {
        let live = ["t1", "t2", "macbook/t1", "macbook/t2w", "my-machine_2/t3", "build.box/t1", "box/t1"];
        for (word, source, expected) in [
            ("t1", "t2", Some("t1")),
            ("t1", "macbook/t2w", Some("macbook/t1")),
            ("t1", "build.box/t2", Some("build.box/t1")),
            ("t2", "macbook/t1", None),
            ("macbook/t2w", "t1", Some("macbook/t2w")),
            ("my-machine_2/t3", "macbook/t1", Some("my-machine_2/t3")),
            ("t99", "t1", None),
            ("Build", "t1", None),
            ("t", "t1", None),
            ("other/t1", "t1", None),
            ("macbook/t1/extra", "t1", None),
        ] {
            assert_eq!(terminal_address(word, source, live), expected.map(str::to_owned), "{word} in {source}");
        }
    }

    #[test]
    fn dotted_machines_never_match_a_different_suffix_machine() {
        let text = "<build.box/t1>.";
        let range = word(text, text.find("t1").unwrap()).unwrap();
        assert_eq!(&text[range.clone()], "build.box/t1");
        assert_eq!(terminal_address(&text[range.clone()], "t2", ["box/t1"]), None);
        assert_eq!(terminal_address(&text[range], "t2", ["box/t1", "build.box/t1"]), Some("build.box/t1".into()));
    }

    #[test]
    fn finds_markdown_names_with_and_without_a_slash() {
        for style in [PathStyle::Posix, PathStyle::Windows] {
            let words = |text: &'static str| markdown_words(style, text).into_iter().map(|r| &text[r]).collect::<Vec<_>>();
            assert_eq!(words("see README.md, then docs/plan.MD."), ["README.md", "docs/plan.MD"]);
            assert_eq!(words("read @docs/plan.md and (notes.markdown)"), ["docs/plan.md", "notes.markdown"]);
            assert_eq!(words("./a.mdx ../b.mdown ~/c.mkd /d/e.md"), ["./a.mdx", "../b.mdown", "~/c.mkd", "/d/e.md"]);
            assert_eq!(words("src/main.rs README.mdk .md md"), Vec::<&str>::new());
            assert_eq!(words("https://example.com/a.md"), Vec::<&str>::new());
            assert_eq!(words("see file:///x/y.md and file://localhost/z.md."), ["file:///x/y.md", "file://localhost/z.md"]);
            assert_eq!(words("a.md:12 b.md:3:4"), ["a.md", "b.md"]);
            assert_eq!(words("文档/说明.md"), ["文档/说明.md"]);
        }
    }

    #[test]
    fn finds_markdown_names_written_the_windows_way() {
        let words = |text: &'static str| markdown_words(PathStyle::Windows, text).into_iter().map(|r| &text[r]).collect::<Vec<_>>();
        assert_eq!(words(r"see docs\plan.md, then @docs\notes.MD."), [r"docs\plan.md", r"docs\notes.MD"]);
        assert_eq!(words(r".\a.md ..\b.md"), [r".\a.md", r"..\b.md"]);
        assert_eq!(words(r"(C:\a\b.md) D:/c/d.md"), [r"C:\a\b.md", "D:/c/d.md"]);
        assert_eq!(words(r"C:\a\b.md:12:3"), [r"C:\a\b.md"]);
        assert_eq!(words(r"src\main.rs C:\a\b.py"), Vec::<&str>::new());
        assert_eq!(words(r"at C:\a b\c.md:12 now"), [r"b\c.md", r"C:\a b\c.md"], "the words, then the path holding them");
        assert_eq!(words(r"C:\docs\my plan.md"), ["plan.md", r"C:\docs\my plan.md"]);
        assert_eq!(words(r"C:\Program Files (x86)\a.md"), [r"\a.md", r"C:\Program Files (x86)\a.md"]);
        assert_eq!(words(r".\my docs\a.md"), [r"docs\a.md", r".\my docs\a.md"]);
    }

    #[test]
    fn a_windows_share_is_never_looked_up() {
        // Asking the disk about `\\host\x` reaches that host and offers it this person's login,
        // and the underline asks about whatever a program prints, with no click.
        for text in [r"\\host\share\x.md", "//host/share/x.md", r"\/host\share\x.md", r"/\host\share\x.md"] {
            assert!(markdown_words(PathStyle::Windows, text).is_empty(), "{text}");
            assert_eq!(file_word(PathStyle::Windows, text, 8), None, "{text}");
            assert!(!first_on_windows(text).is_some_and(|m| m.starts_with(['\\', '/'])), "{text}");
        }
    }

    #[test]
    fn the_files_panel_reads_the_same_extensions() {
        let panel = include_str!("../defaults/mods/files/markdown.js");
        assert!(panel.contains(&format!("\\.({})$", MARKDOWN.join("|"))));
    }

    #[test]
    fn the_word_under_the_pointer() {
        let text = "open README.md now";
        let word = |at| file_word(PathStyle::Posix, text, at);
        assert_eq!(word(5).map(|r| &text[r]), Some("README.md"));
        assert_eq!(word(13).map(|r| &text[r]), Some("README.md"));
        assert_eq!(word(14), None);
        assert_eq!(word(0), None);
    }

    #[test]
    fn a_linux_machine_seen_from_here_keeps_its_paths() {
        let cwd = Path::new("/srv/app");
        let posix = |target: Option<(Range<usize>, Target)>| match target {
            Some((_, Target::File(path))) => path.to_str().map(str::to_owned),
            _ => None,
        };
        assert_eq!(posix(target_at("see /srv/app/x.md now", 6, Some(cwd), true)), Some("/srv/app/x.md".into()));
        assert_eq!(posix(target_at("see docs/a.md now", 6, Some(cwd), true)), Some("/srv/app/docs/a.md".into()));
        assert_eq!(posix(target_at("see README.md now", 6, Some(cwd), true)), Some("/srv/app/README.md".into()));
        assert_eq!(posix(target_at("~/a.md", 3, Some(cwd), true)), Some("~/a.md".into()));
        assert_eq!(posix(target_at("see main.rs now", 6, Some(cwd), true)), None, "only Markdown, with no slash");
        assert_eq!(remote_join(Path::new("/home/me/"), Path::new("docs/a.md")).to_str(), Some("/home/me/docs/a.md"));
    }

    #[test]
    fn markdown_targets_include_file_links() {
        let (md, path) = if cfg!(windows) { (PathBuf::from("C:/a b/c.md"), "/C:/a%20b/c.md") } else { (PathBuf::from("/a b/c.md"), "/a%20b/c.md") };
        assert_eq!(markdown_file(&Target::File(md.clone()), false), Some(md.clone()));
        assert_eq!(markdown_file(&Target::Url(format!("file://{path}")), false), Some(md.clone()));
        assert_eq!(markdown_file(&Target::Url(format!("file://localhost{path}#top")), false), Some(md));
        assert_eq!(markdown_file(&Target::File("/a/b.rs".into()), false), None);
        assert_eq!(markdown_file(&Target::Url("https://a.com/c.md".into()), false), None);
        assert_eq!(markdown_file(&Target::Url("file://other-host/c.md".into()), false), None);
        assert!(markdown_file(&Target::Url("file://vps/c.md".into()), true).is_some(), "its terminal is on that machine");
    }

    #[cfg(not(windows))]
    #[test]
    fn a_file_link_naming_this_machine_counts_when_the_file_is_here() {
        let dir = std::env::temp_dir().join(format!("kavex-host-links-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let md = dir.join("c.md");
        std::fs::write(&md, "").unwrap();
        let url = format!("file://this-mac/{}", md.display().to_string().trim_start_matches('/'));
        assert_eq!(markdown_file(&Target::Url(url.clone()), false), Some(md.clone()), "ls --hyperlink names the machine");
        assert!(on_disk(&format!("file://{}", md.display()), None));
        std::fs::remove_file(&md).unwrap();
        assert_eq!(markdown_file(&Target::Url(url), false), None);
        assert!(!on_disk(&format!("file://{}", md.display()), None));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn remote_paths_stay_as_written_there() {
        let cwd = Path::new("/srv/app");
        assert_eq!(remote_path("docs/a.md", Some(cwd)), Some(cwd.join("docs/a.md")));
        assert_eq!(remote_path("/etc/a.md", None), Some(PathBuf::from("/etc/a.md")));
        assert_eq!(remote_path("a.md", None), None);
        assert_eq!(remote_path("$PWD/a.md", Some(cwd)), Some(cwd.join("a.md")));
        assert_eq!(remote_path("~/a.md", None), Some(PathBuf::from("~/a.md")));
        assert_eq!(remote_path("$HOME/a.md", None), Some(PathBuf::from("$HOME/a.md")));
        assert_eq!(remote_path("~other/a.md", Some(cwd)), None);
        assert_eq!(remote_path("$NOTES/a.md", Some(cwd)), None);
    }

    #[test]
    fn a_path_can_name_its_home() {
        assert_eq!(under_home(Path::new("~/docs/a.md")), Some(Path::new("docs/a.md")));
        assert_eq!(under_home(Path::new("$HOME/a.md")), Some(Path::new("a.md")));
        assert_eq!(under_home(Path::new("/home/me/a.md")), None);
        assert_eq!(under_home(Path::new("~other/a.md")), None);
    }

    #[test]
    fn files_resolve_only_when_they_exist() {
        let dir = std::env::temp_dir().join(format!("herdr-links-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "").unwrap();
        let file = Target::File(dir.join("src/main.rs"));
        assert_eq!(resolve("src/main.rs", Some(&dir)), Some(file.clone()));
        assert_eq!(resolve("src/main.rs:42:7", Some(&dir)), Some(file.clone()));
        assert_eq!(resolve("src/main.rs.", Some(&dir)), Some(file.clone()));
        assert_eq!(resolve("src/.", Some(&dir)), Some(Target::File(dir.join("src/."))));
        assert_eq!(resolve("src/..", Some(&dir)), Some(Target::File(dir.join("src/.."))));
        assert_eq!(resolve("$PWD/src/main.rs", Some(&dir)), Some(file.clone()));
        assert_eq!(resolve(dir.join("src/main.rs").to_str().unwrap(), None), Some(file));
        assert_eq!(resolve("src/gone.rs", Some(&dir)), None);
        assert_eq!(resolve("src/main.rs", None), None);
        assert_eq!(resolve("https://a.com/x", None), Some(Target::Url("https://a.com/x".into())));
        #[cfg(unix)]
        {
            let dotted = dir.join("src/main.rs.");
            std::fs::write(&dotted, "").unwrap();
            assert_eq!(resolve("src/main.rs.", Some(&dir)), Some(Target::File(dotted)));
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A folder for a test, with these files in it. Gone when dropped, so a failing
    /// assertion leaves nothing behind.
    #[cfg(windows)]
    struct Files(PathBuf);

    #[cfg(windows)]
    impl Files {
        fn new(name: &str, files: &[&str]) -> Self {
            let root = std::env::temp_dir().join(format!("kavex-links-{name}-{}", std::process::id()));
            for file in files {
                let path = root.join("repo").join(file);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, "").unwrap();
            }
            Self(root)
        }

        fn repo(&self) -> PathBuf {
            self.0.join("repo")
        }
    }

    #[cfg(windows)]
    impl Drop for Files {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Every way a click has to reach a file on Windows, each with what tools put
    /// around it. Markdown goes to the reader; the rest goes to `open`, which hands
    /// explorer.exe this path, so it must never have a forward slash in it.
    #[cfg(windows)]
    #[test]
    fn ctrl_click_opens_what_windows_tools_print() {
        let files = Files::new("click", &[
            r"python\tools\x.py", r"src\main.rs", r"docs\plan.md", "README.md", "here.py", r"with space\in it\y.py", r"with space\in it\z.md", r"..\up.py",
        ]);
        let repo = files.repo();
        let (back, forward) = (repo.display().to_string(), repo.display().to_string().replace('\\', "/"));
        let mut paths: Vec<(String, PathBuf)> = [
            (r"python\tools\x.py", r"python\tools\x.py"),
            ("python/tools/x.py", r"python\tools\x.py"),
            ("src/main.rs", r"src\main.rs"),
            (r".\here.py", "here.py"),
            ("./here.py", "here.py"),
            (r"..\up.py", r"..\up.py"),
            ("README.md", "README.md"),
            (r"docs\plan.md", r"docs\plan.md"),
        ]
        .into_iter()
        .map(|(text, file)| (text.to_owned(), repo.join(file)))
        .collect();
        paths.extend([
            (format!(r"{back}\python\tools\x.py"), repo.join(r"python\tools\x.py")),
            (format!("{forward}/python/tools/x.py"), repo.join(r"python\tools\x.py")),
            (format!(r"{back}\docs\plan.md"), repo.join(r"docs\plan.md")),
            (format!(r"{back}\with space\in it\y.py"), repo.join(r"with space\in it\y.py")),
            (format!(r"{back}\with space\in it\z.md"), repo.join(r"with space\in it\z.md")),
        ]);
        for (path, file) in &paths {
            for suffix in ["", ":42", ":42:7"] {
                for wrap in ["%", "%.", "%, then", "Update(%)", "\"%\"", "'%'", "`%`", "@%", "see % now"] {
                    let text = wrap.replace('%', &format!("{path}{suffix}"));
                    let at = text.find(path.as_str()).unwrap() + path.len() - 2;
                    let (range, target) = target_at(&text, at, Some(&repo), false).unwrap_or_else(|| panic!("no link in {text:?}"));
                    let Target::File(opens) = &target else { panic!("{text:?} is {target:?}") };
                    assert_eq!(opens, file, "{text:?}");
                    assert!(!opens.to_str().unwrap().contains('/'), "{text:?} opens {opens:?}");
                    assert!(!text[range.clone()].ends_with([')', '"', '\'', '`']), "{text:?} took {:?}", &text[range]);
                    let reader = markdown_file(&target, false).is_some();
                    assert_eq!(reader, path.ends_with(".md"), "{text:?}");
                }
            }
        }
    }

    /// `open` hands this path to explorer.exe. Comparing paths ignores which slash
    /// they use, so this compares the text.
    #[cfg(windows)]
    #[test]
    fn a_file_reaches_the_system_with_one_kind_of_slash() {
        let files = Files::new("slashes", &[r"src\main.rs"]);
        let repo = files.repo();
        let whole = repo.join(r"src\main.rs");
        let forward = whole.display().to_string().replace('\\', "/");
        for link in ["src/main.rs", "src/main.rs:42", "src/main.rs.", "./src/main.rs", forward.as_str()] {
            let Some(Target::File(path)) = resolve(link, Some(&repo)) else { panic!("no file for {link}") };
            assert_eq!(path.as_os_str(), whole.as_os_str(), "{link}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_bare_name_is_a_link_only_if_it_is_in_the_terminals_folder() {
        let files = Files::new("bare", &["main.rs"]);
        let repo = files.repo();
        let opens = |text, cwd| target_at(text, 7, cwd, false).map(|(_, target)| target);
        assert_eq!(opens("cargo main.rs now", Some(&*repo)), Some(Target::File(repo.join("main.rs"))));
        assert_eq!(opens("cargo gone.rs now", Some(&*repo)), None);
        assert_eq!(opens("cargo main.rs now", None), None, "no folder to look in");
    }

    #[cfg(windows)]
    #[test]
    fn home_and_variables_read_with_a_backslash() {
        let files = Files::new("vars", &[r"src\main.rs"]);
        let repo = files.repo();
        assert_eq!(resolve(r"$PWD\src\main.rs", Some(&repo)), Some(Target::File(repo.join(r"src\main.rs"))));
        assert_eq!(resolve(r"~\nowhere-kavex-test", Some(&repo)), None);
    }

    // Windows paths: elsewhere `\` isn't a separator, and only Windows runs what it opens.
    #[cfg(windows)]
    #[test]
    fn windows_runs_programs_and_scripts_it_is_handed() {
        let runs = |name: &str, pathext| runnable(Path::new(name), pathext);
        let always = [
            "setup.exe", "SETUP.EXE", "x.Bat", "x.cmd", "x.com", "x.ps1", "x.PSM1", "x.msi", "x.msp", "x.reg", "x.lnk", "x.url", "x.scr", "x.hta",
            "x.cpl", "x.jar", "x.appref-ms", "x.vbs", "x.vbe", "x.js", "x.jse", "x.wsf", "x.wsh", "x.msc", "x.pif", r"C:\a b (x86)\v1.2\x.exe",
        ];
        for name in always {
            for pathext in [None, Some(""), Some(".PY"), Some(".COM;.EXE")] {
                assert!(runs(name, pathext), "{name} with PATHEXT {pathext:?}");
            }
        }
        // Windows drops a name's trailing dots and spaces, and `::$DATA` names the file itself.
        for name in ["x.exe.", "x.exe. ", "x.exe ", r"C:\a\x.exe::$DATA", r"C:\a\x.bat:stream"] {
            assert!(runs(name, None), "{name}");
        }
        for name in ["main.rs", "notes.txt", "x.json", "Makefile", "x.exe.txt", "x.ts", "exe", r"C:\a.exe\notes.txt", "x.exe-old"] {
            assert!(!runs(name, None), "{name}");
        }
        assert!(!runs("x.py", None), "Python is in PATHEXT only where it was put there");
        assert!(runs("x.py", Some(".COM;.EXE;.PY;.PYW")));
        assert!(runs("x.PYW", Some(" .py ; .pyw ;;")), "read case-insensitively, with spaces and empty entries");
        assert!(runs("x.rb", Some("RB")), "an entry without its dot");
        assert!(!runs("x.py", Some("")), "an empty PATHEXT reads as unset");
        assert!(runs("x.cpl", Some("")), "the default covers what PATHEXT usually has");
    }

    // Windows paths: elsewhere `\` isn't a separator, and only Windows runs what it opens.
    #[cfg(windows)]
    #[test]
    fn a_runnable_file_is_shown_but_a_folder_still_opens() {
        let dir = std::env::temp_dir().join(format!("kavex-links-reveal-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("tool.exe")).unwrap();
        std::fs::write(dir.join("setup.exe"), "").unwrap();
        std::fs::write(dir.join("notes.txt"), "").unwrap();
        std::fs::create_dir_all(dir.join("lib.py")).unwrap();
        std::fs::write(dir.join("x.py"), "").unwrap();
        let python = |ext: &str| (ext == "py").then(|| PathBuf::from(r"C:\Windows\py.exe"));
        let shown = |name| shown_in_folder(&dir.join(name), None, python);
        let (file, folder, text, script, package) = (shown("setup.exe"), shown("tool.exe"), shown("notes.txt"), shown("x.py"), shown("lib.py"));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(file);
        assert!(!folder, "a folder named like a program is still a folder");
        assert!(!text);
        assert!(script, "Python opens .py here, and runs it");
        assert!(!package, "a folder named like a script is still a folder");
    }

    // Windows paths: elsewhere `\` isn't a separator, and only Windows runs what it opens.
    #[cfg(windows)]
    #[test]
    fn a_script_counts_when_its_default_app_is_an_interpreter() {
        // Like the registry, the lookup reads an extension in any case.
        let opened_by = |program: &'static str| move |ext: &str| ext.eq_ignore_ascii_case("py").then(|| PathBuf::from(program));
        let shown = |name: &str, program| shown_in_folder(Path::new(name), None, opened_by(program));
        assert!(shown("x.py", r"C:\Windows\py.exe"));
        assert!(shown("x.PY", r"C:\Program Files\Python312\python.exe"));
        assert!(!shown("x.py", r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe"), "an editor shows it");
        assert!(!shown("x.py", ""), "an empty answer");
        assert!(!shown_in_folder(Path::new("x.py"), None, |_| None), "no answer: the lookup failed");
        assert!(!shown_in_folder(Path::new("Makefile"), None, |_| panic!("no extension to look up")));
        assert!(shown_in_folder(Path::new("x.exe"), None, |_| panic!("PATHEXT answers first")));
        assert!(shown_in_folder(Path::new("x.py."), None, |ext| (ext == "py").then(|| PathBuf::from("python.exe"))), "the extension Windows reads");
    }

    // Windows paths: elsewhere `\` isn't a separator, and only Windows runs what it opens.
    #[cfg(windows)]
    #[test]
    fn interpreters_are_known_by_their_program_name() {
        let interpreters = [
            "python", "pythonw", "py", "pyw", "node", "ruby", "rubyw", "perl", "php", "wscript", "cscript", "mshta", "powershell", "pwsh", "cmd", "java", "javaw",
            "bash", "sh", "wsl",
        ];
        for name in interpreters {
            assert!(interpreter(Path::new(&format!(r"C:\bin\{name}.exe"))), "{name}");
        }
        for program in [r"C:\Windows\PY.EXE", r"C:\Python\PythonW.exe", "node.exe", r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe", r"C:\x\python3.12.exe", r"C:\x\php8.exe"] {
            assert!(interpreter(Path::new(program)), "{program}");
        }
        for program in [r"C:\VS Code\Code.exe", r"C:\Windows\notepad.exe", r"C:\x\pythonista.exe", r"C:\x\nodepad.exe", r"C:\x\shell.exe", ""] {
            assert!(!interpreter(Path::new(program)), "{program}");
        }
    }

    #[test]
    fn explorer_selects_the_file_from_one_quoted_argument() {
        let path = Path::new(r"C:\Program Files (x86)\My Tool, v2\setup (1).exe");
        assert_eq!(explorer_select(path), Some(OsString::from(r#"/select,"C:\Program Files (x86)\My Tool, v2\setup (1).exe""#)));
        assert_eq!(explorer_select(Path::new(r#"C:\a"b.exe"#)), None, "a quote would end the path early");
    }

    fn program_and_args(command: &Command) -> (&OsStr, Vec<&OsStr>) {
        (command.get_program(), command.get_args().collect())
    }

    #[cfg(windows)]
    #[test]
    fn windows_shows_a_runnable_file_and_opens_the_rest() {
        let explorer = OsStr::new("explorer.exe");
        let setup = r"C:\Program Files (x86)\My Tool, v2\setup (1).exe";
        let shown = command(&Target::File(setup.into()), |_| true).unwrap();
        let select = format!(r#"/select,"{setup}""#);
        assert_eq!(program_and_args(&shown), (explorer, vec![OsStr::new(&select)]));
        let notes = command(&Target::File(r"C:\a b\notes.txt".into()), |_| false).unwrap();
        assert_eq!(program_and_args(&notes), (explorer, vec![OsStr::new(r"C:\a b\notes.txt")]));
        let url = command(&Target::Url("https://a.com/setup.exe".into()), |_| true).unwrap();
        assert_eq!(program_and_args(&url), (explorer, vec![OsStr::new("https://a.com/setup.exe")]), "a URL goes on as it came");
        assert!(command(&Target::File(r#"C:\a"b.exe"#.into()), |_| true).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn a_file_link_to_a_program_here_is_shown_too() {
        let explorer = OsStr::new("explorer.exe");
        let program = |path: &Path| path.extension().is_some_and(|e| e == "exe");
        let asked = |url: &str| {
            let command = command(&Target::Url(url.into()), program).unwrap();
            program_and_args(&command).1.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>()
        };
        assert_eq!(asked("file:///C:/a%20b/setup.exe"), [r#"/select,"C:\a b\setup.exe""#]);
        assert_eq!(asked("file://localhost/C:/a/setup.exe"), [r#"/select,"C:\a\setup.exe""#]);
        assert_eq!(asked("file:///C:/a/notes.txt"), ["file:///C:/a/notes.txt"], "not a program: as it came");
        assert_eq!(asked("file://other-host/C:/a/setup.exe"), ["file://other-host/C:/a/setup.exe"], "not this machine");
        assert_eq!(asked("https://a.com/setup.exe"), ["https://a.com/setup.exe"]);
        let shown = command(&Target::Url("file:///C:/a/setup.exe".into()), program).unwrap();
        assert_eq!(shown.get_program(), explorer);
    }

    #[cfg(not(windows))]
    #[test]
    fn elsewhere_every_file_goes_to_the_system_as_it_is() {
        let opener = OsStr::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" });
        let setup = command(&Target::File("/a b/setup.exe".into()), |_| true).unwrap();
        assert_eq!(program_and_args(&setup), (opener, vec![OsStr::new("/a b/setup.exe")]));
        let link = command(&Target::Url("file:///a/setup.exe".into()), |_| true).unwrap();
        assert_eq!(program_and_args(&link), (opener, vec![OsStr::new("file:///a/setup.exe")]));
    }

    #[cfg(windows)]
    #[test]
    fn a_url_goes_on_as_it_came() {
        assert_eq!(resolve("file:///C:/a/b.md", None), Some(Target::Url("file:///C:/a/b.md".into())));
        assert_eq!(resolve("https://a.com/x", None), Some(Target::Url("https://a.com/x".into())));
    }
}
