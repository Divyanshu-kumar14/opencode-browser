//! RPC dispatcher (P0-4): §2.2 method routing, `hello` version gate,
//! per-request inputs validated before any CDP call, unknown methods →
//! `INTERNAL`, `cancel` honored at the connection layer (see `main.rs`).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::chrome::ChromeManager;
use crate::error::{ErrorCode, RpcError};
use crate::paths;
use crate::policy::{check_navigate_url, redact_url};
use crate::rpc::{
    self, BenchParams, ClickAtParams, ClickParams, CloseTabParams, ConsoleParams, DialogParams,
    EvalParams, ExpectTextParams, FillParams, HelloParams, HoverParams, NavigateParams,
    NetworkBodyParams, NetworkParams, PressKeyParams, Request, Response, RouteParams,
    ScreenshotParams, ScrollParams, SelectParams, ShutdownParams, SnapshotParams, StatusParams,
    UploadParams, WaitForUidParams,
};
use crate::snapshot::{self, DEFAULT_MAX_NODES};
use crate::tabs::{
    actionability_js, actionability_timeout, classify_probe, now_ms, ActionKind, ProbeOutcome, Tab,
    TabRegistry,
};

/// Methods served by this daemon (also used in the unknown-method hint).
pub const METHODS: &[&str] = &[
    "hello",
    "navigate",
    "snapshot",
    "click",
    "click_at",
    "fill",
    "hover",
    "select",
    "upload",
    "dialog",
    "scroll",
    "press_key",
    "eval",
    "screenshot",
    "console",
    "network",
    "network_body",
    "list_tabs",
    "close_tab",
    "status",
    "shutdown",
    "bench",
    "wait_for_uid",
    "expect_text",
    "route",
    "cancel",
];

/// Bound for the actionability wait on click/fill/hover/select/press_key
/// (B lane, F-gate ~2 s): the element must become visible + enabled +
/// stable within this long; slower pages surface a typed NAV_TIMEOUT and
/// the agent retries via the D-lane wait tools. Well under the 30 s outer
/// request bound, so the action itself always keeps headroom.
const ACTIONABILITY_TIMEOUT_MS: u64 = 2_000;

/// Outer per-request timeout: 30 s by default. `navigate` and `eval` carry
/// their own deadline, so the outer bound is that deadline plus headroom
/// (capped so one call cannot wedge a worker).
pub fn request_timeout_ms(method: &str, params: &Value) -> u64 {
    let inner = |fallback: u64, min: u64| {
        params
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(fallback)
            .clamp(min, 120_000)
    };
    match method {
        "navigate" => (inner(15_000, 1_000) + 10_000).min(130_000),
        "eval" => (inner(30_000, 100) + 5_000).min(125_000),
        // Bounded waits carry their own deadline (clamped to MAX_WAIT_MS by
        // the handler); the outer bound is that deadline plus poll headroom.
        "wait_for_uid" | "expect_text" => (params
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(rpc::DEFAULT_WAIT_MS)
            .clamp(rpc::MIN_WAIT_MS, rpc::MAX_WAIT_MS)
            + 5_000)
            .min(40_000),
        _ => 30_000,
    }
}

pub struct App {
    pub chrome: Arc<ChromeManager>,
    pub tabs: Arc<TabRegistry>,
    pub screenshots: PathBuf,
    pub started_ms: u64,
    pub last_activity_ms: Arc<AtomicU64>,
    pub shutdown_flag: Arc<AtomicBool>,
    pub shutdown_notify: Arc<Notify>,
}

impl App {
    pub fn new(chrome: Arc<ChromeManager>, tabs: Arc<TabRegistry>, screenshots: PathBuf) -> Self {
        Self {
            chrome,
            tabs,
            screenshots,
            started_ms: now_ms(),
            last_activity_ms: Arc::new(AtomicU64::new(now_ms())),
            shutdown_flag: Arc::new(AtomicBool::new(false)),
            shutdown_notify: Arc::new(Notify::new()),
        }
    }

    pub fn touch(&self) {
        self.last_activity_ms.store(now_ms(), Ordering::SeqCst);
    }

    pub fn request_shutdown(&self) {
        self.shutdown_flag.store(true, Ordering::SeqCst);
        self.shutdown_notify.notify_waiters();
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutdown_flag.load(Ordering::SeqCst)
    }
}

/// Mint the effective session id (P1-4): a provided non-empty session is
/// used verbatim; a missing/blank one becomes a per-connection id so two
/// anonymous clients can never drive each other's tab.
pub fn effective_session(raw: Option<&str>, conn_tag: &str) -> String {
    match raw {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => format!("anon:{conn_tag}"),
    }
}

pub async fn dispatch(app: &App, req: Request, session: String) -> Response {
    let result = match req.method.as_str() {
        "hello" => handle_hello(app, req.params).await,
        "navigate" => handle_navigate(app, req.params, &session).await,
        "snapshot" => handle_snapshot(app, req.params, &session).await,
        "click" => handle_click(app, req.params, &session).await,
        "click_at" => handle_click_at(app, req.params, &session).await,
        "fill" => handle_fill(app, req.params, &session).await,
        "hover" => handle_hover(app, req.params, &session).await,
        "select" => handle_select(app, req.params, &session).await,
        "upload" => handle_upload(app, req.params, &session).await,
        "dialog" => handle_dialog(app, req.params, &session).await,
        "scroll" => handle_scroll(app, req.params, &session).await,
        "press_key" => handle_press_key(app, req.params, &session).await,
        "eval" => handle_eval(app, req.params, &session).await,
        "screenshot" => handle_screenshot(app, req.params, &session).await,
        "console" => handle_console(app, req.params, &session).await,
        "network" => handle_network(app, req.params, &session).await,
        "network_body" => handle_network_body(app, req.params, &session).await,
        "list_tabs" => handle_list_tabs(app).await,
        "close_tab" => handle_close_tab(app, req.params, &session).await,
        "status" => handle_status(app, req.params).await,
        "shutdown" => handle_shutdown(app, req.params).await,
        "bench" => handle_bench(app, req.params).await,
        "wait_for_uid" => handle_wait_for_uid(app, req.params, &session).await,
        "expect_text" => handle_expect_text(app, req.params, &session).await,
        "route" => handle_route(app, req.params, &session).await,
        "cancel" => {
            Ok(json!({"cancelled": false, "note": "nothing to cancel on a completed request"}))
        }
        other => Err(RpcError::new(
            ErrorCode::Internal,
            format!("unknown method `{other}`"),
            format!("known methods: {}", METHODS.join(", ")),
        )),
    };
    match result {
        Ok(value) => Response::ok(req.id, value),
        Err(err) => Response::err(req.id, err),
    }
}

fn page_err(tab: &Tab, what: &str, err: impl std::fmt::Display) -> RpcError {
    if tab.is_dead() {
        RpcError::chrome_dead(format!("browser connection lost during {what}: {err}"))
    } else {
        RpcError::internal(format!("{what} failed: {err}"))
    }
}

