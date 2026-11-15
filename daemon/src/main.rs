//! `browserd`: single-instance Rust CDP daemon (IMPLEMENTATION-PLAN.md Phase 1).
//!
//!   - one Unix socket (`.../opencode-browser/v1/daemon.sock`, dir 0700,
//!     socket 0600) with `SO_PEERCRED` uid checks on every connection;
//!   - one Chrome process (fresh profile, supervised, one auto-relaunch);
//!   - NDJSON framing (32 MiB cap), per-request `tokio::spawn`, 30 s timeouts;
//!   - TTL sweep + zero-tab idle shutdown timers.

mod chrome;
mod dispatch;
mod error;
mod frame;
mod paths;
mod policy;
mod rpc;
mod snapshot;
mod tabs;

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, error, info, warn};

use crate::chrome::ChromeManager;
use crate::dispatch::{dispatch, effective_session, request_timeout_ms, App};
use crate::error::RpcError;
use crate::frame::read_frame;
use crate::rpc::{CancelParams, Request, Response};
use crate::tabs::TabRegistry;

#[derive(Debug, Parser)]
#[command(
    name = "browserd",
    about = "CDP daemon for the opencode-browser plugin"
)]
struct Cli {
    /// Override the socket path (default $XDG_RUNTIME_DIR/opencode-browser/v1/daemon.sock).
    #[arg(long)]
    socket: Option<PathBuf>,
    /// Override Chrome discovery (default CHROME_PATH / PATH order).
    #[arg(long)]
    chrome: Option<PathBuf>,
    /// Maximum live tabs; LRU evicts unowned/idle tabs past this.
    #[arg(long, default_value_t = 8)]
    max_tabs: usize,
    /// Tab lease: inactive tabs are closed after this many seconds.
    #[arg(long, default_value_t = 600)]
    ttl_s: u64,
    /// Shut down after this many idle seconds with zero tabs (0 disables).
    #[arg(long, default_value_t = 1800)]
    idle_timeout_s: u64,
    /// Run Chrome with --no-sandbox. Only for rootless containers that cannot
    /// sandbox; never the default, always loud.
    #[arg(long)]
    no_sandbox_acknowledged_risk: bool,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Debug, Subcommand)]
enum Cmd {
    /// Run a synthetic load probe (eval 1+1) against the running daemon.
    Bench {
        #[arg(long, default_value_t = 1)]
        sessions: usize,
        #[arg(long, default_value_t = 10)]
        calls: usize,
    },
}

fn main() {
    let cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let code = runtime.block_on(async_main(cli));
    std::process::exit(code);
}

async fn async_main(cli: Cli) -> i32 {
    if let Some(Cmd::Bench { sessions, calls }) = cli.cmd {
        return bench_client(cli.socket, sessions, calls).await;
    }
    match serve(cli).await {
        Ok(()) => 0,
        Err(err) => {
            error!("{err}");
            1
        }
    }
}

// ---------------------------------------------------------------------------
// bench client
// ---------------------------------------------------------------------------

async fn bench_client(socket: Option<PathBuf>, sessions: usize, calls: usize) -> i32 {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let path = socket.unwrap_or_else(paths::socket_path);
    let stream = match UnixStream::connect(&path).await {
        Ok(stream) => stream,
        Err(err) => {
            eprintln!("cannot connect to {}: {err}", path.display());
            return 1;
        }
    };
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();
    let mut seq = 0;
    let mut round_trip = async |method: &str, params: Value| -> Option<Value> {
        seq += 1;
        let id = format!("bench-{seq}");
        let frame = serde_json::to_vec(&json!({"id": id, "method": method, "params": params}))
            .expect("json");
        if writer.write_all(&frame).await.is_err() {
            return None;
        }
        if writer.write_all(b"\n").await.is_err() {
            return None;
        }
        let line = tokio::time::timeout(Duration::from_secs(130), lines.next_line())
            .await
            .ok()?
            .ok()??;
        serde_json::from_str::<Value>(&line).ok()
    };

    let hello = round_trip("hello", json!({"protocol": 1})).await;
    if hello
        .as_ref()
        .and_then(|v| v.get("ok"))
        .and_then(Value::as_bool)
        != Some(true)
    {
        eprintln!(
            "hello failed: {}",
            hello.map(|v| v.to_string()).unwrap_or_default()
        );
        return 1;
    }
    match round_trip("bench", json!({"sessions": sessions, "calls": calls})).await {
        Some(reply) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&reply).unwrap_or_default()
            );
            if reply.get("ok").and_then(Value::as_bool) == Some(true) {
                0
            } else {
                1
            }
        }
        None => {
            eprintln!("bench: no reply from daemon");
            1
        }
    }
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

