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
 * Graceful teardown on SIGINT / SIGTERM / beforeExit.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { ResolvedConfig } from "../config.ts";
import { loadConfig } from "../config.ts";
import { Telemetry } from "./telemetry.ts";
import {
  AGENT_HUD_SCRIPT,
  DOM_ANNOTATOR_SCRIPT,
} from "../injected/index.ts";

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
  private readonly telemetry = new Telemetry();

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;
  private readonly pages = new Map<string, Page>();
  private readonly perceptionInstalled = new Set<Page>();
  private closed = false;
  private deathWatchArmed = false;
  /** True after an explicit browser_viewport call — disables auto-fill. */
  private viewportPinned = false;
  /** Requested→CSS pixel ratio, calibrated at launch (headful only). */
  private viewportRatio: number | null = null;

  /** Pending "[Switched to new tab: <url>]" notification for the next tool response. */
  private pendingTabSwitch: string | null = null;

  constructor(config?: Partial<ResolvedConfig>) {
    this.config = { ...loadConfig(), ...(config ?? {}) };
  }

  /** Telemetry shared across all tracked pages (delta cursor is global). */
  getTelemetry(): Telemetry {
    return this.telemetry;
  }

  /** Ensure a browser + context exist and return the active page (creating one if needed). */
  async ensureActivePage(): Promise<Page> {
    if (this.activePage && !this.activePage.isClosed()) {
      await this.maybeSyncViewport(this.activePage);
      return this.activePage;
    }
    await this.ensureBrowser();
    const ctx = this.context!;
    const existing = ctx.pages().find((p) => !p.isClosed());
    if (existing) {
      this.setActive(existing);
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
    const geom = await page
      .evaluate((): { outerW: number; innerW: number } => {
        const g = globalThis as unknown as Record<string, any>;
        const w = g["window"] as { outerWidth: number; innerWidth: number };
        return { outerW: w.outerWidth, innerW: w.innerWidth };
      })
      .catch(() => null);
    if (!geom || Math.abs(geom.innerW - (geom.outerW - 16)) <= 20) return;
    let ratio = this.viewportRatio;
    if (ratio === null) {
      await page.setViewportSize({ width: 800, height: 600 });
      const probe = await page
        .evaluate((): number => {
          const g = globalThis as unknown as Record<string, any>;
          return (g["window"] as { innerWidth: number }).innerWidth;
        })
        .catch(() => 0);
      if (!probe) return;
      ratio = 800 / probe;
      this.viewportRatio = ratio;
    }
    const vs = page.viewportSize();
    await page.setViewportSize({
      width: Math.max(320, Math.round((geom.outerW - 16) * ratio)),
      height: vs?.height ?? 1000,
    });
  }

  /** Consume and return any pending tab-switch notification. */
  takeTabSwitchNotification(): string | null {
    const notification = this.pendingTabSwitch;
    this.pendingTabSwitch = null;
    return notification;
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
    const teardown = (): void => {
      void this.close();
    };
    process.on("SIGINT", teardown);
    process.on("SIGTERM", teardown);
    process.on("beforeExit", teardown);
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
    const PROBE_W = 800;
    const PROBE_H = 600;
    await probe.setViewportSize({ width: PROBE_W, height: PROBE_H });
    const innerW = await probe.evaluate((): number => {
      const g = globalThis as unknown as Record<string, any>;
      return (g["window"] as { innerWidth: number }).innerWidth;
    });
    if (innerW <= 0 || outerW <= 0) return;
    this.viewportRatio = PROBE_W / innerW;
    this.viewportPinned = false;
    const targetW = Math.max(800, Math.round((outerW - 16) * this.viewportRatio));
    await probe.setViewportSize({ width: targetW, height: 1000 });
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
    if (this.closed || this.viewportPinned) return;
    const page = this.activePage;
    if (!page || page.isClosed()) return;
    let geom: { outerW: number; innerW: number } | null = null;
    try {
      geom = await page.evaluate((): { outerW: number; innerW: number } => {
        const g = globalThis as unknown as Record<string, any>;
        const w = g["window"] as { outerWidth: number; innerWidth: number };
        return { outerW: w.outerWidth, innerW: w.innerWidth };
      });
    } catch {
      return;
    }
    if (!geom || geom.outerW <= 0 || Math.abs(geom.innerW - (geom.outerW - 16)) <= 20) return;
    let ratio = this.viewportRatio;
    if (ratio === null) {
      await page.setViewportSize({ width: 800, height: 600 });
      const probe = await page
        .evaluate((): number => {
          const g = globalThis as unknown as Record<string, any>;
          return (g["window"] as { innerWidth: number }).innerWidth;
        })
        .catch(() => 0);
      if (!probe) return;
      ratio = 800 / probe;
      this.viewportRatio = ratio;
    }
    const vs = page.viewportSize();
    await page
      .setViewportSize({
        width: Math.max(320, Math.round((geom.outerW - 16) * ratio)),
        height: vs?.height ?? 1000,
      })
      .catch(() => undefined);
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private async ensureBrowser(): Promise<void> {
    if (this.browser && this.context) return;
    if (this.config.cdpUrl) {
      this.browser = await chromium.connectOverCDP(this.config.cdpUrl);
      const contexts = this.browser.contexts();
      const first = contexts[0];
      this.context = first ?? (await this.browser.newContext());
    } else {
      // Headful: open maximized and sync the automation viewport to the real
      // window size so no unpainted strip can appear. (launchPersistentContext
      // ignores `noViewport`, so this is done explicitly.) Playwright passes
      // --no-sandbox unless chromiumSandbox is enabled — that flag is what
      // drew Chrome's "unsupported command-line flag" infobar, so opt in.
      // Headless keeps the deterministic 1280x720 default (tests, screenshots).
      const headful = !this.config.headless;
      this.context = await chromium.launchPersistentContext(this.config.profileDir, {
        headless: this.config.headless,
        executablePath: this.config.executablePath,
        chromiumSandbox: true,
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
      this.browser = this.context.browser();
      if (headful) {
        await this.syncViewportToWindow(this.context);
        this.startViewportWatch();
      }
    }

    // Dead-browser recovery: if Chromium dies (or is killed externally), drop
    // the stale handles so the next tool call relaunches cleanly instead of
    // wedging on a dead connection. Skipped during intentional close().
    const browser = this.browser;
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

    // Init scripts run on EVERY document (including after navigations), so the
    // SoM indexer and HUD survive page loads. registerPage() below also
    // evaluates them once for pages that already exist.
    await this.context.addInitScript(DOM_ANNOTATOR_SCRIPT);
    await this.context.addInitScript(AGENT_HUD_SCRIPT);

    this.registerContextTracking(this.context!);
  }

  private registerContextTracking(context: BrowserContext): void {
    context.on("page", (page) => {
      this.registerPage(page);
      // Auto-switch active pointer to newly opened tabs (target=_blank, popups).
      this.setActive(page);
      this.pendingTabSwitch = `Switched to new tab: ${page.url()}`;
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
            break;
          }
        }
      }
    });
  }

  private installPerception(page: Page): void {
    if (this.perceptionInstalled.has(page)) return;
    void page
      .evaluate(DOM_ANNOTATOR_SCRIPT)
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

function pageIdOf(page: Page): string {
  const obj = page as unknown as { __opencodePageId?: string };
  const id = obj.__opencodePageId;
  if (id) return id;
  const generated = pageId();
  obj.__opencodePageId = generated;
  return generated;
}
