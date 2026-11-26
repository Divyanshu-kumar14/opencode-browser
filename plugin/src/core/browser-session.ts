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
import { execBatch, type Action } from "./action-engine.ts";
import { hud } from "./page-agent.ts";
import { perceive } from "./perception.ts";
import { inspectElement } from "./inspect.ts";
import { waitForSettled, trackNetwork, type NetworkActivity, type SettleResult } from "./settle.ts";
import {
  formatTurn,
  type ToolResult,
  type TurnOutcome,
  type TurnRequest,
  type TurnSnapshot,
} from "./turn.ts";
import { resolveViewport, viewportSizeOf } from "./viewport.ts";
import { checkNavigationUrl, redactUrl } from "./url-policy.ts";

/** Who is asking: the OpenCode session whose tool call this turn serves. */
export interface TurnContext {
  readonly sessionId?: string;
}

export interface BrowserSession {
  /** Run one tool turn and return the formatted result. */
  turn(request: TurnRequest, context?: TurnContext): Promise<ToolResult>;
  /** URL of the active tab, without launching a browser ("about:blank" if none). */
  activeUrl(): string;
}

/** What the turn loop needs from the process browser; the manager satisfies it. */
export type SessionHost = Pick<
  BrowserSessionManager,
  "ensureActivePage" | "runExclusive" | "getConfig" | "getTelemetry" | "getViewport" | "tabs" | "presence"
>;

/** What one request kind's intent hands back to the shared turn sequence. */
interface Intent {
  readonly settle?: SettleResult;
  readonly notice?: string | null;
  readonly metadata?: Record<string, unknown>;
  /** SoM badges on the screenshot (default true). */
  readonly annotate?: boolean;
  readonly fullPage?: boolean;
  /** The outcome built from the snapshot; default is a page outcome. */
  readonly outcome?: (snapshot: TurnSnapshot, metadata: Record<string, unknown>) => TurnOutcome;
}

/** Turns made without a session (direct callers, tests) share this id. */
const UNKNOWN_SESSION = "unknown";

export class PlaywrightBrowserSession implements BrowserSession {
  /**
   * `perceiveTab` is the perception adapter: core/perception.ts in
   * production, a stand-in in turn-loop tests.
   */
  constructor(
    private readonly manager: SessionHost,
    private readonly perceiveTab: typeof perceive = perceive,
  ) { }

  activeUrl(): string {
    const page = this.manager.tabs.active();
    if (!page || page.isClosed()) return "about:blank";
    return page.url();
  }

  /**
   * One turn at a time: the manager's lock serializes turns so two calls
   * never interleave their intent and perception on the shared page.
   */
  turn(request: TurnRequest, context: TurnContext = {}): Promise<ToolResult> {
    return this.manager.runExclusive(() => this.runTurn(request, context.sessionId ?? UNKNOWN_SESSION));
  }

  /**
   * The shared sequence every kind runs: ensure page -> intent -> pick the
   * tab to perceive -> perceive -> snapshot -> format, and clear the HUD on
   * every tab the turn touched, success or failure.
   */
  private async runTurn(request: TurnRequest, sessionId: string): Promise<ToolResult> {
    const page = await this.manager.ensureActivePage();
    const config = this.manager.getConfig();
    let target: Page = page;
    try {
      // The agent is using the browser: show its presence on this tab.
      await this.manager.presence.begin(sessionId, [page]);
      const intent = await this.intent(page, request);

      // Perceive the tab that is active now, not the one the turn started on:
      // the intent may open or close tabs, which moves the active pointer.
      const deadline = Date.now() + config.perceptionTimeoutMs;
      const after = this.manager.tabs.active();
      if (after !== page || page.isClosed()) {
        target = after && !after.isClosed() ? after : await this.manager.ensureActivePage();
        const wait = Math.max(1, Math.min(deadline - Date.now(), config.navigationTimeoutMs));
        await target.waitForLoadState("domcontentloaded", { timeout: wait }).catch(() => undefined);
      }

      const perception = await this.perceiveTab(target, {
        telemetry: this.manager.getTelemetry(),
        screenshotDir: config.screenshotDir,
        deadline,
        budgetMs: config.perceptionTimeoutMs,
        annotate: intent.annotate ?? true,
        fullPage: intent.fullPage ?? false,
      });
      const notice = [intent.notice, perception.notice].filter((n): n is string => !!n).join("\n\n") || null;
      const snapshot: TurnSnapshot = {
        url: target.url(),
        title: await target.title().catch(() => ""),
        tabId: this.manager.tabs.idOf(target),
        elements: perception.elements,
        screenshotPath: perception.screenshotPath,
        width: perception.width,
        height: perception.height,
        telemetry: perception.telemetryEvents,
        tabSwitch: this.manager.tabs.takeNotice(),
        settled: intent.settle?.settled,
        durationMs: intent.settle?.durationMs,
        notice,
      };
      const metadata = intent.metadata ?? {};
      return formatTurn(intent.outcome ? intent.outcome(snapshot, metadata) : { kind: "page", snapshot, metadata });
    } finally {
      // Never leave the pill showing a stale step: "Thinking…" while the agent
      // is still working, cleared when it is not (headless, or released).
      // Perception restores the hidden HUD before this runs.
      await this.manager.presence.settle(target === page ? [page] : [page, target]);
    }
  }

