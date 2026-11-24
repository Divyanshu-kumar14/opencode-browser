/**
 * browse_snapshot — re-index + fresh screenshot without mutating the page.
 */

import { z } from "zod";
import type { ToolResult } from "../core/turn.ts";
import type { ToolDeps } from "./types.ts";

export const schema = z
  .object({
    annotate: z.boolean().optional().default(true).describe("Draw SoM numbered badges on the screenshot"),
    fullPage: z.boolean().optional().default(false).describe("Capture the full scrollable page"),
  })
  .strict();

export type Input = z.infer<typeof schema>;

export const description =
  "Observe the current page without mutating it. Re-indexes the visible interactive elements " +
  "into a fresh [1..N] map, captures an annotated screenshot (unless annotate=false), and " +
  "drains any new console/network errors. Use after the page changed on its own.";

export async function execute(input: Input, deps: ToolDeps): Promise<ToolResult> {
  return deps.session.turn({
    kind: "observe",
    annotate: input.annotate,
    fullPage: input.fullPage,
  });
}
