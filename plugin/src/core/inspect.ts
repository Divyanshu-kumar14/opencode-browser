/**
 * Element diagnostics for `browse_inspect`.
 *
 * The page-side probe lives here, next to its formatting, so the tool handler
 * stays a pure intent mapper. The serialized callback receives the SoM
 * attribute as an argument instead of closing over a host-side constant.
 */

import type { Page } from "playwright";
import { InvalidInputError } from "./errors.ts";
import { SOM_ATTRIBUTE } from "./som.ts";
import { sanitizePageText } from "../utils/formatter.ts";

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
  /** Set when `querySelector` rejected the selector. */
  invalidSelector?: string;
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
      let el;
      try {
        el = (
          args.mode === "id"
            ? doc.querySelector(`[${args.attribute}="${args.target}"]`)
            : doc.querySelector(args.target)
        );
      } catch (error) {
        return { invalidSelector: error instanceof Error ? error.message : String(error) };
      }
      // An element id can live in a same-origin frame (the annotator indexes
      // them); search those documents too, up to three levels deep.
      if (!el && args.mode === "id") {
        const selector = `[${args.attribute}="${args.target}"]`;
        const queue: { d: any; depth: number }[] = [{ d: doc, depth: 0 }];
        while (!el && queue.length > 0) {
          const { d, depth } = queue.shift()!;
          if (depth >= 3) continue;
          for (const fe of Array.from(d.querySelectorAll("iframe, frame")) as any[]) {
            let inner: any = null;
            try {
              inner = fe.contentDocument;
            } catch {
              inner = null;
            }
            if (!inner) continue;
            el = inner.querySelector(selector);
            if (el) break;
            queue.push({ d: inner, depth: depth + 1 });
          }
        }
      }
      if (!el) return null;
      // Positions are reported in the top viewport, also for frame elements.
      let offsetX = 0;
      let offsetY = 0;
      const ownerWin = (el.ownerDocument && el.ownerDocument.defaultView) || g;
      for (let w = ownerWin; w && w !== g; ) {
        const fe = w.frameElement;
        if (!fe) break;
        const fr = fe.getBoundingClientRect();
        offsetX += fr.x + fe.clientLeft;
        offsetY += fr.y + fe.clientTop;
        w = fe.ownerDocument.defaultView;
      }
      const local = el.getBoundingClientRect();
      const r = { x: local.x + offsetX, y: local.y + offsetY, width: local.width, height: local.height };
      const style = ownerWin.getComputedStyle(el);
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
        // getAttribute, not className: SVG elements expose an SVGAnimatedString.
        classes: el.getAttribute("class") ?? "",
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
  if (info?.invalidSelector !== undefined) {
    throw new InvalidInputError(
      `invalid selector "${clean(target).slice(0, 200)}": ${clean(info.invalidSelector).slice(0, 200)}`,
      "fix the CSS selector or use an elementId from the element map",
    );
  }
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
