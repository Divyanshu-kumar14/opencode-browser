/**
 * Host side of the in-page agent objects: the HUD (`window.__opencodeHud`)
 * and the SoM indexer (`window.__opencodeSom`).
 *
 * This module is the only place that knows the page-side names and methods.
 * The names are passed into every page closure as arguments (Playwright
 * serializes closures, so they cannot capture module constants) and into the
 * injected scripts at build time.
 *
 * HUD calls are best-effort: a page without the HUD (about:blank, a crashed
 * renderer, a navigation in flight) is not an error.
 */

import type { Page } from "playwright";
import { AGENT_HUD_SCRIPT, makeDomAnnotatorScript } from "../injected/index.ts";
import type { ElementLine } from "../utils/formatter.ts";
import { PAGE_GLOBALS } from "./som.ts";

export { PAGE_GLOBALS };

type Names = typeof PAGE_GLOBALS;
type Evaluator = Pick<Page, "evaluate">;

/** The scripts every document gets, in install order. */
export function pageScripts(maxElements: number): readonly string[] {
  return [makeDomAnnotatorScript(maxElements), AGENT_HUD_SCRIPT];
}

type HudMethod = "updateStatus" | "moveCursor" | "showClickRipple" | "setPresent";

function callHud(page: Evaluator, method: HudMethod, args: readonly unknown[]): Promise<void> {
  return page
    .evaluate(
      ({ names, method, args }: { names: Names; method: string; args: unknown[] }) => {
        const h = (globalThis as unknown as Record<string, any>)[names.hud];
        if (h) h[method](...args);
      },
      { names: PAGE_GLOBALS, method, args: [...args] },
    )
    .then(
      () => undefined,
      () => undefined,
    );
}

export const hud = {
  /** Show `text` in the status pill. */
  status: (page: Evaluator, text: string): Promise<void> => callHud(page, "updateStatus", [text]),
  /** Hide the status pill. */
  clear: (page: Evaluator): Promise<void> => callHud(page, "updateStatus", [""]),
  /** Move the virtual cursor to viewport (x, y). */
  cursor: (page: Evaluator, x: number, y: number): Promise<void> => callHud(page, "moveCursor", [x, y]),
  /** Show or hide the whole HUD on this tab (only agent tabs are presented). */
  present: (page: Evaluator, on: boolean): Promise<void> => callHud(page, "setPresent", [on]),
  /** Play the click ripple at viewport (x, y). */
  ripple: (page: Evaluator, x: number, y: number): Promise<void> => callHud(page, "showClickRipple", [x, y]),
};

/** Re-index the page into a fresh [1..N] element map. Navigation errors propagate. */
export async function indexPage(page: Evaluator): Promise<ElementLine[]> {
  const indexed: unknown = await page.evaluate((names: Names) => {
    const s = (globalThis as unknown as Record<string, any>)[names.som];
    if (!s) return { elements: [] };
    return s.indexPage();
  }, PAGE_GLOBALS);
  const rec = indexed as { elements?: unknown } | null;
  return Array.isArray(rec?.elements) ? (rec.elements as ElementLine[]) : [];
}

/**
 * Run `capture` against a clean frame: HUD hidden and, when `annotate`, the
 * SoM badges painted. Preparing and restoring are one page call each, so the
 * live window shows the changed frame for as short a time as possible. The
 * restore always runs, so a failed capture never leaves the HUD hidden or
 * badges painted.
 */
export async function cleanFrame<T>(
  page: Evaluator,
  opts: { readonly annotate: boolean },
  capture: () => Promise<T>,
): Promise<T> {
  await page
    .evaluate(
      ({ names, annotate }: { names: Names; annotate: boolean }) => {
        const g = globalThis as unknown as Record<string, any>;
        const h = g[names.hud];
        if (h) h.hide();
        const s = g[names.som];
        if (annotate && s) s.renderSoMOverlay();
      },
      { names: PAGE_GLOBALS, annotate: opts.annotate },
    )
    .catch(() => undefined);
  try {
    return await capture();
  } finally {
    await page
      .evaluate(
        ({ names, annotate }: { names: Names; annotate: boolean }) => {
          const g = globalThis as unknown as Record<string, any>;
          const s = g[names.som];
          if (annotate && s) s.removeSoMOverlay();
          const h = g[names.hud];
          if (h) h.show();
        },
        { names: PAGE_GLOBALS, annotate: opts.annotate },
      )
      .catch(() => undefined);
  }
}
