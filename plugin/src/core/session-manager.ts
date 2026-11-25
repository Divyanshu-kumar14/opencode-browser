/**
 * Singleton browser lifecycle for the perception-action engine.
 *
 * Dual connection modes:
 *   - Persistent launch (default): launches Chromium with a persistent user
 *     profile dir (preserves cookies / localStorage), headful by default.
 *   - CDP attach: OPENCODE_BROWSER_CDP_URL connects to a running browser.
 *
 * Multi-tab awareness: every page opened via the context (target="_blank",
 * OAuth popups, …) is tracked; the active page pointer moves to new tabs and
 * a "switched to new tab" notification is emitted for the next tool response.
 *
 * Concurrency: one launch at a time (single-flight), and `runExclusive`
 * serializes tool turns so two turns never interleave on the shared page.
 *
 * Graceful teardown on SIGINT / SIGTERM / beforeExit. Signals close the
 * browser and then let the process end the way it would have without us.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { ResolvedConfig } from "../config.ts";
import { loadConfig } from "../config.ts";
import { Telemetry } from "./telemetry.ts";
import {
  AGENT_HUD_SCRIPT,
  makeDomAnnotatorScript,
} from "../injected/index.ts";
import {
  RATIO_PROBE,
  calibratedRatio,
  fittedWidth,
  viewportDrifted,
  type ViewportGeometry,
} from "./viewport.ts";

let nextPageSeq = 0;
function pageId(): string {
  return `page-${++nextPageSeq}`;
}

/**
 * Singleton browser session. One instance per OpenCode server process; all
 * tool invocations in a session share the same browser / context.
 */
export class BrowserSessionManager {
  private readonly config: ResolvedConfig;
  private readonly telemetry: Telemetry;
  private readonly annotatorScript: string;

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;
  private readonly pages = new Map<string, Page>();
  private readonly perceptionInstalled = new Set<Page>();
  private closed = false;
  private deathWatchArmed = false;
  private teardownArmed = false;
  /** True after an explicit browser_viewport call — disables auto-fill. */
  private viewportPinned = false;
  /** Requested→CSS pixel ratio, calibrated at launch (headful only). */
  private viewportRatio: number | null = null;

  /**
   * Pending tab switch for the next tool response. The page is stored, not its
   * URL: at the `page` event the URL is still about:blank.
   */
  private pendingTabSwitch: { readonly page: Page; readonly reason: "opened" | "closed" } | null = null;

  /** In-flight launch, shared by concurrent callers (single-flight). */
  private launching: Promise<void> | null = null;
  /** Tail of the turn queue; each turn waits for the previous one. */
  private turnQueue: Promise<void> = Promise.resolve();
  private turnsActive = 0;

  constructor(config?: Partial<ResolvedConfig>) {
    this.config = { ...loadConfig(), ...(config ?? {}) };
    this.telemetry = new Telemetry(this.config.maxTelemetry);
    this.annotatorScript = makeDomAnnotatorScript(this.config.maxElements);
  }

  /** The resolved config this manager was created with (single source). */
  getConfig(): ResolvedConfig {
    return this.config;
  }

  /** Telemetry shared across all tracked pages (delta cursor is global). */
  getTelemetry(): Telemetry {
    return this.telemetry;
  }

  /** Stable id for a page; the one place page identity is assigned. */
  pageIdFor(page: Page): string {
    return pageIdOf(page);
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
    // reused: clear the terminal flag so relaunch, viewport sync and teardown
    // all work again. The browser is process-global, not per plugin instance.
    if (this.closed) {
      this.closed = false;
      this.deathWatchArmed = false;
    }
    if (this.activePage && !this.activePage.isClosed()) {
      await this.maybeSyncViewport(this.activePage);
      return this.activePage;
    }
    await this.ensureBrowser();
    const ctx = this.context!;
    const existing = ctx.pages().find((p) => !p.isClosed());
    if (existing) {
      this.setActive(existing);
      await this.maybeSyncViewport(existing);
      return existing;
    }
    const page = await ctx.newPage();
    this.registerPage(page);
    this.setActive(page);
    await this.maybeSyncViewport(page);
    return page;
  }