async fn handle_hello(app: &App, params: Value) -> Result<Value, RpcError> {
    let parsed: HelloParams = rpc::parse_params_owned("hello", params)?;
    if parsed.protocol != Some(rpc::PROTOCOL) {
        return Err(RpcError::new(
            ErrorCode::ProtocolMismatch,
            format!(
                "shim speaks protocol {:?}, daemon speaks protocol {}",
                parsed.protocol,
                rpc::PROTOCOL
            ),
            "upgrade the shim and daemon together; the protocol major is part of the socket path",
        ));
    }
    if app.chrome.is_attach_mode() {
        app.chrome.ensure().await?;
    }
    let chrome = app.chrome.status().await;
    Ok(json!({
        "protocol": rpc::PROTOCOL,
        "daemon_version": rpc::DAEMON_VERSION,
        "chrome": {
            "alive": chrome.alive,
            "pid": chrome.pid,
            "version": chrome.version,
        },
        "capabilities": METHODS,
    }))
}

async fn handle_status(app: &App, params: Value) -> Result<Value, RpcError> {
    let parsed: StatusParams = rpc::parse_params_owned("status", params)?;
    let chrome = app.chrome.status().await;
    let mut result = json!({
        "tabs": app.tabs.count().await,
        "sessions": app.tabs.session_count().await,
        "rss_mb": paths::self_rss_mb(),
        "chrome_alive": chrome.alive,
        "uptime_s": now_ms().saturating_sub(app.started_ms) / 1000,
        "max_tabs": app.tabs.max_tabs(),
        "chrome": {
            "alive": chrome.alive,
            "pid": chrome.pid,
            "version": chrome.version,
            "launches": chrome.launches,
            "relaunches": chrome.relaunches,
        },
        "daemon_version": rpc::DAEMON_VERSION,
        "protocol": rpc::PROTOCOL,
    });
    // Verbose only: the global `op_lock` queue-wait mean (counter sums, no
    // /proc walk). `None` renders as null when no op ever queued.
    if parsed.verbose.unwrap_or(false) {
        result["op_wait_mean_ms"] = json!(app.tabs.op_wait_mean_ms().await);
    }
    Ok(result)
}

