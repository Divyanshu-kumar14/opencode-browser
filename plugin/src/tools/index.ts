/**
 * Tool registration for the perception-action engine.
 *
 * Each tool module exports `description`, `schema` (zod, the single source of
 * truth) and `execute(input, deps)`. `defineTool` links the two, and the
 * registry derives the advertised JSON Schema from zod so the two can never
 * drift. The wrapper converts validation failures to `INVALID_INPUT` and
 * execution failures to `INTERNAL`, both as `Tool.Error`.
 */

import { Error as ToolError } from "@opencode/plugin/promise/tool";
import type { ToolEditor } from "@opencode/plugin/promise/tool";
import { z } from "zod";
import type { ToolResult } from "../core/turn.ts";
import * as navigateTool from "./navigate.ts";
import * as interactTool from "./interact.ts";
import * as snapshotTool from "./snapshot.ts";
import * as inspectTool from "./inspect.ts";
import * as viewportTool from "./viewport.ts";
import * as evaluateTool from "./evaluate.ts";
import type { ToolDeps } from "./types.ts";

interface AnyTool {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodTypeAny;
  readonly execute: (input: unknown, deps: ToolDeps) => Promise<ToolResult>;
}

/** Link a zod schema to its handler; the schema stays the only declaration. */
function defineTool<S extends z.ZodTypeAny>(definition: {
  readonly name: string;
  readonly description: string;
  readonly schema: S;
  readonly execute: (input: z.infer<S>, deps: ToolDeps) => Promise<ToolResult>;
}): AnyTool {
  return {
    name: definition.name,
    description: definition.description,
    schema: definition.schema,
    execute: (input, deps) => definition.execute(input as z.infer<S>, deps),
  };
}

const tools: readonly AnyTool[] = [
  defineTool({
    name: "navigate",
    description: navigateTool.description,
    schema: navigateTool.schema,
    execute: navigateTool.execute,
  }),
  defineTool({
    name: "interact",
    description: interactTool.description,
    schema: interactTool.schema,
    execute: interactTool.execute,
  }),
  defineTool({
    name: "snapshot",
    description: snapshotTool.description,
    schema: snapshotTool.schema,
    execute: snapshotTool.execute,
  }),
  defineTool({
    name: "inspect",
    description: inspectTool.description,
    schema: inspectTool.schema,
    execute: inspectTool.execute,
  }),
  defineTool({
    name: "viewport",
    description: viewportTool.description,
    schema: viewportTool.schema,
    execute: viewportTool.execute,
  }),
  defineTool({
    name: "eval",
    description: evaluateTool.description,
    schema: evaluateTool.schema,
    execute: evaluateTool.execute,
  }),
];

/** Add `additionalProperties: false` to every object node (strict inputs). */
function strictify(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) strictify(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (
    record["type"] === "object" &&
    record["properties"] !== undefined &&
    record["additionalProperties"] === undefined
  ) {
    record["additionalProperties"] = false;
  }
  for (const value of Object.values(record)) strictify(value);
}

/** Derive the advertised JSON Schema from the zod schema. */
export function inputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", target: "draft-7" }) as Record<string, unknown>;
  delete json["$schema"];
  strictify(json);
  return json;
}

/**
 * Recognize `Tool.Error` across module instances. The host may resolve a
 * second copy of `@opencode/plugin`, in which case `instanceof` is false even
 * though the error is a legitimate typed error with its own metadata.
 */
function isToolError(error: unknown): error is ToolError {
  if (error instanceof ToolError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { _tag?: unknown })._tag === "Tool.Error"
  );
}

/** Register all perception-action tools on the editor. */
export function registerBrowserTools(
  editor: ToolEditor,
  deps: ToolDeps,
  namespace: string,
): void {
  for (const tool of tools) {
    editor.add({
      name: tool.name,
      description: tool.description,
      input: inputSchema(tool.schema),
      options: { codemode: true, namespace },
      execute: async (input: unknown) => {
        let parsed: unknown;
        try {
          parsed = tool.schema.parse(input);
        } catch (error) {
          throw new ToolError({
            message: error instanceof Error ? error.message : String(error),
            metadata: {
              code: "INVALID_INPUT",
              hint: "check the tool's parameter schema and retry",
            },
          });
        }

        try {
          const result = await tool.execute(parsed, deps);
          return { content: result.content, metadata: result.metadata };
        } catch (error) {
          if (isToolError(error)) throw error;
          throw new ToolError({
            message: error instanceof Error ? error.message : String(error),
            metadata: {
              code: "INTERNAL",
              hint: "the browser turn failed; check the message and retry",
            },
          });
        }
      },
    });
  }
}
