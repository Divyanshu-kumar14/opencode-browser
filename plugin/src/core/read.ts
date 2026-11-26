/**
 * Read a page as markdown: headings, paragraphs, lists, tables, code, links.
 *
 * The element map covers what the agent can act on; this covers what it can
 * read. It is built from the live DOM in the page, so it sees what the user
 * sees: hidden content, scripts, styles and the HUD are left out, open shadow
 * roots and slots are read, and form controls are described by their label or
 * placeholder, never by what the user typed.
 *
 * The text is page content, so the host redacts secrets in URLs, and the agent
 * treats it as data, never instructions.
 */

import type { Page } from "playwright";
import { InvalidInputError } from "./errors.ts";
import { HUD_TAG } from "./som.ts";
import { redactUrlsInText } from "./url-policy.ts";

export interface ReadOptions {
  /** Scope the read to the first element matching this CSS selector. */
  readonly selector?: string;
  /** Keep links as `[text](url)` (default true). */
  readonly links?: boolean;
}

export interface ReadResult {
  readonly text: string;
}

export async function readPage(page: Page, options: ReadOptions): Promise<ReadResult> {
  const result = await page.evaluate(extractMarkdown, {
    selector: options.selector ?? null,
    links: options.links !== false,
    hudTag: HUD_TAG,
  });
  if (result.error === "invalid") {
    throw new InvalidInputError(`invalid selector "${options.selector}": ${result.message}`, "fix the CSS selector");
  }
  if (result.error === "missing") {
    throw new InvalidInputError(
      `no element matches "${options.selector}"`,
      "take a browse_snapshot and pick a selector that exists, or omit it to read the main content",
    );
  }
  return { text: redactUrlsInText(result.text) };
}

export interface ReadWindow {
  readonly text: string;
  /** Characters in the whole page text. */
  readonly total: number;
  readonly offset: number;
  /** Where to continue, or null at the end. */
  readonly nextOffset: number | null;
}

/** One window of `full`, cut at a line break when it can be. */
export function paginate(full: string, offset: number, maxChars: number): ReadWindow {
  const total = full.length;
  if (offset >= total) return { text: "", total, offset, nextOffset: null };
  if (offset + maxChars >= total) return { text: full.slice(offset), total, offset, nextOffset: null };
  const window = full.slice(offset, offset + maxChars);
  const cut = window.lastIndexOf("\n");
  if (cut > 0) return { text: window.slice(0, cut), total, offset, nextOffset: offset + cut + 1 };
  return { text: window, total, offset, nextOffset: offset + maxChars };
}

/**
 * Runs in the page. Playwright serializes it, so it must be self-contained:
 * no imports and no references to outer scope.
 */
