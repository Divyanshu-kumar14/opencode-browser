/**
 * browse_dialog — decide how the next alert, confirm or prompt on this tab is
 * answered. Dialogs are always answered automatically (they would otherwise
 * freeze the page) and reported; this overrides the default for one dialog.
 */
import { z } from "zod";
import type { ToolResult } from "../core/turn.ts";
import { screenshotField, turnContext, type ToolCallContext, type ToolDeps } from "./types.ts";

export const schema = z
  .object({
    action: z.enum(["accept", "dismiss"]).describe("How to answer the next dialog on this tab"),
    promptText: z.string().max(1000).optional().describe("Text to type when accepting a prompt()"),
    screenshot: screenshotField,
  })
  .strict()
  .refine((input) => input.promptText === undefined || input.action === "accept", {
    message: "`promptText` only applies when action is `accept`",
    path: ["promptText"],
  });
export type Input = z.infer<typeof schema>;

export const description =
  "Choose how the NEXT alert, confirm or prompt on this tab is answered; call it before the action " +
  "that opens the dialog. Without it, alerts and beforeunload are accepted and confirm/prompt are " +
  "dismissed, and every dialog is reported in the result of the turn that triggered it. The choice " +
  "applies to one dialog only.";

export async function execute(
  input: Input,
  deps: ToolDeps,
  context?: ToolCallContext,
): Promise<ToolResult> {
  return deps.session.turn(
    {
      kind: "dialog",
      accept: input.action === "accept",
      ...(input.promptText === undefined ? {} : { promptText: input.promptText }),
      screenshot: input.screenshot,
    },
    turnContext(context),
  );
}