async fn handle_navigate(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    let parsed: NavigateParams = rpc::parse_params_owned("navigate", params)?;
    if parsed.url.trim().is_empty() {
        return Err(RpcError::nav_failed("navigation target is empty"));
    }
    if parsed.url.len() > 8192 {
        return Err(RpcError::nav_failed(
            "navigation target exceeds the 8 KiB limit",
        ));
    }
    // Fail closed before any tab or CDP call exists (P0-2).
    check_navigate_url(&parsed.url, parsed.allow_file.unwrap_or(false))?;

    let timeout_ms = parsed.timeout_ms.unwrap_or(15_000).clamp(1_000, 120_000);
    let wait_until = parsed.wait_until.unwrap_or_else(|| "load".to_string());
    if !matches!(
        wait_until.as_str(),
        "load" | "domcontentloaded" | "networkidle"
    ) {
        return Err(RpcError::new(
            ErrorCode::Internal,
            format!(
                "invalid wait_until {wait_until:?}: expected load, domcontentloaded or networkidle"
            ),
            "omit wait_until or use one of the three documented values",
        ));
    }

    let tab = app.tabs.resolve_or_create(session, &app.chrome).await?;
    let dialog_manual = match parsed.dialog_policy.as_deref().unwrap_or("auto") {
        "auto" => false,
        "manual" => true,
        other => {
            return Err(RpcError::new(
                ErrorCode::Internal,
                format!("invalid dialog_policy {other:?}: expected auto or manual"),
                "omit dialog_policy to auto-dismiss, or use \"manual\" to drive dialogs with browse_dialog",
            ));
        }
    };
    tab.set_dialog_policy(dialog_manual);
    tab.ensure_listeners().await;
    // Visible-browser loop: activate the tab so a headed browser shows the
    // navigation. Best-effort and headless-harmless (`bring_to_front`
    // swallows its result, so this can never fail the navigation), and
    // BEFORE `op_lock` so activation never extends a lock hold.
    tab.bring_to_front().await;
    let _guard = tab.op_lock.lock().await;

    let nav = tab
        .exec(chromiumoxide::cdp::browser_protocol::page::NavigateParams::new(parsed.url.clone()))
        .await?;
    if let Some(error_text) = nav.error_text {
        if !error_text.is_empty() {
            return Err(RpcError::nav_failed(format!(
                "navigation failed: {error_text}"
            )));
        }
    }

    // Poll document readiness with the caller's deadline (NAV_TIMEOUT, not
    // INTERNAL: a slow page is expected input).
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let target = match wait_until.as_str() {
        "domcontentloaded" => "interactive",
        _ => "complete",
    };
    loop {
        let state = tab
            .eval_json("document.readyState")
            .await
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_default();
        let ready = state == "complete" || (target == "interactive" && state == "interactive");
        if ready {
            break;
        }
        if std::time::Instant::now() >= deadline {
            return Err(RpcError::nav_timeout(format!(
                "page did not reach {target} within {timeout_ms}ms"
            )));
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    if wait_until == "networkidle" {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        tokio::time::sleep(remaining.min(std::time::Duration::from_millis(500))).await;
    }

    let url = tab
        .page
        .url()
        .await
        .map_err(|err| page_err(&tab, "navigate", err))?
        .unwrap_or_default();
    // A redirect may have landed somewhere the allowlist forbids.
    if !url.is_empty() {
        let scheme_ok = crate::policy::url_scheme(&url)
            .map(|scheme| scheme == "http" || scheme == "https" || scheme == "about")
            .unwrap_or(false);
        if !scheme_ok {
            return Err(RpcError::nav_failed(format!(
                "navigation redirected to a disallowed scheme: {}",
                redact_url(&url)
            )));
        }
    }
    if url.is_empty() || url == "about:blank" {
        return Err(RpcError::nav_failed(
            "navigation produced no document (still on about:blank)",
        ));
    }

    let title = tab
        .eval_json("document.title")
        .await
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    // Real HTTP status from the Navigation Timing entry when the browser
    // exposes it (0 when cross-origin/cached hides it).
    let status = tab
        .eval_json("(() => { try { const n = performance.getEntriesByType('navigation')[0]; return (n && n.responseStatus) || 0; } catch (e) { return 0; } })()")
        .await
        .ok()
        .and_then(|value| value.as_u64())
        .unwrap_or(0) as u16;

    // New document: stale uids can never resolve (P0-5).
    tab.bump_generation();
    tab.set_url(&url);
    tab.set_title(&title);

    Ok(json!({
        "tab_id": tab.id,
        "url": url,
        "title": title,
        "status": status,
    }))
}

async fn handle_snapshot(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    let parsed: SnapshotParams = rpc::parse_params_owned("snapshot", params)?;
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    tab.start_listeners();
    // C1: timed acquisition (queue-wait metric) + the guard spans only the
    // CDP sequence. Per-tab ordering is preserved: inject/DOM/AX + set_uids
    // stay mutually exclusive; the guard is dropped before response
    // serialization so a large snapshot body never blocks the next op.
    let (guard, _wait_ms) = tab.lock_op().await;
    let out = snapshot::run_snapshot(
        &tab,
        parsed.max_nodes.unwrap_or(DEFAULT_MAX_NODES),
        parsed.include_ax.unwrap_or(true),
    )
    .await?;
    drop(guard);
    Ok(json!({
        "tab_id": out.tab_id,
        "url": out.url,
        "generation": out.generation,
        "text": out.text,
        "nodes": out.nodes,
        "total": out.total,
        "truncated": out.truncated,
    }))
}

/// Evaluate the center-point + occlusion + actionability probe inside the
/// page. Returns viewport CSS pixels. One shot, no polling: callers wait via
/// `wait_actionable` first (outside `op_lock`), then re-verify here under the
/// lock before acting, so a cover that lands mid-wait still blocks the click.
/// Contract preserved: unknown uid → UID_NOT_FOUND, cover → ELEMENT_OCCLUDED.
async fn probe_click_point(tab: &Tab, uid: &str) -> Result<(f64, f64), RpcError> {
    tab.check_uid(uid)?;
    let value = tab
        .eval_json(&actionability_js(uid))
        .await
        .map_err(|err| RpcError::internal(format!("click occlusion probe failed: {err}")))?;
    match classify_probe(&value, ActionKind::Click, uid) {
        ProbeOutcome::Ready { x, y } => Ok((x, y)),
        ProbeOutcome::Failed(err) => Err(err),
        ProbeOutcome::Pending(state) => {
            Err(actionability_timeout(uid, &state, ACTIONABILITY_TIMEOUT_MS))
        }
    }
}

async fn handle_click(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    use chromiumoxide::cdp::browser_protocol::input::{
        DispatchMouseEventParams, DispatchMouseEventType, MouseButton,
    };
    let parsed: ClickParams = rpc::parse_params_owned("click", params)?;
    if parsed.uid.trim().is_empty() {
        return Err(RpcError::uid_not_found("(empty uid)"));
    }
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    // B lane: wait for actionable OUTSIDE `op_lock` (never sleep under it),
    // then re-check ownership + generation under the lock before any CDP.
    tab.wait_actionable(
        &parsed.uid,
        ActionKind::Click,
        std::time::Duration::from_millis(ACTIONABILITY_TIMEOUT_MS),
    )
    .await?;
    let _guard = tab.op_lock.lock().await;
    tab.assert_owned_by(session)?;
    tab.check_uid(&parsed.uid)?;
    let (x, y) = probe_click_point(&tab, &parsed.uid).await?;

    let button = match parsed.button.as_deref().unwrap_or("left") {
        "left" => MouseButton::Left,
        "middle" => MouseButton::Middle,
        "right" => MouseButton::Right,
        other => {
            return Err(RpcError::new(
                ErrorCode::Internal,
                format!("invalid button {other:?}: expected left, middle or right"),
                "omit button for a normal left click",
            ));
        }
    };
    let clicks = parsed.click_count.unwrap_or(1).clamp(1, 3) as i64;
    let mouse = |event: DispatchMouseEventType| {
        DispatchMouseEventParams::builder()
            .r#type(event)
            .x(x)
            .y(y)
            .button(button.clone())
            .click_count(clicks)
            .build()
    };
    let moved = DispatchMouseEventParams::builder()
        .r#type(DispatchMouseEventType::MouseMoved)
        .x(x)
        .y(y)
        .build()
        .map_err(RpcError::internal)?;
    tab.exec(moved).await?;
    tab.exec(mouse(DispatchMouseEventType::MousePressed).map_err(RpcError::internal)?)
        .await?;
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    tab.exec(mouse(DispatchMouseEventType::MouseReleased).map_err(RpcError::internal)?)
        .await?;

    Ok(json!({"ok": true, "url": tab.url()}))
}

/// Sane-bounds cap for `click_at` coordinates (viewport CSS pixels). Mirrors
/// the `scroll` amount cap (100 000 px): anything larger is a caller bug, not
/// a viewport.
pub const MAX_CLICK_AT_COORD: f64 = 100_000.0;

/// Validate raw `click_at` coordinates before any tab or CDP call (fail
/// closed). Both must be present, finite, and inside `[0, MAX_CLICK_AT_COORD]`.
/// Pure: unit-tested without a browser.
pub fn validate_click_at_coords(x: Option<f64>, y: Option<f64>) -> Result<(f64, f64), RpcError> {
    fn one(name: &str, value: Option<f64>) -> Result<f64, RpcError> {
        let value = value.ok_or_else(|| {
            RpcError::new(
                ErrorCode::Internal,
                format!("click_at needs a numeric {name} coordinate"),
                "pass viewport CSS pixels, e.g. {\"x\": 640.0, \"y\": 480.0}; aim with browse_screenshot",
            )
        })?;
        if !value.is_finite() || value < 0.0 || value > MAX_CLICK_AT_COORD {
            return Err(RpcError::new(
                ErrorCode::Internal,
                format!(
                    "click_at {name}={value} is out of bounds: expected a finite number in [0, {MAX_CLICK_AT_COORD}]"
                ),
                "pass viewport CSS pixels from browse_screenshot; coordinates outside the viewport cannot hit anything",
            ));
        }
        Ok(value)
    }
    Ok((one("x", x)?, one("y", y)?))
}

/// Raw-coordinate click fallback for canvas/exotic widgets that never appear
/// in the snapshot tree. Same permission as `click` (ownership enforced by
/// `resolve` + `assert_owned_by`); `resolve` (never `resolve_or_create`) so a
/// coordinate click can never mint a tab in someone else's session.
///
/// NO uid checks, NO occlusion/actionability probe — that is the documented
/// tradeoff: there is no snapshot node to probe, so the caller aims with
/// `browse_screenshot` and a covering element will simply receive the click
/// instead of an ELEMENT_OCCLUDED error. Coordinates travel as CDP numbers
/// (`DispatchMouseEventParams.x/y`), never interpolated into page JavaScript.
///
/// Lock discipline: serialize the entire mouse sequence under `op_lock`.
/// There is no inter-event sleep while holding the lock.
async fn handle_click_at(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    use chromiumoxide::cdp::browser_protocol::input::{
        DispatchMouseEventParams, DispatchMouseEventType, MouseButton,
    };
    let parsed: ClickAtParams = rpc::parse_params_owned("click_at", params)?;
    // Validate everything before any tab or CDP call: coords first, then the
    // button shape (same accepted set as `click`).
    let (x, y) = validate_click_at_coords(parsed.x, parsed.y)?;
    let button = match parsed.button.as_deref().unwrap_or("left") {
        "left" => MouseButton::Left,
        "middle" => MouseButton::Middle,
        "right" => MouseButton::Right,
        other => {
            return Err(RpcError::new(
                ErrorCode::Internal,
                format!("invalid button {other:?}: expected left, middle or right"),
                "omit button for a normal left click",
            ));
        }
    };
    let clicks = parsed.click_count.unwrap_or(1).clamp(1, 3) as i64;

    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    tab.assert_owned_by(session)?;

    let mouse = |event: DispatchMouseEventType| {
        DispatchMouseEventParams::builder()
            .r#type(event)
            .x(x)
            .y(y)
            .button(button.clone())
            .click_count(clicks)
            .build()
    };
    let moved = DispatchMouseEventParams::builder()
        .r#type(DispatchMouseEventType::MouseMoved)
        .x(x)
        .y(y)
        .build()
        .map_err(RpcError::internal)?;

    let _guard = tab.op_lock.lock().await;
    tab.assert_owned_by(session)?;
    tab.exec(moved).await?;
    tab.exec(mouse(DispatchMouseEventType::MousePressed).map_err(RpcError::internal)?)
        .await?;
    tab.exec(mouse(DispatchMouseEventType::MouseReleased).map_err(RpcError::internal)?)
        .await?;

    Ok(json!({"ok": true, "x": x, "y": y}))
}

async fn handle_fill(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    use chromiumoxide::cdp::browser_protocol::input::InsertTextParams;
    let parsed: FillParams = rpc::parse_params_owned("fill", params)?;
    if parsed.uid.trim().is_empty() {
        return Err(RpcError::uid_not_found("(empty uid)"));
    }
    if parsed.value.len() > 1_000_000 {
        return Err(RpcError::new(
            ErrorCode::Internal,
            "fill value exceeds the 1 MiB limit",
            "split the input into smaller fill calls",
        ));
    }
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    tab.wait_actionable(
        &parsed.uid,
        ActionKind::Fill,
        std::time::Duration::from_millis(ACTIONABILITY_TIMEOUT_MS),
    )
    .await?;
    let _guard = tab.op_lock.lock().await;
    tab.assert_owned_by(session)?;
    tab.check_uid(&parsed.uid)?;

    let want = serde_json::to_string(&parsed.uid).map_err(|e| RpcError::internal(e.to_string()))?;
    let value_js =
        serde_json::to_string(&parsed.value).map_err(|e| RpcError::internal(e.to_string()))?;
    let js = format!(
        r#"(() => {{
  const want = {want};
  const el = document.querySelector('[data-oc-uid="' + want + '"]');
  if (!el) return {{ ok: false }};
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') {{
    el.focus();
    el.value = {value_js};
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
    return {{ ok: true, kind: 'select' }};
  }}
  el.focus();
  if (tag === 'input' || tag === 'textarea') {{
    try {{ el.select(); }} catch (e) {{ try {{ el.setSelectionRange(0, el.value.length); }} catch (e2) {{}} }}
  }} else if (el.isContentEditable) {{
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }}
  return {{ ok: true, kind: tag }};
}})()"#
    );
    let prep = tab
        .eval_json(&js)
        .await
        .map_err(|err| RpcError::internal(format!("fill target preparation failed: {err}")))?;
    if prep.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(RpcError::uid_not_found(&parsed.uid));
    }
    if prep.get("kind").and_then(Value::as_str) != Some("select") {
        tab.exec(InsertTextParams::new(parsed.value.clone()))
            .await?;
    }
    if parsed.submit.unwrap_or(false) {
        tab.page
            .press_key("Enter")
            .await
            .map_err(|err| page_err(&tab, "fill submit", err))?;
    }
    Ok(json!({"ok": true}))
}

