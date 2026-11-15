//! Filesystem locations, permission handling and small OS helpers.
//!
//! Runtime state lives under `$XDG_RUNTIME_DIR/opencode-browser/v1`, with a
//! `$TMPDIR`-based fallback when `XDG_RUNTIME_DIR` is unset. The protocol major
//! version is part of the path, so a shim upgrade can never reach an old daemon.

use std::ffi::OsString;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub const APP_DIR: &str = "opencode-browser";
pub const PROTOCOL_DIR: &str = "v1";
pub const SOCKET_NAME: &str = "daemon.sock";
pub const LOCK_NAME: &str = "daemon.lock";

/// Effective uid of the daemon, used for the fallback path and the
/// `SO_PEERCRED` comparison.
pub fn euid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

fn non_empty_env(key: &str) -> Option<OsString> {
    std::env::var_os(key).filter(|value| !value.is_empty())
}

/// Base runtime directory for the daemon (`.../opencode-browser/v1`).
pub fn runtime_dir() -> PathBuf {
    if let Some(runtime) = non_empty_env("XDG_RUNTIME_DIR") {
        return PathBuf::from(runtime).join(APP_DIR).join(PROTOCOL_DIR);
    }
    let tmp = non_empty_env("TMPDIR").unwrap_or_else(|| OsString::from("/tmp"));
    PathBuf::from(tmp)
        .join(format!("{APP_DIR}-{}", euid()))
        .join(PROTOCOL_DIR)
}

/// Default socket path. `--socket` overrides the whole path.
pub fn socket_path() -> PathBuf {
    runtime_dir().join(SOCKET_NAME)
}

/// Cache root for profiles and screenshots.
pub fn cache_root() -> PathBuf {
    if let Some(cache) = non_empty_env("XDG_CACHE_HOME") {
        return PathBuf::from(cache).join(APP_DIR);
    }
    let home = non_empty_env("HOME").unwrap_or_else(|| OsString::from("."));
    PathBuf::from(home).join(".cache").join(APP_DIR)
}

pub fn profiles_dir() -> PathBuf {
    cache_root().join("profiles")
}

pub fn screenshots_dir() -> PathBuf {
    cache_root().join("screenshots")
}

/// Create a directory (and parents) and force mode 0700.
pub fn ensure_private_dir(path: &Path) -> io::Result<()> {
    std::fs::create_dir_all(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

/// Restrict an existing file (socket) to a single owner.
pub fn make_owner_only(path: &Path) -> io::Result<()> {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

/// True when `pid` is alive (signal 0 succeeds or fails with EPERM).
pub fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: kill with signal 0 only performs an existence/permission check.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if rc == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Resident set size of this process, in MiB.
pub fn self_rss_mb() -> f64 {
    rss_kb_of(std::process::id())
        .map(|kb| kb as f64 / 1024.0)
        .unwrap_or(0.0)
}

fn rss_kb_of(pid: u32) -> Option<u64> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let kb = rest.split_whitespace().next()?.parse::<u64>().ok()?;
            return Some(kb);
        }
    }
    None
}

/// Total RSS (MiB) of a process and every descendant, found by walking
/// `/proc/<pid>/stat` for parent pids. Chrome is a tree, so the root process's
/// own RSS understates memory by an order of magnitude.
pub fn process_tree_rss_mb(root_pid: u32) -> f64 {
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return 0.0;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        // Fields after the comm field, which may itself contain spaces/parens.
        let Some(rest) = stat.rsplit_once(')').map(|(_, r)| r) else {
            continue;
        };
        let mut fields = rest.split_whitespace();
        let _state = fields.next();
        let Some(ppid) = fields.next().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        children.entry(ppid).or_default().push(pid);
    }

    let mut total_kb = rss_kb_of(root_pid).unwrap_or(0);
    let mut stack = children.get(&root_pid).cloned().unwrap_or_default();
    while let Some(pid) = stack.pop() {
        total_kb += rss_kb_of(pid).unwrap_or(0);
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    total_kb as f64 / 1024.0
}

/// Find an executable named `name` on `PATH` (no `which` dependency).
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = non_empty_env("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    meta.is_file() && meta.permissions().mode() & 0o111 != 0
}

/// Resolve the Chrome binary in the documented order, with an explicit CLI or
/// `CHROME_PATH` winning over PATH discovery.
pub fn resolve_chrome(cli: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = cli {
        return Some(path.to_path_buf());
    }
    if let Some(path) = non_empty_env("CHROME_PATH") {
        return Some(PathBuf::from(path));
    }
    for name in ["google-chrome", "chromium", "chromium-browser"] {
        if let Some(path) = find_on_path(name) {
            return Some(path);
        }
    }
    None
}

/// 128 bits of randomness rendered as hex — used for fresh profile directory
/// names. Reads `/dev/urandom`; falls back to time+pid if that is unavailable.
pub fn random_hex_32() -> String {
    let mut bytes = [0u8; 16];
    if let Ok(mut file) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        if file.read_exact(&mut bytes).is_ok() {
            return bytes.iter().map(|b| format!("{b:02x}")).collect();
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("{nanos:032x}{:08x}", std::process::id())
}

pub fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_names_are_unique_and_hex() {
        let a = random_hex_32();
        let b = random_hex_32();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn own_rss_is_plausible() {
        let rss = self_rss_mb();
        assert!(rss > 1.0 && rss < 2048.0, "unexpected rss {rss}");
    }

    #[test]
    fn process_tree_includes_self() {
        let tree = process_tree_rss_mb(std::process::id());
        assert!(tree >= self_rss_mb() - 1.0);
    }

    #[test]
    fn runtime_path_has_the_protocol_segment() {
        let dir = runtime_dir();
        assert_eq!(dir.file_name().and_then(|s| s.to_str()), Some(PROTOCOL_DIR));
        assert_eq!(
            socket_path().file_name().and_then(|s| s.to_str()),
            Some(SOCKET_NAME)
        );
    }
}
