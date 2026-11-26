/**
 * Singleton browser lifecycle for the perception-action engine.
 *
 * Dual connection modes:
 *   - Persistent launch (default): launches Chromium with a persistent user
 *     profile dir (preserves cookies / localStorage), headful by default.
 *   - CDP attach: OPENCODE_BROWSER_CDP_URL connects to a running browser;
 *     with no URL set, a browser on 127.0.0.1:9222 is used when present.
 *
 * Multi-tab awareness lives in the tab tracker (core/tab-tracker.ts): every
 * page the context opens is tracked and becomes active, with a one-shot
 * notice for the next tool response.
 *
 * Concurrency: one launch at a time (single-flight), and `runExclusive`
 * serializes tool turns so two turns never interleave on the shared page.
 *
 * One manager per process lives in core/process-browser.ts, which also owns
 * signal teardown.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { ResolvedConfig } from "../config.ts";
import { loadConfig } from "../config.ts";
import { Telemetry } from "./telemetry.ts";
import { pageScripts } from "./page-agent.ts";
import { Presence } from "./presence.ts";
import { PAGE_GLOBALS } from "./som.ts";
import { Viewport } from "./viewport.ts";
import { TabTracker } from "./tab-tracker.ts";

/**
 * Conventional local DevTools endpoint. Chrome/Brave 136+ refuse remote
 * debugging on their default profile, so this only matches a browser that was
 * deliberately started with --remote-debugging-port and a dedicated profile.
 */
export const AUTODETECT_CDP_URL = "http://127.0.0.1:9222";

/**
 * True when a DevTools endpoint answers and advertises a browser websocket.
 * A closed port fails immediately; the timeout only guards a hung listener.
 */
export async function probeCdpEndpoint(url: string, timeoutMs = 300): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const info = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    return typeof info.webSocketDebuggerUrl === "string";
  } catch {
    return false;
  }
}

/**
 * Explicit OPENCODE_BROWSER_CDP_URL wins. Otherwise, unless autodetect is
 * disabled, attach to a browser already listening on the conventional port
 * instead of launching a second one.
 */
export async function resolveCdpEndpoint(
  config: Pick<ResolvedConfig, "cdpUrl" | "cdpAutoDetect">,
  probe: (url: string) => Promise<boolean> = probeCdpEndpoint,
): Promise<string | undefined> {
  if (config.cdpUrl !== undefined) return config.cdpUrl;
  if (!config.cdpAutoDetect) return undefined;
  return (await probe(AUTODETECT_CDP_URL)) ? AUTODETECT_CDP_URL : undefined;
}

/**
 * Singleton browser session. One instance per OpenCode server process; all
 * tool invocations in a session share the same browser / context.
 */
export class BrowserSessionManager {
  private readonly config: ResolvedConfig;
  private readonly telemetry: Telemetry;
  /** HUD + SoM scripts; installed into every document. */
  private readonly pageScripts: readonly string[];

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  /** Tabs of the current browser; reset whenever the browser goes away. */
  readonly tabs: TabTracker<Page>;
  private closed = false;
  private deathWatchArmed = false;
  /** The agent's visible presence (HUD) on the tabs it uses. */
  readonly presence: Presence;
  /** Viewport for the current launch; its mode is chosen in launchAndSetup. */
  private viewport = new Viewport("emulated");

  /** In-flight launch, shared by concurrent callers (single-flight). */
  private launching: Promise<void> | null = null;
  /** Tail of the turn queue; each turn waits for the previous one. */
  private turnQueue: Promise<void> = Promise.resolve();
  private turnsActive = 0;

  constructor(config?: Partial<ResolvedConfig>) {
    this.config = { ...loadConfig(), ...(config ?? {}) };
    this.telemetry = new Telemetry(this.config.maxTelemetry);
    this.pageScripts = pageScripts(this.config.maxElements);
    this.presence = new Presence({ timeoutMs: this.config.hudTimeoutMs });
    this.tabs = new TabTracker<Page>((page) => {
      this.telemetry.attach(page);
      this.installPageScripts(page);
    });
  }

  /** The resolved config this manager was created with (single source). */
  getConfig(): ResolvedConfig {
    return this.config;
  }

  /** Telemetry shared across all tracked pages (delta cursor is global). */
  getTelemetry(): Telemetry {
    return this.telemetry;
  }

  /**
   * Run `fn` with exclusive use of the browser: turns run one at a time, in
   * call order. The lock is released whether `fn` resolves or rejects.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.turnQueue;
    let release!: () => void;
    this.turnQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.turnsActive += 1;
    try {
      return await fn();
    } finally {
      this.turnsActive -= 1;
      release();
    }
  }

  /** True while a turn holds the lock. */
  isTurnActive(): boolean {
    return this.turnsActive > 0;
  }

