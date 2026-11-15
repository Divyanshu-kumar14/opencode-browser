/**
 * Token-efficient Markdown builder for perception-action tool payloads.
 * Combines page state, the [1..N] interactive element map, telemetry delta,
 * and screenshot info into a compact single text block.
 */

export interface ElementLine {
  readonly id: number;
  readonly tag: string;
  readonly role: string;
  readonly label: string;
  readonly value: string;
  readonly href?: string;
  readonly selectorFallback: string;
  readonly disabled?: boolean;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeQuote(s: string): string {
  return s.replace(/"/g, '\\"');
}

export function formatElementMap(elements: readonly ElementLine[]): string {
  if (elements.length === 0) return "(no interactive elements in viewport)";
  const lines = elements.map((el) => {
    const disabled = el.disabled ? " disabled" : "";
    const tag = `<${el.tag}${el.role ? ` role="${escapeHtml(el.role)}"` : ""}${disabled}>`;
    const label = el.label ? ` "${escapeQuote(el.label)}"` : "";
    const value = el.value ? ` value="${escapeHtml(el.value)}"` : "";
    const href = el.tag === "a" && el.href ? ` href="${escapeHtml(el.href)}"` : "";
    const attrs = el.tag === "a" ? href : value;
    return `[${el.id}] <${el.tag}${attrs}>${label}`;
  });
  return lines.join("\n");
}

export interface TelemetrySection {
  readonly events: readonly { readonly type: string; readonly text: string }[];
  readonly cursor: number;
}

export function formatTelemetryDelta(events: readonly { readonly type: string; readonly text: string }[]): string {
  if (events.length === 0) return "Errors: none";
  const lines = events.map((e) => `  - [${e.type}] ${e.text}`);
  return ["### New Console & Network Errors", ...lines, ""].join("\n");
}

export interface PagePayloadOptions {
  readonly url: string;
  readonly title?: string;
  readonly elements: readonly ElementLine[];
  readonly tabSwitch?: string | null;
  readonly screenshotPath?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly telemetryEvents: readonly { readonly type: string; readonly text: string }[];
  readonly settled?: boolean;
  readonly durationMs?: number;
}

export function buildPagePayload(options: PagePayloadOptions): string {
  const parts: string[] = [];

  parts.push(`URL: ${options.url}${options.title ? ` — ${options.title}` : ""}`);
  if (options.tabSwitch) parts.push(`Tab: ${options.tabSwitch}`);
  if (options.settled !== undefined) {
    parts.push(`Settled: ${options.settled ? "yes" : "no"}${options.durationMs !== undefined ? ` (${options.durationMs}ms)` : ""}`);
  }
  parts.push(""); // blank line

  parts.push("## Interactive elements");
  parts.push(formatElementMap(options.elements));
  parts.push("");

  if (options.screenshotPath) {
    const hint = options.width && options.height
      ? `(${options.width}x${options.height})`
      : "";
    parts.push(`## Screenshot: ${options.screenshotPath} ${hint}`);
    parts.push(`(file attachment; open file://${options.screenshotPath} to view)`);
    parts.push("");
  }

  const telemetrySection = formatTelemetryDelta(options.telemetryEvents);
  parts.push("## Telemetry");
  parts.push(telemetrySection === "Errors: none" ? "Errors: none" : telemetrySection);
  parts.push("");

  return parts.join("\n").trimEnd() + "\n";
}
