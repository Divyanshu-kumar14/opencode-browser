//! Tab registry: ownership, leases, generation counters and per-tab locking.
//!
//! One tab per session (lazily created), a 10 minute lease, a hard cap of
//! `max_tabs` with LRU eviction of unowned/idle tabs only. Every snapshot uid
//! carries the tab's navigation generation, so a uid from an older document can
//! never be clicked by accident.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use chromiumoxide::cdp::browser_protocol::fetch::EventRequestPaused;
use chromiumoxide::cdp::browser_protocol::fetch::HeaderEntry;
use chromiumoxide::cdp::browser_protocol::log::EventEntryAdded;
use chromiumoxide::cdp::browser_protocol::network::{
    ErrorReason, EventRequestWillBeSent, EventResponseReceived, GetResponseBodyParams, Headers,
};
use chromiumoxide::cdp::browser_protocol::page::{
    EventJavascriptDialogOpening, HandleJavaScriptDialogParams,
};
use chromiumoxide::cdp::browser_protocol::target::CloseTargetParams;
use chromiumoxide::cdp::js_protocol::runtime::EvaluateParams;
use chromiumoxide::cdp::js_protocol::runtime::EventConsoleApiCalled;
use chromiumoxide::cdp::IntoEventKind;
use chromiumoxide::listeners::EventStream;
use chromiumoxide::{Binary, Command, Page};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{Mutex as AsyncMutex, MutexGuard as AsyncMutexGuard, RwLock};
use tracing::{debug, warn};

use crate::chrome::ChromeManager;
use crate::error::{ErrorCode, RpcError};
use crate::policy::redact_url;

/// Default CDP round-trip budget for a single command.
pub const CDP_TIMEOUT: Duration = Duration::from_secs(30);

/// Ring-buffer cap per tab for console/network entries (P1-6: ~0.5 MB total).
pub const BUFFER_CAP: usize = 500;

/// Cap on in-flight network correlations per tab (fail-soft bound).
const MAX_PENDING: usize = 1000;

/// One console/log entry kept per tab.
#[derive(Debug, Clone, Serialize)]
pub struct ConsoleEntry {
    /// Monotonic per-tab sequence number, used as the `since` cursor.
    pub seq: u64,
    pub level: String,
    pub text: String,
    pub url: String,
    pub ts: u64,
}

/// One completed network response kept per tab.
#[derive(Debug, Clone, Serialize)]
pub struct NetworkEntry {
    pub seq: u64,
    pub request_id: String,
    pub method: String,
    pub url: String,
    pub status: i64,
    pub ms: f64,
    /// CDP resource type (`document`, `xhr`, `fetch`, …).
    pub kind: String,
    /// Served from the disk cache or a service worker.
    pub from_cache: bool,
    /// Wire bytes as reported by Chrome (`encodedDataLength`).
    pub encoded_bytes: i64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub request_headers: Vec<Header>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub response_headers: Vec<Header>,
    pub ts: u64,
}

/// One header kept on a network entry. Values of credential-bearing headers are
/// replaced at capture time, so the ring buffer never stores the secret and no
/// later serialization path can leak it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Header {
    pub name: String,
    pub value: String,
}

/// Bound header memory: 500 entries × 64 headers × 512 chars worst case would
/// blow the ring budget, so both dimensions are capped.
const MAX_HEADERS: usize = 32;
const MAX_HEADER_VALUE: usize = 512;

/// Header names whose values must never leave the process.
const SECRET_HEADERS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
];

/// Default and hard cap for `network_body` (`docs/PLAN-tool-surface-gaps.md` C3).
pub const DEFAULT_BODY_BYTES: usize = 16 * 1024;
pub const MAX_BODY_BYTES: usize = 256 * 1024;
/// Base64 input bound (~350 KiB of encoded text covers the 256 KiB cap).
const MAX_BODY_B64_CHARS: usize = 512 * 1024;

fn header_value(value: &Value) -> String {
    let raw = match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .collect::<Vec<_>>()
            .join(", "),
        other => other.to_string(),
    };
    if raw.chars().count() > MAX_HEADER_VALUE {
        let mut short: String = raw.chars().take(MAX_HEADER_VALUE).collect();
        short.push('…');
        short
    } else {
        raw
    }
}

/// Copy a CDP header map into bounded, redacted pairs.
fn collect_headers(headers: &Headers) -> Vec<Header> {
    let Some(map) = headers.inner().as_object() else {
        return Vec::new();
    };
    map.iter()
        .take(MAX_HEADERS)
        .map(|(name, value)| {
            let secret = SECRET_HEADERS
                .iter()
                .any(|secret| name.eq_ignore_ascii_case(secret));
            Header {
                name: name.clone(),
                value: if secret {
                    "[redacted]".to_string()
                } else {
                    header_value(value)
                },
            }
        })
        .collect()
}

/// A JavaScript dialog the page opened (`Page.javascriptDialogOpening`).
#[derive(Debug, Clone, Serialize)]
pub struct DialogInfo {
    /// `alert`, `confirm`, `prompt` or `beforeunload`.
    pub kind: String,
    pub message: String,
    pub default_prompt: Option<String>,
    pub url: String,
    pub ts: u64,
}

pub fn now_ms() -> u64 {
    crate::paths::unix_ms()
}

fn lock<T>(mutex: &StdMutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Parse `g{gen}-{n}`. Uids are generated by the injected snapshot script.
pub fn parse_uid(uid: &str) -> Option<(u64, u64)> {
    let rest = uid.strip_prefix('g')?;
    let (generation, index) = rest.split_once('-')?;
    if generation.is_empty() || index.is_empty() {
        return None;
    }
    if !generation.bytes().all(|b| b.is_ascii_digit()) || !index.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some((generation.parse().ok()?, index.parse().ok()?))
}

// --- E lane: deterministic network mocks (trust boundary) -----------------
// `route` records a literal pattern → fulfill/abort decision on the tab.
// Matching is substring/prefix/host comparison ONLY: no regex crate is used
// on untrusted input anywhere (no backtracking engine, no ReDoS). Every
// bound below is enforced in `Tab::new_route` before any tab or CDP call
// exists, so a bad pattern fails closed instead of installing a half-open
// mock.

/// Pattern bound: literal chars, counted in chars so multi-byte patterns
/// cannot smuggle extra bytes past the limit.
pub const MAX_ROUTE_PATTERN: usize = 512;
/// Cap on mocked routes per tab: session-scoped, bounded memory, fail closed.
pub const MAX_ROUTES_PER_TAB: usize = 20;
/// Fulfilled fixture bodies reuse the `network_body` cap (256 KiB).
pub const MAX_ROUTE_BODY_BYTES: usize = MAX_BODY_BYTES;
/// `content-type` value bound: printable ASCII, no CR/LF (header injection).
pub const MAX_ROUTE_CONTENT_TYPE: usize = 128;

/// How a route pattern matches a request URL. All three are literal string
/// operations — `*` and `?` in a pattern match themselves, never wildcards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteKind {
    Substring,
    Prefix,
    Host,
}

/// What answering a paused request does: serve the fixture or fail it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteAction {
    Fulfill,
    Abort,
}

/// One validated mock. `status`/`body`/`content_type` apply to fulfill only;
/// abort carries none so nothing can leak into a failure.
#[derive(Debug, Clone)]
pub struct MockRoute {
    pub pattern: String,
    pub kind: RouteKind,
    pub action: RouteAction,
    pub status: i64,
    pub body: String,
    pub content_type: String,
}

pub struct Tab {
    pub id: String,
    pub page: Page,
    owner: StdMutex<Option<String>>,
    last_used: AtomicU64,
    generation: AtomicU64,
    uids: StdMutex<HashSet<String>>,
    url: StdMutex<String>,
    title: StdMutex<String>,
    dead: AtomicBool,
    chrome_alive: Arc<AtomicBool>,
    /// Serializes snapshot/click/fill/screenshot on this tab.
    ///
    /// PROPOSAL (nav-mutex vs op-mutex split, not yet implemented): navigate
    /// holds this lock across a multi-second readiness poll, head-of-line
    /// blocking every other op on the tab. Splitting into `nav_lock`
    /// (navigation + `bump_generation`) and `op_lock` (everything else) would
    /// fix that, but only with a strict lock order (`nav_lock` -> `op_lock`,
    /// never the reverse) plus a generation re-check after acquiring
    /// `op_lock`, so a click/snapshot can never act on uids from a superseded
    /// document and `assert_owned_by` still runs before any CDP call. Until
    /// that lands, every op keeps taking this one lock.
    pub op_lock: AsyncMutex<()>,
    /// Queue-wait metric: total ms spent awaiting `op_lock` plus acquisition
    /// count. Aggregated without any /proc walk by
    /// [`TabRegistry::op_wait_mean_ms`] for `status` (verbose only).
    /// `u64` ms cannot wrap in practice.
    pub op_wait_total_ms: AtomicU64,
    pub op_wait_count: AtomicU64,
    /// Correlations dropped by the network pump's overflow policy
    /// (drop-oldest, never drop-all). Exposed for bench guards.
    pub net_drop_count: AtomicU64,
    console: StdMutex<VecDeque<ConsoleEntry>>,
    network: StdMutex<VecDeque<NetworkEntry>>,
    console_seq: AtomicU64,
    network_seq: AtomicU64,
    dialog: StdMutex<Option<DialogInfo>>,
    /// `true` leaves dialogs open for `dialog`; `false` (default) auto-handles
    /// them so a page can never wedge the tab.
    dialog_manual: AtomicBool,
    listeners_started: AtomicBool,
    listeners_ready: AtomicBool,
    /// Session-scoped URL mocks (`route`): literal pattern → fulfill/abort.
    /// Cleared by [`Tab::mark_dead`], so `close_tab`, `remove_all` and
    /// `sweep` all drop every mock — a fresh tab always starts unmocked.
    routes: StdMutex<Vec<MockRoute>>,
    /// Fetch-intercept arm state: `fetch_started` elects the single task that
    /// runs `Fetch.enable` + spawns the intercept pump; `fetch_armed` gates
    /// mock installation so a route is never stored unenforced.
    fetch_started: AtomicBool,
    fetch_armed: AtomicBool,
}

