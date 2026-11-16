/**
 * browser_interact — click / type / hover / scroll / press_key / select_option /
 * wait, either a single action or a batched `actions[]` sequence (e.g. fill email,
 * fill password, click submit in one turn).
 *
 * Every mutating action runs the full loop: Update HUD -> Execute -> waitForSettled()
 * -> Re-index SoM + annotated screenshot -> Drain telemetry -> Return payload.
 * Stale-ID recovery stops a batch cleanly when a later target is detached.
 */

import { z } from "zod";
import type { BrowserSessionManager } from "../core/session-manager.ts";
import type { Action } from "../core/action-engine.ts";
import {
  execBatch,
  execAction,
  hudClear,
  hudUpdate,
  capturePerception,
} from "../core/action-engine.ts";
import { waitForSettled } from "../core/settle.ts";
import { buildPagePayload } from "../utils/formatter.ts";

const ActionSchema = z.object({
  type: z.enum([
    "click", "double_click", "right_click", "type", "clear_and_type",
    "press_key", "hover", "select_option", "scroll", "drag", "wait",
  ]),
  elementId: z.number().int().positive().optional().describe("[1..N] element id from the element map"),
  selector: z.string().optional().describe("CSS fallback selector"),
  x: z.number().optional().describe("Viewport CSS x"),
  y: z.number().optional().describe("Viewport CSS y"),
  text: z.string().optional().describe("Text for type / clear_and_type / select_option"),
  key: z.string().optional().describe("Key for press_key, e.g. Enter, Escape, Tab"),
  pressEnter: z.boolean().optional().default(false).describe("Press Enter after typing"),
  scrollDirection: z.enum(["up", "down", "left", "right"]).optional(),
  scrollAmount: z.number().optional().describe("Scroll pixels"),
  toX: z.number().optional().describe("Drag end x (viewport CSS px, required for drag)"),
  toY: z.number().optional().describe("Drag end y (viewport CSS px, required for drag)"),
});

export type Input = z.infer<typeof schema>;

export const schema = z.object({
  actions: z.array(ActionSchema).optional().describe("Batch of actions to run in sequence"),
  // Single-action shorthand fields (used when `actions` is omitted)
  type: ActionSchema.shape.type.optional(),
  elementId: ActionSchema.shape.elementId.optional(),
  selector: ActionSchema.shape.selector.optional(),
  x: ActionSchema.shape.x.optional(),
  y: ActionSchema.shape.y.optional(),
  text: ActionSchema.shape.text.optional(),
  key: ActionSchema.shape.key.optional(),
  pressEnter: ActionSchema.shape.pressEnter.optional(),
  scrollDirection: ActionSchema.shape.scrollDirection.optional(),
  scrollAmount: ActionSchema.shape.scrollAmount.optional(),
  toX: z.number().optional().describe("Drag end x (viewport CSS px, required for drag)"),
  toY: z.number().optional().describe("Drag end y (viewport CSS px, required for drag)"),
});

export const description =
  "Interact with the page by [1..N] elementId (preferred), CSS selector, or coordinates. " +
  "Pass `actions` to batch fill+submit in a single turn. Drag with type `drag` from the " +
  "start point (elementId/selector/x/y) to toX/toY. Stale-ID recovery stops a batch " +
  "cleanly if a target detaches. Returns the refreshed element map, annotated screenshot, " +
  "and any new console/network errors.";

export interface ToolCtx {
  readonly sessionManager: BrowserSessionManager;
  readonly screenshotDir: string;
}

function toAction(input: Input): Action {
  const action: Action = {
    type: input.type!,
    elementId: input.elementId,
    selector: input.selector,
    x: input.x,
    y: input.y,
    text: input.text,
    key: input.key,
    pressEnter: input.pressEnter,
    scrollDirection: input.scrollDirection,
    scrollAmount: input.scrollAmount,
    toX: input.toX,
    toY: input.toY,
  };
  return action;
}

export async function execute(
  input: Input,
  ctx: ToolCtx,
): Promise<{ content: Array<{ type: string; text?: string; uri?: string; mime?: string; name?: string }>; metadata?: Record<string, unknown> }> {
  const { sessionManager, screenshotDir } = ctx;
  const page = await sessionManager.ensureActivePage();
  const telemetry = sessionManager.getTelemetry();

  const actions: Action[] = input.actions ?? (input.type ? [toAction(input)] : []);
  if (actions.length === 0) {
    throw new Error("browse_interact: pass `actions` or a single `type` action");
  }

  let batchMessage: string | null = null;
  let stoppedAt: number | null = null;

  if (actions.length === 1) {
    const a = actions[0]!;
    const c = await (() => {
      // resolve center for HUD
      const loc = (() => {
        if (a.elementId !== undefined) return page.locator('[data-opencode-id="' + a.elementId + '"]');
        if (a.selector) return page.locator(a.selector);
        return null;
      })();
      if (!loc) return Promise.resolve<{x:number,y:number}|null>(null);
      return loc.boundingBox().then((b) => b ? { x: b.x + b.width/2, y: b.y + b.height/2 } : null);
    })();
    if (c) await hudUpdate(page, `Acting on [${a.elementId ?? "?"}] at ${c.x},${c.y}`);
    else if (a.elementId !== undefined) await hudUpdate(page, `Acting on [${a.elementId}]`);
    await execAction(page, a);
  } else {
    // Describe the batch intent briefly.
    await hudUpdate(page, `Batch: ${actions.length} actions`);
    const result = await execBatch(page, actions);
    stoppedAt = result.stoppedAt ?? null;
    batchMessage = result.message;
    if (result.staleElementId !== null) {
      await hudUpdate(page, `Stopped at [${result.staleElementId}] — stale`);
    } else {
      await hudUpdate(page, `Batch complete (${result.completed}/${actions.length})`);
    }
  }

  await waitForSettled(page);
  const perception = await capturePerception(page, telemetry, { screenshotDir, annotate: true });
  await hudClear(page);

  const notification = sessionManager.takeTabSwitchNotification();
  const title = await page.title().catch(() => "");
  const tail = batchMessage ? `\n\n${batchMessage}` : "";
  const text = buildPagePayload({
    url: page.url(),
    title,
    elements: perception.elements as Array<{ id: number; tag: string; role: string; label: string; value: string; selectorFallback: string; disabled?: boolean }>,
    tabSwitch: notification,
    screenshotPath: perception.screenshotPath,
    width: perception.width,
    height: perception.height,
    telemetryEvents: perception.telemetryEvents,
    settled: true,
  }) + tail;

  const content: Array<{ type: string; text?: string; uri?: string; mime?: string; name?: string }> = [
    { type: "text", text },
  ];
  if (perception.screenshotPath) {
    content.push({ type: "file", uri: perception.screenshotPath, mime: "image/png" });
  }

  return {
    content,
    metadata: {
      url: page.url(),
      tabId: (page as any).__opencodePageId,
      screenshotPath: perception.screenshotPath,
      width: perception.width,
      height: perception.height,
      elementCount: perception.elements.length,
      stoppedAt,
      batchMessage: batchMessage ?? undefined,
    },
  };
}
