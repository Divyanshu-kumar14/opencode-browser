import { z } from "zod";
import type { PermissionDomain } from "@opencode/plugin/promise/permission";
import type { BrowserSession } from "../core/browser-session.ts";

/** What every tool handler is given. */
export interface ToolDeps {
  readonly session: BrowserSession;
  /**
   * Host permission domain. Required for browse_eval; `undefined` is allowed
   * only in tests that never exercise eval.
   */
  readonly permission?: Pick<PermissionDomain, "assert">;
  /** Whether the plugin upgrades browse_eval's permission to a prompt. */
  readonly evalPrompt?: boolean;
}

/** The per-call context the host passes to a tool executor. */
export interface ToolCallContext {
  readonly sessionID: string;
  readonly agent?: string;
  readonly messageID: string;
  readonly id: string;
}

/** The `screenshot` parameter every tool shares. */
export const screenshotField = z
  .boolean()
  .optional()
  .describe("Attach a screenshot to the result (default true). false returns text only, which is cheaper.");

/** The per-turn context a tool hands to the browser session. */
export function turnContext(context: ToolCallContext | undefined): { readonly sessionId?: string } {
  return context === undefined ? {} : { sessionId: context.sessionID };
}