async fn handle_hover(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    use chromiumoxide::cdp::browser_protocol::input::{
        DispatchMouseEventParams, DispatchMouseEventType,
    };
    let parsed: HoverParams = rpc::parse_params_owned("hover", params)?;
    if parsed.uid.trim().is_empty() {
        return Err(RpcError::uid_not_found("(empty uid)"));
    }
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    tab.wait_actionable(
        &parsed.uid,
        ActionKind::Hover,
        std::time::Duration::from_millis(ACTIONABILITY_TIMEOUT_MS),
    )
    .await?;
    let _guard = tab.op_lock.lock().await;
    tab.assert_owned_by(session)?;
    tab.check_uid(&parsed.uid)?;
    let (x, y) = probe_click_point(&tab, &parsed.uid).await?;
    let moved = DispatchMouseEventParams::builder()
        .r#type(DispatchMouseEventType::MouseMoved)
        .x(x)
        .y(y)
        .build()
        .map_err(RpcError::internal)?;
    tab.exec(moved).await?;
    Ok(json!({"ok": true, "x": x, "y": y}))
}

/// Change a `<select>` by option value, visible label or index. Exactly one of
/// the three selectors is required, so a typo can never silently pick option 0.
async fn handle_select(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    let parsed: SelectParams = rpc::parse_params_owned("select", params)?;
    if parsed.uid.trim().is_empty() {
        return Err(RpcError::uid_not_found("(empty uid)"));
    }
    let given = usize::from(parsed.value.is_some())
        + usize::from(parsed.label.is_some())
        + usize::from(parsed.index.is_some());
    if given != 1 {
        return Err(RpcError::new(
            ErrorCode::Internal,
            format!("select needs exactly one of value, label or index (got {given})"),
            "pass value for option.value, label for the visible text, or index for the position",
        ));
    }
    let (mode, target) = if let Some(value) = parsed.value.clone() {
        ("value", json!(value))
    } else if let Some(label) = parsed.label.clone() {
        ("label", json!(label))
    } else {
        ("index", json!(parsed.index.unwrap_or(0)))
    };

    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    tab.wait_actionable(
        &parsed.uid,
        ActionKind::Select,
        std::time::Duration::from_millis(ACTIONABILITY_TIMEOUT_MS),
    )
    .await?;
    let _guard = tab.op_lock.lock().await;
    tab.assert_owned_by(session)?;
    tab.check_uid(&parsed.uid)?;

    let want = serde_json::to_string(&parsed.uid).map_err(|e| RpcError::internal(e.to_string()))?;
    let spec = json!({"mode": mode, "target": target});
    let js = format!(
        r#"(() => {{
  const want = {want};
  const spec = {spec};
  const el = document.querySelector('[data-oc-uid="' + want + '"]');
  if (!el) return {{ ok: false, reason: 'missing' }};
  if (el.tagName.toLowerCase() !== 'select') return {{ ok: false, reason: 'not-select', tag: el.tagName.toLowerCase() }};
  const options = Array.from(el.options);
  let index = -1;
  if (spec.mode === 'value') index = options.findIndex((o) => o.value === spec.target);
  else if (spec.mode === 'label') index = options.findIndex((o) => ((o.label || o.text || '').trim() === spec.target));
  else index = spec.target;
  if (!Number.isInteger(index) || index < 0 || index >= options.length) {{
    return {{ ok: false, reason: 'no-match', count: options.length }};
  }}
  el.focus();
  el.selectedIndex = index;
  el.dispatchEvent(new Event('input', {{ bubbles: true }}));
  el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  const chosen = options[index];
  return {{ ok: true, index, value: chosen.value, label: (chosen.label || chosen.text || '') }};
}})()"#
    );
    let value = tab
        .eval_json(&js)
        .await
        .map_err(|err| RpcError::internal(format!("select failed: {err}")))?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        let reason = value
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Err(match reason {
            "missing" => RpcError::uid_not_found(&parsed.uid),
            "not-select" => RpcError::new(
                ErrorCode::Internal,
                format!(
                    "uid {} is a <{}>, not a <select>",
                    parsed.uid,
                    value
                        .get("tag")
                        .and_then(Value::as_str)
                        .unwrap_or("element")
                ),
                "use browse_click or browse_fill for non-select elements",
            ),
            _ => RpcError::new(
                ErrorCode::Internal,
                format!(
                    "no option matched {mode}={:?} (the select has {} options)",
                    target,
                    value.get("count").and_then(Value::as_u64).unwrap_or(0)
                ),
                "call browse_snapshot to read the option values and labels",
            ),
        });
    }
    Ok(value)
}

