/**
 * browse_tabs — list, open, switch and close this session's own tabs.
 * Another session's tabs, and in an attached browser the user's tabs, are
 * never listed or touched.
 */
import { z } from "zod";
import type { ToolResult } from "../core/turn.ts";
import { screenshotField, turnContext, type ToolCallContext, type ToolDeps } from "./types.ts";

export const schema = z
  .object({
    action: z.enum(["list", "open", "switch", "close"]).describe("What to do"),
    url: z.string().min(1).optional().describe("For open: the URL to load in the new tab (default about:blank)"),
    tabId: z
      .string()
      .min(1)
      .optional()
      .describe("For switch (required) and close (default: the active tab): a tab id from the list"),
    screenshot: screenshotField,
  })
  .strict()
  .refine((input) => input.action !== "switch" || input.tabId !== undefined, {
    message: "`tabId` is required when action is `switch`",
    path: ["tabId"],
  })
  .refine((input) => input.url === undefined || input.action === "open", {
    message: "`url` only applies when action is `open`",
    path: ["url"],
  })
  .refine((input) => input.tabId === undefined || input.action === "switch" || input.action === "close", {
    message: "`tabId` only applies to `switch` and `close`",
    path: ["tabId"],
  });
export type Input = z.infer<typeof schema>;

export const description =
  "Manage your own browser tabs. list: your tabs with ids, the active one marked *. open: a new tab, " +
  "optionally loading url, which becomes active. switch: make one of your tabs active by tabId. close: " +
  "close a tab (default the active one). Popups you open become your tabs automatically. You never see " +
  "or touch other sessions' tabs or the user's tabs. Every action returns the active tab's page.";

export async function execute(
  input: Input,
  deps: ToolDeps,
  context?: ToolCallContext,
): Promise<ToolResult> {
  return deps.session.turn(
    {
      kind: "tabs",
      action: input.action,
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
      screenshot: input.screenshot,
    },
    turnContext(context),
  );
}
