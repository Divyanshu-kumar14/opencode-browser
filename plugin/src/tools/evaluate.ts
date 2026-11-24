/**
 * browse_eval — run JavaScript in the page context and return the value.
 *
 * Not a sandbox: the expression runs with the page's privileges.
 */

import { z } from "zod";
import type { ToolResult } from "../core/turn.ts";
import type { ToolDeps } from "./types.ts";

export const schema = z
  .object({
    expression: z.string().describe("Expression to evaluate in the page context"),
  })
  .strict();

export type Input = z.infer<typeof schema>;

export const description =
  "Run a JavaScript expression in the page context and return its JSON-serialized value " +
  "(for example document.title, localStorage.getItem('token'), or a React fiber lookup). " +
  "This is not a sandbox: the expression runs with the page's privileges. A screenshot is " +
  "captured with the result and any new console/network errors are returned.";

export async function execute(input: Input, deps: ToolDeps): Promise<ToolResult> {
  return deps.session.turn({ kind: "evaluate", expression: input.expression });
}
