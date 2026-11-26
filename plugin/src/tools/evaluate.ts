/**
 * browse_eval — run JavaScript in the page context and return the value.
 *
 * Not a sandbox: the expression runs with the page's privileges, so every
 * call is gated by the host permission `browser_eval`, named with the
 * (redacted) URL of the page it will run on.
 */

import type { PermissionDomain } from "@opencode/plugin/promise/permission";
import type { Registration } from "@opencode/plugin/promise/registration";
import { z } from "zod";
import type { ToolResult } from "../core/turn.ts";
import { redactUrl } from "../core/url-policy.ts";
import { markPassthrough } from "./passthrough.ts";
import { turnContext, type ToolCallContext, type ToolDeps } from "./types.ts";

export const schema = z
  .object({
    expression: z.string().describe("Expression to evaluate in the page context"),
  })
  .strict();

export type Input = z.infer<typeof schema>;

export const description =
  "Run a JavaScript expression in the page context and return its JSON-serialized value " +
  "(for example document.title, localStorage.getItem('token'), or a React fiber lookup). " +
  "This is not a sandbox: the expression runs with the page's privileges, and the user is " +
  "asked to approve each call. A screenshot is captured with the result and any new " +
  "console/network errors are returned.";

/** Host permission action for browse_eval (same name as the legacy shim). */
export const PERMISSION = "browser_eval";

export async function execute(
  input: Input,
  deps: ToolDeps,
  context: ToolCallContext,
): Promise<ToolResult> {
  if (!deps.permission) {
    throw new Error("browse_eval: no permission domain is wired; refusing to run unapproved code");
  }
  // Ask before anything runs, naming the page the expression will run on.
  // This stays outside the turn lock: a pending prompt never blocks others.
  const url = redactUrl(deps.session.activeUrl());
  try {
    await deps.permission.assert({
      sessionID: context.sessionID as never,
      ...(context.agent === undefined ? {} : { agent: context.agent as never }),
      action: PERMISSION,
      resources: [url],
      source: { type: "tool", messageID: context.messageID, id: context.id },
    });
  } catch (error) {
    // The host needs this exact rejection to end the step; never rewrap it.
    markPassthrough(error);
    throw error;
  }
  return deps.session.turn(
    { kind: "evaluate", expression: input.expression, approvedUrl: url },
    turnContext(context),
  );
}

type EvaluateHookDomain = Pick<PermissionDomain, "hook">;

/**
 * With no permission rules the host resolves `browser_eval` to allow. This
 * hook upgrades that default to ask, so the user is prompted unless they set
 * OPENCODE_BROWSER_EVAL_PROMPT=0. Deny and ask rules are never weakened.
 */
export async function registerEvalPrompt(
  permission: EvaluateHookDomain,
  enabled: boolean,
): Promise<Registration | null> {
  if (!enabled) return null;
  return permission.hook("evaluate", (evaluation) => {
    if (evaluation.action === PERMISSION && evaluation.effect === "allow") {
      evaluation.effect = "ask";
    }
  });
}