  /** The currently active page, or null if none. */
  getActivePage(): Page | null {
    return this.activePage ?? null;
  }

  /** List all tracked, non-closed pages. */
  listPages(): { pageId: string; page: Page; url: string }[] {
    const out: { pageId: string; page: Page; url: string }[] = [];
    for (const [pageId, page] of this.pages) {
      if (page.isClosed()) continue;
      out.push({ pageId, page, url: page.url() });
    }
    return out;
  }

  /** Switch the active page pointer to another tracked tab. */
  async switchTo(pageId: string): Promise<void> {
    const page = this.pages.get(pageId);
    if (page === undefined || page.isClosed()) {
      throw new Error(`browser: tab ${pageId} not found or closed`);
    }
    await page.bringToFront();
    this.setActive(page);
  }

  /** Pin the viewport (explicit browser_viewport) — disables auto-fill. */
  pinViewport(): void {
    this.viewportPinned = true;
  }

  /** Unpin — the next tool call re-syncs the viewport to the live window. */
  unpinViewport(): void {
    this.viewportPinned = false;
  }

  /**
   * Fit an unpinned viewport to the live window (either direction) when it
   * drifts — e.g. after a manual resize. Pinned viewports (explicit
   * browser_viewport presets) are never touched. The pixel ratio is calibrated
   * on the spot when unknown, so this heals viewports from any launch era.
   */
  private async maybeSyncViewport(page: Page): Promise<void> {
    if (this.viewportPinned || page.isClosed()) return;
    const geom = await readWindowGeometry(page);
    if (geom) await this.syncViewport(page, geom).catch(() => undefined);
  }

  /** One fit path for both the pre-call check and the 1 s watcher. */
  private async syncViewport(page: Page, geom: ViewportGeometry): Promise<void> {
    if (!viewportDrifted(geom)) return;
    const before = page.viewportSize();
    let ratio = this.viewportRatio;
    if (ratio === null) {
      await page.setViewportSize(RATIO_PROBE);
      const probe = await page
        .evaluate((): number => {
          const g = globalThis as unknown as Record<string, any>;
          return (g["window"] as { innerWidth: number }).innerWidth;
        })
        .catch(() => 0);
      ratio = calibratedRatio(probe);
      if (ratio === null) {
        // Do not leave the calibration probe size on screen.
        if (before) await page.setViewportSize(before).catch(() => undefined);
        return;
      }
      this.viewportRatio = ratio;
    }
    await page.setViewportSize({
      width: fittedWidth(geom.outerW, ratio),
      height: before?.height ?? 1000,
    });
  }

  /** Consume and return any pending tab-switch notification. */
  takeTabSwitchNotification(): string | null {
    const pending = this.pendingTabSwitch;
    this.pendingTabSwitch = null;
    if (!pending || pending.page.isClosed()) return null;
    if (pending.reason === "closed") return `Active tab closed; switched to tab: ${pending.page.url()}`;
    return `Switched to new tab: ${pending.page.url()}`;
  }

