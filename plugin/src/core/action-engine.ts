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
import type { Page, Locator } from "playwright";
import { waitForSettled } from "./settle.ts";
import { Telemetry } from "./telemetry.ts";

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

/** Resolve an action's target to a Playwright Locator, or null. */
export function resolveLocator(page: Page, action: Action): Locator | null {
  if (action.elementId !== undefined) {
    return page.locator('[data-opencode-id="' + action.elementId + '"]');
  }
  if (action.selector) return page.locator(action.selector);
  return null;
}

/** Re-verify that an elementId target still exists in the live DOM. */
export async function elementExists(page: Page, elementId: number): Promise<boolean> {
  const count = await page
    .locator('[data-opencode-id="' + elementId + '"]')
    .count();
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
      }
      if (action.pressEnter) await page.keyboard.press("Enter");
      break;
    }
    case "clear_and_type": {
      if (loc) {
        await loc.focus();
        await loc.fill(action.text ?? "");
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
      if (loc) {
        const el = await loc.elementHandle();
        if (el) {
          const tag = await el.evaluate((node: unknown) => (node as { tagName: string }).tagName);
          if (tag === "SELECT" && action.text !== undefined) {
            await loc.selectOption({ label: action.text });
          }
        }
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
      if (center) await page.mouse.wheel(dx, dy);
      else await page.mouse.wheel(dx, dy);
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
  readonly elements: unknown[];
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
  const elements: unknown[] = Array.isArray(rec?.elements)
    ? (rec?.elements as unknown[])
    : [];

  let screenshotPath: string | null = null;
  let width: number | null = null;
  let height: number | null = null;

  if (opts.annotate !== false) {
    // Screenshot hygiene: hide HUD, render SoM badges, capture, remove overlay, restore HUD.
    await page
      .evaluate(() => {
        const w = globalThis as unknown as Record<string, any>;
        const h = w["__opencodeHud"];
        if (h) h.hide();
      })
      .catch(() => undefined);
    await page
      .evaluate(() => {
        const w = globalThis as unknown as Record<string, any>;
        const s = w["__opencodeSom"];
        if (s) s.renderSoMOverlay();
      })
      .catch(() => undefined);

    const buffer = await page.screenshot({ fullPage: opts.fullPage ?? false });
    const vp = page.viewportSize();
    width = vp?.width ?? null;
    height = vp?.height ?? null;

    await page
      .evaluate(() => {
        const w = globalThis as unknown as Record<string, any>;
        const s = w["__opencodeSom"];
        if (s) s.removeSoMOverlay();
      })
      .catch(() => undefined);
    await page
      .evaluate(() => {
        const w = globalThis as unknown as Record<string, any>;
        const h = w["__opencodeHud"];
        if (h) h.show();
      })
      .catch(() => undefined);

    screenshotPath = await savePng(buffer, opts.screenshotDir);
  }

  // Delta drain: only telemetry generated since the last tool call.
  const drained = telemetry.drain();
  const telemetryEvents = drained.events.map((e) => ({ type: e.type, text: e.text }));

  return { elements, screenshotPath, width, height, telemetryEvents };
}

async function savePng(buffer: Buffer, screenshotDir: string): Promise<string> {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const file = path.join(
    screenshotDir,
    `opencode-som-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`,
  );
  fs.writeFileSync(file, buffer);
  return file;
}
