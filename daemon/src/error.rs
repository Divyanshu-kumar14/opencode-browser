//! Error taxonomy — mirrors `docs/IMPLEMENTATION-PLAN.md` §2.5 exactly.
//!
//! Every error carries a machine-readable `code`, a human `message` and a
//! `hint` the calling model can act on. No bare socket errors escape the
//! daemon: transport failures are mapped onto [`ErrorCode::DaemonUnavailable`]
//! or [`ErrorCode::ChromeDead`] before they reach a client.

use std::fmt;

use serde::{Deserialize, Serialize};

/// The closed set of error codes from the implementation plan (§2.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    DaemonUnavailable,
    ProtocolMismatch,
    ChromeDead,
    NavFailed,
    NavTimeout,
    TabNotFound,
    TabForbidden,
    TabLimit,
    UidNotFound,
    UidStale,
    ElementOccluded,
    DialogNotOpen,
    UploadDenied,
    BodyUnavailable,
    EvalError,
    PermissionDenied,
    Internal,
}

/// Wire shape of an error: `{ "code": "...", "message": "...", "hint": "..." }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: ErrorCode,
    pub message: String,
    pub hint: String,
}

impl RpcError {
    pub fn new(code: ErrorCode, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint: hint.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::Internal,
            message,
            "retry the call; if it keeps failing, run browse_status and check the daemon log",
        )
    }

    pub fn chrome_dead(message: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::ChromeDead,
            message,
            "the browser process died; retry — the daemon relaunches Chrome once automatically",
        )
    }

    pub fn tab_not_found(message: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::TabNotFound,
            message,
            "call browse_navigate first, or pass a tab_id from browse_list_tabs",
        )
    }

    pub fn tab_forbidden(message: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::TabForbidden,
            message,
            "this tab belongs to another session; navigate in your own session instead of driving someone else's tab",
        )
    }

    pub fn nav_failed(message: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::NavFailed,
            message,
            "check the URL (only http, https and about are allowed) and that the page is reachable",
        )
    }

    pub fn nav_timeout(message: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::NavTimeout,
            message,
            "the page did not finish loading; retry with a larger timeout_ms, or snapshot what has rendered so far",
        )
    }

    pub fn uid_stale(uid: &str) -> Self {
        Self::new(
            ErrorCode::UidStale,
            format!("uid {uid} belongs to a previous page generation"),
            "the page changed; re-run browse_snapshot and use a uid from the new tree",
        )
    }

    pub fn uid_not_found(uid: &str) -> Self {
        Self::new(
            ErrorCode::UidNotFound,
            format!("uid {uid} is not present in the current snapshot"),
            "re-run browse_snapshot; uids are only valid until the next navigation or snapshot",
        )
    }

    pub fn element_occluded(blocker: &str) -> Self {
        Self::new(
            ErrorCode::ElementOccluded,
            format!("click target is covered by {blocker}"),
            "dismiss the covering element (cookie banner/modal) or close it before clicking",
        )
    }

    pub fn eval_error(message: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::EvalError,
            message,
            "the expression threw; check the JS for syntax/runtime errors",
        )
    }

    pub fn dialog_not_open() -> Self {
        Self::new(
            ErrorCode::DialogNotOpen,
            "no JavaScript dialog is open",
            "the dialog may have been auto-dismissed; navigate with dialog_policy:\"manual\" and schedule the dialog first",
        )
    }

    pub fn upload_denied(message: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::UploadDenied,
            message,
            "pass absolute paths to regular files (max 8 files, 100 MiB total); directories and symlinks are rejected",
        )
    }

    pub fn body_unavailable(request_id: &str, reason: &str) -> Self {
        Self::new(
            ErrorCode::BodyUnavailable,
            format!("no response body for request {request_id}: {reason}"),
            "Chrome evicts bodies after a navigation or when its cache fills; re-run the request and read the body immediately",
        )
    }

    pub fn eval_timeout(ms: u64) -> Self {
        Self::new(
            ErrorCode::EvalError,
            format!("evaluation exceeded the {ms}ms timeout"),
            "raise timeout_ms, or make the expression resolve sooner; the page script may still be running",
        )
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {} ({})", self.code, self.message, self.hint)
    }
}

impl std::error::Error for RpcError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_the_documented_shape() {
        let err = RpcError::new(
            ErrorCode::UidStale,
            "uid g7-3 belongs to a previous page generation",
            "re-run browse_snapshot",
        );
        let value = serde_json::to_value(&err).expect("serialize");
        assert_eq!(value["code"], "UID_STALE");
        assert_eq!(
            value["message"],
            "uid g7-3 belongs to a previous page generation"
        );
        assert_eq!(value["hint"], "re-run browse_snapshot");
        assert_eq!(value.as_object().expect("object").len(), 3);
    }

    #[test]
    fn every_code_round_trips_through_serde() {
        for code in [
            ErrorCode::DaemonUnavailable,
            ErrorCode::ProtocolMismatch,
            ErrorCode::ChromeDead,
            ErrorCode::NavFailed,
            ErrorCode::NavTimeout,
            ErrorCode::TabNotFound,
            ErrorCode::TabForbidden,
            ErrorCode::TabLimit,
            ErrorCode::UidNotFound,
            ErrorCode::UidStale,
            ErrorCode::ElementOccluded,
            ErrorCode::DialogNotOpen,
            ErrorCode::UploadDenied,
            ErrorCode::BodyUnavailable,
            ErrorCode::EvalError,
            ErrorCode::PermissionDenied,
            ErrorCode::Internal,
        ] {
            let json = serde_json::to_string(&code).expect("serialize");
            let back: ErrorCode = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(code, back);
            // to_string wraps the code in JSON quotes; check the payload.
            let payload = json.trim_matches('"');
            assert!(
                !payload.is_empty() && payload.chars().all(|c| c.is_ascii_uppercase() || c == '_'),
                "{json}"
            );
        }
    }
}
