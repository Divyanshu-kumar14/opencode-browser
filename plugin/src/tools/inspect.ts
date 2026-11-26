/**
 * browse_inspect — deep diagnostic info for one element (computed styles,
 * bounding box, attributes, parent/child summary).
 */

import { z } from "zod";
import type { ToolResult } from "../core/turn.ts";
import { screenshotField, turnContext, type ToolCallContext, type ToolDeps } from "./types.ts";

export const schema = z
  .object({
    elementId: z.number().int().positive().optional().describe("[1..N] element id from the element map"),
    selector: z.string().optional().describe("CSS selector fallback"),
    cssProperties: z.array(z.string()).optional().describe("Additional computed CSS properties to return"),
    screenshot: screenshotField,
  })
  .strict()
  .refine((input) => input.elementId !== undefined || input.selector !== undefined, {
    message: "pass either `elementId` or `selector`",
  });

export type Input = z.infer<typeof schema>;

export const description =
  "Return deep diagnostics for one element: tag, classes, attributes, innerText, " +
  "exact bounding box, visibility state, parent/child summary, and key computed CSS " +
  "styles (display, position, z-index, colors, font, box model, flex/grid, plus any " +
  "requested cssProperties). Use for debugging spacing, alignment, z-index, or " +
  "responsive styling bugs. A clean screenshot is captured with the result.";

export async function execute(
  input: Input,
  deps: ToolDeps,
  context?: ToolCallContext,
): Promise<ToolResult> {
  return deps.session.turn({
    kind: "inspect",
    elementId: input.elementId,
    selector: input.selector,
    cssProperties: input.cssProperties,
    screenshot: input.screenshot,
  }, turnContext(context));
}
