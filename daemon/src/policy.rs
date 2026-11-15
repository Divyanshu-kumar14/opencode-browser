//! Daemon-side safety policy: navigation scheme allowlist + URL redaction.
//!
//! Both checks live in the daemon on purpose: the TypeScript shim is a
//! convenience client, never a trust boundary. A hostile or buggy client can
//! send any `navigate` params over the socket, so validation happens here,
//! fail-closed, before any tab is created or any CDP command is issued.

use crate::error::RpcError;

/// Upload limits. File inputs are an exfiltration primitive, so the daemon —
/// not the shim — is the trust boundary for what may be handed to the page.
pub const MAX_UPLOAD_FILES: usize = 8;
pub const MAX_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;

/// Schemes navigable without extra opt-in (`IMPLEMENTATION-PLAN.md` §2.2).
fn scheme_allowed(scheme: &str) -> bool {
    matches!(scheme, "http" | "https" | "about")
}

/// Lowercase scheme of `url` (text before the first `:`), or `None` when the
/// value has no parseable scheme.
pub fn url_scheme(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let end = trimmed.find(':')?;
    let scheme = trimmed[..end].to_ascii_lowercase();
    if scheme.is_empty()
        || !scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'+' || b == b'.')
    {
        return None;
    }
    Some(scheme)
}

/// Validate a navigation target. Fails closed with `NAV_FAILED`:
///
/// - `http`/`https`/`about` always allowed (case-insensitive);
/// - `file` only with `allow_file: true`;
/// - everything else (`javascript:`, `data:`, `chrome:`, …) rejected.
///
/// The full URL is never echoed back: the scheme name is enough to act on and
/// keeps query strings / tokens out of error payloads and logs.
pub fn check_navigate_url(url: &str, allow_file: bool) -> Result<(), RpcError> {
    let Some(scheme) = url_scheme(url) else {
        return Err(RpcError::nav_failed("navigation target has no URL scheme"));
    };
    if scheme_allowed(&scheme) {
        return Ok(());
    }
    if scheme == "file" {
        if allow_file {
            return Ok(());
        }
        return Err(RpcError::new(
            crate::error::ErrorCode::NavFailed,
            "navigation to file: URLs needs allow_file:true",
            "pass allow_file:true for local fixture files, or use an http(s) URL",
        ));
    }
    Err(RpcError::nav_failed(format!(
        "navigation to {scheme}: URLs is not allowed"
    )))
}

/// Shape-only checks for `upload` paths (pure; the filesystem checks live in
/// the dispatcher). Fails closed with `UPLOAD_DENIED`:
///
/// - 1–8 paths, each non-empty and absolute;
/// - no `..` component, so a relative traversal can never widen the set;
/// - the full path is never echoed — errors carry the basename only.
pub fn check_upload_paths(paths: &[String]) -> Result<(), RpcError> {
    use std::path::{Component, Path};

    if paths.is_empty() {
        return Err(RpcError::upload_denied("no files given"));
    }
    if paths.len() > MAX_UPLOAD_FILES {
        return Err(RpcError::upload_denied(format!(
            "{} files given, the limit is {MAX_UPLOAD_FILES}",
            paths.len()
        )));
    }
    for path in paths {
        let label = file_label(path);
        if path.trim().is_empty() {
            return Err(RpcError::upload_denied("empty upload path"));
        }
        if !Path::new(path).is_absolute() {
            return Err(RpcError::upload_denied(format!(
                "{label} is not an absolute path"
            )));
        }
        if Path::new(path)
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(RpcError::upload_denied(format!(
                "{label} contains a `..` component"
            )));
        }
    }
    Ok(())
}

/// Last path component, for error messages and logs. Never the full path.
pub fn file_label(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "(unnamed)".to_string())
}

/// Strip query string and fragment from a URL for logs and stored metadata.
/// Anything that is not hierarchical (`about:blank`, …) passes through, still
/// length-capped so a hostile client cannot flood the logs.
pub fn redact_url(url: &str) -> String {
    let mut end = url.len();
    for (i, c) in url.char_indices() {
        if c == '?' || c == '#' {
            end = i;
            break;
        }
    }
    let mut out = url[..end].to_string();
    if out.len() > 512 {
        out.truncate(512);
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_http_https_about_case_insensitive() {
        for url in [
            "http://example.com/",
            "https://example.com/a?b=c#d",
            "about:blank",
            "HTTP://EXAMPLE.COM/",
            "Https://example.com/x",
            "ABOUT:BLANK",
            "  https://example.com/  ",
        ] {
            assert!(check_navigate_url(url, false).is_ok(), "{url}");
        }
    }

    #[test]
    fn rejects_dangerous_schemes_even_uppercase() {
        for url in [
            "javascript:alert(1)",
            "JAVASCRIPT:alert(1)",
            "JaVaScRiPt:void(0)",
            "data:text/html,<h1>hi</h1>",
            "DATA:text/html,hi",
            "chrome://settings/",
            "file:///etc/passwd",
            "ftp://example.com/x",
            "vbscript:msgbox(1)",
        ] {
            let err = check_navigate_url(url, false).expect_err(url);
            assert_eq!(err.code, crate::error::ErrorCode::NavFailed, "{url}");
            // The payload must never leak: only the scheme name is echoed.
            assert!(!err.message.contains("alert"), "{url}");
        }
    }

    #[test]
    fn file_needs_explicit_opt_in() {
        assert!(check_navigate_url("file:///tmp/fixture.html", false).is_err());
        assert!(check_navigate_url("file:///tmp/fixture.html", true).is_ok());
        assert!(check_navigate_url("FILE:///tmp/fixture.html", true).is_ok());
    }

    #[test]
    fn rejects_values_without_a_scheme() {
        for url in ["", "   ", "not a url", "//example.com/no-scheme"] {
            assert!(check_navigate_url(url, false).is_err(), "{url:?}");
        }
    }

    #[test]
    fn redaction_strips_query_and_fragment() {
        assert_eq!(
            redact_url("https://example.com/a?token=secret#frag"),
            "https://example.com/a"
        );
        assert_eq!(redact_url("about:blank"), "about:blank");
        assert_eq!(
            redact_url("https://example.com/a/b"),
            "https://example.com/a/b"
        );
        let long = format!("https://example.com/{}", "x".repeat(600));
        let redacted = redact_url(&long);
        assert!(redacted.len() <= 520, "len={}", redacted.len());
        assert!(!redacted.contains('?'));
    }

    #[test]
    fn upload_paths_must_be_absolute_regular_and_bounded() {
        let ok = vec!["/tmp/a.png".to_string(), "/home/u/b.pdf".to_string()];
        assert!(check_upload_paths(&ok).is_ok());

        assert!(check_upload_paths(&[]).is_err());
        assert!(check_upload_paths(&["relative/a.png".to_string()]).is_err());
        assert!(check_upload_paths(&["/tmp/../etc/passwd".to_string()]).is_err());
        assert!(check_upload_paths(&["   ".to_string()]).is_err());

        let too_many: Vec<String> = (0..9).map(|i| format!("/tmp/{i}.png")).collect();
        assert!(check_upload_paths(&too_many).is_err());

        let err = check_upload_paths(&["/tmp/../etc/passwd".to_string()]).expect_err("denied");
        assert_eq!(err.code, crate::error::ErrorCode::UploadDenied);
        // The full path never leaks into the payload.
        assert!(!err.message.contains("etc/passwd"), "{}", err.message);
    }
}