/// Actionability gate (B lane): what an action needs from its element.
/// Mirrors Playwright's per-action check sets (reference only): click/hover
/// need receives-events (hit test); fill needs editable; every action needs
/// attached + visible + enabled + stable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionKind {
    Click,
    Hover,
    Fill,
    Select,
    PressKey,
}

impl ActionKind {
    /// Click/hover drive the mouse to the center point: the topmost element
    /// at that point must be the target itself.
    pub fn needs_hit_test(self) -> bool {
        matches!(self, Self::Click | Self::Hover)
    }

    /// Fill replaces editable text: a readonly control can never accept input.
    pub fn needs_editable(self) -> bool {
        matches!(self, Self::Fill)
    }
}

/// One poll result: ready to act, terminally failed, or worth retrying.
pub enum ProbeOutcome {
    Ready { x: f64, y: f64 },
    Pending(String),
    Failed(RpcError),
}

/// One-shot actionability probe shared by the wait loop and the final
/// under-lock probe. Returns `{ok, x, y, cover, editable}` or
/// `{ok: false, reason}` with reason `missing | hidden | disabled |
/// unstable`. The uid travels JSON-escaped (P1-2); the scroll-into-view +
/// `elementFromPoint` occlusion logic is the pre-existing probe, extended
/// with visible (display/visibility/opacity/viewport), enabled (`disabled`
/// + `aria-disabled`) and stable (same bounding box across two frames,
///   2 px total drift tolerance) checks.
pub fn actionability_js(uid: &str) -> String {
    let want = serde_json::to_string(uid).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(async () => {{
  const want = {want};
  const el = document.querySelector('[data-oc-uid="' + want + '"]');
  if (!el || !el.isConnected) return {{ ok: false, reason: 'missing' }};
  const vw = window.innerWidth, vh = window.innerHeight;
  let r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) {{
    el.scrollIntoView({{ block: 'center', inline: 'center' }});
    await new Promise((f) => requestAnimationFrame(() => requestAnimationFrame(f)));
    r = el.getBoundingClientRect();
  }}
  const cs = getComputedStyle(el);
  if (r.width <= 0 || r.height <= 0 || cs.display === 'none'
      || cs.visibility === 'hidden' || cs.visibility === 'collapse'
      || Number(cs.opacity || '1') === 0) {{
    return {{ ok: false, reason: 'hidden' }};
  }}
  if (el.disabled
      || (typeof el.getAttribute === 'function' && el.getAttribute('aria-disabled') === 'true')) {{
    return {{ ok: false, reason: 'disabled' }};
  }}
  const r1 = el.getBoundingClientRect();
  await new Promise((f) => requestAnimationFrame(() => requestAnimationFrame(f)));
  const r2 = el.getBoundingClientRect();
  const drift = Math.abs(r1.x - r2.x) + Math.abs(r1.y - r2.y)
    + Math.abs(r1.width - r2.width) + Math.abs(r1.height - r2.height);
  if (drift > 2) return {{ ok: false, reason: 'unstable' }};
  const x = r2.x + r2.width / 2, y = r2.y + r2.height / 2;
  let cover = null;
  const top = document.elementFromPoint(x, y);
  if (top && top !== el && !el.contains(top)) {{
    const label = ((top.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60)
      || top.getAttribute('aria-label') || '');
    cover = (top.tagName || '?').toLowerCase() + (label ? ' "' + label + '"' : '');
  }}
  return {{ ok: true, x, y, cover, editable: !el.readOnly }};
}})()"#
    )
}

/// Map one probe round onto an outcome for `kind`. Pure: unit-tested.
/// Order preserves the pre-existing contract: unknown uid →
/// UID_NOT_FOUND, cover (click/hover only) → ELEMENT_OCCLUDED;
/// hidden/disabled/unstable (and readonly for fill) are retryable, never
/// instant failures.
pub fn classify_probe(value: &Value, kind: ActionKind, uid: &str) -> ProbeOutcome {
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        let reason = value
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("missing");
        return match reason {
            "missing" => ProbeOutcome::Failed(RpcError::uid_not_found(uid)),
            other => ProbeOutcome::Pending(other.to_string()),
        };
    }
    if kind.needs_hit_test() {
        if let Some(cover) = value.get("cover").and_then(Value::as_str) {
            if !cover.is_empty() {
                return ProbeOutcome::Failed(RpcError::element_occluded(cover));
            }
        }
    }
    if kind.needs_editable() && value.get("editable").and_then(Value::as_bool) == Some(false) {
        return ProbeOutcome::Pending("readonly".to_string());
    }
    let x = value.get("x").and_then(Value::as_f64).unwrap_or(0.0);
    let y = value.get("y").and_then(Value::as_f64).unwrap_or(0.0);
    ProbeOutcome::Ready { x, y }
}

/// Typed timeout for an element that never became actionable. The §2.5
/// taxonomy has no dedicated action-timeout code and the shim only surfaces
/// known codes, so this rides on NAV_TIMEOUT with an actionability-specific
/// message and hint (same precedent as `eval_timeout` on EVAL_ERROR).
pub fn actionability_timeout(uid: &str, state: &str, timeout_ms: u64) -> RpcError {
    RpcError::new(
        ErrorCode::NavTimeout,
        format!("uid {uid} never became actionable: still {state} after {timeout_ms}ms"),
        "the element stayed hidden, disabled or unstable; retry once — if it keeps failing, re-run browse_snapshot and use a fresh uid",
    )
}

impl Tab {
    fn new(id: String, page: Page, owner: &str, chrome_alive: Arc<AtomicBool>) -> Self {
        Self {
            id,
            page,
            owner: StdMutex::new(Some(owner.to_string())),
            last_used: AtomicU64::new(now_ms()),
            generation: AtomicU64::new(1),
            uids: StdMutex::new(HashSet::new()),
            url: StdMutex::new(String::new()),
            title: StdMutex::new(String::new()),
            dead: AtomicBool::new(false),
            chrome_alive,
            op_lock: AsyncMutex::new(()),
            op_wait_total_ms: AtomicU64::new(0),
            op_wait_count: AtomicU64::new(0),
            net_drop_count: AtomicU64::new(0),
            console: StdMutex::new(VecDeque::new()),
            network: StdMutex::new(VecDeque::new()),
            console_seq: AtomicU64::new(0),
            network_seq: AtomicU64::new(0),
            dialog: StdMutex::new(None),
            dialog_manual: AtomicBool::new(false),
            listeners_started: AtomicBool::new(false),
            listeners_ready: AtomicBool::new(false),
            routes: StdMutex::new(Vec::new()),
            fetch_started: AtomicBool::new(false),
            fetch_armed: AtomicBool::new(false),
        }
    }

    /// `true` leaves dialogs open for the `dialog` method; `false` auto-handles
    /// them (dismiss `alert`/`confirm`/`prompt`, accept `beforeunload`).
    pub fn set_dialog_policy(&self, manual: bool) {
        self.dialog_manual.store(manual, Ordering::SeqCst);
    }

    pub fn dialog(&self) -> Option<DialogInfo> {
        lock(&self.dialog).clone()
    }

    pub fn set_dialog(&self, info: Option<DialogInfo>) {
        *lock(&self.dialog) = info;
    }

