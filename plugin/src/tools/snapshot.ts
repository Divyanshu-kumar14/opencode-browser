/**
 * browser_snapshot — re-index the current page and capture a fresh annotated
 * screenshot (or plain screenshot) without performing any interaction. Drains
 * any new telemetry.
 */

import { z } from "zod";
import type { BrowserSessionManager } from "../core/session-manager.ts";
import { capturePerception, hudClear } from "../core/action-engine.ts";
import { buildPagePayload } from "../utils/formatter.ts";

export const schema = z.object({
  annotate: z.boolean().optional().default(true).describe("Draw SoM numbered badges on the screenshot"),
  fullPage: z.boolean().optional().default(false).describe("Capture the full scrollable page"),
});

export type Input = z.infer<typeof schema>;

export const description =
  "Re-index the page and capture a fresh screenshot (with SoM numbered badges by default) " +
  "without mutating state. Returns the [1..N] interactive element map and any new " +
  "console/network errors. Re-run after navigation.";

export interface ToolCtx {
  readonly sessionManager: BrowserSessionManager;
  readonly screenshotDir: string;
}

export async function execute(
  input: Input,
  ctx: ToolCtx,
): Promise<{ content: Array<{ type: string; text?: string; uri?: string; mime?: string; name?: string }>; metadata?: Record<string, unknown> }> {
  const { sessionManager, screenshotDir } = ctx;
  const page = await sessionManager.ensureActivePage();
  const telemetry = sessionManager.getTelemetry();

  const perception = await capturePerception(page, telemetry, {
    screenshotDir,
    annotate: input.annotate,
    fullPage: input.fullPage,
  });
  await hudClear(page);

  const notification = sessionManager.takeTabSwitchNotification();
  const title = await page.title().catch(() => "");
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
  });

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
      annotate: input.annotate,
      fullPage: input.fullPage,
    },
  };
}
