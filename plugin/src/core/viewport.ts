/**
 * The viewport module: how big the page is, and who decides.
 *
 * Two modes, chosen once at launch:
 *   - native (headful launch, CDP attach): Playwright emulates no viewport, so
 *     the page fills the real window and follows resize / maximize /
 *     fullscreen. An explicit size is a CDP device-metrics override on a
 *     session this module owns, so releasing it hands sizing back to the
 *     window. (Playwright's setViewportSize cannot be undone.)
 *   - emulated (headless): Playwright's fixed emulation; release returns to
 *     1280x720.
 *
 * An override is remembered per tab, so a release clears every tab in its
 * scope that carries one (a session's own tabs), including a tab the active
 * pointer has since left.
 */

import type { CDPSession, Page } from "playwright";
import type { ViewportPreset } from "./turn.ts";

export const VIEWPORT_PRESETS: Record<ViewportPreset, { readonly width: number; readonly height: number }> = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

/** Headless default size; also what a released emulated viewport returns to. */
export const HEADLESS_VIEWPORT = { width: 1280, height: 720 } as const;

export interface ResolvedViewport {
  readonly width: number;
  readonly height: number;
}

export type ViewportMode = "native" | "emulated";

/** The page surface this module needs; Playwright's Page satisfies it. */
export type ViewportPage = Pick<Page, "setViewportSize" | "viewportSize" | "evaluate" | "context" | "once">;

/**
 * Resolve an explicit viewport request. Returns null for a bare call, which
 * means "release the override and follow the live window again".
 */
export function resolveViewport(input: {
  readonly preset?: ViewportPreset;
  readonly width?: number;
  readonly height?: number;
}): ResolvedViewport | null {
  if (input.preset !== undefined) return VIEWPORT_PRESETS[input.preset];
  if (input.width !== undefined && input.height !== undefined) {
    return { width: input.width, height: input.height };
  }
  return null;
}

/**
 * CSS size of `page`'s viewport: the emulated size when there is one,
 * otherwise the live window.innerWidth/innerHeight. The one size read.
 */
export async function viewportSizeOf(
  page: Pick<Page, "viewportSize" | "evaluate">,
): Promise<ResolvedViewport | null> {
  const emulated = page.viewportSize();
  if (emulated !== null) return emulated;
  return page
    .evaluate(() => {
      const w = globalThis as unknown as { innerWidth: number; innerHeight: number };
      return { width: w.innerWidth, height: w.innerHeight };
    })
    .catch(() => null);
}

export class Viewport {
  /** Tabs carrying an explicit size; native tabs keep their CDP session. */
  private readonly overrides = new Map<ViewportPage, CDPSession | null>();

  constructor(readonly mode: ViewportMode) { }

  /** Launch-time options that make `mode` work. */
  static launchOptions(mode: ViewportMode): { readonly viewport?: null; readonly args: readonly string[] } {
    return mode === "native" ? { viewport: null, args: ["--start-maximized"] } : { args: [] };
  }

  /**
   * Give `page` an explicit size, or release overrides (`null`): on the tabs in
   * `scope` when given, otherwise on every tab.
   */
  async apply(page: ViewportPage, size: ResolvedViewport | null, scope?: readonly ViewportPage[]): Promise<void> {
    if (size === null) {
      await this.release(scope);
      return;
    }
    if (this.mode === "emulated") {
      await page.setViewportSize(size);
      this.track(page, null);
      return;
    }
    let session = this.overrides.get(page) ?? null;
    if (session === null) {
      session = await page.context().newCDPSession(page as Page);
      this.track(page, session);
    }
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 0,
      mobile: false,
    });
  }

  private track(page: ViewportPage, session: CDPSession | null): void {
    if (!this.overrides.has(page)) page.once("close", () => this.overrides.delete(page));
    this.overrides.set(page, session);
  }

  private async release(scope: readonly ViewportPage[] | undefined): Promise<void> {
    const only = scope === undefined ? null : new Set(scope);
    const entries = [...this.overrides].filter(([page]) => only === null || only.has(page));
    for (const [page] of entries) this.overrides.delete(page);
    await Promise.all(
      entries.map(([page, session]) =>
        session === null
          ? page.setViewportSize(HEADLESS_VIEWPORT)
          : session
            .send("Emulation.clearDeviceMetricsOverride")
            .then(() => session.detach())
            .catch(() => undefined),
      ),
    );
  }
}