async fn serve(cli: Cli) -> anyhow::Result<()> {
    let attach_endpoint = std::env::var("OPENCODE_BROWSER_ATTACH_URL")
        .ok()
        .filter(|value| !value.is_empty());
    let binary = if attach_endpoint.is_some() {
        PathBuf::new()
    } else {
        crate::paths::resolve_chrome(cli.chrome.as_deref()).ok_or_else(|| {
            anyhow::anyhow!(
                "no Chrome binary: set --chrome or CHROME_PATH, or install google-chrome/chromium"
            )
        })?
    };
    info!(chrome = %binary.display(), "resolved chrome");

    let socket_path = cli.socket.clone().unwrap_or_else(paths::socket_path);
    let lock_path = match socket_path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(paths::LOCK_NAME),
        _ => PathBuf::from(paths::LOCK_NAME),
    };
    let _lock = acquire_single_instance(&socket_path, &lock_path).await?;

    if let Some(parent) = socket_path.parent() {
        paths::ensure_private_dir(parent)?;
    }
    // Stale socket from a previous crash: we hold the lock, so it is ours.
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)?;
    paths::make_owner_only(&socket_path)?;
    info!(socket = %socket_path.display(), "listening");

    let chrome = Arc::new(
        ChromeManager::new(
            binary,
            paths::profiles_dir(),
            cli.no_sandbox_acknowledged_risk,
        )
        .with_attach_endpoint(attach_endpoint),
    );
    let tabs = Arc::new(TabRegistry::new(
        cli.max_tabs.max(1),
        Duration::from_secs(cli.ttl_s.max(60)),
    ));
    let app = Arc::new(App::new(
        chrome.clone(),
        tabs.clone(),
        paths::screenshots_dir(),
    ));

    spawn_death_watcher(&app);
    spawn_sweep_task(&app, cli.idle_timeout_s);
    spawn_signal_watcher(&app);

    let conn_seq = Arc::new(AtomicU64::new(0));
    loop {
        tokio::select! {
            biased;
            _ = app.shutdown_notify.notified() => break,
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let app = app.clone();
                let seq = conn_seq.fetch_add(1, Ordering::SeqCst) + 1;
                tokio::spawn(async move {
                    serve_conn(app, stream, format!("c{seq}")).await;
                });
            }
        }
        if app.is_shutting_down() {
            break;
        }
    }

    info!("shutting down");
    chrome.shutdown().await;
    let _ = std::fs::remove_file(&socket_path);
    Ok(())
}

/// `flock` on the lock file: the loser probes the socket — exit 0 when a
/// healthy daemon answers, exit 1 when the lock is held but nobody answers.
async fn acquire_single_instance(
    socket_path: &std::path::Path,
    lock_path: &std::path::Path,
) -> anyhow::Result<std::fs::File> {
    use fs2::FileExt;
    if let Some(parent) = lock_path.parent() {
        if !parent.as_os_str().is_empty() {
            paths::ensure_private_dir(parent)?;
        }
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)?;
    match file.try_lock_exclusive() {
        Ok(()) => Ok(file),
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
            if probe_healthy(socket_path).await {
                eprintln!("browserd is already running ({})", socket_path.display());
                std::process::exit(0);
            }
            anyhow::bail!(
                "socket is locked but no healthy daemon answers; is another browserd starting?"
            );
        }
        Err(err) => anyhow::bail!("cannot lock {}: {err}", lock_path.display()),
    }
}

