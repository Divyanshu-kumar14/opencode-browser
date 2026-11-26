/**
 * Perception: re-index the page into the [1..N] element map, take a clean
 * screenshot, and drain the telemetry delta, all within one budget.
 *
 * One operation, `perceive`, owns the whole rule:
 *   - a navigation during capture is retried (up to 3 attempts) after the new
 *     document loads;
 *   - an attempt that outlives the deadline counts as a navigation race;
 *   - when the page never stabilizes, the result is "perception incomplete"
 *     with a notice instead of an error;
 *   - telemetry is drained exactly once per returned result, never by a
 *     failed attempt;
 *   - any other error propagates.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "playwright";
import type { Telemetry } from "./telemetry.ts";
import { viewportSizeOf } from "./viewport.ts";
import { cleanFrame, indexPage } from "./page-agent.ts";
import { ensurePrivateDir } from "./files.ts";
import type { ElementLine, UnindexedFrame } from "../utils/formatter.ts";

export interface Perception {
  readonly elements: readonly ElementLine[];
  /** Cross-origin frames on screen, listed by origin only. */
  readonly frames: readonly UnindexedFrame[];
  readonly screenshotPath: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly telemetryEvents: readonly { readonly type: string; readonly text: string }[];
  /** Set when perception is incomplete; tells the agent what to do next. */
  readonly notice: string | null;
}

export interface PerceiveOptions {
  readonly telemetry: Telemetry;
  readonly screenshotDir: string;
  /** Absolute time (ms since epoch) by which perception must finish. */
  readonly deadline: number;
  /** The configured budget, quoted in the timeout notice. */
  readonly budgetMs: number;
  /** Paint SoM badges on the screenshot (default true). */
  readonly annotate?: boolean;
  readonly fullPage?: boolean;
  /** Take a screenshot (default true). `false` skips it and the HUD hide/show around it. */
  readonly screenshot?: boolean;
  /** Pages whose telemetry this perception reports (default: the perceived page). */
  readonly telemetryPages?: readonly Page[];
}

const MAX_ATTEMPTS = 3;

export async function perceive(page: Page, opts: PerceiveOptions): Promise<Perception> {
  let lastRace: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const remaining = opts.deadline - Date.now();
    if (remaining <= 0) break;
    const capture = captureOnce(page, opts, remaining);
    capture.catch(() => undefined);
    try {
      const result = await raceDeadline(capture, remaining, () => new PerceptionTimeoutError(opts.budgetMs));
      return { ...result, telemetryEvents: drain(opts.telemetry, opts.telemetryPages ?? [page]), notice: null };
    } catch (error) {
      if (!isNavigationRace(error)) throw error;
      lastRace = error;
      const left = opts.deadline - Date.now();
      if (left <= 0) break;
      await page.waitForLoadState("domcontentloaded", { timeout: left }).catch(() => undefined);
    }
  }
  const size = page.isClosed() ? null : await viewportSizeOf(page);
  const reason = firstLine(lastRace) ?? `perception did not finish within ${opts.budgetMs}ms`;
  return {
    elements: [],
    frames: [],
    screenshotPath: null,
    width: size?.width ?? null,
    height: size?.height ?? null,
    telemetryEvents: drain(opts.telemetry, opts.telemetryPages ?? [page]),
    notice:
      `Perception incomplete: the page navigated during capture (${reason}). ` +
      "Call browse_snapshot to observe the new page.",
  };
}

/** One capture attempt; drains nothing, so a failed attempt consumes no events. */
async function captureOnce(
  page: Page,
  opts: PerceiveOptions,
  timeoutMs: number,
): Promise<Omit<Perception, "telemetryEvents" | "notice">> {
  const { elements, frames } = await indexPage(page);
  if (opts.screenshot === false) {
    const size = await viewportSizeOf(page);
    return { elements, frames, screenshotPath: null, width: size?.width ?? null, height: size?.height ?? null };
  }
  // annotate:false means a clean screenshot, not no screenshot.
  const { buffer, size } = await cleanFrame(page, { annotate: opts.annotate !== false }, async () => ({
    buffer: await page.screenshot({
      fullPage: opts.fullPage ?? false,
      timeout: Math.max(1, Math.round(timeoutMs)),
    }),
    size: await viewportSizeOf(page),
  }));
  const screenshotPath = await savePng(buffer, opts.screenshotDir);
  return { elements, frames, screenshotPath, width: size?.width ?? null, height: size?.height ?? null };
}

/** Delta drain: only telemetry generated since the last tool call. */
function drain(telemetry: Telemetry, pages: readonly Page[]): { readonly type: string; readonly text: string }[] {
  return telemetry.drain(pages).events.map((e) => ({ type: e.type, text: e.text }));
}

/** Raised when a capture attempt runs past its perception budget. */
class PerceptionTimeoutError extends Error {
  constructor(ms: number) {
    super(`perception did not finish within ${ms}ms`);
    this.name = "PerceptionTimeoutError";
  }
}

/**
 * True for errors caused by the document changing under an evaluate or a
 * screenshot: the page navigated or reloaded during capture.
 */
function isNavigationRace(error: unknown): boolean {
  if (error instanceof PerceptionTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message;
  if (
    message.includes("Execution context was destroyed") ||
    message.includes("frame was detached") ||
    message.includes("Cannot find context with specified id") ||
    // A reload swapped the page's render target out from under a screenshot.
    message.includes("Not attached to an active page")
  ) {
    return true;
  }
  return error.name === "TimeoutError" && message.includes("screenshot");
}

/** Reject with `makeError()` if `promise` has not settled within `ms`. */
function raceDeadline<T>(promise: Promise<T>, ms: number, makeError: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function firstLine(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? null;
}

async function savePng(buffer: Buffer, screenshotDir: string): Promise<string> {
  ensurePrivateDir(screenshotDir);
  const file = path.join(
    screenshotDir,
    `opencode-som-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`,
  );
  // 0600 and O_CREAT|O_EXCL: private even under a shared parent directory, and
  // never follows a planted file or symlink.
  fs.writeFileSync(file, buffer, { mode: 0o600, flag: "wx" });
  return file;
}
