/**
 * browser_viewport — resize the viewport (preset or custom), settle, and return
 * a refreshed snapshot + element map.
 */

import { z } from "zod";
import type { BrowserSessionManager } from "../core/session-manager.ts";
import { capturePerception } from "../core/action-engine.ts";
import { waitForSettled } from "../core/settle.ts";
import { buildPagePayload } from "../utils/formatter.ts";

const PRESETS: Record<string, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

export const schema = z.object({
  preset: z.enum(["desktop", "laptop", "tablet", "mobile"]).optional().describe("Viewport preset"),
  width: z.number().optional().describe("Custom viewport width (CSS px)"),
  height: z.number().optional().describe("Custom viewport height (CSS px)"),
});

export type Input = z.infer<typeof schema>;

export const description =
  "Resize the viewport to a preset (desktop 1440x900, laptop 1280x800, " +
  "tablet 768x1024, mobile 390x844) or custom dimensions, wait for layout to " +
  "settle, and return a refreshed snapshot + element map. Called with no " +
  "arguments, it releases any preset pin and re-syncs the viewport to the " +
  "live window (fixes unpainted strips after manual resizes).";

export interface ToolCtx {
  readonly sessionManager: BrowserSessionManager;
  readonly screenshotDir: string;
}

export async function execute(
  input: Input,
  ctx: ToolCtx,
): Promise<{ content: Array<{ type: string; text?: string; uri?: string; mime?: string; name?: string }>; metadata?: Record<string, unknown> }> {
  const { sessionManager, screenshotDir } = ctx;
  // Bare call = release the pin and re-sync to the live window.
  const resyncOnly = input.preset === undefined && input.width === undefined && input.height === undefined;
  if (resyncOnly) sessionManager.unpinViewport();
  const page = await sessionManager.ensureActivePage();
  const telemetry = sessionManager.getTelemetry();

  let width: number, height: number;
  if (resyncOnly) {
    const vs = page.viewportSize();
    width = vs?.width ?? 1280;
    height = vs?.height ?? 720;
  } else if (input.preset) {
    const preset = PRESETS[input.preset];
    if (!preset) throw new Error(`browse_viewport: unknown preset "${input.preset}"`);
    width = preset.width; height = preset.height;
  } else {
    if (input.width === undefined || input.height === undefined) {
      throw new Error("browse_viewport: pass `preset`, both `width` and `height`, or nothing to re-sync to the window");
    }
    width = input.width; height = input.height;
  }

  if (!resyncOnly) {
    await page.setViewportSize({ width, height });
    sessionManager.pinViewport();
  }
  await waitForSettled(page);

  const perception = await capturePerception(page, telemetry, { screenshotDir, annotate: true });

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
      viewport: { width, height },
      screenshotPath: perception.screenshotPath,
      elementCount: perception.elements.length,
    },
  };
}
