/**
 * browser_navigate — navigate the active tab (goto / back / forward / reload),
 * then settle, capture SoM perception + annotated screenshot, drain telemetry.
 */

import { z } from "zod";
import type { BrowserSessionManager } from "../core/session-manager.ts";
import { capturePerception, hudClear, hudUpdate } from "../core/action-engine.ts";
import { waitForSettled } from "../core/settle.ts";
import { buildPagePayload } from "../utils/formatter.ts";

export const schema = z.object({
  url: z.string().optional().describe("URL to load (required for action: goto)."),
  action: z
    .enum(["goto", "back", "forward", "reload"])
    .optional()
    .default("goto")
    .describe("Navigation action."),
  waitUntil: z
    .enum(["load", "domcontentloaded", "networkidle"])
    .optional()
    .describe("Readiness to wait for (default load)."),
});

export type Input = z.infer<typeof schema>;

export const description =
  "Navigate the active browser tab. Use goto with a url to load a page; back/forward/reload " +
  "to move history. Always settles the DOM/network, returns the [1..N] interactive element " +
  "map, an annotated screenshot, and any new console/network errors. Prefer elementId from " +
  "the element map over guessing CSS selectors in subsequent calls.";

export interface ToolCtx {
  readonly sessionManager: BrowserSessionManager;
  readonly screenshotDir: string;
}

export async function execute(
  input: Input,
  ctx: ToolCtx,
): Promise<{ content: unknown; metadata?: Record<string, unknown> }> {
  const { sessionManager, screenshotDir } = ctx;
  const page = await sessionManager.ensureActivePage();
  const telemetry = sessionManager.getTelemetry();

  let url = page.url();
  let waitUntil: "load" | "domcontentloaded" | "networkidle" | undefined;
  if (input.waitUntil) waitUntil = input.waitUntil;

  if (input.action === "goto") {
    if (!input.url) {
      throw new Error("browse_navigate: `url` is required when action is `goto`");
    }
    await hudUpdate(page, `Navigating to ${input.url}`);
    await page.goto(input.url, { waitUntil: waitUntil ?? "load", timeout: 30000 });
    url = input.url;
  } else if (input.action === "back") {
    await hudUpdate(page, "Going back");
    await page.goBack();
    url = page.url();
  } else if (input.action === "forward") {
    await hudUpdate(page, "Going forward");
    await page.goForward();
    url = page.url();
  } else {
    await hudUpdate(page, "Reloading");
    await page.reload();
    url = page.url();
  }

  await waitForSettled(page);
  const perception = await capturePerception(page, telemetry, {
    screenshotDir,
    annotate: true,
  });
  await hudClear(page);

  const notification = sessionManager.takeTabSwitchNotification();
  const title = await page.title().catch(() => "");
  const text = buildPagePayload({
    url,
    title,
    elements: perception.elements as Array<{
      id: number;
      tag: string;
      role: string;
      label: string;
      value: string;
      selectorFallback: string;
      disabled?: boolean;
    }>,
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
      url,
      tabId: (page as any).__opencodePageId,
      screenshotPath: perception.screenshotPath,
      width: perception.width,
      height: perception.height,
      elementCount: perception.elements.length,
    },
  };
}

export default { schema, description, execute };