function extractMarkdown(arg: { selector: string | null; links: boolean; hudTag: string }):
  | { error: null; text: string }
  | { error: "invalid" | "missing"; text: ""; message: string } {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const g = globalThis as any;
  const doc = g.document;
  // Bound the walk and the result on enormous pages.
  const MAX = 2_000_000;

  let root: any;
  if (arg.selector !== null) {
    try {
      root = doc.querySelector(arg.selector);
    } catch (e: any) {
      return { error: "invalid", text: "", message: String(e && e.message ? e.message : e).split("\n")[0] ?? "" };
    }
    if (!root) return { error: "missing", text: "", message: "" };
  } else {
    root = doc.querySelector("main, [role=main], article") || doc.body;
  }

  const SKIP = new Set([
    "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed",
    "head", "title", "meta", "link", "datalist", "audio", "video",
  ]);
  const BLOCK = new Set([
    "p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "form", "fieldset",
    "details", "summary", "figure", "figcaption", "dl", "dt", "dd", "address", "legend",
  ]);

  const hidden = (el: any): boolean => {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    const style = g.getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden";
  };

  let size = 0;
  const inline = (nodes: any, ctx: any): string => {
    let out = "";
    for (const node of nodes) {
      if (size > MAX) break;
      out += render(node, ctx);
    }
    return out;
  };

  const collapse = (s: string): string => s.replace(/[ \t\r\n\f]+/g, " ");
  const childNodes = (el: any): any[] => {
    if (el.localName === "slot" && typeof el.assignedNodes === "function") {
      const assigned = el.assignedNodes({ flatten: true });
      if (assigned.length > 0) return Array.from(assigned);
    }
    if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
    return Array.from(el.childNodes);
  };

  const render = (node: any, ctx: { pre: boolean; depth: number }): string => {
    if (node.nodeType === 3) {
      const t = ctx.pre ? node.data : collapse(node.data);
      size += t.length;
      return t;
    }
    if (node.nodeType !== 1) return "";
    const tag: string = node.localName;
    if (SKIP.has(tag) || tag === arg.hudTag) return "";
    if (hidden(node)) return "";
    const kids = (c: any = ctx) => inline(childNodes(node), c);

    if (/^h[1-6]$/.test(tag)) {
      const text = kids().trim();
      return text ? "\n\n" + "#".repeat(Number(tag.slice(1))) + " " + text + "\n\n" : "";
    }
    switch (tag) {
      case "br":
        return "\n";
      case "hr":
        return "\n\n---\n\n";
      case "ul":
      case "ol": {
        const items = Array.from(node.children).filter((c: any) => c.localName === "li");
        let n = 0;
        let list = "";
        for (const li of items as any[]) {
          if (hidden(li)) continue;
          n += 1;
          const marker = tag === "ol" ? n + ". " : "- ";
          const body = inline(childNodes(li), { pre: false, depth: ctx.depth + 1 }).trim().replace(/\n{2,}/g, "\n");
          list += "  ".repeat(ctx.depth) + marker + body.replace(/\n/g, "\n" + "  ".repeat(ctx.depth + 1)) + "\n";
        }
        return ctx.depth > 0 ? "\n" + list : "\n\n" + list + "\n";
      }
      case "li":
        return "\n- " + kids().trim() + "\n";
      case "a": {
        const text = kids().trim();
        const href: string = node.href || "";
        if (!text) return "";
        if (!arg.links || !href || /^javascript:/i.test(href)) return text;
        return "[" + text + "](" + href + ")";
      }
      case "b":
      case "strong": {
        const t = kids().trim();
        return t ? "**" + t + "**" : "";
      }
      case "i":
      case "em": {
        const t = kids().trim();
        return t ? "*" + t + "*" : "";
      }
      case "code": {
        if (ctx.pre) return kids();
        const t = kids().trim();
        return t ? "`" + t + "`" : "";
      }
      case "pre": {
        const code = String(node.textContent || "").replace(/\n+$/, "");
        size += code.length;
        return "\n\n```\n" + code + "\n```\n\n";
      }
      case "blockquote": {
        const t = kids().trim();
        return t ? "\n\n" + t.split("\n").map((l: string) => "> " + l).join("\n") + "\n\n" : "";
      }
      case "img": {
        const alt = String(node.getAttribute("alt") || "").trim();
        return alt ? "[image: " + alt + "]" : "";
      }
      case "table": {
        const rows = Array.from(node.querySelectorAll("tr")).filter((r: any) => !hidden(r)) as any[];
        let out = "\n\n";
        rows.forEach((row, index) => {
          const cells = Array.from(row.children).filter((c: any) => c.localName === "td" || c.localName === "th") as any[];
          const texts = cells.map((c) =>
            inline(childNodes(c), { pre: false, depth: 0 }).trim().replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " "),
          );
          out += "| " + texts.join(" | ") + " |\n";
          if (index === 0) out += "| " + texts.map(() => "---").join(" | ") + " |\n";
        });
        return out + "\n";
      }
      case "button": {
        const t = kids().trim();
        return "[button: " + (t || String(node.getAttribute("aria-label") || "")) + "]";
      }
      case "select": {
        const options = Array.from(node.options || []).map((o: any) => String(o.label || o.text || "").trim());
        return "[select: " + options.join(" | ") + "]";
      }
      case "textarea":
        return "[textarea: " + String(node.getAttribute("placeholder") || node.getAttribute("aria-label") || node.name || "") + "]";
      case "input": {
        const type = String(node.type || "text").toLowerCase();
        if (type === "hidden") return "";
        if (type === "password") return "[password field]";
        if (type === "submit" || type === "button" || type === "reset") {
          return "[button: " + String(node.value || type) + "]";
        }
        if (type === "checkbox" || type === "radio") return "[" + type + " " + (node.checked ? "checked" : "unchecked") + "]";
        if (type === "file") return "[file input]";
        const label = node.getAttribute("placeholder") || node.getAttribute("aria-label") || node.name || type;
        return "[input: " + String(label) + "]";
      }
      default:
        break;
    }
    const body = kids();
    if (BLOCK.has(tag)) return body.trim() ? "\n\n" + body.trim() + "\n\n" : "";
    return body;
  };

  let text = inline(childNodes(root), { pre: false, depth: 0 });
  text = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+(?=\n)/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim();
  if (text.length > MAX) text = text.slice(0, MAX);
  return { error: null, text };
}
