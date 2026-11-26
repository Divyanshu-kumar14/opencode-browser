/**
 * browse_upload — put files into a file input, or into the file picker a
 * button opens. Only files inside the project folder (or the download folder)
 * can be read.
 */
import { z } from "zod";
import type { ToolResult } from "../core/turn.ts";
import { screenshotField, turnContext, type ToolCallContext, type ToolDeps } from "./types.ts";

export const schema = z
  .object({
    elementId: z.number().int().positive().optional().describe("The file input, or the button that opens a file picker"),
    selector: z.string().min(1).optional().describe("CSS fallback for the target"),
    paths: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .describe("Files to upload: relative to the project folder, or absolute inside it or the download folder"),
    screenshot: screenshotField,
  })
  .strict()
  .refine((input) => input.elementId !== undefined || input.selector !== undefined, {
    message: "pass either `elementId` or `selector`",
  });
export type Input = z.infer<typeof schema>;

export const description =
  "Upload files. Target a file input, or a button that opens a file picker, by elementId or selector. " +
  "Paths are relative to the project folder; files outside it (or outside the download folder, so a " +
  "file you downloaded can be uploaded again) are refused. Returns the refreshed page.";

export async function execute(
  input: Input,
  deps: ToolDeps,
  context?: ToolCallContext,
): Promise<ToolResult> {
  return deps.session.turn(
    {
      kind: "upload",
      ...(input.elementId === undefined ? {} : { elementId: input.elementId }),
      ...(input.selector === undefined ? {} : { selector: input.selector }),
      paths: input.paths,
      screenshot: input.screenshot,
    },
    turnContext(context),
  );
}
