/**
 * The browser seam.
 *
 * Tools depend on `BrowserSession`, never on Playwright. The Playwright
 * adapter below owns the one closed loop every turn shares:
 *
 *   ensure page -> intent -> settle (when mutating) -> perceive + screenshot
 *   -> drain telemetry -> format -> clear HUD
 *
 * A fake adapter in `test/fake-session.ts` satisfies the same interface, so
 * handler and registry tests run without a browser.
 */

import type { Page } from "playwright";
import type { BrowserSessionManager } from "./session-manager.ts";
import {
  PerceptionTimeoutError,
  capturePerception,
  drainTelemetryEvents,
  execBatch,
  hudClear,
  hudUpdate,
  isNavigationRace,
  type PerceptionResult,
} from "./action-engine.ts";
import { inspectElement } from "./inspect.ts";
import { waitForSettled, trackNetwork, type NetworkActivity, type SettleResult } from "./settle.ts";
import { formatTurn, type ToolResult, type TurnRequest, type TurnSnapshot } from "./turn.ts";
import { resolveViewport } from "./viewport.ts";
import { checkNavigationUrl, redactUrl } from "./url-policy.ts";

export interface BrowserSession {
  /** Run one tool turn and return the formatted result. */
  turn(request: TurnRequest): Promise<ToolResult>;
  /** URL of the active tab, without launching a browser ("about:blank" if none). */
  activeUrl(): string;
}

export class PlaywrightBrowserSession implements BrowserSession {
  constructor(private readonly manager: BrowserSessionManager) { }

  activeUrl(): string {
    const page = this.manager.getActivePage();
    if (!page || page.isClosed()) return "about:blank";
    return page.url();
  }

  /**
   * One turn at a time: the manager's lock serializes turns so two calls
   * never interleave their intent and perception on the shared page.
   */
  turn(request: TurnRequest): Promise<ToolResult> {
    return this.manager.runExclusive(() => this.runTurn(request));
  }

