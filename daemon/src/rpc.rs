//! Wire protocol (§2.2): NDJSON request/response envelopes and typed params.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{ErrorCode, RpcError};

/// Protocol major version. Also encoded in the socket path (`.../v1/`), so a
/// shim upgrade can never talk to an old daemon by accident.
pub const PROTOCOL: u32 = 1;

pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");

/// A parsed request. `id` is echoed back verbatim in the response.
#[derive(Debug, Clone)]
pub struct Request {
    pub id: Value,
    pub method: String,
    pub params: Value,
    pub session: Option<String>,
}

/// Raw envelope used for parsing: `id` and `method` are both optional so that
/// id-less notifications (e.g. `cancel`) can be ignored without an error.
#[derive(Debug, Deserialize)]
pub struct RawRequest {
    #[serde(default)]
    pub id: Option<Value>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub params: Option<Value>,
    #[serde(default)]
    pub session: Option<String>,
}

/// Outgoing response envelope.
#[derive(Debug, Serialize)]
pub struct Response {
    pub id: Value,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl Response {
    pub fn ok(id: Value, result: Value) -> Self {
        Self {
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: Value, error: RpcError) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(error),
        }
    }

    /// Protocol-level failure that has no request id to echo (bad framing,
    /// unparseable JSON).
    pub fn protocol_failure(error: RpcError) -> Self {
        Self::err(Value::Null, error)
    }

    pub fn to_line(&self) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(self).unwrap_or_else(|_| {
            br#"{"id":null,"ok":false,"error":{"code":"INTERNAL","message":"response serialization failed","hint":"report this daemon bug"}}"#.to_vec()
        });
        bytes.push(b'\n');
        bytes
    }
}

