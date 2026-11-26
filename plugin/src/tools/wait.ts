/**
 * browse_wait — wait for a page condition, then return the refreshed page.
 * A timeout is not an error: the page state comes back with a note saying
 * which condition did not hold.
 */
import { z } from "zod";
import type { ToolResult } from "../core/turn.ts";
import { screenshotField, turnContext, type ToolCallContext, type ToolDeps } from "./types.ts";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 30_000;

export const schema = z
  .object({
    text: z.string().min(1).optional().describe("Wait until the visible page text contains this"),
    textGone: z.string().min(1).optional().describe("Wait until the visible page text no longer contains this"),
    selector: z.string().min(1).optional().describe("Wait until a visible element matches this CSS selector"),
    urlContains: z.string().min(1).optional().describe("Wait until the page URL contains this"),
    networkIdle: z.boolean().optional().describe("Wait until the network has been idle for 500 ms"),
    ms: z.number().int().positive().max(MAX_TIMEOUT_MS).optional().describe("Plain delay in milliseconds"),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(MAX_TIMEOUT_MS)
      .optional()
      .default(DEFAULT_TIMEOUT_MS)
      .describe("Give up after this long (default 10000, max 30000), shared by all conditions"),
    screenshot: screenshotField,
  })
  .strict()
  .refine(
    (input) =>
      input.text !== undefined ||
      input.textGone !== undefined ||
      input.selector !== undefined ||
      input.urlContains !== undefined ||
      input.networkIdle === true ||
      input.ms !== undefined,
    { message: "pass at least one condition: text, textGone, selector, urlContains, networkIdle or ms" },
  );
export type Input = z.infer<typeof schema>;

export const description =
  "Wait for something on the page instead of guessing: text to appear or disappear, a selector to " +
  "become visible, the URL to change, or the network to go idle. Every condition you pass must hold, " +
  "within one shared timeout. A timeout is not an error: you get the current page and a note naming " +
  "the condition that did not hold. Use it after an action that loads results asynchronously.";

export async function execute(
  input: Input,
  deps: ToolDeps,
  context?: ToolCallContext,
): Promise<ToolResult> {
  return deps.session.turn(
    {
      kind: "wait",
      conditions: {
        text: input.text,
        textGone: input.textGone,
        selector: input.selector,
        urlContains: input.urlContains,
        networkIdle: input.networkIdle,
        ms: input.ms,
      },
      timeoutMs: input.timeoutMs,
      screenshot: input.screenshot,
    },
    turnContext(context),
  );
}