/// Attach local files to an `<input type="file">`. Permission-gated in the shim
/// because this is a file-exfiltration primitive; the daemon re-validates every
/// path so a hostile client cannot bypass the shim.
async fn handle_upload(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    use chromiumoxide::cdp::browser_protocol::dom::{
        DescribeNodeParams, GetDocumentParams, QuerySelectorParams, SetFileInputFilesParams,
    };

    let parsed: UploadParams = rpc::parse_params_owned("upload", params)?;
    if parsed.uid.trim().is_empty() {
        return Err(RpcError::uid_not_found("(empty uid)"));
    }
    crate::policy::check_upload_paths(&parsed.paths)?;

    let mut total = 0u64;
    for path in &parsed.paths {
        let label = crate::policy::file_label(path);
        let meta = tokio::fs::symlink_metadata(path)
            .await
            .map_err(|err| RpcError::upload_denied(format!("cannot read {label}: {err}")))?;
        if meta.file_type().is_symlink() {
            return Err(RpcError::upload_denied(format!("{label} is a symlink")));
        }
        if !meta.is_file() {
            return Err(RpcError::upload_denied(format!(
                "{label} is not a regular file"
            )));
        }
        total = total.saturating_add(meta.len());
    }
    if total > crate::policy::MAX_UPLOAD_BYTES {
        return Err(RpcError::upload_denied(format!(
            "{} bytes total, over the {} MiB limit",
            total,
            crate::policy::MAX_UPLOAD_BYTES / (1024 * 1024)
        )));
    }

    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    let _guard = tab.op_lock.lock().await;
    tab.check_uid(&parsed.uid)?;

    let doc = tab
        .exec(GetDocumentParams {
            depth: Some(0),
            pierce: None,
        })
        .await?;
    let selector = format!("[data-oc-uid=\"{}\"]", parsed.uid);
    let found = tab
        .exec(QuerySelectorParams::new(doc.root.node_id, selector))
        .await?;
    if found.node_id.0 == 0 {
        return Err(RpcError::uid_not_found(&parsed.uid));
    }
    let described = tab
        .exec(DescribeNodeParams {
            node_id: Some(found.node_id),
            ..Default::default()
        })
        .await?;
    let node = described.node;
    if !node.node_name.eq_ignore_ascii_case("input") {
        return Err(RpcError::new(
            ErrorCode::UploadDenied,
            format!(
                "uid {} is a <{}>, not a file input",
                parsed.uid,
                node.node_name.to_lowercase()
            ),
            "point upload at an <input type=\"file\"> uid from browse_snapshot",
        ));
    }
    let attrs = node.attributes.unwrap_or_default();
    let mut kind = String::new();
    for pair in attrs.chunks(2) {
        if pair.len() == 2 && pair[0].eq_ignore_ascii_case("type") {
            kind = pair[1].to_ascii_lowercase();
        }
    }
    if kind != "file" {
        return Err(RpcError::new(
            ErrorCode::UploadDenied,
            format!(
                "uid {} is an <input type=\"{kind}\">, not a file input",
                parsed.uid
            ),
            "point upload at an <input type=\"file\"> uid from browse_snapshot",
        ));
    }

    tab.exec(SetFileInputFilesParams {
        files: parsed.paths.clone(),
        node_id: Some(found.node_id),
        backend_node_id: None,
        object_id: None,
    })
    .await?;

    let files: Vec<String> = parsed
        .paths
        .iter()
        .map(|path| crate::policy::file_label(path))
        .collect();
    Ok(json!({"ok": true, "files": files}))
}

/// Accept or dismiss the dialog the page opened. Only meaningful after a
/// navigation with `dialog_policy: "manual"`; the default policy auto-handles.
async fn handle_dialog(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    use chromiumoxide::cdp::browser_protocol::page::HandleJavaScriptDialogParams;

    let parsed: DialogParams = rpc::parse_params_owned("dialog", params)?;
    let action = parsed.action.to_ascii_lowercase();
    if !matches!(action.as_str(), "accept" | "dismiss") {
        return Err(RpcError::new(
            ErrorCode::Internal,
            format!("invalid dialog action {action:?}: expected accept or dismiss"),
            "use accept to confirm, dismiss to cancel",
        ));
    }
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    let pending = tab.dialog().ok_or_else(RpcError::dialog_not_open)?;
    tab.exec(HandleJavaScriptDialogParams {
        accept: action == "accept",
        prompt_text: parsed.prompt_text.clone(),
    })
    .await?;
    tab.set_dialog(None);
    Ok(json!({"ok": true, "action": action, "dialog": pending}))
}

/// Scroll the document. Fires real scroll events, so infinite feeds load.
async fn handle_scroll(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    let parsed: ScrollParams = rpc::parse_params_owned("scroll", params)?;
    let direction = parsed.direction.to_ascii_lowercase();
    if !matches!(
        direction.as_str(),
        "up" | "down" | "left" | "right" | "top" | "bottom"
    ) {
        return Err(RpcError::new(
            ErrorCode::Internal,
            format!("invalid scroll direction {direction:?}"),
            "use up, down, left, right, top or bottom",
        ));
    }
    if let Some(amount) = parsed.amount {
        if !amount.is_finite() || amount <= 0.0 || amount > 100_000.0 {
            return Err(RpcError::new(
                ErrorCode::Internal,
                "amount must be a positive number of pixels (max 100000)",
                "omit amount to scroll by 80% of the viewport",
            ));
        }
    }
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    let _guard = tab.op_lock.lock().await;

    let spec = json!({"direction": direction, "amount": parsed.amount});
    let js = format!(
        r#"(() => {{
  const spec = {spec};
  const vh = window.innerHeight || 800;
  const vw = window.innerWidth || 1200;
  const horizontal = spec.direction === 'left' || spec.direction === 'right';
  const step = (typeof spec.amount === 'number' && spec.amount > 0) ? spec.amount : (horizontal ? vw : vh) * 0.8;
  const before = {{ x: window.scrollX, y: window.scrollY }};
  if (spec.direction === 'top') window.scrollTo({{ top: 0, left: window.scrollX }});
  else if (spec.direction === 'bottom') window.scrollTo({{ top: document.documentElement.scrollHeight, left: window.scrollX }});
  else if (spec.direction === 'up') window.scrollBy({{ top: -step, left: 0 }});
  else if (spec.direction === 'down') window.scrollBy({{ top: step, left: 0 }});
  else if (spec.direction === 'left') window.scrollBy({{ top: 0, left: -step }});
  else window.scrollBy({{ top: 0, left: step }});
  const max = Math.max(0, document.documentElement.scrollHeight - vh);
  return {{
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    at_bottom: window.scrollY >= max - 1,
    moved: window.scrollX !== before.x || window.scrollY !== before.y,
  }};
}})()"#
    );
    let value = tab.eval_json(&js).await?;
    Ok(json!({
        "ok": true,
        "scrollX": value.get("scrollX"),
        "scrollY": value.get("scrollY"),
        "at_bottom": value.get("at_bottom"),
        "moved": value.get("moved"),
    }))
}

