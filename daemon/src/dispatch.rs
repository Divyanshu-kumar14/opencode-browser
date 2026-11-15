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
    self, BenchParams, ClickParams, CloseTabParams, ConsoleParams, EvalParams, FillParams,
    HelloParams, NavigateParams, NetworkParams, PressKeyParams, Request, Response,
    ScreenshotParams, ShutdownParams, SnapshotParams,
};
use crate::snapshot::{self, DEFAULT_MAX_NODES};
use crate::tabs::{now_ms, Tab, TabRegistry};

/// Methods served by this daemon (also used in the unknown-method hint).
pub const METHODS: &[&str] = &[
    "hello",
    "navigate",
    "snapshot",
    "click",
    "fill",
    "press_key",
    "eval",
    "screenshot",
    "console",
    "network",
    "list_tabs",
    "close_tab",
    "status",
    "shutdown",
    "bench",
    "cancel",
];

/// Outer per-request timeout: 30 s everywhere except `navigate`, which gets
/// its own deadline plus headroom (capped so one call cannot wedge a worker).
pub fn request_timeout_ms(method: &str, params: &Value) -> u64 {
    if method == "navigate" {
        let inner = params
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(15_000)
            .clamp(1_000, 120_000);
        return (inner + 10_000).min(130_000);
    }
    30_000
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
        "fill" => handle_fill(app, req.params, &session).await,
        "press_key" => handle_press_key(app, req.params, &session).await,
        "eval" => handle_eval(app, req.params, &session).await,
        "screenshot" => handle_screenshot(app, req.params, &session).await,
        "console" => handle_console(app, req.params, &session).await,
        "network" => handle_network(app, req.params, &session).await,
        "list_tabs" => handle_list_tabs(app).await,
        "close_tab" => handle_close_tab(app, req.params, &session).await,
        "status" => handle_status(app).await,
        "shutdown" => handle_shutdown(app, req.params).await,
        "bench" => handle_bench(app, req.params).await,
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
    let parsed: HelloParams = rpc::parse_params("hello", &params)?;
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

async fn handle_status(app: &App) -> Result<Value, RpcError> {
    let chrome = app.chrome.status().await;
    Ok(json!({
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
    }))
}

async fn handle_navigate(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    let parsed: NavigateParams = rpc::parse_params("navigate", &params)?;
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
    tab.ensure_listeners().await;
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
    let parsed: SnapshotParams = rpc::parse_params("snapshot", &params)?;
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    tab.start_listeners();
    let _guard = tab.op_lock.lock().await;
    let out = snapshot::run_snapshot(
        &tab,
        parsed.max_nodes.unwrap_or(DEFAULT_MAX_NODES),
        parsed.include_ax.unwrap_or(true),
    )
    .await?;
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

/// Evaluate the center-point + occlusion probe inside the page. Returns
/// viewport CSS pixels and an optional covering element description.
async fn probe_click_point(tab: &Tab, uid: &str) -> Result<(f64, f64), RpcError> {
    let want = serde_json::to_string(uid)
        .map_err(|err| RpcError::internal(format!("cannot encode uid for page script: {err}")))?;
    let js = format!(
        r#"(async () => {{
  const want = {want};
  const el = document.querySelector('[data-oc-uid="' + want + '"]');
  if (!el) return {{ ok: false, reason: 'missing' }};
  const vw = window.innerWidth, vh = window.innerHeight;
  let r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) {{
    el.scrollIntoView({{ block: 'center', inline: 'center' }});
    await new Promise((f) => requestAnimationFrame(() => requestAnimationFrame(f)));
    r = el.getBoundingClientRect();
  }}
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  let cover = null;
  const top = document.elementFromPoint(x, y);
  if (top && top !== el && !el.contains(top)) {{
    const label = ((top.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60)
      || top.getAttribute('aria-label') || '');
    cover = (top.tagName || '?').toLowerCase() + (label ? ' "' + label + '"' : '');
  }}
  return {{ ok: true, x, y, cover }};
}})()"#
    );
    let value = tab
        .eval_json(&js)
        .await
        .map_err(|err| RpcError::internal(format!("click occlusion probe failed: {err}")))?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(RpcError::uid_not_found(uid));
    }
    if let Some(cover) = value.get("cover").and_then(Value::as_str) {
        if !cover.is_empty() {
            return Err(RpcError::element_occluded(cover));
        }
    }
    let x = value.get("x").and_then(Value::as_f64).unwrap_or(0.0);
    let y = value.get("y").and_then(Value::as_f64).unwrap_or(0.0);
    Ok((x, y))
}