  /** Close the browser / context and clear all state. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopViewportWatch();
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
    this.pages.clear();
    this.perceptionInstalled.clear();
    this.activePage = null;
    this.context = null;
    this.browser = null;
  }

  /** Register signal / process teardown so managed Chromium never zombies. */
  registerTeardown(): void {
    if (this.teardownArmed) return;
    this.teardownArmed = true;
    // Installing a signal handler replaces the default termination. After the
    // browser is closed (bounded at 5 s), re-raise the signal only when no
    // other listener remains: the default action then ends the process with
    // the right signal status. When the host has its own handlers, they own
    // termination. Never process.exit(0): that reports success for a signal
    // and cuts off the host's asynchronous cleanup.
    const onSignal = (signal: NodeJS.Signals): void => {
      void Promise.race([this.close(), sleepMs(5000)]).finally(() => {
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      });
    };
    const closeOnly = (): void => {
      void this.close();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    process.on("beforeExit", closeOnly);
  }

  /**
   * Fill the real window: wait for --start-maximized to settle, probe the
   * requested→CSS pixel ratio, then size the viewport to outerWidth (minus
   * scrollbar) with a generous height. Runs once at launch; later manual
   * resizes can re-sync via browser_viewport.
   */
  private async syncViewportToWindow(context: BrowserContext): Promise<void> {
    const probe = context.pages().find((p) => !p.isClosed()) ?? await context.newPage();
    const outerW = await this.settledOuterWidth(probe);
    const before = probe.viewportSize();
    await probe.setViewportSize(RATIO_PROBE);
    const innerW = await probe.evaluate((): number => {
      const g = globalThis as unknown as Record<string, any>;
      return (g["window"] as { innerWidth: number }).innerWidth;
    });
    const ratio = calibratedRatio(innerW);
    if (ratio === null || outerW <= 0) {
      // Do not leave the calibration probe size on screen.
      if (before) await probe.setViewportSize(before).catch(() => undefined);
      return;
    }
    this.viewportRatio = ratio;
    this.viewportPinned = false;
    await probe.setViewportSize({ width: fittedWidth(outerW, ratio), height: 1000 });
  }

  /** outerWidth once --start-maximized stops resizing (stable 2x100ms, ≤3s). */
  private async settledOuterWidth(page: import("playwright").Page): Promise<number> {
    let prev = -1;
    let stable = 0;
    let width = 0;
    for (let i = 0; i < 30 && stable < 2; i++) {
      width = await page.evaluate((): number => {
        const g = globalThis as unknown as Record<string, any>;
        return (g["window"] as { outerWidth: number }).outerWidth;
      });
      stable = width === prev && width > 0 ? stable + 1 : 0;
      prev = width;
      if (stable < 2) await new Promise((r) => setTimeout(r, 100));
    }
    return width;
  }

  private viewportWatch: ReturnType<typeof setInterval> | null = null;

  /** Poll the live window size and re-fit an unpinned viewport on drift. */
  private startViewportWatch(): void {
    this.stopViewportWatch();
    this.viewportWatch = setInterval(() => {
      void this.watchTick().catch(() => undefined);
    }, 1000);
    const t = this.viewportWatch as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  }

  private stopViewportWatch(): void {
    if (this.viewportWatch !== null) {
      clearInterval(this.viewportWatch);
      this.viewportWatch = null;
    }
  }

  private async watchTick(): Promise<void> {
    // Never resize mid-turn: indexing and the screenshot must see one viewport.
    if (this.closed || this.viewportPinned || this.turnsActive > 0) return;
    const page = this.activePage;
    if (!page || page.isClosed()) return;
    const geom = await readWindowGeometry(page);
    if (geom) await this.syncViewport(page, geom).catch(() => undefined);
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

  private browserReady(): boolean {
    return this.browser !== null && this.context !== null;
  }

  /**
   * Launch (or attach) and run every setup step on locals. State is published
   * only after all steps succeed, so a failure leaves nothing half-initialized
   * and the next call runs the full setup again.
   */
  private async launchAndSetup(): Promise<void> {
    const headful = !this.config.cdpUrl && !this.config.headless;
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      if (this.config.cdpUrl) {
        browser = await chromium.connectOverCDP(this.config.cdpUrl);
        const first = browser.contexts()[0];
        context = first ?? (await browser.newContext());
      } else {
        // Headful: open maximized and sync the automation viewport to the real
        // window size so no unpainted strip can appear. (launchPersistentContext
        // ignores `noViewport`, so this is done explicitly.) Playwright passes
        // --no-sandbox unless chromiumSandbox is enabled — that flag is what
        // drew Chrome's "unsupported command-line flag" infobar, so opt in.
        // Headless keeps the deterministic 1280x720 default (tests, screenshots).
        context = await chromium.launchPersistentContext(this.config.profileDir, {
          headless: this.config.headless,
          executablePath: this.config.executablePath,
          chromiumSandbox: !this.config.noSandbox,
          args: [
            ...(this.config.noSandbox ? ["--no-sandbox"] : []),
            "--disable-dev-shm-usage",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-extensions",
            "--mute-audio",
            ...(headful ? ["--start-maximized"] : []),
          ],
        });
        browser = context.browser();
        if (headful) await this.syncViewportToWindow(context);
      }

      // Init scripts run on EVERY document (including after navigations), so
      // the SoM indexer and HUD survive page loads. registerPage() also
      // evaluates them once for pages that already exist.
      await context.addInitScript(this.annotatorScript);
      await context.addInitScript(AGENT_HUD_SCRIPT);
      this.registerContextTracking(context);
    } catch (error) {
      // Roll back: close what we launched (an attached browser is only
      // disconnected, never closed) and clear everything setup touched.
      this.stopViewportWatch();
      if (this.config.cdpUrl) {
        await browser?.close().catch(() => undefined);
      } else {
        await context?.close().catch(() => undefined);
      }
      this.viewportRatio = null;
      this.deathWatchArmed = false;
      this.pages.clear();
      this.perceptionInstalled.clear();
      this.activePage = null;
      this.pendingTabSwitch = null;
      throw error;
    }

    this.context = context;
    this.browser = browser;
    if (headful) this.startViewportWatch();

    // Dead-browser recovery: if Chromium dies (or is killed externally), drop
    // the stale handles so the next tool call relaunches cleanly instead of
    // wedging on a dead connection. Skipped during intentional close().
    if (browser !== null && !this.deathWatchArmed) {
      this.deathWatchArmed = true;
      browser.on("disconnected", () => {
        if (this.closed) return;
        this.browser = null;
        this.context = null;
        this.activePage = null;
        this.deathWatchArmed = false;
      });
    }
  }

  private registerContextTracking(context: BrowserContext): void {
    context.on("page", (page) => {
      this.registerPage(page);
      // Auto-switch active pointer to newly opened tabs (target=_blank, popups).
      this.setActive(page);
      this.pendingTabSwitch = { page, reason: "opened" };
    });
    for (const page of context.pages()) {
      this.registerPage(page);
    }
  }

  private registerPage(page: Page): void {
    const id = pageIdOf(page);
    if (this.pages.has(id)) return;
    this.pages.set(id, page);
    this.telemetry.attach(page);
    this.installPerception(page);

    page.on("close", () => {
      this.pages.delete(id);
      this.perceptionInstalled.delete(page);
      if (this.activePage === page) {
        this.activePage = null;
        // Re-point to another live tab if one exists.
        for (const candidate of this.pages.values()) {
          if (!candidate.isClosed()) {
            this.setActive(candidate);
            this.pendingTabSwitch = { page: candidate, reason: "closed" };
            break;
          }
        }
      }
    });
  }

  private installPerception(page: Page): void {
    if (this.perceptionInstalled.has(page)) return;
    void page
      .evaluate(this.annotatorScript)
      .catch(() => {
        // Perception install is best-effort; the page still works without it.
      });
    void page
      .evaluate(AGENT_HUD_SCRIPT)
      .catch(() => {
        // Best-effort.
      });
    this.perceptionInstalled.add(page);
  }

  private setActive(page: Page): void {
    this.activePage = page;
  }
}

async function readWindowGeometry(page: Page): Promise<ViewportGeometry | null> {
  const geom = await page
    .evaluate((): ViewportGeometry => {
      const g = globalThis as unknown as Record<string, any>;
      const w = g["window"] as { outerWidth: number; innerWidth: number };
      return { outerW: w.outerWidth, innerW: w.innerWidth };
    })
    .catch(() => null);
  if (!geom || geom.outerW <= 0) return null;
  return geom;
}

/** Page identity lives off-object, so nothing can collide with Playwright's Page. */
const pageIds = new WeakMap<Page, string>();

function pageIdOf(page: Page): string {
  const existing = pageIds.get(page);
  if (existing) return existing;
  const generated = pageId();
  pageIds.set(page, generated);
  return generated;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms) as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  });
}