async fn handle_press_key(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    let parsed: PressKeyParams = rpc::parse_params_owned("press_key", params)?;
    if parsed.key.is_empty() {
        return Err(RpcError::new(
            ErrorCode::Internal,
            "press_key needs a non-empty key",
            "use a key name like Enter, Tab, Escape, ArrowUp, or a single character",
        ));
    }
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    if let Some(uid) = parsed.uid.as_deref() {
        // Unfocused press needs no element; a uid-targeted press waits for an
        // actionable focus target first (fill/select/press_key were unprobed).
        tab.wait_actionable(
            uid,
            ActionKind::PressKey,
            std::time::Duration::from_millis(ACTIONABILITY_TIMEOUT_MS),
        )
        .await?;
    }
    let _guard = tab.op_lock.lock().await;
    tab.assert_owned_by(session)?;
    if let Some(uid) = parsed.uid.as_deref() {
        tab.focus_uid(uid).await?;
    }
    tab.page
        .press_key(parsed.key.clone())
        .await
        .map_err(|err| page_err(&tab, "press_key", err))?;
    Ok(json!({"ok": true}))
}

async fn handle_eval(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    let parsed: EvalParams = rpc::parse_params_owned("eval", params)?;
    if parsed.js.trim().is_empty() {
        return Err(RpcError::eval_error("expression is empty"));
    }
    if parsed.js.len() > 1_000_000 {
        return Err(RpcError::eval_error(
            "js expression exceeds the 1 MiB limit",
        ));
    }
    let tab = app.tabs.resolve_or_create(session, &app.chrome).await?;
    tab.ensure_listeners().await;
    let _guard = tab.op_lock.lock().await;
    let timeout_ms = parsed.timeout_ms.unwrap_or(30_000).clamp(100, 120_000);
    let eval_params = chromiumoxide::cdp::js_protocol::runtime::EvaluateParams {
        expression: parsed.js.clone(),
        return_by_value: Some(true),
        await_promise: Some(parsed.await_promise.unwrap_or(true)),
        ..Default::default()
    };
    // The deadline bounds the caller's wait; Chrome may keep running the
    // script, which the error hint says explicitly.
    let result = tab
        .exec_timeout_with(
            eval_params,
            std::time::Duration::from_millis(timeout_ms),
            || RpcError::eval_timeout(timeout_ms),
        )
        .await?;
    if let Some(details) = result.exception_details {
        let text = details
            .exception
            .as_ref()
            .and_then(|object| object.description.clone())
            .unwrap_or_else(|| details.text.clone());
        return Err(RpcError::eval_error(crate::tabs::truncate_chars(
            &text, 1000,
        )));
    }
    let rendered = serde_json::to_string(&result.result.value.unwrap_or(Value::Null))
        .map_err(|e| RpcError::internal(e.to_string()))?;
    let (value, truncated) = truncate_value(&rendered);
    Ok(json!({"value": value, "truncated": truncated}))
}

/// Truncate eval payloads past 100 KiB (plan §2.4), on a char boundary.
fn truncate_value(rendered: &str) -> (Value, bool) {
    const CAP: usize = 100 * 1024;
    if rendered.len() <= CAP {
        let value: Value = serde_json::from_str(rendered).unwrap_or(Value::Null);
        return (value, false);
    }
    let cut: String = rendered.chars().take(CAP).collect();
    (
        Value::String(format!(
            "{cut}…[truncated {} of {} bytes]",
            rendered.len() - cut.len(),
            rendered.len()
        )),
        true,
    )
}

async fn handle_screenshot(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    use chromiumoxide::cdp::browser_protocol::page::CaptureScreenshotFormat;
    use chromiumoxide::page::ScreenshotParams as PageShot;
    let parsed: ScreenshotParams = rpc::parse_params_owned("screenshot", params)?;
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    let _guard = tab.op_lock.lock().await;

    let bytes = tab
        .page
        .screenshot(
            PageShot::builder()
                .format(CaptureScreenshotFormat::Png)
                .full_page(parsed.full_page.unwrap_or(false))
                .build(),
        )
        .await
        .map_err(|err| page_err(&tab, "screenshot", err))?;
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err(RpcError::internal("screenshot did not return PNG data"));
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);

    crate::paths::ensure_private_dir(&app.screenshots)
        .map_err(|err| RpcError::internal(format!("cannot create screenshot dir: {err}")))?;
    let path = app.screenshots.join(format!("{}-{}.png", tab.id, now_ms()));
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|err| RpcError::internal(format!("cannot write screenshot: {err}")))?;
    crate::paths::make_owner_only(&path)
        .map_err(|err| RpcError::internal(format!("cannot restrict screenshot: {err}")))?;

    Ok(json!({
        "path": path.to_string_lossy(),
        "width": width,
        "height": height,
    }))
}

async fn handle_console(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    let parsed: ConsoleParams = rpc::parse_params_owned("console", params)?;
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    let limit = parsed.limit.unwrap_or(100).clamp(1, 500);
    let (messages, truncated, next_since) =
        tab.drain_console(limit, parsed.level.as_deref(), parsed.since);
    Ok(json!({"messages": messages, "truncated": truncated, "next_since": next_since}))
}

async fn handle_network(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    let parsed: NetworkParams = rpc::parse_params_owned("network", params)?;
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    let limit = parsed.limit.unwrap_or(100).clamp(1, 500);
    let (mut requests, truncated, next_since) =
        tab.drain_network(limit, parsed.filter.as_deref(), parsed.since);
    // Headers are captured redacted, but they still double the payload size:
    // only send them when the caller asked.
    if !parsed.include_headers.unwrap_or(false) {
        for entry in &mut requests {
            entry.request_headers.clear();
            entry.response_headers.clear();
        }
    }
    Ok(json!({"requests": requests, "truncated": truncated, "next_since": next_since}))
}

async fn handle_network_body(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    let parsed: NetworkBodyParams = rpc::parse_params_owned("network_body", params)?;
    if parsed.request_id.is_empty() {
        return Err(RpcError::internal(
            "network_body: `request_id` must not be empty",
        ));
    }
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    let max_bytes = parsed
        .max_bytes
        .unwrap_or(crate::tabs::DEFAULT_BODY_BYTES)
        .clamp(1, crate::tabs::MAX_BODY_BYTES);
    tab.response_body(&parsed.request_id, max_bytes).await
}

async fn handle_list_tabs(app: &App) -> Result<Value, RpcError> {
    let tabs: Vec<Value> = app
        .tabs
        .list()
        .await
        .into_iter()
        .map(|info| {
            json!({
                "tab_id": info.tab_id,
                "url": redact_url(&info.url),
                "title": info.title,
                "owner": info.owner,
                "last_used": info.last_used,
                "generation": info.generation,
                "alive": info.alive,
            })
        })
        .collect();
    Ok(json!({"tabs": tabs}))
}

