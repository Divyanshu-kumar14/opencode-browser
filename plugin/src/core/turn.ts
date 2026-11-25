/**
 * The tool-turn contract.
 *
 * A `TurnRequest` is the intent a tool expresses ("navigate", "act",
 * "observe", …). A `BrowserSession` turns that intent into a `ToolResult`.
 * The handlers never see a Playwright `Page`; everything that must happen on
 * every turn (settle, perceive, format, attach, clear the HUD, consume the
 * tab-switch notice) lives behind this seam.
 */

import type { ElementLine } from "../utils/formatter.ts";
import { buildPagePayload, formatTelemetryDelta } from "../utils/formatter.ts";
import type { Action } from "./action-engine.ts";

export type NavigationAction = "goto" | "back" | "forward" | "reload";
export type WaitUntil = "load" | "domcontentloaded" | "networkidle";
export type ViewportPreset = "desktop" | "laptop" | "tablet" | "mobile";

export type TurnRequest =
  | {
    readonly kind: "navigate";
    readonly action: NavigationAction;
    readonly url?: string;
    readonly waitUntil?: WaitUntil;
  }
  | { readonly kind: "act"; readonly actions: readonly Action[] }
  | { readonly kind: "observe"; readonly annotate?: boolean; readonly fullPage?: boolean }
  | {
    readonly kind: "inspect";
    readonly elementId?: number;
    readonly selector?: string;
    readonly cssProperties?: readonly string[];
  }
  | {
    readonly kind: "viewport";
    readonly preset?: ViewportPreset;
    readonly width?: number;
    readonly height?: number;
  }
  | {
    readonly kind: "evaluate";
    readonly expression: string;
    /**
     * Redacted URL the user approved the eval for. The turn refuses to run
     * the expression on any other page.
     */
    readonly approvedUrl?: string;
  };

export type ToolContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string };

export interface ToolResult {
  readonly content: ToolContentPart[];
  readonly metadata: Record<string, unknown>;
}

export interface TelemetryLine {
  readonly type: string;
  readonly text: string;
}

/** Everything a formatted turn needs from the page, already captured. */
export interface TurnSnapshot {
  readonly url: string;
  readonly title: string;
  readonly tabId: string | null;
  readonly elements: readonly ElementLine[];
  readonly screenshotPath: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly telemetry: readonly TelemetryLine[];
  readonly tabSwitch: string | null;
  /** Present only for turns that actually ran a settle. */
  readonly settled?: boolean;
  readonly durationMs?: number;
  readonly notice?: string | null;
}

export type TurnOutcome =
  | { readonly kind: "page"; readonly snapshot: TurnSnapshot; readonly metadata?: Record<string, unknown> }
  | {
    readonly kind: "inspect";
    readonly snapshot: TurnSnapshot;
    readonly lines: readonly string[];
    readonly found: boolean;
    readonly metadata?: Record<string, unknown>;
  }
  | {
    readonly kind: "evaluate";
    readonly snapshot: TurnSnapshot;
    readonly rendered: string;
    readonly threw: boolean;
    readonly metadata?: Record<string, unknown>;
  };

/** Format any turn into the one payload shape every tool returns. */
export function formatTurn(outcome: TurnOutcome): ToolResult {
  const snapshot = outcome.snapshot;
  let text: string;

  if (outcome.kind === "inspect") {
    text = [
      "## Element inspect",
      ...outcome.lines,
      "",
      "## Telemetry",
      formatTelemetryDelta(snapshot.telemetry),
    ].join("\n");
  } else if (outcome.kind === "evaluate") {
    text = [
      "## Eval result",
      outcome.threw ? `Error: ${outcome.rendered}` : outcome.rendered,
      "",
      "## Telemetry",
      formatTelemetryDelta(snapshot.telemetry),
    ].join("\n");
  } else {
    text = buildPagePayload({
      url: snapshot.url,
      title: snapshot.title,
      elements: snapshot.elements,
      tabSwitch: snapshot.tabSwitch,
      screenshotPath: snapshot.screenshotPath,
      width: snapshot.width,
      height: snapshot.height,
      telemetryEvents: snapshot.telemetry,
      settled: snapshot.settled,
      durationMs: snapshot.durationMs,
    });
  }

  if (outcome.kind !== "page" && snapshot.tabSwitch) {
    // inspect/eval do not print the page payload, so surface the notice here.
    text += `\n\nTab: ${snapshot.tabSwitch}`;
  }
  if (snapshot.notice) text += `\n\n${snapshot.notice}`;

  const content: ToolContentPart[] = [{ type: "text", text }];
  if (snapshot.screenshotPath) {
    content.push({ type: "file", uri: snapshot.screenshotPath, mime: "image/png" });
  }

  return {
    content,
    metadata: {
      url: snapshot.url,
      tabId: snapshot.tabId,
      screenshotPath: snapshot.screenshotPath,
      width: snapshot.width,
      height: snapshot.height,
      elementCount: snapshot.elements.length,
      ...(outcome.metadata ?? {}),
    },
  };
}
