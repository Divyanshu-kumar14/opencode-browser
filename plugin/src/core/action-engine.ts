/**
 * Action execution engine for the perception-action loop.
 *
 * Supports a single action or a batched `actions[]` sequence. Every mutating
 * action runs: Update HUD -> Execute Action(s) -> waitForSettled() -> Re-index
 * SoM + annotated screenshot -> Drain telemetry -> Formatted payload (the tool
 * layer owns formatting).
 *
 * Stale-ID recovery: in a batch, each step's target element is re-verified
 * against the live DOM before acting. If an earlier step navigates or removes
 * a later step's target, the batch stops cleanly and reports which action #.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ElementHandle, Page, Locator } from "playwright";
import { InvalidInputError } from "./errors.ts";
import { somSelector } from "./som.ts";
import { Telemetry } from "./telemetry.ts";
import { sanitizePageText, type ElementLine } from "../utils/formatter.ts";

export type ActionType =
  | "click"
  | "double_click"
  | "right_click"
  | "type"
  | "clear_and_type"
  | "press_key"
  | "hover"
  | "select_option"
  | "scroll"
  | "drag"
  | "wait";

export interface Action {
  readonly type: ActionType;
  readonly elementId?: number;
  readonly selector?: string;
  readonly x?: number;
  readonly y?: number;
  readonly text?: string;
  readonly key?: string;
  readonly pressEnter?: boolean;
  readonly scrollDirection?: "up" | "down" | "left" | "right";
  readonly scrollAmount?: number;
  /** Drag end point (viewport CSS px). Required for type "drag". */
  readonly toX?: number;
  readonly toY?: number;
}

export interface BatchResult {
  readonly completed: number;
  readonly stoppedAt: number | null;
  readonly message: string | null;
  readonly staleElementId: number | null;
}

export function hudUpdate(page: Page, text: string): Promise<unknown> {
  return page
    .evaluate((t: string) => {
      const w = globalThis as unknown as Record<string, any>;
      const h = w["__opencodeHud"];
      if (h) h.updateStatus(t);
    }, text)
    .catch(() => undefined);
}

export function hudClear(page: Page): Promise<unknown> {
  return page
    .evaluate(() => {
      const w = globalThis as unknown as Record<string, any>;
      const h = w["__opencodeHud"];
      if (h) h.updateStatus("");
    })
    .catch(() => undefined);
}

export function hudCursor(page: Page, x: number, y: number): Promise<unknown> {
  return page
    .evaluate((args: { x: number; y: number }) => {
      const w = globalThis as unknown as Record<string, any>;
      const h = w["__opencodeHud"];
      if (h) h.moveCursor(args.x, args.y);
    }, { x, y })
    .catch(() => undefined);
}

export function hudRipple(page: Page, x: number, y: number): Promise<unknown> {
  return page
    .evaluate((args: { x: number; y: number }) => {
      const w = globalThis as unknown as Record<string, any>;
      const h = w["__opencodeHud"];
      if (h) h.showClickRipple(args.x, args.y);
    }, { x, y })
    .catch(() => undefined);
}

/**
 * Page-side hit test that descends into open shadow roots (the annotator's
 * `deepElementFromPoint`, serialized for `page.evaluateHandle`).
 */