  /** Ensure a browser + context exist and return the active page (creating one if needed). */
  async ensureActivePage(): Promise<Page> {
    // A manager that was closed (or whose plugin instance was disposed) can be
    // reused: clear the terminal flag so relaunch and teardown work again. The browser is process-global, not per plugin instance.
    if (this.closed) {
      this.closed = false;
      this.deathWatchArmed = false;
    }
    const active = this.tabs.active();
    if (active && !active.isClosed()) return active;
    await this.ensureBrowser();
    const ctx = this.context!;
    const page = ctx.pages().find((p) => !p.isClosed()) ?? (await ctx.newPage());
    this.tabs.activate(page);
    return page;
  }

  /** The viewport module for the current launch (apply / release overrides). */
  getViewport(): Viewport {
    return this.viewport;
  }

  /** Close the browser / context and clear all state. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.context?.close();
    } catch {
      // Best effort.
    }
    try {
      await this.browser?.close();
    } catch {
      // Best effort.
    }
    this.resetBrowserState();
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private async ensureBrowser(): Promise<void> {
    if (this.browserReady()) return;
    // Single-flight: concurrent callers share one launch instead of racing
    // two launches onto the same profile.
    this.launching ??= this.launchAndSetup().finally(() => {
      this.launching = null;
    });
    await this.launching;
  }

  /**
   * Forget the browser and everything tied to it. The one reset, shared by
   * close(), a failed setup and a browser that died.
   */
  private resetBrowserState(): void {
    this.browser = null;
    this.context = null;
    this.deathWatchArmed = false;
    this.tabs.reset();
    this.presence.discard();
  }

  private browserReady(): boolean {
    return this.browser !== null && this.context !== null;
  }

  /**
   * Launch (or attach) and run every setup step on locals. State is published
   * only after all steps succeed, so a failure leaves nothing half-initialized
   * and the next call runs the full setup again.
   */
  private async launchAndSetup(): Promise<void> {
    // Explicit URL wins; otherwise a real browser already listening on 9222 is
    // adopted instead of launching the plugin's own Chromium.
    const cdpUrl = await resolveCdpEndpoint(this.config);
    // Native: the page follows the real window (headful launch, CDP attach).
    const mode = cdpUrl !== undefined || !this.config.headless ? "native" : "emulated";
    const viewportOptions = Viewport.launchOptions(mode);
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      if (cdpUrl) {
        browser = await chromium.connectOverCDP(cdpUrl);
        const first = browser.contexts()[0];
        context = first ?? (await browser.newContext({ viewport: viewportOptions.viewport }));
      } else {
        // The viewport module supplies the mode's options (no emulation and
        // --start-maximized when headful). Playwright passes --no-sandbox
        // unless chromiumSandbox is enabled — that flag is what drew Chrome's
        // "unsupported command-line flag" infobar, so opt in.
        context = await chromium.launchPersistentContext(this.config.profileDir, {
          headless: this.config.headless,
          ...("viewport" in viewportOptions ? { viewport: viewportOptions.viewport } : {}),
          executablePath: this.config.executablePath,
          chromiumSandbox: !this.config.noSandbox,
          args: [
            ...(this.config.noSandbox ? ["--no-sandbox"] : []),
            "--disable-dev-shm-usage",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-extensions",
            "--mute-audio",
            ...viewportOptions.args,
          ],
        });
        browser = context.browser();
      }

      // Init scripts run on EVERY document (including after navigations), so
      // the SoM indexer and HUD survive page loads. Tracking a page also
      // evaluates them once for pages that already exist.
      // The HUD's Stop button calls this binding: a Take over. It is exposed
      // first so each document's HUD script can capture it and remove the
      // global before page scripts run. A headless browser never presents the
      // HUD, so the binding is idle there.
      if (this.config.indicators) {
        await context.exposeBinding(PAGE_GLOBALS.stop, () => {
          void this.presence.takeOver();
        });
      }
      for (const script of this.pageScripts) await context.addInitScript(script);
      this.tabs.watch(context);
    } catch (error) {
      // Roll back: close what we launched (an attached browser is only
      // disconnected, never closed) and clear everything setup touched.
      if (cdpUrl) {
        await browser?.close().catch(() => undefined);
      } else {
        await context?.close().catch(() => undefined);
      }
      this.resetBrowserState();
      throw error;
    }

    this.context = context;
    this.browser = browser;
    this.viewport = new Viewport(mode);
    this.presence.enabled = mode === "native" && this.config.indicators;

    // Dead-browser recovery: if Chromium dies (or is killed externally), drop
    // the stale handles so the next tool call relaunches cleanly instead of
    // wedging on a dead connection. Skipped during intentional close().
    if (browser !== null && !this.deathWatchArmed) {
      this.deathWatchArmed = true;
      browser.on("disconnected", () => {
        if (this.closed) return;
        this.resetBrowserState();
      });
    }
  }

  /** Evaluate the page scripts once in a page that existed before the init scripts. */
  private installPageScripts(page: Page): void {
    // Best-effort: the page still works without perception or the HUD.
    for (const script of this.pageScripts) void page.evaluate(script).catch(() => undefined);
  }
}
