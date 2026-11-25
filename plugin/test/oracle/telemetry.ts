// ORACLE: verbatim copy of plugin/src/core/telemetry.ts at c4bf2d5 (F).
/**
 * Passive DevTools telemetry.
 *
 * Attaches persistent listeners to every tracked Page and records, in a
 * bounded ring buffer:
 *   - console  : error / warning messages (with source location)
 *   - pageerror: uncaught exceptions (message + first 3 stack frames)
 *   - response : HTTP responses with status >= 400
 *   - requestfailed: aborted / CORS-failed requests
 *
 * Delta-cursor architecture: `drain()` returns only events added since the
 * last drain and advances the cursor, so each tool execution reports only the
 * *new* errors since the previous tool call.
 */

export interface TelemetryEvent {
  type: "console" | "pageerror" | "response" | "requestfailed";
  timestamp: number;
  /** Human-readable one-line summary. */
  text: string;
  /** Source URL / location where available. */
  source: string;
  /** Repeat counter for consecutive duplicate console spam, e.g. " (x4)". */
  repeat?: string;
}

export class Telemetry {
  private readonly max: number;
  private readonly events: TelemetryEvent[] = [];
  /** Number of events already drained (delta cursor). */
  private cursor = 0;
  /** Last console text, for dedup of identical consecutive messages. */
  private lastConsoleText: string | null = null;
  private repeatCount = 0;
  private readonly attached = new WeakSet<import("playwright").Page>();

  constructor(max = 200) {
    this.max = max;
  }

  /** Attach persistent listeners to a Playwright Page. Idempotent per page. */
  attach(page: import("playwright").Page): void {
    if (this.attached.has(page)) return;
    this.attached.add(page);
    page.on("console", (msg) => {
      const type = msg.type();
      if (type !== "error" && type !== "warning") return;
      const loc = msg.location();
      const source = loc.url || "(inline)";
      const text = `[${type.toUpperCase()}] ${msg.text()} (${source})`;
      this.addConsole(text);
    });

    page.on("pageerror", (err) => {
      const stack = (err.stack ?? "")
        .split("\n")
        .slice(1, 4)
        .filter(Boolean)
        .join(" | ");
      this.add({
        type: "pageerror",
        text: `[PAGE ERROR] ${err.message}${stack ? ` | ${stack}` : ""}`,
        source: "(page)",
        timestamp: Date.now(),
      });
    });

    page.on("response", (resp) => {
      if (resp.status() < 400) return;
      this.add({
        type: "response",
        text: `[HTTP ${resp.status()}] ${resp.request().method()} ${resp.url()}`,
        source: resp.url(),
        timestamp: Date.now(),
      });
    });

    page.on("requestfailed", (req) => {
      const failure = req.failure();
      const reason = failure?.errorText ?? "failed";
      this.add({
        type: "requestfailed",
        text: `[NET FAIL] ${req.method()} ${req.url()} - net::${reason}`,
        source: req.url(),
        timestamp: Date.now(),
      });
    });
  }

  /** Record a console message, deduplicating identical consecutive spam. */
  /**
   * Record a console message, collapsing consecutive duplicates *inside the
   * current undrained delta*. Once a message has been drained, an identical
   * one starts a fresh event: the next tool call must still see that the error
   * happened again, instead of reporting "Errors: none".
   */
  private addConsole(text: string): void {
    const last = this.events[this.events.length - 1];
    const undrained = this.events.length > this.cursor;
    if (undrained && text === this.lastConsoleText && last?.type === "console") {
      this.repeatCount += 1;
      last.text = `${text} (x${this.repeatCount})`;
      last.repeat = ` (x${this.repeatCount})`;
      last.timestamp = Date.now();
      return;
    }
    this.lastConsoleText = text;
    this.repeatCount = 1;
    this.add({ type: "console", text, source: "(console)", timestamp: Date.now() });
  }

  private add(event: TelemetryEvent): void {
    this.events.push(event);
    if (this.events.length > this.max) {
      this.events.shift();
      // Cursor may now exceed the (trimmed) length; clamp on drain.
      if (this.cursor > this.events.length) this.cursor = this.events.length;
    }
  }

  /** Drain events added since the last drain, advancing the cursor. */
  drain(): { readonly events: TelemetryEvent[]; readonly cursor: number } {
    const start = Math.min(this.cursor, this.events.length);
    const newEvents = this.events.slice(start);
    this.cursor = this.events.length;
    return { events: newEvents, cursor: this.cursor };
  }

  /** Snapshot the current cursor without consuming (for peek / testing). */
  peekCursor(): number {
    return this.cursor;
  }

  /** Total events currently in the buffer. */
  size(): number {
    return this.events.length;
  }
}