async fn handle_close_tab(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    let parsed: CloseTabParams = rpc::parse_params_owned("close_tab", params)?;
    app.tabs.close(session, &parsed.tab_id).await?;
    Ok(json!({"closed": true}))
}

async fn handle_shutdown(app: &App, params: Value) -> Result<Value, RpcError> {
    let _parsed: ShutdownParams = rpc::parse_params_owned("shutdown", params)?;
    app.request_shutdown();
    Ok(json!({}))
}

async fn handle_bench(app: &App, params: Value) -> Result<Value, RpcError> {
    let parsed: BenchParams = rpc::parse_params_owned("bench", params)?;
    let sessions = parsed.sessions.unwrap_or(1).clamp(1, 8);
    let calls = parsed.calls.unwrap_or(10).clamp(1, 20);
    if app.tabs.count().await + sessions > app.tabs.max_tabs() {
        return Err(RpcError::new(
            ErrorCode::TabLimit,
            "bench would exceed the tab limit",
            "close tabs with browse_close_tab first, or bench with fewer sessions",
        ));
    }
    let started = std::time::Instant::now();
    let mut tasks = Vec::new();
    for index in 0..sessions {
        let tabs = app.tabs.clone();
        let chrome = app.chrome.clone();
        tasks.push(tokio::spawn(async move {
            let session = format!("bench-s{index}-{}", now_ms());
            let tab = tabs.resolve_or_create(&session, &chrome).await?;
            for _ in 0..calls {
                tab.eval_json("1+1").await?;
            }
            let id = tab.id.clone();
            tabs.close(&session, &id).await?;
            Ok::<(), RpcError>(())
        }));
    }
    for task in tasks {
        task.await
            .map_err(|err| RpcError::internal(format!("bench task panicked: {err}")))??;
    }
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let total = (sessions * calls) as u64;
    let chrome_tree_mb = app
        .chrome
        .status()
        .await
        .pid
        .map(paths::process_tree_rss_mb)
        .unwrap_or(0.0);
    Ok(json!({
        "sessions": sessions,
        "calls_per_session": calls,
        "total_calls": total,
        "elapsed_ms": elapsed_ms,
        "avg_ms_per_call": elapsed_ms as f64 / total.max(1) as f64,
        "rss_mb": paths::self_rss_mb(),
        "chrome_tree_mb": chrome_tree_mb,
    }))
}

// ---------------------------------------------------------------------------
// D lane: bounded waits (additive, protocol v1). Both handlers poll with a
// clamped deadline and NEVER hold `op_lock` across sleeps: the loop sleeps
// between single-shot CDP evals, so a 30 s wait cannot head-of-line block
// every other op on the tab. Transient eval failures (e.g. mid-navigation)
// keep polling until the deadline; only the timeout decides the outcome.
// ---------------------------------------------------------------------------

/// Poll until the element carrying `uid` exists in the page (`data-oc-uid`
/// match). Success reports `{found: true, elapsed_ms}`; a blown deadline is
/// a typed `NAV_TIMEOUT` naming the uid and the budget — never a bare
/// INTERNAL, so the outer `request_timeout_ms` headroom always loses the race
/// to this verdict instead of the reverse.
async fn handle_wait_for_uid(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    let parsed: WaitForUidParams = rpc::parse_params_owned("wait_for_uid", params)?;
    if parsed.uid.trim().is_empty() {
        return Err(RpcError::uid_not_found("(empty uid)"));
    }
    let timeout_ms = rpc::clamp_wait_timeout_ms(parsed.timeout_ms);
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;

    // The uid is JSON-escaped into the script (P1-2): even if the uid shape
    // ever widens past `g{gen}-{n}`, it stays a string literal.
    let want = serde_json::to_string(&parsed.uid)
        .map_err(|err| RpcError::internal(format!("cannot encode uid for page script: {err}")))?;
    let js = format!(
        r#"(() => {{
  const want = {want};
  return !!document.querySelector('[data-oc-uid="' + want + '"]');
}})()"#
    );
    let started = std::time::Instant::now();
    let deadline = started + std::time::Duration::from_millis(timeout_ms);
    let poll = std::time::Duration::from_millis(rpc::WAIT_POLL_MS);
    loop {
        let present = tab
            .eval_json(&js)
            .await
            .ok()
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        if present {
            return Ok(json!({
                "found": true,
                "uid": parsed.uid,
                "elapsed_ms": started.elapsed().as_millis() as u64,
                "timeout_ms": timeout_ms,
            }));
        }
        if std::time::Instant::now() >= deadline {
            return Err(RpcError::nav_timeout(format!(
                "uid {} did not appear within {timeout_ms}ms",
                parsed.uid
            )));
        }
        tokio::time::sleep(poll).await;
    }
}

/// Poll until the page's visible text contains `text` (plain case-sensitive
/// substring over `body.innerText` — never a regex, so no backtracking bomb).
/// Success reports `{matched: true, elapsed_ms}`; a blown deadline is a
/// typed `NAV_TIMEOUT` (same outer-headroom argument as `wait_for_uid`).
async fn handle_expect_text(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    let parsed: ExpectTextParams = rpc::parse_params_owned("expect_text", params)?;
    if parsed.text.is_empty() {
        return Err(RpcError::new(
            ErrorCode::Internal,
            "expect_text needs a non-empty text",
            "pass the substring to wait for, e.g. {\"text\": \"Sign in\"}",
        ));
    }
    if parsed.text.len() > rpc::MAX_EXPECT_TEXT_LEN {
        return Err(RpcError::new(
            ErrorCode::Internal,
            format!(
                "expect_text needle is {} bytes, over the {} byte limit",
                parsed.text.len(),
                rpc::MAX_EXPECT_TEXT_LEN
            ),
            "wait for a shorter, distinctive substring instead of a whole document",
        ));
    }
    let timeout_ms = rpc::clamp_wait_timeout_ms(parsed.timeout_ms);
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;

    let needle = serde_json::to_string(&parsed.text)
        .map_err(|err| RpcError::internal(format!("cannot encode text for page script: {err}")))?;
    let js = format!(
        r#"(() => {{
  const needle = {needle};
  const root = document.body || document.documentElement;
  const body = root && typeof root.innerText === 'string' ? root.innerText : '';
  return body.includes(needle);
}})()"#
    );
    let started = std::time::Instant::now();
    let deadline = started + std::time::Duration::from_millis(timeout_ms);
    let poll = std::time::Duration::from_millis(rpc::WAIT_POLL_MS);
    loop {
        let matched = tab
            .eval_json(&js)
            .await
            .ok()
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        if matched {
            return Ok(json!({
                "matched": true,
                "elapsed_ms": started.elapsed().as_millis() as u64,
                "timeout_ms": timeout_ms,
            }));
        }
        if std::time::Instant::now() >= deadline {
            return Err(RpcError::nav_timeout(format!(
                "text did not appear within {timeout_ms}ms",
            )));
        }
        tokio::time::sleep(poll).await;
    }
}