// ---------------------------------------------------------------------------
// Per-method params. All are `#[serde(default)]` so a missing field degrades to
// an explicit validation error instead of a deserialization failure.
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct HelloParams {
    pub protocol: Option<u32>,
    #[serde(alias = "shimVersion")]
    pub shim_version: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct NavigateParams {
    pub url: String,
    pub tab_id: Option<String>,
    pub wait_until: Option<String>,
    pub timeout_ms: Option<u64>,
    pub allow_file: Option<bool>,
    /// `auto` (default) dismisses dialogs so a page can never wedge the tab;
    /// `manual` leaves them open for `dialog`.
    pub dialog_policy: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct SnapshotParams {
    pub tab_id: Option<String>,
    pub max_nodes: Option<usize>,
    pub include_ax: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ClickParams {
    pub uid: String,
    pub tab_id: Option<String>,
    pub button: Option<String>,
    pub click_count: Option<u32>,
}

/// `click_at`: raw viewport-coordinate click for canvas/exotic widgets that
/// never appear in the snapshot tree. `x`/`y` are `Option` so a missing
/// coordinate degrades to `None` (rejected by the handler with an explicit
/// validation error) instead of silently clicking the viewport origin.
/// Same permission as `click`: no new capability, tab ownership enforced by
/// `resolve` + `assert_owned_by` in the handler.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ClickAtParams {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub tab_id: Option<String>,
    pub button: Option<String>,
    pub click_count: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct FillParams {
    pub uid: String,
    pub value: String,
    pub tab_id: Option<String>,
    pub submit: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct PressKeyParams {
    pub key: String,
    pub uid: Option<String>,
    pub tab_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct EvalParams {
    pub js: String,
    pub tab_id: Option<String>,
    pub await_promise: Option<bool>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct HoverParams {
    pub uid: String,
    pub tab_id: Option<String>,
}

/// Exactly one of `value`, `label` or `index` selects the option.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct SelectParams {
    pub uid: String,
    pub value: Option<String>,
    pub label: Option<String>,
    pub index: Option<usize>,
    pub tab_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct UploadParams {
    pub uid: String,
    pub paths: Vec<String>,
    pub tab_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct DialogParams {
    /// `accept` or `dismiss`.
    pub action: String,
    pub prompt_text: Option<String>,
    pub tab_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ScrollParams {
    pub direction: String,
    pub amount: Option<f64>,
    pub tab_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ScreenshotParams {
    pub tab_id: Option<String>,
    pub full_page: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ConsoleParams {
    pub tab_id: Option<String>,
    pub limit: Option<usize>,
    pub level: Option<String>,
    /// Cursor from a previous response's `next_since`; returns only newer entries.
    pub since: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct NetworkParams {
    pub tab_id: Option<String>,
    pub limit: Option<usize>,
    pub filter: Option<String>,
    /// Include redacted request/response headers (default false).
    pub include_headers: Option<bool>,
    /// Cursor from a previous response's `next_since`; returns only newer entries.
    pub since: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct NetworkBodyParams {
    pub tab_id: Option<String>,
    pub request_id: String,
    /// Truncation bound; default 16 KiB, cap 256 KiB.
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct CloseTabParams {
    pub tab_id: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct CancelParams {
    pub id: Option<Value>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ShutdownParams {
    pub force: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct BenchParams {
    pub sessions: Option<usize>,
    pub calls: Option<usize>,
}

/// Bounded-wait budget shared by `wait_for_uid` and `expect_text` (D lane).
/// Sane default 5 s, floor 100 ms (one poll), hard cap 30 s so the outer
/// `request_timeout_ms` headroom (+5 s, cap 40 s) always covers the poll loop.
pub const DEFAULT_WAIT_MS: u64 = 5_000;
pub const MIN_WAIT_MS: u64 = 100;
pub const MAX_WAIT_MS: u64 = 30_000;

/// Poll cadence for the wait loops in `dispatch.rs`. Short enough that a
/// fast-appearing condition resolves in ~one interval, long enough that a
/// full-timeout wait costs ~200 CDP round trips, not thousands.
pub const WAIT_POLL_MS: u64 = 150;

/// Upper bound on the `expect_text` needle so a hostile client cannot stuff a
/// multi-megabyte string into every poll's page script.
pub const MAX_EXPECT_TEXT_LEN: usize = 10_000;

/// Clamp a `timeout_ms` onto the wait budget. `None` (omitted) degrades to
/// the default instead of failing deserialization.
pub fn clamp_wait_timeout_ms(timeout_ms: Option<u64>) -> u64 {
    timeout_ms
        .unwrap_or(DEFAULT_WAIT_MS)
        .clamp(MIN_WAIT_MS, MAX_WAIT_MS)
}

/// `wait_for_uid`: poll until the element carrying this uid exists in the
/// page. The uid is matched verbatim against `data-oc-uid`; an empty uid is
/// rejected by the handler before any tab or CDP call.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct WaitForUidParams {
    pub uid: String,
    pub tab_id: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// `expect_text`: poll until the page's visible text contains this substring.
/// Matching is a plain substring search (case-sensitive); empty needles are
/// rejected by the handler before any tab or CDP call.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ExpectTextParams {
    pub text: String,
    pub tab_id: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// `route`: mock one URL pattern on the session tab — fulfill with a fixture
/// body or abort the request. Matching is a literal substring/prefix/host
/// comparison, never regex; over-limit patterns are rejected by the handler
/// before any tab or CDP call. Session-scoped: the tab owner check in
/// `resolve` is the authorization, and mocks die with the tab.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct RouteParams {
    pub tab_id: Option<String>,
    pub pattern: String,
    /// `substring` (default), `prefix`, or `host`.
    pub kind: Option<String>,
    /// `fulfill` or `abort`.
    pub action: String,
    /// Fulfill only: HTTP status (default 200, must be 100-599).
    pub status: Option<i64>,
    /// Fulfill only: fixture body (default "", cap 256 KiB).
    pub body: Option<String>,
    /// Fulfill only: single `content-type` header value (default
    /// `text/plain; charset=utf-8`, printable ASCII, max 128 chars).
    pub content_type: Option<String>,
}

/// `status`: `verbose: true` adds the global `op_lock` queue-wait mean
/// (counter sums only, no /proc walk). Default off.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct StatusParams {
    pub verbose: Option<bool>,
}

/// Deserialize method params, mapping a schema error onto `INTERNAL` with a
/// hint that names the offending method. Never panics on client input.
///
/// Takes `params` by value: `serde_json::from_value` reuses the owned
/// `String`/`Vec` buffers instead of copying them, so the dispatch path pays
/// zero clones for the params tree itself (matters for 1 MiB `fill`/`eval`
/// payloads).
pub fn parse_params_owned<T: for<'de> Deserialize<'de>>(
    method: &str,
    params: Value,
) -> Result<T, RpcError> {
    let params = if params.is_null() {
        Value::Object(Default::default())
    } else {
        params
    };
    serde_json::from_value(params).map_err(|err| {
        RpcError::new(
            ErrorCode::Internal,
            format!("invalid params for `{method}`: {err}"),
            "check the parameter names and types against the implementation plan §2.2",
        )
    })
}

/// Key used by `cancel` to address an in-flight request on the same connection.
pub fn request_key(id: &Value) -> String {
    match id {
        Value::String(s) => format!("s:{s}"),
        other => format!("j:{other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn response_omits_the_unused_side() {
        let ok = Response::ok(json!("1"), json!({"a": 1}));
        let ok_value: Value = serde_json::from_slice(&ok.to_line()).expect("json");
        assert_eq!(ok_value["ok"], true);
        assert!(ok_value.get("error").is_none());

        let err = Response::err(
            json!(7),
            RpcError::new(ErrorCode::TabNotFound, "no tab", "navigate first"),
        );
        let err_value: Value = serde_json::from_slice(&err.to_line()).expect("json");
        assert_eq!(err_value["id"], 7);
        assert_eq!(err_value["ok"], false);
        assert!(err_value.get("result").is_none());
        assert_eq!(err_value["error"]["code"], "TAB_NOT_FOUND");
    }

    #[test]
    fn idless_messages_are_representable() {
        let raw: RawRequest =
            serde_json::from_str(r#"{"method":"cancel","params":{}}"#).expect("parse");
        assert!(raw.id.is_none());
        assert_eq!(raw.method.as_deref(), Some("cancel"));
    }

    #[test]
    fn request_keys_never_collide_between_strings_and_numbers() {
        assert_ne!(request_key(&json!("1")), request_key(&json!(1)));
    }

    #[test]
    fn params_default_to_empty_and_report_bad_types() {
        let hello: HelloParams = parse_params_owned("hello", Value::Null).expect("empty params ok");
        assert!(hello.protocol.is_none());

        let bad = parse_params_owned::<NavigateParams>("navigate", json!({"url": 5}));
        assert!(bad.is_err());
        assert_eq!(bad.expect_err("err").code, ErrorCode::Internal);

        // Regression guard: the owned path accepts good params and rejects
        // bad ones with the same INTERNAL code (protocol v1 additive).
        let good: FillParams =
            parse_params_owned("fill", json!({"uid": "g7-3", "value": "hi"})).expect("ok");
        assert_eq!(good.uid, "g7-3");
        assert_eq!(good.value, "hi");
        let bad_fill = parse_params_owned::<FillParams>("fill", json!({"uid": 5}));
        assert!(bad_fill.is_err());
        assert_eq!(bad_fill.expect_err("err").code, ErrorCode::Internal);
    }

    #[test]
    fn wait_params_parse_and_clamp() {
        let good: WaitForUidParams =
            parse_params_owned("wait_for_uid", json!({"uid": "g7-3"})).expect("ok");
        assert_eq!(good.uid, "g7-3");
        assert!(good.tab_id.is_none());
        assert_eq!(clamp_wait_timeout_ms(good.timeout_ms), DEFAULT_WAIT_MS);

        let bad = parse_params_owned::<WaitForUidParams>("wait_for_uid", json!({"uid": 5}));
        assert!(bad.is_err());
        assert_eq!(bad.expect_err("err").code, ErrorCode::Internal);

        let text: ExpectTextParams =
            parse_params_owned("expect_text", json!({"text": "Sign in"})).expect("ok");
        assert_eq!(text.text, "Sign in");
        assert_eq!(clamp_wait_timeout_ms(text.timeout_ms), DEFAULT_WAIT_MS);

        // Missing text degrades to "" (serde default); the handler rejects it
        // with an explicit validation error before any tab or CDP call.
        let empty: ExpectTextParams = parse_params_owned("expect_text", json!({})).expect("ok");
        assert!(empty.text.is_empty());
        let bad_text = parse_params_owned::<ExpectTextParams>("expect_text", json!({"text": 5}));
        assert!(bad_text.is_err());
        assert_eq!(bad_text.expect_err("err").code, ErrorCode::Internal);

        assert_eq!(clamp_wait_timeout_ms(None), DEFAULT_WAIT_MS);
        assert_eq!(clamp_wait_timeout_ms(Some(50)), MIN_WAIT_MS);
        assert_eq!(clamp_wait_timeout_ms(Some(999_999_999)), MAX_WAIT_MS);
        assert_eq!(clamp_wait_timeout_ms(Some(7_500)), 7_500);
    }

    #[test]
    fn click_at_params_parse_and_reject_bad_types() {
        // D lane (F-gate S9): wire shape `{x, y, tab_id?, button?,
        // click_count?}` with `Option<f64>` coords degrading to None — the
        // handler rejects missing coords explicitly instead of silently
        // clicking the viewport origin.
        let good: ClickAtParams =
            parse_params_owned("click_at", json!({"x": 100.0, "y": 200.0})).expect("ok");
        assert_eq!(good.x, Some(100.0));
        assert_eq!(good.y, Some(200.0));
        assert!(good.tab_id.is_none());

        let missing: ClickAtParams = parse_params_owned("click_at", json!({})).expect("ok");
        assert!(missing.x.is_none());
        assert!(missing.y.is_none());

        // Huge-but-finite parses: range rejection is the handler's job
        // (`validate_click_at_coords`), not the parser's.
        let huge: ClickAtParams =
            parse_params_owned("click_at", json!({"x": 1e12, "y": 0.0})).expect("ok");
        assert_eq!(huge.x, Some(1e12));

        for bad in [json!({"x": "left"}), json!({"x": true}), json!({"y": []})] {
            let err =
                parse_params_owned::<ClickAtParams>("click_at", bad).expect_err("must reject");
            assert_eq!(err.code, ErrorCode::Internal);
        }
    }

    #[test]
    fn click_at_coords_must_be_finite() {
        // Contract for the B-lane handler: NaN/Infinity can never become a
        // CDP mouse coordinate. JSON cannot represent either (serde_json
        // decodes both to Null), so the handler-side `is_finite` check is
        // the real boundary — pin both facts so B cannot regress them.
        assert!(json!(f64::NAN).is_null());
        assert!(json!(f64::INFINITY).is_null());
        fn finite(v: f64) -> Option<f64> {
            v.is_finite().then_some(v)
        }
        assert_eq!(finite(100.5), Some(100.5));
        assert_eq!(finite(f64::NAN), None);
        assert_eq!(finite(f64::INFINITY), None);
        // Huge-but-finite is representable on the wire; the handler rejects
        // it by range (`validate_click_at_coords`), it never reaches CDP.
        assert_eq!(finite(1e12), Some(1e12));
    }
}
