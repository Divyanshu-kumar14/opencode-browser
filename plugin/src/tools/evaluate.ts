/**
 * browser_eval — sandboxed JavaScript evaluation in the page context (e.g. reading
 * localStorage, checking window globals, inspecting React state). Returns the
 * serialized result alongside any new console/runtime errors.
 */

import { z } from "zod";
import type { BrowserSessionManager } from "../core/session-manager.ts";
import { capturePerception } from "../core/action-engine.ts";
import { buildPagePayload } from "../utils/formatter.ts";

export const schema = z.object({
  expression: z.string().describe("Expression to evaluate in the page context"),
});

export type Input = z.infer<typeof schema>;

export const description =
  "Evaluate arbitrary diagnostic JavaScript in the page context and return the " +
  "serialized result. Use for reading localStorage, window globals, or React state. " +
  "Always check the Telemetry section for runtime errors triggered by the evaluation.";

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

  let rendered: string;
  let threw = false;
  try {
    const value = await page.evaluate<unknown>(input.expression);
    if (value === undefined) rendered = "undefined";
    else {
      try { rendered = JSON.stringify(value); }
      catch { rendered = String(value); }
    }
  } catch (error) {
    threw = true;
    rendered = error instanceof Error ? error.message : String(error);
  }

  const perception = await capturePerception(page, telemetry, {
    screenshotDir,
    annotate: false,
    fullPage: false,
  });

  const lines: string[] = [];
  lines.push(`## Eval result`);
  lines.push(threw ? `Error: ${rendered}` : rendered);
  lines.push("");
  lines.push(`## Telemetry`);
  lines.push(...formatTelemetryLines(perception.telemetryEvents));
  const text = lines.join("\n");

  const content: Array<{ type: string; text?: string; uri?: string; mime?: string; name?: string }> = [
    { type: "text", text },
  ];

  return {
    content,
    metadata: {
      url: page.url(),
      tabId: (page as any).__opencodePageId,
      threw,
      elementCount: perception.elements.length,
    },
  };
}

function formatTelemetryLines(events: readonly { readonly type: string; readonly text: string }[]): string[] {
  if (events.length === 0) return ["Errors: none"];
  const out: string[] = ["### New Console & Network Errors"];
  for (const e of events) out.push(`  - [${e.type}] ${e.text}`);
  return out;
}