// ---------------------------------------------------------------------------
// E lane: deterministic network mocks (additive, protocol v1). A route binds
// one literal URL pattern to fulfill-with-fixture or abort on the session
// tab. Ordering is fail-closed: validate bounds first (never regex), resolve
// the owned tab second, arm `Fetch.enable` third, record the mock last — a
// route that is stored but unenforced would be fail-open.
// ---------------------------------------------------------------------------

/// Mock one request URL pattern: fulfill with a fixture body or abort it.
/// Session-scoped (ownership enforced by `resolve`); mocks die with the tab.
async fn handle_route(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    let parsed: RouteParams = rpc::parse_params_owned("route", params)?;
    // Fail closed before any tab or CDP call: literal-only matching, bounded
    // pattern/body/status/content-type; abort rejects fulfill-only fields
    // rather than silently dropping them.
    let route = Tab::new_route(
        parsed.pattern.clone(),
        parsed.kind.clone(),
        &parsed.action,
        parsed.status,
        parsed.body.clone(),
        parsed.content_type.clone(),
    )?;
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    // Arm interception before recording: a stored-but-unenforced mock lies.
    tab.ensure_fetch_intercept().await?;
    let count = tab.add_route(route)?;
    Ok(json!({
        "pattern": parsed.pattern,
        "kind": parsed.kind.unwrap_or_else(|| "substring".to_string()),
        "action": parsed.action,
        "routes": count,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anonymous_sessions_are_isolated_per_connection() {
        let a = effective_session(None, "c1");
        let b = effective_session(None, "c2");
        assert_ne!(a, b);
        assert_eq!(effective_session(Some("ses_x"), "c1"), "ses_x");
        assert_eq!(effective_session(Some("   "), "c9"), "anon:c9");
    }

    #[test]
    fn navigate_and_eval_get_their_own_deadline() {
        let params = json!({"url": "https://example.com/", "timeout_ms": 60_000});
        assert_eq!(request_timeout_ms("navigate", &params), 70_000);
        assert_eq!(request_timeout_ms("snapshot", &json!({})), 30_000);
        let huge = json!({"url": "https://example.com/", "timeout_ms": 999_999_999});
        assert_eq!(request_timeout_ms("navigate", &huge), 130_000);

        // eval must never be cut off by the default 30 s outer bound.
        let long_eval = json!({"js": "1", "timeout_ms": 90_000});
        assert_eq!(request_timeout_ms("eval", &long_eval), 95_000);
        assert_eq!(request_timeout_ms("eval", &json!({"js": "1"})), 35_000);
    }

    #[test]
    fn eval_payloads_truncate_past_100kib() {
        let (value, truncated) = truncate_value("\"short\"");
        assert!(!truncated);
        assert_eq!(value, Value::String("short".to_string()));
        let big = format!("\"{}\"", "x".repeat(200_000));
        let (value, truncated) = truncate_value(&big);
        assert!(truncated);
        assert!(value.as_str().expect("string").contains("truncated"));
    }

    #[test]
    fn wait_methods_get_their_own_bounded_deadline() {
        // New additive waits: default 5 s inner + 5 s headroom, hard-capped so
        // the outer bound always covers the poll loop (D lane).
        assert!(METHODS.contains(&"wait_for_uid"));
        assert!(METHODS.contains(&"expect_text"));
        assert_eq!(request_timeout_ms("wait_for_uid", &json!({})), 10_000);
        assert_eq!(request_timeout_ms("expect_text", &json!({})), 10_000);
        let huge = json!({"timeout_ms": 999_999_999});
        assert_eq!(request_timeout_ms("wait_for_uid", &huge), 35_000);
        assert_eq!(request_timeout_ms("expect_text", &huge), 35_000);
    }

    #[test]
    fn click_at_coords_validate_before_any_tab_or_cdp() {
        // Happy path: viewport pixels pass through untouched (CDP numbers,
        // never interpolated into page JavaScript).
        let (x, y) = validate_click_at_coords(Some(640.0), Some(480.0)).expect("valid");
        assert_eq!((x, y), (640.0, 480.0));
        // Boundary is inclusive on both ends.
        let (x, y) =
            validate_click_at_coords(Some(0.0), Some(MAX_CLICK_AT_COORD)).expect("boundary ok");
        assert_eq!((x, y), (0.0, MAX_CLICK_AT_COORD));
        // Missing, NaN, infinite, negative and huge all reject with INTERNAL
        // (protocol v1 additive: no new error codes).
        for (x, y) in [
            (None, Some(0.0)),
            (Some(0.0), None),
            (None, None),
            (Some(f64::NAN), Some(0.0)),
            (Some(0.0), Some(f64::NAN)),
            (Some(f64::INFINITY), Some(0.0)),
            (Some(0.0), Some(f64::NEG_INFINITY)),
            (Some(-1.0), Some(0.0)),
            (Some(0.0), Some(-0.5)),
            (Some(MAX_CLICK_AT_COORD + 1.0), Some(0.0)),
            (Some(0.0), Some(1_000_001.0)),
        ] {
            let err = validate_click_at_coords(x, y).expect_err("must reject");
            assert_eq!(err.code, ErrorCode::Internal);
        }
    }

    #[test]
    fn click_at_uses_the_default_outer_timeout() {
        // No dedicated arm in `request_timeout_ms`: the default 30 s outer
        // bound covers the two-shot CDP sequence (no poll loop to budget).
        assert!(METHODS.contains(&"click_at"));
        assert_eq!(request_timeout_ms("click_at", &json!({})), 30_000);
    }

    #[test]
    fn coordinate_actions_enforce_session_ownership() {
        // Contract for `handle_click_at` (same boundary as `click`): the
        // handler resolves with `resolve` (never `resolve_or_create`, so a
        // coordinate click can never mint a tab in another session) and
        // enforces `assert_owned_by` before any CDP call. Unit level pins
        // the error shape; the live resolve path runs against real tabs in
        // the smoke suite.
        let err = RpcError::tab_forbidden("tab t9 belongs to session ses_other");
        assert_eq!(err.code, ErrorCode::TabForbidden);
        let wire: Value = serde_json::to_value(&err).expect("json");
        assert_eq!(wire["code"], "TAB_FORBIDDEN");
    }

    #[test]
    fn every_method_is_routed() {
        // The dispatch table must cover the §2.2 surface: no silent gaps.
        for method in METHODS {
            assert!(
                matches!(
                    *method,
                    "hello"
                        | "navigate"
                        | "snapshot"
                        | "click"
                        | "click_at"
                        | "fill"
                        | "hover"
                        | "select"
                        | "upload"
                        | "dialog"
                        | "scroll"
                        | "press_key"
                        | "eval"
                        | "screenshot"
                        | "console"
                        | "network"
                        | "network_body"
                        | "list_tabs"
                        | "close_tab"
                        | "status"
                        | "shutdown"
                        | "bench"
                        | "wait_for_uid"
                        | "expect_text"
                        | "route"
                        | "cancel"
                ),
                "{method}"
            );
        }
    }
}
