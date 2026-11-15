//! Chrome process lifecycle: launch, supervise, one automatic relaunch.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chromiumoxide::browser::{Browser, BrowserConfig};
use tokio::io::AsyncBufReadExt;
use tokio::sync::{broadcast, Mutex, RwLock};
use tracing::{debug, info, warn};

use crate::error::RpcError;
use crate::paths;

/// One live Chrome process plus the CDP handle used to create tabs.
pub struct ChromeInstance {
    pub browser: Mutex<Browser>,
    pub pid: u32,
    pub version: String,
    pub profile: PathBuf,
    pub alive: Arc<AtomicBool>,
}

impl ChromeInstance {
    /// Create a new tab. Serialized on the browser handle, which is only used
    /// for target creation and target closing.
    pub async fn new_page(&self) -> Result<chromiumoxide::Page, RpcError> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(RpcError::chrome_dead("the browser process is not running"));
        }
        let browser = self.browser.lock().await;
        browser
            .new_page("about:blank")
            .await
            .map_err(|err| map_launch_error(self, err))
    }
}

fn map_launch_error(instance: &ChromeInstance, err: impl std::fmt::Display) -> RpcError {
    if !instance.alive.load(Ordering::SeqCst) {
        return RpcError::chrome_dead(format!("browser connection lost: {err}"));
    }
    RpcError::internal(format!("chrome command failed: {err}"))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ChromeStatus {
    pub alive: bool,
    pub pid: Option<u32>,
    pub version: Option<String>,
    pub launches: u32,
    pub relaunches: u32,
}

/// Owns the single Chrome process and the supervision metadata around it.
pub struct ChromeManager {
    binary: PathBuf,
    profiles_root: PathBuf,
    /// Set only via `--no-sandbox-acknowledged-risk`. Never from the
    /// environment: a process that can set our env could silently strip the
    /// sandbox (P1-1).
    allow_no_sandbox: bool,
    state: RwLock<Option<Arc<ChromeInstance>>>,
    launch_lock: Mutex<()>,
    deaths: broadcast::Sender<u32>,
    shutting_down: Arc<AtomicBool>,
    auto_relaunches: Arc<AtomicU32>,
    launches: AtomicU32,
}

impl ChromeManager {
    pub fn new(binary: PathBuf, profiles_root: PathBuf, allow_no_sandbox: bool) -> Self {
        if allow_no_sandbox {
            warn!(
                "Chrome launched with --no-sandbox (explicit operator opt-in); \
                 do not browse untrusted content in this configuration"
            );
        }
        let (deaths, _) = broadcast::channel(8);
        Self {
            binary,
            profiles_root,
            allow_no_sandbox,
            state: RwLock::new(None),
            launch_lock: Mutex::new(()),
            deaths,
            shutting_down: Arc::new(AtomicBool::new(false)),
            auto_relaunches: Arc::new(AtomicU32::new(0)),
            launches: AtomicU32::new(0),
        }
    }

    /// Death notifications carry the pid of the instance that died.
    pub fn subscribe_deaths(&self) -> broadcast::Receiver<u32> {
        self.deaths.subscribe()
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    /// Number of automatic relaunches already spent for the current crash.
    pub fn note_death(&self) -> u32 {
        self.auto_relaunches.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Return the live instance, launching Chrome if needed.
    pub async fn ensure(&self) -> Result<Arc<ChromeInstance>, RpcError> {
        if let Some(instance) = self.state.read().await.as_ref() {
            if instance.alive.load(Ordering::SeqCst) {
                return Ok(instance.clone());
            }
        }

        let _guard = self.launch_lock.lock().await;
        if let Some(instance) = self.state.read().await.as_ref() {
            if instance.alive.load(Ordering::SeqCst) {
                return Ok(instance.clone());
            }
        }
        let instance = self.launch().await?;
        *self.state.write().await = Some(instance.clone());
        Ok(instance)
    }

    async fn launch(&self) -> Result<Arc<ChromeInstance>, RpcError> {
        paths::ensure_private_dir(&self.profiles_root).map_err(|err| {
            RpcError::internal(format!(
                "cannot create profile root {}: {err}",
                self.profiles_root.display()
            ))
        })?;

        let profile = self.profiles_root.join(paths::random_hex_32());
        paths::ensure_private_dir(&profile).map_err(|err| {
            RpcError::internal(format!(
                "cannot create profile {}: {err}",
                profile.display()
            ))
        })?;

        let mut builder = BrowserConfig::builder()
            .chrome_executable(&self.binary)
            .new_headless_mode()
            .viewport(None)
            .window_size(1280, 800)
            .user_data_dir(&profile)
            // E lane: chromey's per-target NetworkManager answers EVERY
            // `Fetch.requestPaused` it sees (continue for allowed URLs) and
            // always wins the race against a page-listener pump — a daemon
            // `Fetch.enable` alone can never mock deterministically. With
            // `request_intercept` the manager enables Fetch itself at target
            // creation and then STEPS ASIDE (user+protocol flags), leaving
            // the daemon pump as the sole answerer on every tab. Cost: every
            // request takes one CDP round trip through `pump_fetch`
            // (passthrough when no route matches), armed from tab birth in
            // `setup_listeners` so no pause can predate the pump.
            .enable_request_intercept()
            .args([
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-sync",
                "--disable-extensions",
                "--mute-audio",
                "--hide-scrollbars",
            ]);

        if self.allow_no_sandbox {
            builder = builder.no_sandbox();
        }

        let config = builder.build().map_err(|err| {
            RpcError::chrome_dead(format!(
                "cannot build Chrome launch config for {}: {err}",
                self.binary.display()
            ))
        })?;

        info!(binary = %self.binary.display(), profile = %profile.display(), "launching chrome");
        let launched = tokio::time::timeout(Duration::from_secs(45), Browser::launch(config)).await;
        let (mut browser, handler) = match launched {
            Ok(Ok(pair)) => pair,
            Ok(Err(err)) => {
                let _ = tokio::fs::remove_dir_all(&profile).await;
                return Err(RpcError::chrome_dead(format!(
                    "chrome failed to launch ({}): {err}",
                    self.binary.display()
                )));
            }
            Err(_) => {
                let _ = tokio::fs::remove_dir_all(&profile).await;
                return Err(RpcError::chrome_dead(format!(
                    "chrome did not become ready within 45s ({})",
                    self.binary.display()
                )));
            }
        };

        // Drain Chrome's stderr so a full pipe buffer can never stall the
        // process. The interesting line (DevTools URL) was already consumed by
        // the launcher; the rest is diagnostics.
        if let Some(child) = browser.get_mut_child() {
            if let Some(stderr) = child.stderr.take() {
                tokio::spawn(async move {
                    let mut reader = tokio::io::BufReader::new(stderr);
                    let mut line = String::new();
                    loop {
                        line.clear();
                        match reader.read_line(&mut line).await {
                            Ok(0) | Err(_) => break,
                            Ok(_) => debug!(target: "chrome", "{}", line.trim_end()),
                        }
                    }
                });
            }
        }

        let pid = browser
            .get_mut_child()
            .and_then(|child| child.inner.id())
            .unwrap_or(0);
        let version = match tokio::time::timeout(Duration::from_secs(5), browser.version()).await {
            Ok(Ok(value)) => value.product,
            Ok(Err(err)) => {
                warn!(%err, "could not read chrome version");
                "unknown".to_string()
            }
            Err(_) => "unknown".to_string(),
        };

        let instance = Arc::new(ChromeInstance {
            browser: Mutex::new(browser),
            pid,
            version,
            profile,
            alive: Arc::new(AtomicBool::new(true)),
        });
        self.launches.fetch_add(1, Ordering::SeqCst);

        // Event pump: commands only resolve while this stream is polled.
        let pump_instance = instance.clone();
        let deaths = self.deaths.clone();
        tokio::spawn(async move {
            let result = handler.run().await;
            if pump_instance.alive.swap(false, Ordering::SeqCst) {
                warn!(
                    pid = pump_instance.pid,
                    error = ?result.err().map(|err| err.to_string()),
                    "chrome connection ended"
                );
                let _ = deaths.send(pump_instance.pid);
            }
        });

        // A relaunch that survives 30s resets the automatic-relaunch budget, so
        // a later crash may be recovered without a daemon restart.
        let budget = self.auto_relaunches.clone();
        let alive = instance.alive.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            if alive.load(Ordering::SeqCst) {
                budget.store(0, Ordering::SeqCst);
            }
        });

        info!(pid = instance.pid, version = %instance.version, "chrome ready");
        Ok(instance)
    }

    /// Drop a dead instance from the current slot (only if it is the one that
    /// reported the death).
    pub async fn forget(&self, pid: u32) {
        let mut state = self.state.write().await;
        if state.as_ref().map(|instance| instance.pid) == Some(pid) {
            *state = None;
        }
    }

    pub async fn status(&self) -> ChromeStatus {
        let state = self.state.read().await;
        match state.as_ref() {
            Some(instance) => ChromeStatus {
                alive: instance.alive.load(Ordering::SeqCst),
                pid: Some(instance.pid),
                version: Some(instance.version.clone()),
                launches: self.launches.load(Ordering::SeqCst),
                relaunches: self.auto_relaunches.load(Ordering::SeqCst),
            },
            None => ChromeStatus {
                alive: false,
                pid: None,
                version: None,
                launches: self.launches.load(Ordering::SeqCst),
                relaunches: self.auto_relaunches.load(Ordering::SeqCst),
            },
        }
    }

    /// Close Chrome, make sure the process is gone and delete its profile.
    pub async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let instance = self.state.write().await.take();
        let Some(instance) = instance else {
            return;
        };
        instance.alive.store(false, Ordering::SeqCst);

        {
            let mut browser = instance.browser.lock().await;
            let _ = tokio::time::timeout(Duration::from_secs(2), browser.close()).await;
            let _ = tokio::time::timeout(Duration::from_secs(2), browser.kill()).await;
        }

        for _ in 0..20 {
            if !paths::process_alive(instance.pid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if paths::process_alive(instance.pid) {
            warn!(
                pid = instance.pid,
                "chrome survived graceful shutdown; sending SIGKILL"
            );
            // SAFETY: pid was obtained from the child we spawned.
            unsafe {
                libc::kill(instance.pid as libc::pid_t, libc::SIGKILL);
            }
        }

        if let Err(err) = tokio::fs::remove_dir_all(&instance.profile).await {
            debug!(profile = %instance.profile.display(), %err, "could not remove profile");
        } else {
            info!(profile = %instance.profile.display(), "removed chrome profile");
        }
    }
}
