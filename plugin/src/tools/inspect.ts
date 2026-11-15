/**
 * browser_inspect — deep diagnostic info for a specific element (computed styles,
 * bounding box, attributes, parent/child summary). For debugging broken CSS layouts.
 */

import { z } from "zod";
import type { BrowserSessionManager } from "../core/session-manager.ts";
import { capturePerception } from "../core/action-engine.ts";
import { buildPagePayload } from "../utils/formatter.ts";

export const schema = z.object({
  elementId: z.number().int().positive().optional().describe("[1..N] element id from the element map"),
  selector: z.string().optional().describe("CSS selector fallback"),
  cssProperties: z.array(z.string()).optional().describe("Additional computed CSS properties to return"),
}).refine((i) => i.elementId !== undefined || i.selector !== undefined, {
  message: "pass either `elementId` or `selector`",
});

export type Input = z.infer<typeof schema>;

export const description =
  "Return deep diagnostics for one element: tag, classes, attributes, innerText, " +
  "exact bounding box, visibility state, parent/child summary, and key computed CSS " +
  "styles (display, position, z-index, colors, font, box model, flex/grid, plus any " +
  "requested cssProperties). Use for debugging spacing, alignment, z-index, or " +
  "responsive styling bugs.";

export interface ToolCtx {
  readonly sessionManager: BrowserSessionManager;
  readonly screenshotDir: string;
}

const DEFAULT_COMPUTED_PROPS = [
  "display", "position", "zIndex", "color", "backgroundColor", "fontSize",
  "padding", "margin", "overflow", "flexDirection", "flexWrap",
  "gridTemplateColumns", "gridTemplateRows", "alignItems", "justifyContent",
  "border", "borderRadius", "boxShadow",
];

export async function execute(
  input: Input,
  ctx: ToolCtx,
): Promise<{ content: Array<{ type: string; text?: string; uri?: string; mime?: string; name?: string }>; metadata?: Record<string, unknown> }> {
  const { sessionManager, screenshotDir } = ctx;
  const page = await sessionManager.ensureActivePage();
  const telemetry = sessionManager.getTelemetry();

  const mode = input.elementId !== undefined ? "id" : "sel";
  const target = input.elementId !== undefined ? String(input.elementId) : input.selector!;
  const extra = [...DEFAULT_COMPUTED_PROPS, ...(input.cssProperties ?? [])];

  const info = await page.evaluate<
    {
      tag?: string; role?: string; classes?: string;
      attributes?: Record<string, string>; innerText?: string;
      bbox?: { x: number; y: number; width: number; height: number };
      visibility?: Record<string, string>; parent?: string | null;
      childCount?: number; computed?: Record<string, string>;
    } | null,
    { mode: string; target: string; extra: string[] }
  >(
    (args) => {
      const g = globalThis as unknown as Record<string, any>;
      const doc = g["document"];
      const getStyle = g["getComputedStyle"];
      const el = (
        args.mode === "id"
          ? doc.querySelector('[data-opencode-id="' + args.target + '"]')
          : doc.querySelector(args.target)
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const style = getStyle(el);
      const attributes: Record<string, string> = {};
      for (const attr of el.getAttributeNames()) {
        attributes[attr] = el.getAttribute(attr) ?? "";
      }
      const computed: Record<string, string> = {};
      for (const p of args.extra) {
        computed[p] = style[p];
      }
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        classes: el.className || "",
        attributes,
        innerText: (el.innerText || "").slice(0, 500),
        bbox: {
          x: Math.round(r.x), y: Math.round(r.y),
          width: Math.round(r.width), height: Math.round(r.height),
        },
        visibility: {
          display: style.display, visibility: style.visibility,
          opacity: style.opacity, pointerEvents: style.pointerEvents,
        },
        parent: el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
        childCount: el.children.length,
        computed,
      };
    },
    { mode, target, extra },
  );

  const lines: string[] = [];
  if (!info) {
    lines.push(`Element not found: ${mode === "id" ? `[${target}]` : target}`);
  } else {
    lines.push(`tag: <${info.tag}${info.role ? ` role="${info.role}"` : ""}${info.classes ? ` class="${info.classes}"` : ""}>`);
    if (info.innerText) lines.push(`text: "${info.innerText}"`);
    const b = info.bbox;
    lines.push(`bbox: x=${b?.x ?? 0}, y=${b?.y ?? 0}, w=${b?.width ?? 0}, h=${b?.height ?? 0}`);
    const v = info.visibility;
    lines.push(`visibility: display=${v?.display ?? "?"}, visibility=${v?.visibility ?? "?"}, opacity=${v?.opacity ?? "?"}, pointer-events=${v?.pointerEvents ?? "?"}`);
    lines.push(`parent: ${info.parent ?? "none"}  children: ${info.childCount ?? 0}`);
    if (info.attributes && Object.keys(info.attributes).length) {
      lines.push("attributes:");
      for (const [k, v] of Object.entries(info.attributes)) lines.push(`  ${k}="${v}"`);
    }
    if (info.computed && Object.keys(info.computed).length) {
      lines.push("computed styles:");
      for (const [k, v] of Object.entries(info.computed)) {
        if (v === undefined || v === "") continue;
        lines.push(`  ${k}: ${v}`);
      }
    }
  }

  // Refresh perception once (re-index + optional screenshot) and drain telemetry.
  const perception = await capturePerception(page, telemetry, {
    screenshotDir,
    annotate: false,
    fullPage: false,
  });

  const text =
    ["## Element inspect", ...lines, "", "## Telemetry", ...formatTelemetryLines(perception.telemetryEvents)].join("\n");

  const content: Array<{ type: string; text?: string; uri?: string; mime?: string; name?: string }> = [
    { type: "text", text },
  ];
  if (perception.screenshotPath) {
    content.push({ type: "file", uri: perception.screenshotPath, mime: "image/png" });
  }

  return {
    content,
    metadata: {
      url: page.url(),
      tabId: (page as any).__opencodePageId,
      elementId: input.elementId,
      selector: input.selector,
      found: info !== null,
      screenshotPath: perception.screenshotPath,
      elementCount: perception.elements.length,
    },
  };
}

function formatTelemetryLines(events: readonly { readonly type: string; readonly text: string }[]): string[] {
  if (events.length === 0) return ["Errors: none"];
  const out: string[] = ["### New Console & Network Errors"];
  for (const e of events) out.push(`  - [${e.type}] ${e.text}`);
  return out;
}
