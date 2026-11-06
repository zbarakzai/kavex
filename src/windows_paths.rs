//! Paths as tools on Windows write them: `src\main.rs`, `C:\x\y.py`. Ghostty's
//! pattern, in `links.rs`, knows only forward slashes. Apart from [`native`]
//! this is all text, so its tests run on every platform.

use fancy_regex::Regex;
use std::path::PathBuf;
use std::sync::LazyLock;

/// Ghostty's pattern with `\` as well as `/`, and two additions: a drive starts
/// a rooted path, and a rooted path with spaces ends at the first word with a
/// file's extension, as it would otherwise take the rest of the line
/// (`wrote C:\a b\c.py and more`) and name no file at all.
pub static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    let sep = r"[\\/]";
    let path_chars = r"[\w\-.~:\/\\?#@!$&*+;=%]";
    // Around a path, not in it: `?` and `*` can't be in a name on Windows.
    let no_trailing = r"(?<![:;*?!])";
    let dotted = format!(r"(?={path_chars}*\.)");
    let undotted = format!(r"(?!{path_chars}*\.)");
    let space = format!(r"(?<!:) (?!\w+:\/\/)(?!\.{{0,2}}{sep})(?!~{sep})(?![A-Za-z]:{sep})");
    let dotted_spaces = format!(r"(?:{space}{path_chars}*[\\/.])*");
    let any_spaces = format!(r"(?:{space}{path_chars}+)*");
    let drive = format!(r"(?<![\w\\/.\-])[A-Za-z]:{sep}");
    let rooted = format!(
        r"(?:{drive}|\.\.{sep}|\.{sep}|(?<!\w)~{sep}|(?:[\w][\w\-.]*{sep})*(?<!\w)\$[A-Za-z_]\w*{sep}|\.[\w][\w\-.]*{sep}|(?<![\w~\\/]){sep}(?!{sep}))"
    );
    // `(x86)` is part of a name; a `)` nothing opened is what's around the path.
    let word = format!(r"(?:{path_chars}|\(\w+\))");
    let file_end = format!(r"\.\w*[A-Za-z]\w*(?::\d+){{0,2}}(?=[.:;!?*]*(?!{path_chars}))");
    let to_a_file = format!("(?:{word}+{space})*?{word}*{file_end}");
    let rooted_path = format!(
        "{rooted}(?:{to_a_file}|{dotted}{path_chars}+{dotted_spaces}{no_trailing}|{undotted}{path_chars}+{any_spaces}{no_trailing})"
    );
    let bare_path = format!(r"{dotted}(?<!\$\d*)(?<!\w)[\w][\w\-.]*{sep}{path_chars}+{no_trailing}");
    Regex::new(&format!("{}|{rooted_path}|{bare_path}", crate::links::scheme_url())).expect("Windows link pattern")
});

/// Whether a word names a share (`\\host\x`). Asking the disk about one reaches
/// that host and offers it this person's login, so what a program prints never
/// gets asked about.
pub fn names_share(word: &str) -> bool {
    matches!(word.as_bytes(), [b'\\' | b'/', b'\\' | b'/', ..])
}

/// Where the word at `begin` really starts: `:` ended the word before it, which
/// leaves a drive behind (`C:\x`).
pub fn with_drive(text: &str, begin: usize) -> usize {
    let Some(head) = text[..begin].strip_suffix(':') else { return begin };
    let mut before = head.chars().rev();
    let letter = before.next().is_some_and(|c| c.is_ascii_alphabetic()) && !before.next().is_some_and(char::is_alphanumeric);
    if letter && text[begin..].starts_with(['\\', '/']) { begin - 2 } else { begin }
}

/// Whether a path with spaces could end at byte `at`. Reading a line stays cheap
/// by asking [`PATTERN`] only when one could.
pub fn spaced_path_ends(text: &str, at: usize) -> bool {
    let head = &text[..at];
    head.contains(' ') && [r":\", ":/", r".\", "./", r"~\", "~/"].iter().any(|root| head.contains(root))
}

/// A path as this system writes it: `C:\repo` joined with `src/main.rs` reads
/// `C:\repo\src/main.rs`, and `links::open` hands it to explorer.exe, whose
/// switches start with `/`.
pub fn native(path: PathBuf) -> PathBuf {
    if cfg!(windows) { path.components().collect() } else { path }
}
