/**
 * Tool registration for the perception-action engine.
 *
 * Each tool module exports `description`, `schema` (zod, for runtime input
 * validation) and `execute(input, deps)`. This module maps them onto the
 * OpenCode V2 `ToolEditor` with plain JSON-Schema inputs under the `browse`
 * namespace.
 */

import { Error as ToolError } from "@opencode/plugin/promise/tool";
import type { ToolEditor } from "@opencode/plugin/promise/tool";
import type { z } from "zod";
import * as navigateTool from "./navigate.ts";
import * as interactTool from "./interact.ts";
import * as snapshotTool from "./snapshot.ts";
import * as inspectTool from "./inspect.ts";
import * as viewportTool from "./viewport.ts";
import * as evaluateTool from "./evaluate.ts";

export interface ToolDeps {
  readonly sessionManager: import("../core/session-manager.ts").BrowserSessionManager;
  readonly screenshotDir: string;
}

function jsonSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const baseOptions = { codemode: true } as const;

const specs: {
  readonly name: string;
  readonly description: string;
  readonly input: Record<string, unknown>;
  readonly schema: z.ZodTypeAny;
  readonly execute: (
    input: never,
    deps: ToolDeps,
  ) => Promise<{
    readonly content: unknown;
    readonly metadata?: Record<string, unknown>;
  }>;
}[] = [
  {
    name: "navigate",
    description: navigateTool.description,
    input: jsonSchema({
      url: { type: "string", description: "URL to load (required for action: goto)." },
      action: {
        type: "string",
        description: "Navigation action: goto | back | forward | reload (default goto).",
      },
      waitUntil: {
        type: "string",
        description: "Readiness to wait for: load | domcontentloaded | networkidle.",
      },
    }),
    schema: navigateTool.schema,
    execute: navigateTool.execute as (
      input: never,
      deps: ToolDeps,
    ) => Promise<{ readonly content: unknown; readonly metadata?: Record<string, unknown> }>,
  },
  {
    name: "interact",
    description: interactTool.description,
    input: jsonSchema({
      actions: {
        type: "array",
        description: "Batch of actions to run in sequence (fill + submit in one turn).",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "click | double_click | right_click | type | clear_and_type | press_key | hover | select_option | scroll | drag | wait",
            },
            elementId: { type: "number", description: "[1..N] element id from the element map" },
            selector: { type: "string", description: "CSS fallback selector" },
            x: { type: "number", description: "Viewport CSS x" },
            y: { type: "number", description: "Viewport CSS y" },
            text: { type: "string", description: "Text for type / clear_and_type / select_option" },
            key: { type: "string", description: "Key for press_key, e.g. Enter, Escape, Tab" },
            pressEnter: { type: "boolean", description: "Press Enter after typing" },
            scrollDirection: { type: "string", description: "up | down | left | right" },
            scrollAmount: { type: "number", description: "Scroll pixels" },
            toX: { type: "number", description: "Drag end x (viewport CSS px)" },
            toY: { type: "number", description: "Drag end y (viewport CSS px)" },
          },
          additionalProperties: false,
        },
      },
      type: { type: "string", description: "Single-action shorthand: action type" },
      elementId: { type: "number", description: "[1..N] element id" },
      selector: { type: "string", description: "CSS fallback selector" },
      x: { type: "number", description: "Viewport CSS x" },
      y: { type: "number", description: "Viewport CSS y" },
      text: { type: "string", description: "Text to type" },
      key: { type: "string", description: "Key to press" },
      pressEnter: { type: "boolean", description: "Press Enter after typing" },
      scrollDirection: { type: "string", description: "up | down | left | right" },
      scrollAmount: { type: "number", description: "Scroll pixels" },
    }),
    schema: interactTool.schema,
    execute: interactTool.execute as (
      input: never,
      deps: ToolDeps,
    ) => Promise<{ readonly content: unknown; readonly metadata?: Record<string, unknown> }>,
  },
  {
    name: "snapshot",
    description: snapshotTool.description,
    input: jsonSchema({
      annotate: { type: "boolean", description: "Draw SoM numbered badges on the screenshot (default true)" },
      fullPage: { type: "boolean", description: "Capture the full scrollable page (default false)" },
    }),
    schema: snapshotTool.schema,
    execute: snapshotTool.execute as (
      input: never,
      deps: ToolDeps,
    ) => Promise<{ readonly content: unknown; readonly metadata?: Record<string, unknown> }>,
  },
  {
    name: "inspect",
    description: inspectTool.description,
    input: jsonSchema(
      {
        elementId: { type: "number", description: "[1..N] element id from the element map" },
        selector: { type: "string", description: "CSS selector fallback" },
        cssProperties: { type: "array", items: { type: "string" }, description: "Additional computed CSS properties" },
      },
    ),
    schema: inspectTool.schema,
    execute: inspectTool.execute as (
      input: never,
      deps: ToolDeps,
    ) => Promise<{ readonly content: unknown; readonly metadata?: Record<string, unknown> }>,
  },
  {
    name: "viewport",
    description: viewportTool.description,
    input: jsonSchema({
      preset: { type: "string", description: "desktop | laptop | tablet | mobile" },
      width: { type: "number", description: "Custom viewport width (CSS px)" },
      height: { type: "number", description: "Custom viewport height (CSS px)" },
    }),
    schema: viewportTool.schema,
    execute: viewportTool.execute as (
      input: never,
      deps: ToolDeps,
    ) => Promise<{ readonly content: unknown; readonly metadata?: Record<string, unknown> }>,
  },
  {
    name: "eval",
    description: evaluateTool.description,
    input: jsonSchema({
      expression: { type: "string", description: "Expression to evaluate in the page context" },
    }, ["expression"]),
    schema: evaluateTool.schema,
    execute: evaluateTool.execute as (
      input: never,
      deps: ToolDeps,
    ) => Promise<{ readonly content: unknown; readonly metadata?: Record<string, unknown> }>,
  },
];

/** Register all perception-action tools on the editor. */
export function registerBrowserTools(
  editor: ToolEditor,
  deps: ToolDeps,
  namespace: string,
): void {
  for (const spec of specs) {
    editor.add({
      name: spec.name,
      description: spec.description,
      input: spec.input,
      options: { ...baseOptions, namespace },
      execute: (async (input: unknown) => {
        let parsed: unknown;
        try {
          parsed = spec.schema.parse(input);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new ToolError({
            message,
            metadata: {
              code: "INVALID_INPUT",
              hint: "check the tool's parameter schema and retry",
            },
          });
        }
        const result = await spec.execute(parsed as never, deps);
        return {
          content: result.content,
          metadata: result.metadata,
        };
      }) as never,
    });
  }
}
