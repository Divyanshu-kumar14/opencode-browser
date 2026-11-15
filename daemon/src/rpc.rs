//! Wire protocol (§2.2): NDJSON request/response envelopes and typed params.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct NetworkParams {
    pub tab_id: Option<String>,
    pub limit: Option<usize>,
    pub filter: Option<String>,
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

/// Deserialize method params, mapping a schema error onto `INTERNAL` with a
/// hint that names the offending method. Never panics on client input.
pub fn parse_params<T: for<'de> Deserialize<'de>>(
    method: &str,
    params: &Value,
) -> Result<T, RpcError> {
    let params = if params.is_null() { &json!({}) } else { params };
    serde_json::from_value(params.clone()).map_err(|err| {
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
        let hello: HelloParams = parse_params("hello", &Value::Null).expect("empty params ok");
        assert!(hello.protocol.is_none());

        let bad = parse_params::<NavigateParams>("navigate", &json!({"url": 5}));
        assert!(bad.is_err());
        assert_eq!(bad.expect_err("err").code, ErrorCode::Internal);
    }
}
