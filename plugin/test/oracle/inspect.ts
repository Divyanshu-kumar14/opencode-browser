// ORACLE: verbatim copy of plugin/src/core/inspect.ts at c4bf2d5 (F). Only import paths changed.
/**
 * Element diagnostics for `browse_inspect`.
 *
 * The page-side probe lives here, next to its formatting, so the tool handler
 * stays a pure intent mapper. The serialized callback receives the SoM
 * attribute as an argument instead of closing over a host-side constant.
 */

import type { Page } from "playwright";
import { SOM_ATTRIBUTE } from "../../src/core/som.ts";
import { sanitizePageText } from "./formatter.ts";

const DEFAULT_COMPUTED_PROPS = [
  "display", "position", "zIndex", "color", "backgroundColor", "fontSize",
  "padding", "margin", "overflow", "flexDirection", "flexWrap",
  "gridTemplateColumns", "gridTemplateRows", "alignItems", "justifyContent",
  "border", "borderRadius", "boxShadow",
] as const;

export interface InspectInput {
  readonly elementId?: number;
  readonly selector?: string;
  readonly cssProperties?: readonly string[];
}

export interface InspectResult {
  readonly lines: string[];
  readonly found: boolean;
}

interface InspectInfo {
  tag?: string;
  role?: string;
  classes?: string;
  attributes?: Record<string, string>;
  innerText?: string;
  bbox?: { x: number; y: number; width: number; height: number };
  visibility?: Record<string, string>;
  parent?: string | null;
  childCount?: number;
  computed?: Record<string, string>;
}

export async function inspectElement(page: Page, input: InspectInput): Promise<InspectResult> {
  const mode = input.elementId !== undefined ? "id" : "sel";
  const target = input.elementId !== undefined ? String(input.elementId) : input.selector!;
  const extra = [...DEFAULT_COMPUTED_PROPS, ...(input.cssProperties ?? [])];

  const info = await page.evaluate<
    InspectInfo | null,
    { mode: string; target: string; extra: string[]; attribute: string }
  >(
    (args) => {
      const g = globalThis as unknown as Record<string, any>;
      const doc = g["document"];
      const getStyle = g["getComputedStyle"];
      const el = (
        args.mode === "id"
          ? doc.querySelector(`[${args.attribute}="${args.target}"]`)
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
    { mode, target, extra, attribute: SOM_ATTRIBUTE },
  );

  const lines: string[] = [];
  const clean = sanitizePageText;
  if (!info) {
    lines.push(`Element not found: ${mode === "id" ? `[${clean(target)}]` : clean(target)}`);
    return { lines, found: false };
  }

  lines.push(`tag: <${clean(info.tag ?? "")}${info.role ? ` role="${clean(info.role)}"` : ""}${info.classes ? ` class="${clean(info.classes)}"` : ""}>`);
  if (info.innerText) lines.push(`text: "${clean(info.innerText)}"`);
  const b = info.bbox;
  lines.push(`bbox: x=${b?.x ?? 0}, y=${b?.y ?? 0}, w=${b?.width ?? 0}, h=${b?.height ?? 0}`);
  const v = info.visibility;
  lines.push(`visibility: display=${clean(v?.display ?? "?")}, visibility=${clean(v?.visibility ?? "?")}, opacity=${clean(v?.opacity ?? "?")}, pointer-events=${clean(v?.pointerEvents ?? "?")}`);
  lines.push(`parent: ${clean(info.parent ?? "none")}  children: ${info.childCount ?? 0}`);
  if (info.attributes && Object.keys(info.attributes).length) {
    lines.push("attributes:");
    for (const [k, value] of Object.entries(info.attributes)) lines.push(`  ${clean(k)}="${clean(value)}"`);
  }
  if (info.computed && Object.keys(info.computed).length) {
    lines.push("computed styles:");
    for (const [k, value] of Object.entries(info.computed)) {
      if (value === undefined || value === "") continue;
      lines.push(`  ${clean(k)}: ${clean(value)}`);
    }
  }

  return { lines, found: true };
}