  /** Run one request kind's intent on `page`. */
  private intent(page: Page, request: TurnRequest): Promise<Intent> {
    switch (request.kind) {
      case "navigate":
        return this.navigateIntent(page, request);
      case "act":
        return this.actIntent(page, request.actions);
      case "observe":
        return Promise.resolve({ annotate: request.annotate !== false, fullPage: request.fullPage ?? false });
      case "inspect":
        return this.inspectIntent(page, request);
      case "viewport":
        return this.viewportIntent(page, request);
      case "evaluate":
        return this.evaluateIntent(page, request);
    }
  }

  private async navigateIntent(page: Page, request: Extract<TurnRequest, { kind: "navigate" }>): Promise<Intent> {
    const settle = await this.withNetwork(page, async (activity) => {
      await this.navigate(page, request.action, request.url, request.waitUntil);
      return this.settle(page, activity);
    });
    return { settle, metadata: { action: request.action } };
  }

  private async actIntent(page: Page, requested: readonly Action[]): Promise<Intent> {
    const actions = [...requested];
    if (actions.length === 0) {
      throw new Error("browse_interact: pass `actions` or a single `type` action");
    }
    if (actions.length > 1) await hud.status(page, `Batch: ${actions.length} actions`);
    const { batch, settle } = await this.withNetwork(page, async (activity) => {
      const batch = await execBatch(page, actions);
      return { batch, settle: await this.settle(page, activity) };
    });
    if (batch.staleElementId !== null) {
      await hud.status(page, `Stopped at [${batch.staleElementId}] — stale`);
    } else if (actions.length > 1) {
      await hud.status(page, `Batch complete (${batch.completed}/${actions.length})`);
    }
    return {
      settle,
      notice: batch.message,
      metadata: { stoppedAt: batch.stoppedAt, batchMessage: batch.message ?? undefined },
    };
  }

  private async inspectIntent(page: Page, request: Extract<TurnRequest, { kind: "inspect" }>): Promise<Intent> {
    const inspected = await inspectElement(page, request);
    return {
      annotate: false,
      metadata: { elementId: request.elementId, selector: request.selector, found: inspected.found },
      outcome: (snapshot, metadata) => ({
        kind: "inspect",
        snapshot,
        lines: inspected.lines,
        found: inspected.found,
        metadata,
      }),
    };
  }

  private async viewportIntent(page: Page, request: Extract<TurnRequest, { kind: "viewport" }>): Promise<Intent> {
    // null = release the override and follow the live window again.
    const resolved = resolveViewport(request);
    const settle = await this.withNetwork(page, async (activity) => {
      await this.manager.getViewport().apply(page, resolved);
      return this.settle(page, activity);
    });
    return { settle, metadata: { viewport: resolved ?? (await viewportSizeOf(page)) } };
  }

  private async evaluateIntent(page: Page, request: Extract<TurnRequest, { kind: "evaluate" }>): Promise<Intent> {
    const config = this.manager.getConfig();
    if (request.approvedUrl !== undefined) {
      const now = redactUrl(page.url());
      if (now !== request.approvedUrl) {
        throw new Error(
          `page changed since browse_eval was approved (approved ${request.approvedUrl}, now ${now}); retry`,
        );
      }
    }
    const evaluated = await this.evaluateBounded(page, request.expression, config.evalTimeoutMs);
    let rendered: string;
    let threw = true;
    let metadata: Record<string, unknown>;
    if (evaluated.kind === "value") {
      threw = false;
      const value = evaluated.value;
      if (value === undefined) {
        rendered = "undefined";
      } else {
        try {
          rendered = JSON.stringify(value);
        } catch {
          rendered = String(value);
        }
      }
      metadata = { threw: false };
    } else if (evaluated.kind === "error") {
      const error = evaluated.error;
      rendered = error instanceof Error ? error.message : String(error);
      metadata = { threw: true };
    } else {
      rendered =
        `timed out after ${config.evalTimeoutMs}ms` +
        (evaluated.terminated
          ? "; the page script was terminated"
          : "; the page script may still be pending");
      metadata = { threw: true, timedOut: true };
    }
    return {
      annotate: false,
      metadata,
      outcome: (snapshot, meta) => ({ kind: "evaluate", snapshot, rendered, threw, metadata: meta }),
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
      await hud.status(page, `Navigating to ${url}`);
      await page.goto(url, {
        waitUntil: waitUntil ?? "load",
        timeout,
      });
      return;
    }
    if (action === "back") {
      await hud.status(page, "Going back");
      await page.goBack({ timeout });
      return;
    }
    if (action === "forward") {
      await hud.status(page, "Going forward");
      await page.goForward({ timeout });
      return;
    }
    await hud.status(page, "Reloading");
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