async fn handle_click(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    use chromiumoxide::cdp::browser_protocol::input::{
        DispatchMouseEventParams, DispatchMouseEventType, MouseButton,
    };
    let parsed: ClickParams = rpc::parse_params("click", &params)?;
    if parsed.uid.trim().is_empty() {
        return Err(RpcError::uid_not_found("(empty uid)"));
    }
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    let _guard = tab.op_lock.lock().await;
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

async fn handle_fill(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    use chromiumoxide::cdp::browser_protocol::input::InsertTextParams;
    let parsed: FillParams = rpc::parse_params("fill", &params)?;
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
    let _guard = tab.op_lock.lock().await;
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

async fn handle_press_key(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    let parsed: PressKeyParams = rpc::parse_params("press_key", &params)?;
    if parsed.key.is_empty() {
        return Err(RpcError::new(
            ErrorCode::Internal,
            "press_key needs a non-empty key",
            "use a key name like Enter, Tab, Escape, ArrowUp, or a single character",
        ));
    }
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    let _guard = tab.op_lock.lock().await;
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
    let parsed: EvalParams = rpc::parse_params("eval", &params)?;
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
    let eval_params = chromiumoxide::cdp::js_protocol::runtime::EvaluateParams {
        expression: parsed.js.clone(),
        return_by_value: Some(true),
        await_promise: Some(parsed.await_promise.unwrap_or(true)),
        ..Default::default()
    };
    let result = tab.exec(eval_params).await?;
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
    let parsed: ScreenshotParams = rpc::parse_params("screenshot", &params)?;
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
    let parsed: ConsoleParams = rpc::parse_params("console", &params)?;
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    let limit = parsed.limit.unwrap_or(100).clamp(1, 500);
    let (messages, truncated) = tab.drain_console(limit, parsed.level.as_deref());
    Ok(json!({"messages": messages, "truncated": truncated}))
}

async fn handle_network(app: &App, params: Value, session: &str) -> Result<Value, RpcError> {
    let parsed: NetworkParams = rpc::parse_params("network", &params)?;
    let tab = app.tabs.resolve(session, parsed.tab_id.as_deref()).await?;
    let limit = parsed.limit.unwrap_or(100).clamp(1, 500);
    let (requests, truncated) = tab.drain_network(limit, parsed.filter.as_deref());
    Ok(json!({"requests": requests, "truncated": truncated}))
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
    let parsed: CloseTabParams = rpc::parse_params("close_tab", &params)?;
    app.tabs.close(session, &parsed.tab_id).await?;
    Ok(json!({"closed": true}))
}

async fn handle_shutdown(app: &App, params: Value) -> Result<Value, RpcError> {
    let _parsed: ShutdownParams = rpc::parse_params("shutdown", &params)?;
    app.request_shutdown();
    Ok(json!({}))
}

async fn handle_bench(app: &App, params: Value) -> Result<Value, RpcError> {
    let parsed: BenchParams = rpc::parse_params("bench", &params)?;
    let sessions = parsed.sessions.unwrap_or(1).clamp(1, 8);
    let calls = parsed.calls.unwrap_or(10).clamp(1, 20);
    if app.tabs.count().await + sessions > app.tabs.max_tabs() {
        return Err(RpcError::new(
            ErrorCode::TabLimit,
            "bench would exceed the tab limit",
            "close tabs with browser_close_tab first, or bench with fewer sessions",
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
    fn navigate_gets_a_longer_timeout_than_default() {
        let params = json!({"url": "https://example.com/", "timeout_ms": 60_000});
        assert_eq!(request_timeout_ms("navigate", &params), 70_000);
        assert_eq!(request_timeout_ms("snapshot", &json!({})), 30_000);
        let huge = json!({"url": "https://example.com/", "timeout_ms": 999_999_999});
        assert_eq!(request_timeout_ms("navigate", &huge), 130_000);
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
                        | "fill"
                        | "press_key"
                        | "eval"
                        | "screenshot"
                        | "console"
                        | "network"
                        | "list_tabs"
                        | "close_tab"
                        | "status"
                        | "shutdown"
                        | "bench"
                        | "cancel"
                ),
                "{method}"
            );
        }
    }
}