async fn probe_healthy(socket_path: &std::path::Path) -> bool {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let stream = match tokio::time::timeout(
        Duration::from_secs(2),
        UnixStream::connect(socket_path),
    )
    .await
    {
        Ok(Ok(stream)) => stream,
        _ => return false,
    };
    let (reader, mut writer) = stream.into_split();
    let frame = serde_json::to_vec(&json!({
        "id": "probe",
        "method": "hello",
        "params": {"protocol": 1},
    }))
    .expect("json");
    if writer.write_all(&frame).await.is_err() || writer.write_all(b"\n").await.is_err() {
        return false;
    }
    let mut lines = BufReader::new(reader).lines();
    let Ok(Ok(Some(line))) = tokio::time::timeout(Duration::from_secs(2), lines.next_line()).await
    else {
        return false;
    };
    serde_json::from_str::<Value>(&line)
        .ok()
        .and_then(|v| v.get("ok").and_then(Value::as_bool))
        .unwrap_or(false)
}

/// `SO_PEERCRED` uid of the connecting process (P0-3).
fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    use std::os::unix::io::AsRawFd;
    let fd = stream.as_raw_fd();
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: getsockopt with SO_PEERCRED only writes `struct ucred`.
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut len,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(cred.uid)
}

async fn serve_conn(app: Arc<App>, stream: UnixStream, conn_tag: String) {
    let peer = match peer_uid(&stream) {
        Ok(uid) => uid,
        Err(err) => {
            warn!("cannot read peer credentials: {err}");
            return;
        }
    };
    if peer != paths::euid() {
        warn!("rejecting connection from uid {peer}");
        let denial = Response::protocol_failure(RpcError::new(
            crate::error::ErrorCode::PermissionDenied,
            format!("socket is owned by uid {}", paths::euid()),
            "connect as the same user that started the daemon",
        ))
        .to_line();
        let (_, mut writer) = stream.into_split();
        let _ = writer.write_all(&denial).await;
        return;
    }

    let (reader, writer) = stream.into_split();
    let mut reader = tokio::io::BufReader::new(reader);
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let writer_task = tokio::spawn(async move {
        let mut writer = writer;
        while let Some(bytes) = rx.recv().await {
            if writer.write_all(&bytes).await.is_err() {
                break;
            }
        }
    });

    // In-flight requests on this connection, addressable by `cancel`.
    let in_flight: Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>> =
        Arc::new(Mutex::new(HashMap::new()));

    loop {
        if app.is_shutting_down() {
            break;
        }
        let frame = match read_frame(&mut reader).await {
            Ok(Some(frame)) => frame,
            Ok(None) => break, // clean EOF
            Err(err) => {
                let _ = tx.send(
                    Response::protocol_failure(RpcError::internal(format!(
                        "frame error (connection closing): {err}"
                    )))
                    .to_line(),
                );
                break;
            }
        };
        // One parse straight into the envelope: no intermediate `Value` tree,
        // i.e. one fewer full-frame alloc + deserialization per request.
        let raw_req: crate::rpc::RawRequest = match serde_json::from_slice(&frame) {
            Ok(parsed) => parsed,
            Err(err) => {
                // Cold path only: re-parse untyped to keep the two
                // protocol-failure messages distinct (malformed JSON vs
                // well-formed JSON that is not an envelope).
                let malformed = serde_json::from_slice::<serde_json::Value>(&frame).is_err();
                let label = if malformed {
                    "malformed JSON frame (connection continues)"
                } else {
                    "bad request envelope"
                };
                let _ = tx.send(
                    Response::protocol_failure(RpcError::internal(format!("{label}: {err}")))
                        .to_line(),
                );
                continue;
            }
        };
        let Some(method) = raw_req.method.clone() else {
            // Id-less notification without a method: nothing to do.
            continue;
        };

        if method == "cancel" {
            let params: CancelParams =
                match rpc::parse_params_owned("cancel", raw_req.params.unwrap_or(Value::Null)) {
                    Ok(parsed) => parsed,
                    Err(err) => {
                        if let Some(id) = raw_req.id {
                            let _ = tx.send(Response::err(id, err).to_line());
                        }
                        continue;
                    }
                };
            let cancelled = match params.id {
                Some(id) => {
                    let key = rpc::request_key(&id);
                    if let Some(handle) = in_flight.lock().await.remove(&key) {
                        handle.abort();
                        true
                    } else {
                        false
                    }
                }
                None => false,
            };
            if let Some(id) = raw_req.id {
                let _ = tx.send(Response::ok(id, json!({"cancelled": cancelled})).to_line());
            }
            continue;
        }

        let id = raw_req.id.unwrap_or(Value::Null);
        let req = Request {
            id: id.clone(),
            method: method.clone(),
            params: raw_req.params.unwrap_or(Value::Null),
            session: raw_req.session,
        };
        let session = effective_session(req.session.as_deref(), &conn_tag);
        let timeout_ms = request_timeout_ms(&req.method, &req.params);

        let app = app.clone();
        let tx = tx.clone();
        let task_flight = in_flight.clone();
        let key = rpc::request_key(&id);
        let task_key = key.clone();
        let handle = tokio::spawn(async move {
            app.touch();
            let outcome = tokio::time::timeout(
                Duration::from_millis(timeout_ms),
                dispatch(&app, req, session),
            )
            .await;
            let response = match outcome {
                Ok(response) => response,
                Err(_) => Response::err(
                    id.clone(),
                    RpcError::new(
                        if method == "navigate" {
                            crate::error::ErrorCode::NavTimeout
                        } else {
                            crate::error::ErrorCode::Internal
                        },
                        format!("request timed out after {timeout_ms}ms"),
                        "retry with a larger timeout_ms (navigate) or check the daemon log",
                    ),
                ),
            };
            task_flight.lock().await.remove(&task_key);
            let _ = tx.send(response.to_line());
        });
        in_flight.lock().await.insert(key, handle.abort_handle());
    }

    // Client went away: cancel anything it left running.
    for (_, handle) in in_flight.lock().await.drain() {
        handle.abort();
    }
    writer_task.abort();
}