  private async runTurn(request: TurnRequest): Promise<ToolResult> {
    // A bare viewport call releases the pin *before* the page is ensured, so
    // ensureActivePage() re-syncs to the live window.
    if (request.kind === "viewport" && resolveViewport(request) === null) {
      this.manager.unpinViewport();
    }

    const page = await this.manager.ensureActivePage();
    const config = this.manager.getConfig();
    // The tab perceived at the end of the turn; the intent may open or close
    // tabs, which moves the manager's active pointer.
    let target: Page = page;

    let settle: SettleResult | undefined;
    let notice: string | null = null;
    let kind: "page" | "inspect" | "evaluate" = "page";
    let inspectLines: readonly string[] = [];
    let inspectFound = false;
    let evalRendered = "";
    let evalThrew = false;
    let extraMetadata: Record<string, unknown> = {};
    let annotate = true;
    let fullPage = false;

    try {
      switch (request.kind) {
        case "navigate": {
          await this.withNetwork(page, async (activity) => {
            await this.navigate(page, request.action, request.url, request.waitUntil);
            settle = await this.settle(page, activity);
          });
          extraMetadata = { action: request.action };
          break;
        }

        case "act": {
          const actions = [...request.actions];
          if (actions.length === 0) {
            throw new Error("browse_interact: pass `actions` or a single `type` action");
          }
          if (actions.length > 1) await hudUpdate(page, `Batch: ${actions.length} actions`);
          const batch = await this.withNetwork(page, async (activity) => {
            const result = await execBatch(page, actions);
            settle = await this.settle(page, activity);
            return result;
          });
          notice = batch.message;
          extraMetadata = {
            stoppedAt: batch.stoppedAt,
            batchMessage: batch.message ?? undefined,
          };
          if (batch.staleElementId !== null) {
            await hudUpdate(page, `Stopped at [${batch.staleElementId}] — stale`);
          } else if (actions.length > 1) {
            await hudUpdate(page, `Batch complete (${batch.completed}/${actions.length})`);
          }
          break;
        }

        case "observe": {
          annotate = request.annotate !== false;
          fullPage = request.fullPage ?? false;
          break;
        }

        case "inspect": {
          kind = "inspect";
          annotate = false;
          const inspected = await inspectElement(page, request);
          inspectLines = inspected.lines;
          inspectFound = inspected.found;
          extraMetadata = {
            elementId: request.elementId,
            selector: request.selector,
            found: inspected.found,
          };
          break;
        }

        case "viewport": {
          const resolved = resolveViewport(request);
          if (resolved === null) {
            const vs = page.viewportSize();
            extraMetadata = {
              viewport: { width: vs?.width ?? 1280, height: vs?.height ?? 720 },
            };
          } else {
            // Pin before resizing so the 1 s viewport watcher cannot re-fit
            // the page while the resize is in flight.
            this.manager.pinViewport();
            try {
              await this.withNetwork(page, async (activity) => {
                await page.setViewportSize(resolved);
                settle = await this.settle(page, activity);
              });
            } catch (error) {
              this.manager.unpinViewport();
              throw error;
            }
            extraMetadata = { viewport: resolved };
          }
          break;
        }

        case "evaluate": {
          kind = "evaluate";
          annotate = false;
          if (request.approvedUrl !== undefined) {
            const now = redactUrl(page.url());
            if (now !== request.approvedUrl) {
              throw new Error(
                `page changed since browse_eval was approved (approved ${request.approvedUrl}, now ${now}); retry`,
              );
            }
          }
          const evaluated = await this.evaluateBounded(page, request.expression, config.evalTimeoutMs);
          if (evaluated.kind === "value") {
            const value = evaluated.value;
            if (value === undefined) {
              evalRendered = "undefined";
            } else {
              try {
                evalRendered = JSON.stringify(value);
              } catch {
                evalRendered = String(value);
              }
            }
            extraMetadata = { threw: false };
          } else if (evaluated.kind === "error") {
            evalThrew = true;
            const error = evaluated.error;
            evalRendered = error instanceof Error ? error.message : String(error);
            extraMetadata = { threw: true };
          } else {
            evalThrew = true;
            evalRendered =
              `timed out after ${config.evalTimeoutMs}ms` +
              (evaluated.terminated
                ? "; the page script was terminated"
                : "; the page script may still be pending");
            extraMetadata = { threw: true, timedOut: true };
          }
          break;
        }
      }

      // Perceive the tab that is active now, not the one the turn started on.
      const deadline = Date.now() + config.perceptionTimeoutMs;
      const after = this.manager.getActivePage();
      if (after !== page || page.isClosed()) {
        target = after && !after.isClosed() ? after : await this.manager.ensureActivePage();
        const wait = Math.max(1, Math.min(deadline - Date.now(), config.navigationTimeoutMs));
        await target.waitForLoadState("domcontentloaded", { timeout: wait }).catch(() => undefined);
      }

      const perception = await this.perceive(target, { annotate, fullPage }, deadline);
      const turnNotice = [notice, perception.notice].filter((n): n is string => !!n).join("\n\n") || null;

      const snapshot: TurnSnapshot = {
        url: target.url(),
        title: await target.title().catch(() => ""),
        tabId: this.manager.pageIdFor(target),
        elements: perception.elements,
        screenshotPath: perception.screenshotPath,
        width: perception.width,
        height: perception.height,
        telemetry: perception.telemetryEvents,
        tabSwitch: this.manager.takeTabSwitchNotification(),
        settled: settle?.settled,
        durationMs: settle?.durationMs,
        notice: turnNotice,
      };

      if (kind === "inspect") {
        return formatTurn({
          kind,
          snapshot,
          lines: inspectLines,
          found: inspectFound,
          metadata: extraMetadata,
        });
      }
      if (kind === "evaluate") {
        return formatTurn({
          kind,
          snapshot,
          rendered: evalRendered,
          threw: evalThrew,
          metadata: extraMetadata,
        });
      }
      return formatTurn({ kind: "page", snapshot, metadata: extraMetadata });
    } finally {
      // Never leave the status pill showing a stale activity, on success or
      // failure. capturePerception restores the HUD before this runs.
      await hudClear(page);
      if (target !== page) await hudClear(target);
    }
  }

