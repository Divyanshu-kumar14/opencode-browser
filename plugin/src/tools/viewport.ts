/**
 * browse_viewport — resize the page to a preset or custom CSS size.
 * A bare call releases the override so the page follows the live window again.
 */

import { z } from "zod";
import type { ToolResult } from "../core/turn.ts";
import type { ToolDeps } from "./types.ts";

export const schema = z
  .object({
    preset: z
      .enum(["desktop", "laptop", "tablet", "mobile"])
      .optional()
      .describe("Viewport preset"),
    width: z.number().int().positive().optional().describe("Custom viewport width (CSS px)"),
    height: z.number().int().positive().optional().describe("Custom viewport height (CSS px)"),
  })
  .strict()
  .refine((input) => (input.width === undefined) === (input.height === undefined), {
    message: "pass both `width` and `height`, or neither",
    path: ["height"],
  })
  .refine(
    (input) => input.preset === undefined || (input.width === undefined && input.height === undefined),
    { message: "pass either `preset` or `width` + `height`, not both", path: ["width"] },
  );

export type Input = z.infer<typeof schema>;

export const description =
  "Resize the page to a preset (desktop 1440x900, laptop 1280x800, tablet 768x1024, " +
  "mobile 390x844), a custom width+height, or call with no arguments to release the " +
  "override so the page fills the live browser window again. Settles and returns the refreshed element map " +
  "and screenshot.";

export async function execute(input: Input, deps: ToolDeps): Promise<ToolResult> {
  return deps.session.turn({
    kind: "viewport",
    preset: input.preset,
    width: input.width,
    height: input.height,
  });
}
