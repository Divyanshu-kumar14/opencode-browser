/**
 * browse_interact — click / type / hover / scroll / press_key / select_option /
 * drag / wait, either a single action or a batched `actions[]` sequence.
 *
 * The session turn owns HUD, execution, settle, perception, screenshot,
 * telemetry, and stale-element recovery reporting.
 */

import { z } from "zod";
import type { Action } from "../core/action-engine.ts";
import type { ToolResult } from "../core/turn.ts";
import { turnContext, type ToolCallContext, type ToolDeps } from "./types.ts";

const ActionShape = z.object({
  type: z.enum([
    "click", "double_click", "right_click", "type", "clear_and_type",
    "press_key", "hover", "select_option", "scroll", "drag", "wait",
  ]),
  elementId: z.number().int().positive().optional().describe("[1..N] element id from the element map"),
  selector: z.string().optional().describe("CSS fallback selector"),
  x: z.number().optional().describe("Viewport CSS x"),
  y: z.number().optional().describe("Viewport CSS y"),
  text: z.string().optional().describe("Text for type / clear_and_type / select_option"),
  key: z.string().optional().describe("Key for press_key, e.g. Enter, Escape, Tab"),
  pressEnter: z.boolean().optional().default(false).describe("Press Enter after typing"),
  scrollDirection: z.enum(["up", "down", "left", "right"]).optional(),
  scrollAmount: z.number().optional().describe("Scroll pixels"),
  toX: z.number().optional().describe("Drag end x (viewport CSS px, required for drag)"),
  toY: z.number().optional().describe("Drag end y (viewport CSS px, required for drag)"),
}).strict();

/** Actions that silently no-op without a target, so reject them up front. */
const TARGETED = new Set([
  "click", "double_click", "right_click", "hover", "select_option", "drag", "clear_and_type",
]);

function hasTarget(action: {
  elementId?: number;
  selector?: string;
  x?: number;
  y?: number;
}): boolean {
  return (
    action.elementId !== undefined ||
    action.selector !== undefined ||
    (action.x !== undefined && action.y !== undefined)
  );
}

const ActionSchema = ActionShape.refine(
  (action) => !TARGETED.has(action.type) || hasTarget(action),
  { message: "this action requires `elementId`, `selector`, or `x` + `y`", path: ["elementId"] },
).refine(
  (action) => action.type !== "drag" || (action.toX !== undefined && action.toY !== undefined),
  { message: "drag requires `toX` and `toY`", path: ["toX"] },
).refine(
  (action) => action.type !== "select_option" || action.text !== undefined,
  { message: "select_option requires `text` (the option label)", path: ["text"] },
);

export const schema = z
  .object({
    actions: z.array(ActionSchema).min(1).optional().describe("Batch of actions to run in sequence"),
    // Single-action shorthand fields (used when `actions` is omitted)
    type: ActionShape.shape.type.optional(),
    elementId: ActionShape.shape.elementId.optional(),
    selector: ActionShape.shape.selector.optional(),
    x: ActionShape.shape.x.optional(),
    y: ActionShape.shape.y.optional(),
    text: ActionShape.shape.text.optional(),
    key: ActionShape.shape.key.optional(),
    pressEnter: ActionShape.shape.pressEnter.optional(),
    scrollDirection: ActionShape.shape.scrollDirection.optional(),
    scrollAmount: ActionShape.shape.scrollAmount.optional(),
    toX: ActionShape.shape.toX.optional(),
    toY: ActionShape.shape.toY.optional(),
  })
  .strict()
  .refine((input) => input.actions !== undefined || input.type !== undefined, {
    message: "pass `actions` or a single `type` action",
  })
  .refine(
    (input) => !TARGETED.has(input.type ?? "") || hasTarget(input),
    { message: "this action requires `elementId`, `selector`, or `x` + `y`", path: ["elementId"] },
  )
  .refine(
    (input) => input.type !== "drag" || (input.toX !== undefined && input.toY !== undefined),
    { message: "drag requires `toX` and `toY`", path: ["toX"] },
  )
  .refine(
    (input) => input.type !== "select_option" || input.text !== undefined,
    { message: "select_option requires `text` (the option label)", path: ["text"] },
  );

export type Input = z.infer<typeof schema>;

export const description =
  "Interact with the page by [1..N] elementId (preferred), CSS selector, or coordinates. " +
  "Pass `actions` to batch fill+submit in a single turn. Drag with type `drag` from the " +
  "start point (elementId/selector/x/y) to toX/toY. Stale-ID recovery stops a batch " +
  "cleanly if a target detaches. Returns the refreshed element map, annotated screenshot, " +
  "and any new console/network errors.";

function toAction(input: Input): Action {
  return {
    type: input.type!,
    elementId: input.elementId,
    selector: input.selector,
    x: input.x,
    y: input.y,
    text: input.text,
    key: input.key,
    pressEnter: input.pressEnter,
    scrollDirection: input.scrollDirection,
    scrollAmount: input.scrollAmount,
    toX: input.toX,
    toY: input.toY,
  };
}

export async function execute(
  input: Input,
  deps: ToolDeps,
  context?: ToolCallContext,
): Promise<ToolResult> {
  const actions: Action[] = input.actions ?? [toAction(input)];
  return deps.session.turn({ kind: "act", actions }, turnContext(context));
}
