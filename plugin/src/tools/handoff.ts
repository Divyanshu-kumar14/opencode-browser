/**
 * browse_handoff — hand this tab to the user for a step only they can do:
 * signing in, multi-factor approval, a passkey, a CAPTCHA, a payment
 * confirmation. The tab shows "Your turn: <reason>"; the agent stops and asks
 * the user to reply when they are done, then continues where it stopped.
 */
import { z } from "zod";
import type { ToolResult } from "../core/turn.ts";
import { screenshotField, turnContext, type ToolCallContext, type ToolDeps } from "./types.ts";

export const schema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(3)
      .max(160)
      .describe('What the user should do in this tab, e.g. "Sign in to GitHub" or "Solve the CAPTCHA"'),
    screenshot: screenshotField,
  })
  .strict();
export type Input = z.infer<typeof schema>;

export const description =
  "Hand the current tab to the user for a step only they should do: sign in, approve MFA or a " +
  "passkey, solve a CAPTCHA, confirm a payment. Never try to solve a CAPTCHA or guess credentials " +
  "yourself. The tab shows 'Your turn: <reason>'. After calling it, stop using the browser, tell the " +
  "user what to do and to reply when done; when they reply, continue on the same tab.";

export async function execute(
  input: Input,
  deps: ToolDeps,
  context?: ToolCallContext,
): Promise<ToolResult> {
  return deps.session.turn({ kind: "handoff", reason: input.reason, screenshot: input.screenshot }, turnContext(context));
}