function deepElementFromPointInPage(point: { x: number; y: number }): unknown {
  const doc = (globalThis as unknown as Record<string, any>)["document"];
  let hit = doc.elementFromPoint(point.x, point.y);
  while (hit && hit.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(point.x, point.y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
}

/** The element at viewport (x, y), piercing open shadow roots, or null. */
async function elementAtPoint(
  page: Page,
  point: { x: number; y: number },
): Promise<ElementHandle | null> {
  const handle = await page.evaluateHandle(deepElementFromPointInPage, point);
  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    return null;
  }
  return element as ElementHandle;
}

function short(text: string, max = 200): string {
  const clean = sanitizePageText(text);
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

/** Resolve an action's target to a Playwright Locator, or null. */
export function resolveLocator(page: Page, action: Action): Locator | null {
  if (action.elementId !== undefined) {
    return page.locator(somSelector(action.elementId));
  }
  if (action.selector) return page.locator(action.selector);
  return null;
}

/** Re-verify that an elementId target still exists in the live DOM. */
export async function elementExists(page: Page, elementId: number): Promise<boolean> {
  const count = await page.locator(somSelector(elementId)).count();
  return count > 0;
}

/** Get the center point of an action target, or null. */
export async function targetCenter(
  page: Page,
  action: Action,
): Promise<{ x: number; y: number } | null> {
  if (action.x !== undefined && action.y !== undefined) {
    return { x: action.x, y: action.y };
  }
  const loc = resolveLocator(page, action);
  if (!loc) return null;
  const box = await loc.boundingBox();
  if (!box) return null;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function execAction(page: Page, action: Action): Promise<void> {
  const center = await targetCenter(page, action);
  const loc = resolveLocator(page, action);
  const label =
    action.elementId !== undefined
      ? `[${action.elementId}]`
      : action.selector ?? (center ? `${center.x},${center.y}` : null);
  if (label) await hudUpdate(page, `Acting on ${label}`);

  switch (action.type) {
    case "click": {
      if (center) await hudCursor(page, center.x, center.y);
      if (loc) {
        await loc.click();
      } else if (center) {
        await page.mouse.click(center.x, center.y);
      }
      if (center) await hudRipple(page, center.x, center.y);
      break;
    }
    case "double_click": {
      if (center) await hudCursor(page, center.x, center.y);
      if (loc) await loc.dblclick();
      else if (center) await page.mouse.dblclick(center.x, center.y);
      if (center) await hudRipple(page, center.x, center.y);
      break;
    }
    case "right_click": {
      if (center) await hudCursor(page, center.x, center.y);
      if (loc) await loc.click({ button: "right" });
      else if (center)
        await page.mouse.click(center.x, center.y, { button: "right" });
      if (center) await hudRipple(page, center.x, center.y);
      break;
    }
    case "type": {
      if (loc) {
        await loc.focus();
        await loc.pressSequentially(action.text ?? "");
      } else {
        // No explicit target: type into whatever already holds focus (canvas
        // text editors, contenteditable regions, custom widgets).
        await page.keyboard.type(action.text ?? "");
      }
      if (action.pressEnter) await page.keyboard.press("Enter");
      break;
    }
    case "clear_and_type": {
      if (loc) {
        await loc.focus();
        await loc.fill(action.text ?? "");
      } else if (center) {
        const element = await elementAtPoint(page, center);
        if (!element) throw new Error(`clear_and_type: no element at (${center.x}, ${center.y})`);
        try {
          await element.fill(action.text ?? "");
        } finally {
          await element.dispose();
        }
      }
      if (action.pressEnter) await page.keyboard.press("Enter");
      break;
    }
    case "press_key": {
      await page.keyboard.press(action.key ?? "Enter");
      break;
    }
    case "hover": {
      if (center) await hudCursor(page, center.x, center.y);
      if (loc) await loc.hover();
      else if (center) await page.mouse.move(center.x, center.y);
      break;
    }
    case "select_option": {
      if (action.text === undefined) {
        throw new InvalidInputError("select_option requires `text` (the option label)");
      }
      const el = loc ? await loc.elementHandle() : center ? await elementAtPoint(page, center) : null;
      if (!el) throw new Error(`select_option: no element at ${label ?? "the target"}`);
      try {
        const info = await el.evaluate((node: unknown) => {
          const n = node as { tagName: string; options?: ArrayLike<{ label: string }> };
          return {
            tag: n.tagName,
            labels: n.tagName === "SELECT" && n.options ? Array.from(n.options, (o) => o.label) : [],
          };
        });
        if (info.tag !== "SELECT") {
          throw new InvalidInputError(
            `select_option target is <${short(info.tag.toLowerCase(), 40)}>, not <select>`,
          );
        }
        if (!info.labels.includes(action.text)) {
          const options = info.labels.slice(0, 20).map((l) => `"${short(l, 60)}"`).join(", ");
          throw new InvalidInputError(
            `no option labelled "${short(action.text)}"; options: ${options || "(none)"}`,
          );
        }
        if (loc) await loc.selectOption({ label: action.text });
        else await el.selectOption({ label: action.text });
      } finally {
        await el.dispose();
      }
      break;
    }
    case "scroll": {
      const dir = action.scrollDirection ?? "down";
      const amount = action.scrollAmount ?? 400;
      let dx = 0,
        dy = 0;
      if (dir === "up") dy = -amount;
      else if (dir === "down") dy = amount;
      else if (dir === "left") dx = -amount;
      else if (dir === "right") dx = amount;
      if (loc) {
        // Wheel over the target so its own scroll container moves.
        await loc.scrollIntoViewIfNeeded();
        const box = await loc.boundingBox();
        if (!box) throw new Error(`scroll: could not resolve the position of ${label ?? "the target"}`);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(dx, dy);
      } else if (center) {
        await page.mouse.move(center.x, center.y);
        await page.mouse.wheel(dx, dy);
      } else await page.mouse.wheel(dx, dy);
      break;
    }
    case "drag": {
      if (!center) {
        // Never fall back to (0, 0): that drags from a point nobody chose.
        throw new Error(
          `drag: could not resolve the position of ${label ?? "the start point"}; the element has no layout box`,
        );
      }
      await hudCursor(page, center.x, center.y);
      const start = center;
      if (action.toX === undefined || action.toY === undefined) {
        throw new Error("browse_interact: `drag` requires `toX` and `toY` (viewport CSS px)");
      }
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(action.toX, action.toY, { steps: 12 });
      await page.mouse.up();
      await hudRipple(page, action.toX, action.toY);
      break;
    }
    case "wait": {
      await new Promise((r) => setTimeout(r, 300));
      break;
    }
  }
}

/**
 * Execute a batch of actions with stale-ID detection.
 * Stops cleanly when a target element is detached/stale after a prior action.
 */
export async function execBatch(
  page: Page,
  actions: Action[],
): Promise<BatchResult> {
  // Reject a syntactically invalid selector before any step runs. Playwright's
  // own parser keeps its selector extensions (text=, >>, …) valid.
  for (const action of actions) {
    if (action.selector === undefined) continue;
    try {
      await page.locator(action.selector).count();
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      throw new InvalidInputError(
        `invalid selector "${short(action.selector)}": ${short(message ?? "")}`,
        "fix the CSS selector or use an elementId from the element map",
      );
    }
  }
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (!action) continue;
    // Re-verify elementId targets before every step.
    if (action.elementId !== undefined && !(await elementExists(page, action.elementId))) {
      return {
        completed: i,
        stoppedAt: i + 1,
        message:
          `Stopped at action #${i + 1}: Element [${action.elementId}] became stale or detached ` +
          `after the previous action modified the page. Review the updated element map below to continue.`,
        staleElementId: action.elementId,
      };
    }
    await execAction(page, action);
  }
  return { completed: actions.length, stoppedAt: null, message: null, staleElementId: null };
}

export interface PerceptionResult {
  readonly elements: readonly ElementLine[];
  readonly screenshotPath: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly telemetryEvents: readonly { readonly type: string; readonly text: string }[];
}

export async function capturePerception(
  page: Page,
  telemetry: Telemetry,
  opts: {
    readonly screenshotDir: string;
    readonly annotate?: boolean;
    readonly fullPage?: boolean;
    /** Screenshot timeout (Playwright default 30 s when omitted). */
    readonly timeoutMs?: number;
    /**
     * Drain telemetry into the result (default true). Callers that retry
     * capture pass false and call `drainTelemetryEvents` once, so a failed
     * attempt never consumes events.
     */
    readonly drainTelemetry?: boolean;
  },
): Promise<PerceptionResult> {
  // Re-index the current page into a fresh [1..N] element map.
  const indexed: unknown = await page.evaluate(() => {
    const w = globalThis as unknown as Record<string, any>;
    const s = w["__opencodeSom"];
    if (!s) return { elements: [], count: 0, capped: false };
    return s.indexPage();
  });
  const rec = indexed as { elements?: unknown } | null;
  const elements = Array.isArray(rec?.elements) ? (rec.elements as ElementLine[]) : [];

  let screenshotPath: string | null = null;
  let width: number | null = null;
  let height: number | null = null;

  // Always capture: annotate:false means a clean screenshot, not no screenshot.
  // Screenshot hygiene: hide HUD, optionally render SoM badges, capture,
  // remove the overlay, restore the HUD. The restore is a finally: a failed or
  // timed-out screenshot must never leave the HUD hidden or badges painted.
  await page
    .evaluate(() => {
      const w = globalThis as unknown as Record<string, any>;
      const h = w["__opencodeHud"];
      if (h) h.hide();
    })
    .catch(() => undefined);

  let buffer: Buffer;
  try {
    if (opts.annotate !== false) {
      await page
        .evaluate(() => {
          const w = globalThis as unknown as Record<string, any>;
          const s = w["__opencodeSom"];
          if (s) s.renderSoMOverlay();
        })
        .catch(() => undefined);
    }

    buffer = await page.screenshot({
      fullPage: opts.fullPage ?? false,
      ...(opts.timeoutMs === undefined ? {} : { timeout: Math.max(1, Math.round(opts.timeoutMs)) }),
    });
    const vp = page.viewportSize();
    width = vp?.width ?? null;
    height = vp?.height ?? null;
  } finally {
    if (opts.annotate !== false) {
      await page
        .evaluate(() => {
          const w = globalThis as unknown as Record<string, any>;
          const s = w["__opencodeSom"];
          if (s) s.removeSoMOverlay();
        })
        .catch(() => undefined);
    }
    await page
      .evaluate(() => {
        const w = globalThis as unknown as Record<string, any>;
        const h = w["__opencodeHud"];
        if (h) h.show();
      })
      .catch(() => undefined);
  }

  screenshotPath = await savePng(buffer, opts.screenshotDir);

  const telemetryEvents = opts.drainTelemetry === false ? [] : drainTelemetryEvents(telemetry);

  return { elements, screenshotPath, width, height, telemetryEvents };
}

/** Delta drain: only telemetry generated since the last tool call. */
export function drainTelemetryEvents(
  telemetry: Telemetry,
): { readonly type: string; readonly text: string }[] {
  return telemetry.drain().events.map((e) => ({ type: e.type, text: e.text }));
}

/** Raised when a capture attempt runs past its perception budget. */
export class PerceptionTimeoutError extends Error {
  constructor(ms: number) {
    super(`perception did not finish within ${ms}ms`);
    this.name = "PerceptionTimeoutError";
  }
}

/**
 * True for errors caused by the document changing under an evaluate or a
 * screenshot: the page navigated or reloaded during capture.
 */
export function isNavigationRace(error: unknown): boolean {
  if (error instanceof PerceptionTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message;
  if (
    message.includes("Execution context was destroyed") ||
    message.includes("frame was detached") ||
    message.includes("Cannot find context with specified id")
  ) {
    return true;
  }
  return error.name === "TimeoutError" && message.includes("screenshot");
}

/**
 * Create the screenshot directory owner-only (0700). An existing directory
 * must be a real directory, not a symlink; one owned by this uid is tightened
 * to 0700.
 */
function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`screenshot directory ${dir} is not a directory (or is a symlink)`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && st.uid === uid && (st.mode & 0o777) !== 0o700) {
    fs.chmodSync(dir, 0o700);
  }
}

async function savePng(buffer: Buffer, screenshotDir: string): Promise<string> {
  ensurePrivateDir(screenshotDir);
  const file = path.join(
    screenshotDir,
    `opencode-som-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`,
  );
  // 0600 and O_CREAT|O_EXCL: private even under a shared parent directory, and
  // never follows a planted file or symlink.
  fs.writeFileSync(file, buffer, { mode: 0o600, flag: "wx" });
  return file;
}