  /**
   * Capture the element map and screenshot within `perceptionTimeoutMs`.
   * A navigation during capture is retried (up to 3 attempts) after the new
   * document loads; if it never stabilizes, the turn still succeeds with a
   * "Perception incomplete" notice. Telemetry is drained exactly once for
   * every returned result. Other errors propagate as before.
   */
  private async perceive(
    page: Page,
    opts: { readonly annotate: boolean; readonly fullPage: boolean },
    deadline: number,
  ): Promise<PerceptionResult & { readonly notice: string | null }> {
    const config = this.manager.getConfig();
    const telemetry = this.manager.getTelemetry();
    const budget = config.perceptionTimeoutMs;
    let lastRace: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const capture = capturePerception(page, telemetry, {
        screenshotDir: config.screenshotDir,
        annotate: opts.annotate,
        fullPage: opts.fullPage,
        timeoutMs: remaining,
        drainTelemetry: false,
      });
      capture.catch(() => undefined);
      try {
        const result = await raceDeadline(capture, remaining, () => new PerceptionTimeoutError(budget));
        return { ...result, telemetryEvents: drainTelemetryEvents(telemetry), notice: null };
      } catch (error) {
        if (!isNavigationRace(error)) throw error;
        lastRace = error;
        const left = deadline - Date.now();
        if (left <= 0) break;
        await page.waitForLoadState("domcontentloaded", { timeout: left }).catch(() => undefined);
      }
    }
    const vs = page.isClosed() ? null : page.viewportSize();
    const reason = firstLine(lastRace) ?? `perception did not finish within ${budget}ms`;
    return {
      elements: [],
      screenshotPath: null,
      width: vs?.width ?? null,
      height: vs?.height ?? null,
      telemetryEvents: drainTelemetryEvents(telemetry),
      notice:
        `Perception incomplete: the page navigated during capture (${reason}). ` +
        "Call browse_snapshot to observe the new page.",
    };
  }

  /**
   * `page.evaluate` bounded by `timeoutMs`. On timeout, a short probe tells a
   * pending promise (renderer idle) from a blocking script (renderer busy);
   * only a blocked renderer gets `Runtime.terminateExecution`, because CDP
   * would otherwise terminate the next script instead. The CDP session is
   * opened before the eval starts: a blocked renderer cannot accept a new one.
   */
  private async evaluateBounded(
    page: Page,
    expression: string,
    timeoutMs: number,
  ): Promise<
    | { readonly kind: "value"; readonly value: unknown }
    | { readonly kind: "error"; readonly error: unknown }
    | { readonly kind: "timeout"; readonly terminated: boolean }
  > {
    const cdp = await orNullAfter(
      page.context().newCDPSession(page).catch(() => null),
      2000,
    );
    try {
      const evaluation = page.evaluate<unknown>(expression).then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const first = await orNullAfter(evaluation, timeoutMs);
      if (first !== null) return first;

      const responsive =
        (await orNullAfter(
          page.evaluate("1").then(
            () => true,
            () => true,
          ),
          250,
        )) ?? false;
      let terminated = false;
      if (!responsive && cdp !== null) {
        terminated =
          (await orNullAfter(
            cdp.send("Runtime.terminateExecution").then(
              () => true,
              () => false,
            ),
            2000,
          )) ?? false;
      }
      return { kind: "timeout", terminated };
    } finally {
      if (cdp !== null) void cdp.detach().catch(() => undefined);
    }
  }

  /** Track mutable requests from before the action until settle finishes. */
  private async withNetwork<T>(
    page: Page,
    run: (activity: NetworkActivity) => Promise<T>,
  ): Promise<T> {
    const activity = trackNetwork(page);
    try {
      return await run(activity);
    } finally {
      activity.dispose();
    }
  }

  private async navigate(
    page: Page,
    action: "goto" | "back" | "forward" | "reload",
    url: string | undefined,
    waitUntil: "load" | "domcontentloaded" | "networkidle" | undefined,
  ): Promise<void> {
    const config = this.manager.getConfig();
    const timeout = config.navigationTimeoutMs;
    if (action === "goto") {
      if (!url) throw new Error("browse_navigate: `url` is required when action is `goto`");
      checkNavigationUrl(url, { allowFile: config.allowFileUrls });
      await hudUpdate(page, `Navigating to ${url}`);
      await page.goto(url, {
        waitUntil: waitUntil ?? "load",
        timeout,
      });
      return;
    }
    if (action === "back") {
      await hudUpdate(page, "Going back");
      await page.goBack({ timeout });
      return;
    }
    if (action === "forward") {
      await hudUpdate(page, "Going forward");
      await page.goForward({ timeout });
      return;
    }
    await hudUpdate(page, "Reloading");
    await page.reload({ timeout });
  }

  private settle(page: Page, activity: NetworkActivity): Promise<SettleResult> {
    const config = this.manager.getConfig();
    return waitForSettled(page, {
      maxTimeoutMs: config.settleMaxTimeoutMs,
      quietWindowMs: config.settleQuietWindowMs,
      activity,
    });
  }
}

/** `promise`'s value, or null if it has not settled within `ms`. */
function orNullAfter<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
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
