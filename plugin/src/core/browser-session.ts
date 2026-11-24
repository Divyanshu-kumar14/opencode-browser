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
import { capturePerception, execBatch, hudClear, hudUpdate } from "./action-engine.ts";
import { inspectElement } from "./inspect.ts";
import { waitForSettled, trackNetwork, type NetworkActivity, type SettleResult } from "./settle.ts";
import { formatTurn, type ToolResult, type TurnRequest, type TurnSnapshot } from "./turn.ts";
import { resolveViewport } from "./viewport.ts";

export interface BrowserSession {
  /** Run one tool turn and return the formatted result. */
  turn(request: TurnRequest): Promise<ToolResult>;
}

export class PlaywrightBrowserSession implements BrowserSession {
  constructor(private readonly manager: BrowserSessionManager) {}

  async turn(request: TurnRequest): Promise<ToolResult> {
    // A bare viewport call releases the pin *before* the page is ensured, so
    // ensureActivePage() re-syncs to the live window.
    if (request.kind === "viewport" && resolveViewport(request) === null) {
      this.manager.unpinViewport();
    }

    const page = await this.manager.ensureActivePage();
    const telemetry = this.manager.getTelemetry();
    const config = this.manager.getConfig();
    const tabId = this.manager.pageIdFor(page);

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
          try {
            const value = await page.evaluate<unknown>(request.expression);
            if (value === undefined) {
              evalRendered = "undefined";
            } else {
              try {
                evalRendered = JSON.stringify(value);
              } catch {
                evalRendered = String(value);
              }
            }
          } catch (error) {
            evalThrew = true;
            evalRendered = error instanceof Error ? error.message : String(error);
          }
          extraMetadata = { threw: evalThrew };
          break;
        }
      }

      const perception = await capturePerception(page, telemetry, {
        screenshotDir: config.screenshotDir,
        annotate,
        fullPage,
      });

      const snapshot: TurnSnapshot = {
        url: page.url(),
        title: await page.title().catch(() => ""),
        tabId,
        elements: perception.elements,
        screenshotPath: perception.screenshotPath,
        width: perception.width,
        height: perception.height,
        telemetry: perception.telemetryEvents,
        tabSwitch: this.manager.takeTabSwitchNotification(),
        settled: settle?.settled,
        durationMs: settle?.durationMs,
        notice,
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