/// Chrome supervision: on death, forget the instance, invalidate every tab
/// (`remove_all`), then attempt exactly one automatic relaunch (P0-1).
fn spawn_death_watcher(app: &Arc<App>) {
    let app = app.clone();
    let mut deaths = app.chrome.subscribe_deaths();
    tokio::spawn(async move {
        loop {
            let pid = match deaths.recv().await {
                Ok(pid) => pid,
                Err(_) => return,
            };
            warn!(pid, "chrome died");
            app.chrome.forget(pid).await;
            let dropped = app.tabs.remove_all().await;
            debug!(tabs = dropped, "invalidated tabs after chrome death");
            if app.is_shutting_down() || app.chrome.is_shutting_down() {
                return;
            }
            let attempt = app.chrome.note_death();
            match app.chrome.ensure().await {
                Ok(instance) => {
                    info!(pid = instance.pid, attempt, "chrome relaunched");
                }
                Err(err) => {
                    error!("automatic relaunch failed (attempt {attempt}): {err}");
                }
            }
        }
    });
}

/// TTL sweep every 60 s + zero-tab idle shutdown (P1-6 wiring).
fn spawn_sweep_task(app: &Arc<App>, idle_timeout_s: u64) {
    let app = app.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(60));
        loop {
            ticker.tick().await;
            if app.is_shutting_down() {
                return;
            }
            let closed = app.tabs.sweep().await;
            if closed > 0 {
                info!(closed, "ttl sweep closed idle tabs");
            }
            if idle_timeout_s > 0
                && app.tabs.count().await == 0
                && crate::tabs::now_ms().saturating_sub(app.last_activity_ms.load(Ordering::SeqCst))
                    > idle_timeout_s * 1000
            {
                info!(idle_timeout_s, "idle with zero tabs; shutting down");
                app.request_shutdown();
                return;
            }
        }
    });
}

fn spawn_signal_watcher(app: &Arc<App>) {
    let app = app.clone();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            let mut int = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                .expect("SIGINT handler");
            tokio::select! {
                _ = term.recv() => info!("SIGTERM received"),
                _ = int.recv() => info!("SIGINT received"),
            }
            app.request_shutdown();
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
            app.request_shutdown();
        }
    });
}
