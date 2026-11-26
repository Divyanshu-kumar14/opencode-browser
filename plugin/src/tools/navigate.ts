/**
 * browse_navigate — navigate the active tab (goto / back / forward / reload).
 * The session turn owns settle, perception, screenshot, telemetry, and HUD.
 */

import { z } from "zod";
import type { ToolResult } from "../core/turn.ts";
import { turnContext, type ToolCallContext, type ToolDeps } from "./types.ts";

export const schema = z
  .object({
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
  })
  .strict()
  .refine((input) => input.action !== "goto" || !!input.url, {
    message: "`url` is required when action is `goto`",
    path: ["url"],
  });

export type Input = z.infer<typeof schema>;

export const description =
  "Navigate the active browser tab. Use goto with a url to load a page; back/forward/reload " +
  "to move history. Always settles the DOM/network, returns the [1..N] interactive element " +
  "map, an annotated screenshot, and any new console/network errors. Prefer elementId from " +
  "the element map over guessing CSS selectors in subsequent calls.";

export async function execute(
  input: Input,
  deps: ToolDeps,
  context?: ToolCallContext,
): Promise<ToolResult> {
  return deps.session.turn({
    kind: "navigate",
    action: input.action,
    url: input.url,
    waitUntil: input.waitUntil,
  }, turnContext(context));
}