    /// Acquire `op_lock`, recording the queue wait. C1: snapshot (highest
    /// contention) uses this so lock-wait is MEASURED; the guard still spans
    /// the full CDP sequence to preserve per-tab ordering. Callers must
    /// `drop` the guard before CPU-only tail work (response serialization).
    pub async fn lock_op(&self) -> (AsyncMutexGuard<'_, ()>, u64) {
        let t0 = std::time::Instant::now();
        let guard = self.op_lock.lock().await;
        let wait_ms = u64::try_from(t0.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.op_wait_total_ms.fetch_add(wait_ms, Ordering::Relaxed);
        self.op_wait_count.fetch_add(1, Ordering::Relaxed);
        (guard, wait_ms)
    }

    pub fn owner(&self) -> Option<String> {
        lock(&self.owner).clone()
    }

    pub fn touch(&self) {
        self.last_used.store(now_ms(), Ordering::SeqCst);
    }

    pub fn last_used(&self) -> u64 {
        self.last_used.load(Ordering::SeqCst)
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn bump_generation(&self) -> u64 {
        {
            let mut uids = lock(&self.uids);
            uids.clear();
        }
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn set_uids(&self, uids: Vec<String>) {
        let mut current = lock(&self.uids);
        current.clear();
        current.extend(uids);
    }

    pub fn url(&self) -> String {
        lock(&self.url).clone()
    }

    pub fn set_url(&self, url: &str) {
        *lock(&self.url) = url.to_string();
    }

    pub fn title(&self) -> String {
        lock(&self.title).clone()
    }

    pub fn set_title(&self, title: &str) {
        *lock(&self.title) = title.to_string();
    }

    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::SeqCst)
    }

    pub fn mark_dead(&self) {
        self.dead.store(true, Ordering::SeqCst);
        {
            let mut uids = lock(&self.uids);
            uids.clear();
        }
        // Session-scoped mocks die with the tab: close_tab, remove_all,
        // sweep and eviction all funnel through here.
        {
            let mut routes = lock(&self.routes);
            routes.clear();
        }
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    /// Verify a uid belongs to the current generation and a known snapshot.
    pub fn check_uid(&self, uid: &str) -> Result<(), RpcError> {
        if self.is_dead() {
            return Err(RpcError::tab_not_found(format!(
                "tab {} is closed",
                self.id
            )));
        }
        let Some((generation, _)) = parse_uid(uid) else {
            return Err(RpcError::uid_not_found(uid));
        };
        if generation != self.generation() {
            return Err(RpcError::uid_stale(uid));
        }
        if !lock(&self.uids).contains(uid) {
            return Err(RpcError::uid_not_found(uid));
        }
        Ok(())
    }

    /// Own-tab enforcement. A `None` owner is a shared/anonymous tab.
    pub fn assert_owned_by(&self, session: &str) -> Result<(), RpcError> {
        match self.owner() {
            Some(owner) if owner != session => Err(RpcError::tab_forbidden(format!(
                "tab {} belongs to session {owner}",
                self.id
            ))),
            _ => Ok(()),
        }
    }

    fn map_error(&self, message: String) -> RpcError {
        if self.is_dead() || !self.chrome_alive.load(Ordering::SeqCst) {
            RpcError::chrome_dead(format!("browser connection lost: {message}"))
        } else {
            RpcError::internal(format!("CDP error: {message}"))
        }
    }

    pub async fn exec<T: Command>(&self, cmd: T) -> Result<T::Response, RpcError> {
        self.exec_timeout(cmd, CDP_TIMEOUT).await
    }

    pub async fn exec_timeout<T: Command>(
        &self,
        cmd: T,
        timeout: Duration,
    ) -> Result<T::Response, RpcError> {
        self.exec_timeout_with(cmd, timeout, || {
            RpcError::internal(format!(
                "CDP call timed out after {}ms",
                timeout.as_millis()
            ))
        })
        .await
    }

    /// Like [`Tab::exec_timeout`], but a blown deadline is reported with a
    /// caller-chosen error — `eval` must say EVAL_ERROR, not INTERNAL.
    pub async fn exec_timeout_with<T: Command>(
        &self,
        cmd: T,
        timeout: Duration,
        on_timeout: impl FnOnce() -> RpcError,
    ) -> Result<T::Response, RpcError> {
        if self.is_dead() || !self.chrome_alive.load(Ordering::SeqCst) {
            return Err(RpcError::chrome_dead(format!(
                "tab {} has no live browser",
                self.id
            )));
        }
        match tokio::time::timeout(timeout, self.page.execute(cmd)).await {
            Ok(Ok(response)) => Ok(response.result),
            Ok(Err(err)) => Err(self.map_error(err.to_string())),
            Err(_) => Err(on_timeout()),
        }
    }

    /// Evaluate internal JavaScript and return the JSON value by value.
    pub async fn eval_json(&self, expression: &str) -> Result<Value, RpcError> {
        let params = EvaluateParams {
            expression: expression.to_string(),
            return_by_value: Some(true),
            await_promise: Some(true),
            ..Default::default()
        };
        let result = self.exec(params).await?;
        if let Some(details) = result.exception_details {
            let text = details
                .exception
                .as_ref()
                .and_then(|object| object.description.clone())
                .or(Some(details.text))
                .unwrap_or_else(|| "javascript exception".to_string());
            // User JS that throws is expected input, not a daemon bug: report
            // it as EVAL_ERROR (P1-3), never INTERNAL.
            return Err(RpcError::eval_error(truncate_chars(&text, 1000)));
        }
        Ok(result.result.value.unwrap_or(Value::Null))
    }

    /// Focus an element by uid (used by fill/press_key).
    pub async fn focus_uid(&self, uid: &str) -> Result<Value, RpcError> {
        self.check_uid(uid)?;
        // The uid is JSON-escaped into the script (P1-2): even if the uid
        // shape ever widens past `g{gen}-{n}`, it stays a string literal.
        let want = serde_json::to_string(uid).map_err(|err| {
            RpcError::internal(format!("cannot encode uid for page script: {err}"))
        })?;
        let js = format!(
            r#"(() => {{
  const want = {want};
  const el = document.querySelector('[data-oc-uid="' + want + '"]');
  if (!el) return {{ ok: false }};
  el.focus();
  return {{ ok: true }};
}})()"#
        );
        self.eval_json(&js).await
    }

    /// Poll one actionability round until `kind` is satisfied or `timeout`
    /// elapses. Takes NO lock: callers must invoke this BEFORE acquiring
    /// `op_lock` (sleeps never happen under the lock), then re-check
    /// ownership + generation after acquiring it. Every round re-runs
    /// `check_uid`, so a navigation landing mid-wait surfaces UID_STALE
    /// instead of acting on a superseded document. Eval failures propagate
    /// immediately (fail loud); only defined pending states retry.
    pub async fn wait_actionable(
        &self,
        uid: &str,
        kind: ActionKind,
        timeout: Duration,
    ) -> Result<(f64, f64), RpcError> {
        let timeout_ms = timeout.as_millis().min(u128::from(u64::MAX)) as u64;
        let deadline = std::time::Instant::now() + timeout;
        let poll = Duration::from_millis(crate::rpc::WAIT_POLL_MS);
        let mut last_state: String;
        loop {
            self.check_uid(uid)?;
            let value = self
                .eval_json(&actionability_js(uid))
                .await
                .map_err(|err| RpcError::internal(format!("actionability probe failed: {err}")))?;
            match classify_probe(&value, kind, uid) {
                ProbeOutcome::Ready { x, y } => return Ok((x, y)),
                ProbeOutcome::Failed(err) => return Err(err),
                ProbeOutcome::Pending(state) => {
                    last_state = state;
                    if std::time::Instant::now() >= deadline {
                        return Err(actionability_timeout(uid, &last_state, timeout_ms));
                    }
                    tokio::time::sleep(poll).await;
                }
            }
        }
    }

    /// Fire-and-forget listener setup for call sites that do not navigate
    /// (snapshot, eval): capture starts as soon as setup completes.
    /// Events are appended to bounded ring buffers; the listener tasks end
    /// when the tab's CDP session closes, so nothing outlives its tab.
    pub fn start_listeners(self: &Arc<Self>) {
        let tab = self.clone();
        tokio::spawn(async move {
            tab.ensure_listeners().await;
        });
    }

    /// Complete listener setup, awaiting enables AND subscriptions so a
    /// subsequent `Page.navigate` cannot outrun capture. Idempotent: only one
    /// task performs setup; concurrent callers wait for `listeners_ready`.
    pub async fn ensure_listeners(self: &Arc<Self>) {
        if self.listeners_ready.load(Ordering::SeqCst) {
            return;
        }
        if self
            .listeners_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            self.setup_listeners().await;
            return;
        }
        for _ in 0..100 {
            if self.listeners_ready.load(Ordering::SeqCst) {
                return;
            }
            if !self.listeners_started.load(Ordering::SeqCst)
                && self
                    .listeners_started
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
            {
                // A previous setup attempt failed; take over.
                self.setup_listeners().await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        debug!(tab = %self.id, "timed out waiting for listener setup");
    }

    /// Enables, subscriptions, then pump tasks. Runs once per tab.
    async fn setup_listeners(self: &Arc<Self>) {
        {
            use chromiumoxide::cdp::browser_protocol::log::EnableParams as LogEnable;
            use chromiumoxide::cdp::browser_protocol::network::EnableParams as NetEnable;
            use chromiumoxide::cdp::browser_protocol::page::EnableParams as PageEnable;
            use chromiumoxide::cdp::js_protocol::runtime::EnableParams as RtEnable;
            // Cold tabs may still be settling: retry the enables briefly
            // instead of leaving permanently-dead listeners behind.
            let mut enabled = false;
            for _ in 0..25 {
                let rt = self.exec(RtEnable {}).await.is_ok();
                let log = self.exec(LogEnable {}).await.is_ok();
                let net = self.exec(NetEnable::builder().build()).await.is_ok();
                // Page domain: required for `javascriptDialogOpening`. Without
                // it a page can block the renderer on an unhandled dialog.
                let page = self.exec(PageEnable::default()).await.is_ok();
                if rt && log && net && page {
                    enabled = true;
                    break;
                }
                if self.is_dead() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            if !enabled {
                warn!(tab = %self.id, "console/network/dialog enables never succeeded; listeners disabled for this tab");
                self.listeners_started.store(false, Ordering::SeqCst);
                return;
            }
        }

        use chromiumoxide::cdp::browser_protocol::log::EventEntryAdded;
        use chromiumoxide::cdp::browser_protocol::network::{
            EventRequestWillBeSent, EventResponseReceived,
        };
        use chromiumoxide::cdp::js_protocol::runtime::EventConsoleApiCalled;

        // Subscribe BEFORE any pump task exists: all five subscriptions must
        // predate the navigation this setup was awaited for.
        let Some(console_stream) = self.subscribe::<EventConsoleApiCalled>("console").await else {
            self.listeners_started.store(false, Ordering::SeqCst);
            return;
        };
        let Some(log_stream) = self.subscribe::<EventEntryAdded>("log").await else {
            self.listeners_started.store(false, Ordering::SeqCst);
            return;
        };
        let Some(will_be_sent) = self
            .subscribe::<EventRequestWillBeSent>("network-request")
            .await
        else {
            self.listeners_started.store(false, Ordering::SeqCst);
            return;
        };
        let Some(responded) = self
            .subscribe::<EventResponseReceived>("network-response")
            .await
        else {
            self.listeners_started.store(false, Ordering::SeqCst);
            return;
        };
        let Some(dialogs) = self
            .subscribe::<EventJavascriptDialogOpening>("dialog")
            .await
        else {
            self.listeners_started.store(false, Ordering::SeqCst);
            return;
        };

        let tab = self.clone();
        tokio::spawn(async move { Self::pump_console(tab, console_stream).await });
        let tab = self.clone();
        tokio::spawn(async move { Self::pump_log(tab, log_stream).await });
        let tab = self.clone();
        tokio::spawn(async move { Self::pump_network(tab, will_be_sent, responded).await });
        let tab = self.clone();
        tokio::spawn(async move { Self::pump_dialog(tab, dialogs).await });
        self.listeners_ready.store(true, Ordering::SeqCst);
    }

    /// Subscribe to one CDP event kind with retries. `None` after ~2s means
    /// the tab is too unsettled to capture from; the caller resets the setup
    /// flag so a later call retries.
    async fn subscribe<T>(&self, what: &str) -> Option<EventStream<T>>
    where
        T: IntoEventKind,
    {
        for _ in 0..10 {
            match self.page.event_listener::<T>().await {
                Ok(stream) => return Some(stream),
                Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
        warn!(tab = %self.id, "{what} listener subscription failed");
        None
    }

    async fn pump_console(tab: Arc<Self>, mut stream: EventStream<EventConsoleApiCalled>) {
        while let Some(event) = stream.next().await {
            let mut parts = Vec::new();
            for arg in &event.args {
                parts.push(remote_text(arg));
            }
            tab.push_console(ConsoleEntry {
                seq: 0,
                level: format!("{:?}", event.r#type).to_lowercase(),
                text: truncate_chars(&parts.join(" "), 2000),
                url: redact_url(&tab.url()),
                ts: now_ms(),
            });
        }
    }

    async fn pump_log(tab: Arc<Self>, mut stream: EventStream<EventEntryAdded>) {
        while let Some(event) = stream.next().await {
            tab.push_console(ConsoleEntry {
                seq: 0,
                level: event.entry.level.as_ref().to_string(),
                text: truncate_chars(&event.entry.text, 2000),
                url: event
                    .entry
                    .url
                    .as_deref()
                    .map(redact_url)
                    .unwrap_or_default(),
                ts: now_ms(),
            });
        }
    }

    /// A page dialog either gets handled here (default policy) or stays in the
    /// slot for the `dialog` method. Handling never takes `op_lock`: the pump
    /// must be able to unblock a tab whose in-flight op is waiting on JS.
    async fn pump_dialog(tab: Arc<Self>, mut stream: EventStream<EventJavascriptDialogOpening>) {
        while let Some(event) = stream.next().await {
            let info = DialogInfo {
                kind: event.r#type.as_ref().to_string(),
                message: truncate_chars(&event.message, 2000),
                default_prompt: event
                    .default_prompt
                    .as_deref()
                    .map(|prompt| truncate_chars(prompt, 500)),
                url: redact_url(&event.url),
                ts: now_ms(),
            };
            let manual = tab.dialog_manual.load(Ordering::SeqCst);
            tab.set_dialog(Some(info.clone()));
            if manual {
                continue;
            }
            // `beforeunload` must be accepted or navigation can never complete.
            let accept = info.kind == "beforeunload";
            let params = HandleJavaScriptDialogParams {
                accept,
                prompt_text: None,
            };
            if let Err(err) = tab.exec(params).await {
                warn!(tab = %tab.id, error = %err.message, "auto-handling a JavaScript dialog failed");
            }
            tab.set_dialog(None);
        }
    }

    async fn pump_network(
        tab: Arc<Self>,
        mut will_be_sent: EventStream<EventRequestWillBeSent>,
        mut responded: EventStream<EventResponseReceived>,
    ) {
        struct Pending {
            method: String,
            url: String,
            kind: String,
            t0: f64,
            headers: Vec<Header>,
        }
        let mut pending: HashMap<String, Pending> = HashMap::new();
        loop {
            tokio::select! {
                biased;
                next = will_be_sent.next() => {
                    let Some(event) = next else { break };
                    if pending.len() >= MAX_PENDING {
                        // Fail-soft, not fail-open: evict the single oldest
                        // pending request; each overflow loses one
                        // correlation (counted) instead of orphaning all of
                        // them on a chatty page.
                        if let Some(oldest) = pick_oldest_key(&pending, |p| p.t0) {
                            pending.remove(&oldest);
                            tab.net_drop_count.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    let kind = event
                        .r#type
                        .as_ref()
                        .map(|kind| format!("{kind:?}").to_lowercase())
                        .unwrap_or_else(|| "other".to_string());
                    pending.insert(
                        event.request_id.0.clone(),
                        Pending {
                            method: event.request.method.clone(),
                            url: redact_url(&event.request.url),
                            kind,
                            t0: event.timestamp.0,
                            headers: collect_headers(&event.request.headers),
                        },
                    );
                }
                next = responded.next() => {
                    let Some(event) = next else { break };
                    if let Some(request) = pending.remove(&event.request_id.0) {
                        let ms = (event.timestamp.0 - request.t0) * 1000.0;
                        let encoded = event.response.encoded_data_length;
                        tab.push_network(NetworkEntry {
                            seq: 0,
                            request_id: event.request_id.0.clone(),
                            method: request.method,
                            url: request.url,
                            status: event.response.status,
                            ms: if ms.is_finite() && ms >= 0.0 { ms } else { 0.0 },
                            kind: request.kind,
                            from_cache: event.response.from_disk_cache.unwrap_or(false)
                                || event.response.from_service_worker.unwrap_or(false),
                            encoded_bytes: if encoded.is_finite() && encoded >= 0.0 {
                                encoded as i64
                            } else {
                                0
                            },
                            request_headers: request.headers,
                            response_headers: collect_headers(&event.response.headers),
                            ts: now_ms(),
                        });
                    }
                }
            }
        }
    }

    // --- E lane: route construction, matching and interception ---------------
    // All trust-boundary logic lives here, next to the network pump. Matching
    // is literal string comparison only — no regex crate touches untrusted
    // input anywhere in this file.

    /// Build a validated [`MockRoute`] from raw client params. Every bound
    /// fails closed here, before any tab lookup or CDP call exists.
    pub fn new_route(
        pattern: String,
        kind: Option<String>,
        action: &str,
        status: Option<i64>,
        body: Option<String>,
        content_type: Option<String>,
    ) -> Result<MockRoute, RpcError> {
        if pattern.trim().is_empty() {
            return Err(RpcError::new(
                ErrorCode::Internal,
                "route needs a non-empty pattern",
                "pass a URL substring, prefix, or host to match, e.g. {\"pattern\": \"/api/ping\"}",
            ));
        }
        if pattern.chars().count() > MAX_ROUTE_PATTERN {
            return Err(RpcError::new(
                ErrorCode::Internal,
                format!(
                    "route pattern is {} chars, over the {} char limit",
                    pattern.chars().count(),
                    MAX_ROUTE_PATTERN
                ),
                "use a shorter, distinctive substring instead of a whole URL",
            ));
        }
        let kind = match kind.as_deref().unwrap_or("substring") {
            "substring" => RouteKind::Substring,
            "prefix" => RouteKind::Prefix,
            "host" => RouteKind::Host,
            other => {
                return Err(RpcError::new(
                    ErrorCode::Internal,
                    format!("invalid route kind {other:?}: expected substring, prefix or host"),
                    "omit kind for a substring match",
                ));
            }
        };
        if kind == RouteKind::Host && !Self::is_valid_host_pattern(&pattern) {
            return Err(RpcError::new(
                ErrorCode::Internal,
                format!("invalid route host pattern {pattern:?}"),
                "pass a bare hostname without scheme, path or port, e.g. {\"kind\": \"host\", \"pattern\": \"example.com\"}",
            ));
        }
        let action = match action {
            "fulfill" => RouteAction::Fulfill,
            "abort" => RouteAction::Abort,
            other => {
                return Err(RpcError::new(
                    ErrorCode::Internal,
                    format!("invalid route action {other:?}: expected fulfill or abort"),
                    "fulfill serves a fixture body; abort fails the request",
                ));
            }
        };
        // Fulfill-only fields are rejected with abort, never silently dropped:
        // a stored-but-unenforced option would be fail-open.
        if action == RouteAction::Abort
            && (status.is_some() || body.is_some() || content_type.is_some())
        {
            return Err(RpcError::new(
                ErrorCode::Internal,
                "abort routes take no status, body or content_type",
                "omit the fulfill-only fields, or use action fulfill",
            ));
        }
        let status = status.unwrap_or(200);
        if !(100..=599).contains(&status) {
            return Err(RpcError::new(
                ErrorCode::Internal,
                format!("route status {status} is outside 100-599"),
                "use a valid HTTP status code, e.g. 200 or 404",
            ));
        }
        let body = body.unwrap_or_default();
        if body.len() > MAX_ROUTE_BODY_BYTES {
            return Err(RpcError::new(
                ErrorCode::Internal,
                format!(
                    "route body is {} bytes, over the {} byte limit",
                    body.len(),
                    MAX_ROUTE_BODY_BYTES
                ),
                "serve a smaller fixture, or split the mock across routes",
            ));
        }
        let content_type = content_type.unwrap_or_else(|| "text/plain; charset=utf-8".to_string());
        if content_type.len() > MAX_ROUTE_CONTENT_TYPE || !Self::is_safe_content_type(&content_type)
        {
            return Err(RpcError::new(
                ErrorCode::Internal,
                "route content_type must be printable ASCII with a type/subtype, max 128 chars",
                "pass a plain content type, e.g. \"application/json\"",
            ));
        }
        Ok(MockRoute {
            pattern,
            kind,
            action,
            status,
            body,
            content_type,
        })
    }

    /// Bare-hostname shape for `host` patterns: no scheme, path, port,
    /// userinfo or whitespace, so `example.com` can never smuggle a URL.
    fn is_valid_host_pattern(pattern: &str) -> bool {
        !pattern.is_empty()
            && !pattern.contains("://")
            && !pattern
                .chars()
                .any(|c| c.is_whitespace() || matches!(c, '/' | '?' | '#' | '@' | ':'))
    }

    /// `content-type` hygiene: printable ASCII only (no CR/LF to inject
    /// headers through) with a `type/subtype` slash.
    fn is_safe_content_type(value: &str) -> bool {
        !value.is_empty()
            && value.contains('/')
            && value.bytes().all(|b| (0x20..=0x7E).contains(&b))
    }

    /// Literal match only: substring containment, prefix, or exact host
    /// (case-insensitive DNS comparison). `*` and `?` match themselves.
    fn route_matches(route: &MockRoute, url: &str) -> bool {
        match route.kind {
            RouteKind::Substring => url.contains(&route.pattern),
            RouteKind::Prefix => url.starts_with(&route.pattern),
            RouteKind::Host => {
                Self::url_host(url).is_some_and(|host| host.eq_ignore_ascii_case(&route.pattern))
            }
        }
    }

    /// Authority host of an absolute URL, without userinfo or port. Returns
    /// `None` for relative URLs and malformed authorities (fail closed: no
    /// match rather than a guessed match).
    fn url_host(url: &str) -> Option<&str> {
        let rest = url.split("://").nth(1)?;
        let authority = rest.split(['/', '?', '#']).next()?;
        let host_port = authority.rsplit('@').next()?;
        let host = if let Some(after_bracket) = host_port.strip_prefix('[') {
            after_bracket.split(']').next()?
        } else {
            host_port.split(':').next()?
        };
        (!host.is_empty()).then_some(host)
    }

    /// The ONLY headers a fulfilled mock sends: exactly `content-type`.
    /// Request headers — and their secrets — are never reflected into a mock.
    fn fulfill_response_headers(content_type: &str) -> Vec<HeaderEntry> {
        vec![HeaderEntry::new("content-type", content_type.to_string())]
    }

    /// First matching route wins (insertion order); `None` = passthrough.
    pub fn match_route(&self, url: &str) -> Option<MockRoute> {
        let routes = lock(&self.routes);
        routes
            .iter()
            .find(|route| Self::route_matches(route, url))
            .cloned()
    }

    /// Bounded insert shared by the handler; the per-tab table never grows
    /// past `MAX_ROUTES_PER_TAB` (fail closed, never evict another mock).
    fn push_route(routes: &mut Vec<MockRoute>, route: MockRoute) -> Result<usize, RpcError> {
        if routes.len() >= MAX_ROUTES_PER_TAB {
            return Err(RpcError::new(
                ErrorCode::Internal,
                format!("route table full ({MAX_ROUTES_PER_TAB} per tab)"),
                "close the tab to clear its mocks, then add routes on a fresh tab",
            ));
        }
        routes.push(route);
        Ok(routes.len())
    }

    /// Record a validated mock on this tab. The table is bounded; clearing
    /// happens in [`Tab::mark_dead`] (close/remove_all/sweep funnel there).
    pub fn add_route(&self, route: MockRoute) -> Result<usize, RpcError> {
        let mut routes = lock(&self.routes);
        Self::push_route(&mut routes, route)
    }

    /// Arm `Fetch.enable` (all URLs paused) and spawn the intercept pump, once
    /// per tab. Idempotent: exactly one task enables + pumps; concurrent
    /// callers wait briefly for `fetch_armed` instead of double-enabling.
    pub async fn ensure_fetch_intercept(self: &Arc<Self>) -> Result<(), RpcError> {
        if self.fetch_armed.load(Ordering::SeqCst) {
            return Ok(());
        }
        if self
            .fetch_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            use chromiumoxide::cdp::browser_protocol::fetch::EnableParams;
            let result = self
                .exec_timeout(EnableParams::builder().build(), Duration::from_secs(10))
                .await;
            match result {
                Ok(_) => {
                    let tab = self.clone();
                    tokio::spawn(async move { Self::pump_fetch(tab).await });
                    self.fetch_armed.store(true, Ordering::SeqCst);
                    Ok(())
                }
                Err(err) => {
                    self.fetch_started.store(false, Ordering::SeqCst);
                    Err(err)
                }
            }
        } else {
            for _ in 0..50 {
                if self.fetch_armed.load(Ordering::SeqCst) {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(RpcError::new(
                ErrorCode::Internal,
                "fetch intercept did not arm in time",
                "retry the route call; report a daemon bug if it persists",
            ))
        }
    }

    /// Intercept pump: every paused request gets exactly one answer —
    /// fulfill, fail, or continue — so the page can never wedge on an
    /// unanswered pause. A dead tab has no routes (cleared in `mark_dead`),
    /// so late pauses fall through to passthrough.
    async fn pump_fetch(tab: Arc<Self>) {
        use chromiumoxide::cdp::browser_protocol::fetch::{
            ContinueRequestParams, FailRequestParams, FulfillRequestParams,
        };
        let Some(mut stream) = tab.subscribe::<EventRequestPaused>("fetch").await else {
            tab.fetch_started.store(false, Ordering::SeqCst);
            warn!(tab = %tab.id, "fetch listener subscription failed; routes unenforced");
            return;
        };
        while let Some(event) = stream.next().await {
            let decision = tab.match_route(&event.request.url);
            let request_id = event.request_id.clone();
            let answered = match decision {
                None => tab
                    .exec(ContinueRequestParams::new(request_id))
                    .await
                    .map(|_| ()),
                Some(route) if route.action == RouteAction::Abort => tab
                    .exec(FailRequestParams::new(
                        request_id,
                        ErrorReason::BlockedByClient,
                    ))
                    .await
                    .map(|_| ()),
                Some(route) => {
                    let body = BASE64.encode(route.body.as_bytes());
                    let mut params = FulfillRequestParams::new(request_id, route.status);
                    params.response_headers =
                        Some(Self::fulfill_response_headers(&route.content_type));
                    params.body = Some(Binary::from(body));
                    tab.exec(params).await.map(|_| ())
                }
            };
            if let Err(err) = answered {
                // The pause may have lapsed (navigation, double answer) — log
                // and keep pumping: one missed answer must not kill mocks.
                debug!(tab = %tab.id, error = %err.message, "fetch answer failed");
            }
        }
    }

    fn push_console(&self, mut entry: ConsoleEntry) {
        entry.seq = self.console_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let mut buf = lock(&self.console);
        while buf.len() >= BUFFER_CAP {
            buf.pop_front();
        }
        buf.push_back(entry);
    }

    fn push_network(&self, mut entry: NetworkEntry) {
        entry.seq = self.network_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let mut buf = lock(&self.network);
        while buf.len() >= BUFFER_CAP {
            buf.pop_front();
        }
        buf.push_back(entry);
    }

    /// Oldest-first, capped at `limit`, with a truncation flag and the cursor
    /// to pass back as `since`. Without `since` the newest `limit` entries are
    /// returned (tail); with `since` the oldest unread ones (head), so a caller
    /// polling in a loop cannot silently skip entries.
    pub fn drain_console(
        &self,
        limit: usize,
        level: Option<&str>,
        since: Option<u64>,
    ) -> (Vec<ConsoleEntry>, bool, u64) {
        let buf = lock(&self.console);
        drain_buffered(
            &buf,
            limit,
            since,
            self.console_seq.load(Ordering::SeqCst),
            |entry| entry.seq,
            |entry| level.is_none_or(|want| entry.level.eq_ignore_ascii_case(want)),
        )
    }

    pub fn drain_network(
        &self,
        limit: usize,
        filter: Option<&str>,
        since: Option<u64>,
    ) -> (Vec<NetworkEntry>, bool, u64) {
        let buf = lock(&self.network);
        drain_buffered(
            &buf,
            limit,
            since,
            self.network_seq.load(Ordering::SeqCst),
            |entry| entry.seq,
            |entry| {
                filter.is_none_or(|want| {
                    entry.url.contains(want) || entry.method.eq_ignore_ascii_case(want)
                })
            },
        )
    }

    /// Read one response body by request id. Chrome evicts bodies after a
    /// navigation or when its cache fills; that surfaces as `BODY_UNAVAILABLE`,
    /// never as a generic internal error.
    pub async fn response_body(
        &self,
        request_id: &str,
        max_bytes: usize,
    ) -> Result<Value, RpcError> {
        if self.is_dead() || !self.chrome_alive.load(Ordering::SeqCst) {
            return Err(RpcError::chrome_dead(format!(
                "tab {} has no live browser",
                self.id
            )));
        }
        let params = GetResponseBodyParams::new(request_id.to_string());
        let payload =
            match tokio::time::timeout(Duration::from_secs(10), self.page.execute(params)).await {
                Ok(Ok(response)) => response.result,
                Ok(Err(err)) => {
                    return Err(RpcError::body_unavailable(request_id, &err.to_string()));
                }
                Err(_) => {
                    return Err(RpcError::body_unavailable(
                        request_id,
                        "Chrome did not answer within 10s",
                    ));
                }
            };
        let (body, total, truncated) =
            decode_body(&payload.body, payload.base64_encoded, max_bytes)
                .map_err(|err| RpcError::body_unavailable(request_id, &err))?;
        Ok(serde_json::json!({
            "request_id": request_id,
            "body": body,
            "base64_encoded": payload.base64_encoded,
            "bytes": total,
            "returned_bytes": body.len(),
            "truncated": truncated,
        }))
    }
}

/// Truncate at a UTF-8 boundary. Returns `(text, truncated, original_bytes)`.
fn truncate_utf8(text: &str, max_bytes: usize) -> (String, bool, usize) {
    let total = text.len();
    if total <= max_bytes {
        return (text.to_string(), false, total);
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true, total)
}

/// Decode a CDP body payload. Returns `(text, original_bytes, truncated)`.
fn decode_body(
    payload: &str,
    base64_encoded: bool,
    max_bytes: usize,
) -> Result<(String, usize, bool), String> {
    if base64_encoded {
        // Bound the decode: keep whole 4-char groups so the tail still parses.
        let take = (MAX_BODY_B64_CHARS / 4) * 4;
        let encoded: String = payload.chars().take(take).collect();
        let decoded = BASE64
            .decode(encoded.as_bytes())
            .map_err(|err| format!("invalid base64 body: {err}"))?;
        let total = decoded.len();
        let cut = total.min(max_bytes);
        Ok((
            String::from_utf8_lossy(&decoded[..cut]).into_owned(),
            total,
            total > cut,
        ))
    } else {
        let (text, truncated, total) = truncate_utf8(payload, max_bytes);
        Ok((text, total, truncated))
    }
}

/// Shared ring-buffer read logic for console/network entries.
///
/// Returns `(entries, truncated, next_since)`. The cursor advances only over
/// entries actually returned, so a truncated response can be resumed.
pub fn drain_buffered<T: Clone>(
    buf: &VecDeque<T>,
    limit: usize,
    since: Option<u64>,
    latest_seq: u64,
    seq_of: impl Fn(&T) -> u64,
    matches: impl Fn(&T) -> bool,
) -> (Vec<T>, bool, u64) {
    let matching: Vec<&T> = buf
        .iter()
        .filter(|entry| since.is_none_or(|cursor| seq_of(entry) > cursor))
        .filter(|entry| matches(entry))
        .collect();
    let truncated = matching.len() > limit;
    let selected: Vec<T> = match since {
        // Incremental read: oldest unread first, so the cursor never skips.
        Some(_) => matching
            .iter()
            .take(limit)
            .map(|entry| (*entry).clone())
            .collect(),
        // Snapshot read: newest entries are the interesting ones.
        None => {
            let start = matching.len().saturating_sub(limit);
            matching[start..]
                .iter()
                .map(|entry| (*entry).clone())
                .collect()
        }
    };
    let next_since = match selected.last() {
        Some(entry) => seq_of(entry),
        None => since.unwrap_or(latest_seq),
    };
    (selected, truncated, next_since)
}

/// Truncate to `max` chars on a char boundary (never splits UTF-8).
pub(crate) fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

/// Short human-readable rendering of a console argument.
fn remote_text(object: &chromiumoxide::cdp::js_protocol::runtime::RemoteObject) -> String {
    if let Some(value) = object.value.as_ref() {
        if let Some(text) = value.as_str() {
            return text.to_string();
        }
        return value.to_string();
    }
    if let Some(unserializable) = object.unserializable_value.as_ref() {
        return unserializable.0.clone();
    }
    object.description.clone().unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
pub struct TabInfo {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub owner: Option<String>,
    pub last_used: u64,
    pub generation: u64,
    pub alive: bool,
}

struct Inner {
    tabs: BTreeMap<String, Arc<Tab>>,
    sessions: HashMap<String, String>,
    next_id: u64,
}

pub struct TabRegistry {
    inner: RwLock<Inner>,
    max_tabs: usize,
    ttl_ms: u64,
}

impl TabRegistry {
    pub fn new(max_tabs: usize, ttl: Duration) -> Self {
        Self {
            inner: RwLock::new(Inner {
                tabs: BTreeMap::new(),
                sessions: HashMap::new(),
                next_id: 0,
            }),
            max_tabs: max_tabs.max(1),
            ttl_ms: ttl.as_millis() as u64,
        }
    }

    pub fn max_tabs(&self) -> usize {
        self.max_tabs
    }

    pub async fn count(&self) -> usize {
        self.inner.read().await.tabs.len()
    }

    pub async fn session_count(&self) -> usize {
        self.inner.read().await.sessions.len()
    }

    /// Global mean `op_lock` queue wait in ms across live tabs, or `None`
    /// when no op ever acquired the lock. Sums only — no /proc walk, no new
    /// syscalls — so it is safe to expose in `status` (verbose only).
    pub async fn op_wait_mean_ms(&self) -> Option<u64> {
        let inner = self.inner.read().await;
        let mut total = 0u64;
        let mut count = 0u64;
        for tab in inner.tabs.values() {
            total = total.saturating_add(tab.op_wait_total_ms.load(Ordering::Relaxed));
            count = count.saturating_add(tab.op_wait_count.load(Ordering::Relaxed));
        }
        (count > 0).then(|| total / count)
    }

    pub async fn current(&self, session: &str) -> Option<Arc<Tab>> {
        let inner = self.inner.read().await;
        let id = inner.sessions.get(session)?;
        let tab = inner.tabs.get(id)?;
        if tab.is_dead() {
            return None;
        }
        tab.touch();
        Some(tab.clone())
    }

    /// Resolve an explicit `tab_id`, or the caller's current tab.
    pub async fn resolve(&self, session: &str, tab_id: Option<&str>) -> Result<Arc<Tab>, RpcError> {
        let inner = self.inner.read().await;
        match tab_id {
            Some(id) => {
                let tab = inner
                    .tabs
                    .get(id)
                    .ok_or_else(|| RpcError::tab_not_found(format!("tab {id} does not exist")))?;
                if tab.is_dead() {
                    return Err(RpcError::tab_not_found(format!("tab {id} is closed")));
                }
                tab.assert_owned_by(session)?;
                tab.touch();
                Ok(tab.clone())
            }
            None => {
                let id = inner.sessions.get(session).ok_or_else(|| {
                    RpcError::tab_not_found(format!("session {session} has no open tab"))
                })?;
                let tab = inner
                    .tabs
                    .get(id)
                    .ok_or_else(|| RpcError::tab_not_found(format!("tab {id} does not exist")))?;
                if tab.is_dead() {
                    return Err(RpcError::tab_not_found(format!("tab {id} is closed")));
                }
                tab.touch();
                Ok(tab.clone())
            }
        }
    }

    /// Resolve the caller's tab, creating one (and Chrome) when needed.
    pub async fn resolve_or_create(
        &self,
        session: &str,
        chrome: &ChromeManager,
    ) -> Result<Arc<Tab>, RpcError> {
        if let Some(tab) = self.current(session).await {
            return Ok(tab);
        }
        self.create(session, chrome).await
    }

    async fn create(&self, session: &str, chrome: &ChromeManager) -> Result<Arc<Tab>, RpcError> {
        let instance = chrome.ensure().await?;

        if let Some(victim) = self.make_room(session).await? {
            debug!(tab = %victim.id, "evicting idle tab to stay under the tab limit");
            self.detach_and_close(&victim).await;
        }

        let page = instance.new_page().await?;
        let id = {
            let mut inner = self.inner.write().await;
            inner.next_id += 1;
            format!("t{}", inner.next_id)
        };
        let tab = Arc::new(Tab::new(id.clone(), page, session, instance.alive.clone()));

        let mut inner = self.inner.write().await;
        // Another task may have created the session's tab while we awaited.
        if let Some(existing_id) = inner.sessions.get(session).cloned() {
            if let Some(existing) = inner.tabs.get(&existing_id).cloned() {
                drop(inner);
                let target = tab.page.target_id().clone();
                let _ = tokio::time::timeout(
                    Duration::from_secs(2),
                    tab.page.execute(CloseTargetParams::new(target)),
                )
                .await;
                return Ok(existing);
            }
        }
        inner.tabs.insert(id.clone(), tab.clone());
        inner.sessions.insert(session.to_string(), id);
        Ok(tab)
    }

    async fn make_room(&self, session: &str) -> Result<Option<Arc<Tab>>, RpcError> {
        let now = now_ms();
        let mut inner = self.inner.write().await;
        if inner.tabs.len() < self.max_tabs {
            return Ok(None);
        }
        let entries: Vec<(String, Option<String>, u64)> = inner
            .tabs
            .values()
            .map(|tab| (tab.id.clone(), tab.owner(), tab.last_used()))
            .collect();
        let victim = pick_eviction(&entries, session, self.ttl_ms, now).ok_or_else(|| {
            RpcError::new(
                ErrorCode::TabLimit,
                format!(
                    "tab limit ({}) reached with no evictable tab",
                    self.max_tabs
                ),
                "close a tab with browse_close_tab, or wait for the 10 minute lease to expire",
            )
        })?;
        let removed = inner.tabs.remove(&victim);
        if let Some(tab) = &removed {
            inner.sessions.retain(|_, tab_id| tab_id != &victim);
            tab.mark_dead();
        }
        Ok(removed)
    }

    /// Remove a tab that was already taken out of the registry, then close its
    /// CDP target.
    async fn detach_and_close(&self, tab: &Arc<Tab>) {
        tab.mark_dead();
        let target = tab.page.target_id().clone();
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            tab.page.execute(CloseTargetParams::new(target)),
        )
        .await;
    }

    pub async fn close(&self, session: &str, tab_id: &str) -> Result<bool, RpcError> {
        let tab =
            {
                let inner = self.inner.read().await;
                inner.tabs.get(tab_id).cloned().ok_or_else(|| {
                    RpcError::tab_not_found(format!("tab {tab_id} does not exist"))
                })?
            };
        tab.assert_owned_by(session)?;

        {
            let mut inner = self.inner.write().await;
            inner.tabs.remove(tab_id);
            inner.sessions.retain(|_, id| id != tab_id);
        }
        self.detach_and_close(&tab).await;
        Ok(true)
    }

    pub async fn list(&self) -> Vec<TabInfo> {
        let inner = self.inner.read().await;
        inner
            .tabs
            .values()
            .map(|tab| TabInfo {
                tab_id: tab.id.clone(),
                url: tab.url(),
                title: tab.title(),
                owner: tab.owner(),
                last_used: tab.last_used(),
                generation: tab.generation(),
                alive: !tab.is_dead(),
            })
            .collect()
    }

    /// Drop every tab after the browser died. Uids are invalidated and the
    /// session map is cleared so the next call recreates tabs on the new Chrome.
    pub async fn remove_all(&self) -> usize {
        let mut inner = self.inner.write().await;
        let tabs: Vec<Arc<Tab>> = inner.tabs.values().cloned().collect();
        inner.tabs.clear();
        inner.sessions.clear();
        for tab in &tabs {
            tab.mark_dead();
        }
        tabs.len()
    }

    /// Close tabs whose lease expired and that are not currently in use.
    pub async fn sweep(&self) -> usize {
        let now = now_ms();
        let candidates: Vec<Arc<Tab>> = {
            let inner = self.inner.read().await;
            inner
                .tabs
                .values()
                .filter(|tab| now.saturating_sub(tab.last_used()) > self.ttl_ms)
                .cloned()
                .collect()
        };

        let mut closed = 0;
        for tab in candidates {
            let Ok(_guard) = tab.op_lock.try_lock() else {
                continue;
            };
            let removed = {
                let mut inner = self.inner.write().await;
                let removed = inner.tabs.remove(&tab.id);
                inner.sessions.retain(|_, id| id != &tab.id);
                removed
            };
            if removed.is_some() {
                self.detach_and_close(&tab).await;
                closed += 1;
            }
        }
        closed
    }
}

/// Overflow policy for the network pump's pending map: return the key with
/// the smallest `t0` so exactly one correlation is dropped per overflow
/// instead of `clear()`-ing all of them (fail-open on chatty pages: one
/// burst orphaned up to 1000 in-flight responses).
fn pick_oldest_key<V>(map: &HashMap<String, V>, t0_of: impl Fn(&V) -> f64) -> Option<String> {
    map.iter()
        .min_by(|a, b| {
            t0_of(a.1)
                .partial_cmp(&t0_of(b.1))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(id, _)| id.clone())
}

/// Choose a tab to evict: never the caller's own tab, never a live tab owned by
/// another active session unless its lease expired. Oldest `last_used` wins.
pub fn pick_eviction(
    tabs: &[(String, Option<String>, u64)],
    current_session: &str,
    ttl_ms: u64,
    now: u64,
) -> Option<String> {
    let mut best: Option<(&String, u64)> = None;
    for (id, owner, last_used) in tabs {
        if owner.as_deref() == Some(current_session) {
            continue;
        }
        let idle = now.saturating_sub(*last_used);
        let eligible = owner.is_none() || idle >= ttl_ms;
        if !eligible {
            continue;
        }
        match best {
            Some((_, best_used)) if best_used <= *last_used => {}
            _ => best = Some((id, *last_used)),
        }
    }
    best.map(|(id, _)| id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uid_parsing_accepts_only_the_generated_shape() {
        assert_eq!(parse_uid("g7-3"), Some((7, 3)));
        assert_eq!(parse_uid("g12-340"), Some((12, 340)));
        assert_eq!(parse_uid("g7"), None);
        assert_eq!(parse_uid("7-3"), None);
        assert_eq!(parse_uid("g7-"), None);
        assert_eq!(parse_uid("g-3"), None);
        assert_eq!(parse_uid("g7-x"), None);
        assert_eq!(parse_uid("g7-3-4"), None);
        assert_eq!(parse_uid("G7-3"), None);
    }

    #[test]
    fn eviction_never_takes_the_callers_tab() {
        let tabs = vec![
            ("t1".to_string(), Some("me".to_string()), 10),
            ("t2".to_string(), Some("me".to_string()), 5),
        ];
        assert_eq!(pick_eviction(&tabs, "me", 60_000, 100_000), None);
    }

    #[test]
    fn eviction_prefers_unowned_then_oldest_idle() {
        let tabs = vec![
            ("t1".to_string(), Some("other".to_string()), 99_000),
            ("t2".to_string(), None, 98_000),
            ("t3".to_string(), Some("other".to_string()), 99_500),
        ];
        // t2 is unowned; t1 and t3 leases are still valid.
        assert_eq!(
            pick_eviction(&tabs, "me", 10_000, 100_000).as_deref(),
            Some("t2")
        );

        let expired = vec![
            ("t1".to_string(), Some("other".to_string()), 50_000),
            ("t2".to_string(), Some("third".to_string()), 40_000),
        ];
        assert_eq!(
            pick_eviction(&expired, "me", 10_000, 100_000).as_deref(),
            Some("t2")
        );
    }

    #[test]
    fn eviction_returns_none_when_every_tab_is_actively_owned() {
        let tabs = vec![("t1".to_string(), Some("other".to_string()), 99_999)];
        assert_eq!(pick_eviction(&tabs, "me", 10_000, 100_000), None);
    }

    #[test]
    fn pending_overflow_evicts_only_the_oldest() {
        let mut map: HashMap<String, f64> = HashMap::new();
        map.insert("a".to_string(), 3.0);
        map.insert("b".to_string(), 1.0);
        map.insert("c".to_string(), 2.0);
        assert_eq!(pick_oldest_key(&map, |t0| *t0).as_deref(), Some("b"));
    }

    #[test]
    fn pending_overflow_with_no_entries_evicts_nothing() {
        let map: HashMap<String, f64> = HashMap::new();
        assert_eq!(pick_oldest_key(&map, |t0| *t0), None);
    }

    #[test]
    fn pending_overflow_with_nan_t0_still_returns_a_key() {
        let mut map: HashMap<String, f64> = HashMap::new();
        map.insert("a".to_string(), f64::NAN);
        map.insert("b".to_string(), 1.0);
        // NaN never compares less; the fallback keeps this total and
        // panic-free so the pump cannot wedge on a bad timestamp.
        assert!(pick_oldest_key(&map, |t0| *t0).is_some());
    }

    #[derive(Clone, Debug)]
    struct Row {
        seq: u64,
        keep: bool,
    }

    fn rows(count: u64) -> VecDeque<Row> {
        (1..=count)
            .map(|seq| Row {
                seq,
                keep: seq % 2 == 0,
            })
            .collect()
    }

    #[test]
    fn drain_without_cursor_returns_the_newest_window() {
        let buf = rows(10);
        let (out, truncated, next) = drain_buffered(&buf, 3, None, 10, |r| r.seq, |_| true);
        assert_eq!(
            out.iter().map(|r| r.seq).collect::<Vec<_>>(),
            vec![8, 9, 10]
        );
        assert!(truncated);
        assert_eq!(next, 10);
    }

    #[test]
    fn drain_with_cursor_returns_oldest_unread_and_advances() {
        let buf = rows(10);
        let (out, truncated, next) = drain_buffered(&buf, 3, Some(2), 10, |r| r.seq, |_| true);
        assert_eq!(out.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![3, 4, 5]);
        assert!(truncated);
        assert_eq!(next, 5, "cursor must not skip the unread tail");

        let (out, truncated, next) = drain_buffered(&buf, 3, Some(5), 10, |r| r.seq, |_| true);
        assert_eq!(out.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![6, 7, 8]);
        assert!(truncated);
        assert_eq!(next, 8);
    }

    #[test]
    fn drain_with_cursor_and_no_new_entries_keeps_the_cursor() {
        let buf = rows(4);
        let (out, truncated, next) = drain_buffered(&buf, 10, Some(4), 4, |r| r.seq, |_| true);
        assert!(out.is_empty());
        assert!(!truncated);
        assert_eq!(next, 4);
    }

    #[test]
    fn drain_applies_the_filter_before_the_window() {
        let buf = rows(10);
        let (out, _, next) = drain_buffered(&buf, 2, None, 10, |r| r.seq, |r| r.keep);
        assert_eq!(out.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![8, 10]);
        assert_eq!(next, 10);
    }

    #[test]
    fn collect_headers_redacts_secrets_case_insensitively() {
        let headers = Headers::new(serde_json::json!({
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-live-secret",
            "COOKIE": "session=abc",
            "Set-Cookie": "a=b; HttpOnly",
            "X-Api-Key": "k-123",
            "X-Trace": "abc",
        }));
        let collected = collect_headers(&headers);
        let get = |name: &str| {
            collected
                .iter()
                .find(|header| header.name.eq_ignore_ascii_case(name))
                .map(|header| header.value.as_str())
                .unwrap_or("")
        };
        assert_eq!(get("content-type"), "application/json");
        assert_eq!(get("authorization"), "[redacted]");
        assert_eq!(get("cookie"), "[redacted]");
        assert_eq!(get("set-cookie"), "[redacted]");
        assert_eq!(get("x-api-key"), "[redacted]");
        assert_eq!(get("x-trace"), "abc");
    }

    #[test]
    fn collect_headers_bounds_count_and_value_length() {
        let mut map = serde_json::Map::new();
        for i in 0..(MAX_HEADERS + 10) {
            map.insert(format!("x-{i}"), Value::String("v".to_string()));
        }
        map.insert("a-long".to_string(), Value::String("y".repeat(2000)));
        let collected = collect_headers(&Headers::new(Value::Object(map)));
        assert_eq!(collected.len(), MAX_HEADERS);
        let long = collected
            .iter()
            .find(|header| header.name == "a-long")
            .expect("early-sorting header kept");
        assert!(long.value.chars().count() <= MAX_HEADER_VALUE + 1);
    }

    #[test]
    fn truncate_utf8_never_splits_a_char() {
        let text = "aé€𝄞"; // 1 + 2 + 3 + 4 bytes
        let (cut, truncated, total) = truncate_utf8(text, 3);
        assert_eq!(total, text.len());
        assert!(truncated);
        assert_eq!(cut, "aé", "byte 3 is the start of €, so it is a valid cut");
        let (cut, _, _) = truncate_utf8(text, 4);
        assert_eq!(cut, "aé", "byte 4 is inside €, so back off to byte 3");
        let (cut, truncated, _) = truncate_utf8(text, 100);
        assert!(!truncated);
        assert_eq!(cut, text);
    }

    #[test]
    fn decode_body_passes_plain_text_and_truncates() {
        let (body, total, truncated) = decode_body("hello world", false, 5).expect("decode");
        assert_eq!(body, "hello");
        assert_eq!(total, 11);
        assert!(truncated);

        let (body, total, truncated) = decode_body("hello", false, 5).expect("decode");
        assert_eq!(body, "hello");
        assert_eq!(total, 5);
        assert!(!truncated);
    }

    #[test]
    fn decode_body_decodes_base64_and_truncates() {
        // "hello world" in base64.
        let (body, total, truncated) = decode_body("aGVsbG8gd29ybGQ=", true, 5).expect("decode");
        assert_eq!(body, "hello");
        assert_eq!(total, 11);
        assert!(truncated);

        let (body, _, truncated) = decode_body("aGVsbG8gd29ybGQ=", true, 1024).expect("decode");
        assert_eq!(body, "hello world");
        assert!(!truncated);
    }

    #[test]
    fn decode_body_reports_invalid_base64() {
        let err = decode_body("!!!not-base64!!!", true, 1024).expect_err("must fail");
        assert!(err.contains("invalid base64"), "{err}");
    }

    #[test]
    fn action_kind_flags_match_playwright_check_sets() {
        assert!(ActionKind::Click.needs_hit_test());
        assert!(ActionKind::Hover.needs_hit_test());
        assert!(!ActionKind::Fill.needs_hit_test());
        assert!(!ActionKind::Select.needs_hit_test());
        assert!(ActionKind::Fill.needs_editable());
        assert!(!ActionKind::Click.needs_editable());
        assert!(!ActionKind::Hover.needs_editable());
        assert!(!ActionKind::Select.needs_editable());
    }

    #[test]
    fn actionability_timeout_is_a_typed_timeout() {
        let err = actionability_timeout("g7-3", "hidden", 10_000);
        assert_eq!(err.code, ErrorCode::NavTimeout);
        assert!(err.message.contains("g7-3"), "{err}");
        assert!(err.message.contains("hidden"), "{err}");
        assert!(err.message.contains("10000"), "{err}");
        assert!(!err.hint.is_empty());
    }

    #[test]
    fn actionability_js_escapes_uid_and_probes_all_checks() {
        let js = actionability_js("g7-3");
        assert!(
            js.contains("[data-oc-uid="),
            "queries the snapshot uid attribute"
        );
        assert!(
            js.contains("\"g7-3\""),
            "uid is a JSON string literal, never interpolated raw"
        );
        for fragment in [
            "scrollIntoView",
            "elementFromPoint",
            "requestAnimationFrame",
            "isConnected",
            "aria-disabled",
            "getComputedStyle",
        ] {
            assert!(js.contains(fragment), "probe covers {fragment}");
        }
    }

    #[test]
    fn classify_probe_maps_states_to_outcomes() {
        let ready =
            serde_json::json!({"ok": true, "x": 10.0, "y": 20.0, "cover": "", "editable": true});
        assert!(matches!(
            classify_probe(&ready, ActionKind::Click, "g7-3"),
            ProbeOutcome::Ready { x, y } if x == 10.0 && y == 20.0
        ));
        // Cover blocks click/hover (receives-events) but not fill/select.
        let covered = serde_json::json!({"ok": true, "x": 1.0, "y": 2.0, "cover": "div \"banner\"", "editable": true});
        assert!(matches!(
            classify_probe(&covered, ActionKind::Click, "g7-3"),
            ProbeOutcome::Failed(_)
        ));
        assert!(matches!(
            classify_probe(&covered, ActionKind::Fill, "g7-3"),
            ProbeOutcome::Ready { .. }
        ));
        // Readonly blocks fill only, as a retryable pending state.
        let readonly =
            serde_json::json!({"ok": true, "x": 1.0, "y": 2.0, "cover": "", "editable": false});
        assert!(matches!(
            classify_probe(&readonly, ActionKind::Fill, "g7-3"),
            ProbeOutcome::Pending(_)
        ));
        assert!(matches!(
            classify_probe(&readonly, ActionKind::Click, "g7-3"),
            ProbeOutcome::Ready { .. }
        ));
        // Missing is terminal (today's instant UID_NOT_FOUND); hidden/disabled poll.
        let missing = serde_json::json!({"ok": false, "reason": "missing"});
        assert!(matches!(
            classify_probe(&missing, ActionKind::Click, "g7-3"),
            ProbeOutcome::Failed(_)
        ));
        for state in ["hidden", "disabled", "unstable"] {
            let pending = serde_json::json!({"ok": false, "reason": state});
            assert!(
                matches!(
                    classify_probe(&pending, ActionKind::Click, "g7-3"),
                    ProbeOutcome::Pending(_)
                ),
                "{state} must poll, not fail"
            );
        }
    }

    // --- E lane: route trust boundary ------------------------------------

    fn fulfill_route(pattern: &str) -> MockRoute {
        Tab::new_route(
            pattern.to_string(),
            None,
            "fulfill",
            Some(200),
            Some(r#"{"pong":"mock"}"#.to_string()),
            Some("application/json".to_string()),
        )
        .expect("valid fulfill route")
    }

    #[test]
    fn route_fulfill_matches_substring_and_passthrough_misses() {
        let route = fulfill_route("/api/ping");
        assert!(Tab::route_matches(
            &route,
            "https://example.com/api/ping?x=1"
        ));
        assert!(!Tab::route_matches(&route, "https://example.com/api/pong"));
        assert!(!Tab::route_matches(&route, "https://example.com/"));
    }

    #[test]
    fn route_abort_matches_and_carries_no_fixture() {
        let route = Tab::new_route("/ads/".to_string(), None, "abort", None, None, None)
            .expect("valid abort route");
        assert_eq!(route.action, RouteAction::Abort);
        assert!(Tab::route_matches(
            &route,
            "https://cdn.example/ads/banner.js"
        ));
        assert!(!Tab::route_matches(&route, "https://cdn.example/app.js"));
    }

    #[test]
    fn route_prefix_matches_starts_only() {
        let route = Tab::new_route(
            "https://api.example/".to_string(),
            Some("prefix".to_string()),
            "fulfill",
            None,
            None,
            None,
        )
        .expect("valid prefix route");
        assert!(Tab::route_matches(&route, "https://api.example/v1/users"));
        assert!(!Tab::route_matches(
            &route,
            "https://evil.example/?next=https://api.example/"
        ));
    }

    #[test]
    fn route_host_matches_exact_host_case_insensitively() {
        let route = Tab::new_route(
            "Example.COM".to_string(),
            Some("host".to_string()),
            "abort",
            None,
            None,
            None,
        )
        .expect("valid host route");
        assert!(Tab::route_matches(&route, "https://example.com:8080/a?b=1"));
        assert!(Tab::route_matches(&route, "http://user@example.com/x"));
        // Lookalikes must not match: no suffix/prefix confusion.
        assert!(!Tab::route_matches(&route, "https://notexample.com/"));
        assert!(!Tab::route_matches(&route, "https://example.com.evil.com/"));
        assert!(!Tab::route_matches(&route, "/relative/path"));
    }

    #[test]
    fn route_matching_is_literal_never_regex() {
        // `.*` is four literal chars here, not "match anything".
        let route = fulfill_route("api.*");
        assert!(Tab::route_matches(&route, "https://x.example/api.*"));
        assert!(!Tab::route_matches(&route, "https://x.example/apixyz"));
        assert!(!Tab::route_matches(&route, "https://x.example/api/v1"));
    }

    #[test]
    fn route_rejects_empty_and_oversized_patterns() {
        for bad in ["", "   "] {
            assert!(
                Tab::new_route(bad.to_string(), None, "fulfill", None, None, None).is_err(),
                "{bad:?} must fail closed"
            );
        }
        let oversized = "p".repeat(MAX_ROUTE_PATTERN + 1);
        let err = Tab::new_route(oversized, None, "fulfill", None, None, None)
            .expect_err("513-char pattern must be rejected");
        assert_eq!(err.code, ErrorCode::Internal);
        // Boundary holds: exactly 512 chars is accepted.
        Tab::new_route(
            "p".repeat(MAX_ROUTE_PATTERN),
            None,
            "fulfill",
            None,
            None,
            None,
        )
        .expect("512-char pattern is the documented bound");
    }

    #[test]
    fn route_rejects_bad_kind_action_status_and_content_type() {
        let base = || ("/api/".to_string(), Some(200), None, None);
        let (p, s, b, c) = base();
        assert!(Tab::new_route(
            p.clone(),
            Some("wildcard".to_string()),
            "fulfill",
            s,
            b.clone(),
            c.clone()
        )
        .is_err());
        let (p, s, b, c) = base();
        assert!(Tab::new_route(p, None, "drop", s, b, c).is_err());
        // Abort rejects fulfill-only fields instead of silently dropping them.
        assert!(Tab::new_route("/a/".to_string(), None, "abort", Some(404), None, None).is_err());
        assert!(Tab::new_route(
            "/a/".to_string(),
            None,
            "abort",
            None,
            Some("x".to_string()),
            None
        )
        .is_err());
        // Status outside 100-599, oversized body, header-injecting type.
        assert!(Tab::new_route("/a/".to_string(), None, "fulfill", Some(99), None, None).is_err());
        assert!(Tab::new_route("/a/".to_string(), None, "fulfill", Some(600), None, None).is_err());
        assert!(Tab::new_route(
            "/a/".to_string(),
            None,
            "fulfill",
            None,
            Some("x".repeat(MAX_ROUTE_BODY_BYTES + 1)),
            None
        )
        .is_err());
        assert!(Tab::new_route(
            "/a/".to_string(),
            None,
            "fulfill",
            None,
            None,
            Some("text/html\r\nX-Injected: 1".to_string())
        )
        .is_err());
        assert!(Tab::new_route(
            "/a/".to_string(),
            None,
            "fulfill",
            None,
            None,
            Some("not-a-type".to_string())
        )
        .is_err());
        // Host kind rejects URL-shaped patterns (fail closed, no smuggling).
        for bad_host in [
            "https://example.com",
            "example.com/path",
            "example.com:8080",
            "a b.com",
        ] {
            assert!(
                Tab::new_route(
                    bad_host.to_string(),
                    Some("host".to_string()),
                    "abort",
                    None,
                    None,
                    None
                )
                .is_err(),
                "{bad_host:?} must fail closed"
            );
        }
    }

    #[test]
    fn route_fulfill_headers_carry_no_secrets() {
        // A fulfilled mock sends exactly one header. Request secrets
        // (authorization/cookie/...) are never reflected into a mock.
        let headers = Tab::fulfill_response_headers("application/json");
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].name, "content-type");
        assert_eq!(headers[0].value, "application/json");
        let leaked = ["authorization", "cookie", "set-cookie", "x-api-key"];
        assert!(
            !headers
                .iter()
                .any(|h| leaked.iter().any(|s| h.name.eq_ignore_ascii_case(s))),
            "fulfill headers must never carry secrets"
        );
    }

    #[test]
    fn route_table_is_bounded_per_tab() {
        let mut routes = Vec::new();
        for i in 0..MAX_ROUTES_PER_TAB {
            let n = Tab::push_route(&mut routes, fulfill_route(&format!("/api/{i}")))
                .expect("table has room");
            assert_eq!(n, i + 1);
        }
        let err = Tab::push_route(&mut routes, fulfill_route("/api/full"))
            .expect_err("21st route must fail closed");
        assert_eq!(err.code, ErrorCode::Internal);
        assert_eq!(routes.len(), MAX_ROUTES_PER_TAB);
    }
}
