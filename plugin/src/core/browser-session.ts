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
import { execBatch, resolveLocator, type Action } from "./action-engine.ts";
import { InvalidInputError } from "./errors.ts";
import { resolveUploadPaths } from "./files.ts";
import * as path from "node:path";
import { hud } from "./page-agent.ts";
import { perceive } from "./perception.ts";
import { DEFAULT_SESSION } from "./tab-tracker.ts";
import { paginate, readPage } from "./read.ts";
import { waitFor } from "./wait.ts";
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
  /** URL of the session's active tab, without launching a browser ("about:blank" if none). */
  activeUrl(context?: TurnContext): string;
}

/** What the turn loop needs from the process browser; the manager satisfies it. */
export type SessionHost = Pick<
  BrowserSessionManager,
  "ensureActivePage" | "openTabFor" | "runExclusive" | "getConfig" | "getTelemetry" | "getViewport" | "tabs" | "presence" | "dialogs" | "downloads" | "sites" | "sitesReady" | "network"
>;

/** What one request kind's intent hands back to the shared turn sequence. */
interface Intent {
  readonly settle?: SettleResult;
  readonly notice?: string | null;
  readonly metadata?: Record<string, unknown>;
  /** SoM badges on the screenshot (default true). */
  readonly annotate?: boolean;
  readonly fullPage?: boolean;
  /** Runs after the HUD is settled at the end of the turn (e.g. a hand-off notice). */
  readonly after?: () => Promise<void>;
  /** The outcome built from the snapshot; default is a page outcome. */
  readonly outcome?: (snapshot: TurnSnapshot, metadata: Record<string, unknown>) => TurnOutcome;
}

/** Turns made without a session (direct callers, tests) share this id. */
const UNKNOWN_SESSION = DEFAULT_SESSION;

export class PlaywrightBrowserSession implements BrowserSession {
  /**
   * `perceiveTab` is the perception adapter: core/perception.ts in
   * production, a stand-in in turn-loop tests.
   */
  constructor(
    private readonly manager: SessionHost,
    private readonly perceiveTab: typeof perceive = perceive,
  ) { }

  activeUrl(context: TurnContext = {}): string {
    const page = this.manager.tabs.active(context.sessionId ?? UNKNOWN_SESSION);
    if (!page || page.isClosed()) return "about:blank";
    return page.url();
  }

  /**
   * One turn at a time: the manager's lock serializes turns so two calls
   * never interleave their intent and perception on the shared page.
   */
  turn(request: TurnRequest, context: TurnContext = {}): Promise<ToolResult> {
    const sessionId = context.sessionId ?? UNKNOWN_SESSION;
    return this.manager.runExclusive(() => this.runTurn(request, sessionId), sessionId);
  }

  /**
   * The shared sequence every kind runs: ensure page -> intent -> pick the
   * tab to perceive -> perceive -> snapshot -> format, and clear the HUD on
   * every tab the turn touched, success or failure.
   */
  private async runTurn(request: TurnRequest, sessionId: string): Promise<ToolResult> {
    // Validate before anything is touched, so a bad URL never opens a tab.
    if (request.kind === "tabs" && request.action === "open" && request.url !== undefined) {
      this.checkUrl(request.url);
    }
    const page = await this.manager.ensureActivePage(sessionId);
    const config = this.manager.getConfig();
    let target: Page = page;
    // Tabs opened while this turn runs (popups) belong to this session.
    this.manager.tabs.beginTurn(sessionId);
    let afterTurn: (() => Promise<void>) | undefined;
    try {
      // Site rules must be in place on this session's tabs before it acts.
      await this.manager.sitesReady();
      // The agent is using the browser: show its presence on this tab.
      await this.manager.presence.begin(sessionId, [page]);
      const intent = await this.intent(page, request, sessionId);

      // Perceive the tab that is active now, not the one the turn started on:
      // the intent may open or close tabs, which moves the active pointer.
      // Wait until any popup it opened knows which session it belongs to.
      await this.manager.tabs.attributed();
      await this.manager.sitesReady();
      const deadline = Date.now() + config.perceptionTimeoutMs;
      const after = this.manager.tabs.active(sessionId);
      if (after !== page || page.isClosed()) {
        target = after && !after.isClosed() ? after : await this.manager.ensureActivePage(sessionId);
        const wait = Math.max(1, Math.min(deadline - Date.now(), config.navigationTimeoutMs));
        await target.waitForLoadState("domcontentloaded", { timeout: wait }).catch(() => undefined);
      }

      const perception = await this.perceiveTab(target, {
        telemetry: this.manager.getTelemetry(),
        screenshotDir: config.screenshotDir,
        // Every tab this session owns (including ones in the background), and
        // nothing else: other sessions' errors are theirs to report.
        telemetryPages: [
          ...new Set<Page>([page, target, ...this.manager.tabs.list(sessionId).map((tab) => tab.page)]),
        ],
        deadline,
        budgetMs: config.perceptionTimeoutMs,
        annotate: intent.annotate ?? true,
        fullPage: intent.fullPage ?? false,
        // Reading is a text task: no screenshot unless asked for.
        screenshot: config.screenshots && (request.kind === "read" ? request.screenshot === true : request.screenshot !== false),
      });
      const touched = target === page ? [page] : [page, target];
      // A download the intent started is usually written within moments.
      await Promise.all(touched.map((tab) => this.manager.downloads.settle(tab, 3000)));
      const dialogNotes = [
        ...touched.flatMap((tab) => this.manager.dialogs.take(tab).map((note) => `Dialog: ${note}`)),
        ...touched.flatMap((tab) => this.manager.downloads.take(tab).map((note) => `Download: ${note}`)),
        ...touched.flatMap((tab) => this.manager.sites.take(tab).map((note) => `Blocked: ${note}`)),
      ].join("\n");
      const notice =
        [intent.notice, dialogNotes, perception.notice].filter((n): n is string => !!n).join("\n\n") || null;
      const snapshot: TurnSnapshot = {
        url: target.url(),
        title: await target.title().catch(() => ""),
        tabId: this.manager.tabs.idOf(target),
        elements: perception.elements,
        frames: perception.frames,
        screenshotPath: perception.screenshotPath,
        width: perception.width,
        height: perception.height,
        telemetry: perception.telemetryEvents,
        tabSwitch: this.manager.tabs.takeNotice(sessionId),
        settled: intent.settle?.settled,
        durationMs: intent.settle?.durationMs,
        notice,
      };
      const metadata = intent.metadata ?? {};
      afterTurn = intent.after;
      return formatTurn(intent.outcome ? intent.outcome(snapshot, metadata) : { kind: "page", snapshot, metadata });
    } finally {
      this.manager.tabs.endTurn(sessionId);
      // Never leave the pill showing a stale step: "Thinking…" while the agent
      // is still working, cleared when it is not (headless, or released).
      // Perception restores the hidden HUD before this runs.
      await this.manager.presence.settle(target === page ? [page] : [page, target]);
      // A hand-off is shown last, so the end-of-turn HUD update cannot hide it.
      if (afterTurn !== undefined) await afterTurn().catch(() => undefined);
    }
  }

  /** Run one request kind's intent on `page`. */
  private intent(page: Page, request: TurnRequest, sessionId: string): Promise<Intent> {
    switch (request.kind) {
      case "tabs":
        return this.tabsIntent(page, request, sessionId);
      case "handoff":
        return this.handoffIntent(page, request, sessionId);
      case "upload":
        return this.uploadIntent(page, request);
      case "network":
        return Promise.resolve(this.networkIntent(page, request));
      case "navigate":
        return this.navigateIntent(page, request);
      case "act":
        return this.actIntent(page, request.actions);
      case "observe":
        return Promise.resolve({ annotate: request.annotate !== false, fullPage: request.fullPage ?? false });
      case "inspect":
        return this.inspectIntent(page, request);
      case "viewport":
        return this.viewportIntent(page, request, sessionId);
      case "read":
        return this.readIntent(page, request);
      case "dialog":
        return Promise.resolve(this.dialogIntent(page, request));
      case "wait":
        return this.waitIntent(page, request);
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

  private async viewportIntent(
    page: Page,
    request: Extract<TurnRequest, { kind: "viewport" }>,
    sessionId: string,
  ): Promise<Intent> {
    // null = release the override and follow the live window again.
    const resolved = resolveViewport(request);
    const settle = await this.withNetwork(page, async (activity) => {
      // A release only resets this session's own tabs.
      const mine = this.manager.tabs.list(sessionId).map((tab) => tab.page);
      await this.manager.getViewport().apply(page, resolved, mine);
      return this.settle(page, activity);
    });
    return { settle, metadata: { viewport: resolved ?? (await viewportSizeOf(page)) } };
  }

  private networkIntent(page: Page, request: Extract<TurnRequest, { kind: "network" }>): Intent {
    const query = {
      ...(request.filter === undefined ? {} : { filter: request.filter }),
      onlyErrors: request.onlyErrors,
      limit: request.limit,
    };
    const sections: string[] = [];
    let requestCount = 0;
    let consoleCount = 0;
    if (request.show !== "console") {
      const rows = this.manager.network.requests(page, query);
      requestCount = rows.length;
      sections.push(
        "## Requests (newest last)",
        rows.length === 0
          ? "(none)"
          : rows
              .map((e) => {
                const outcome = e.pending ? "pending" : (e.failure ?? String(e.status ?? "?"));
                const ms = e.durationMs === null ? "" : ` ${e.durationMs}ms`;
                return `- ${outcome} ${e.method} ${e.url} [${e.type}]${ms}`;
              })
              .join("\n"),
      );
    }
    if (request.show !== "requests") {
      const rows = this.manager.network.console(page, query);
      consoleCount = rows.length;
      sections.push(
        "## Console (newest last)",
        rows.length === 0 ? "(none)" : rows.map((e) => `- [${e.level}] ${e.text}`).join("\n"),
      );
    }
    return {
      annotate: false,
      notice: sections.join("\n"),
      metadata: { requests: requestCount, console: consoleCount },
    };
  }

  private async uploadIntent(page: Page, request: Extract<TurnRequest, { kind: "upload" }>): Promise<Intent> {
    const config = this.manager.getConfig();
    // Refused before the page is touched when any path is outside the folders.
    const files = resolveUploadPaths(request.paths, [config.uploadDir, config.downloadDir]);
    const target = await resolveLocator(page, {
      type: "click",
      ...(request.elementId === undefined ? {} : { elementId: request.elementId }),
      ...(request.selector === undefined ? {} : { selector: request.selector }),
    });
    if (target === null) throw new InvalidInputError("browse_upload: pass `elementId` or `selector`");
    await hud.status(page, `Uploading ${files.length} file${files.length === 1 ? "" : "s"}`);
    const isFileInput = await target
      .evaluate((el) => (el as unknown as { tagName: string; type?: string }).tagName === "INPUT" &&
        String((el as unknown as { type?: string }).type).toLowerCase() === "file")
      .catch(() => false);
    const settle = await this.withNetwork(page, async (activity) => {
      if (isFileInput) {
        await target.setInputFiles(files);
      } else {
        // A button that opens the picker: answer the picker it opens.
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 3000 }),
          target.click(),
        ]).catch(() => {
          throw new InvalidInputError(
            "browse_upload: the target is not a file input and clicking it opened no file picker",
            "target the <input type=file>, or the button that opens the file picker",
          );
        });
        await chooser.setFiles(files);
      }
      return this.settle(page, activity);
    });
    const names = files.map((file) => path.basename(file)).join(", ");
    return { settle, notice: `Uploaded: ${names}`, metadata: { uploaded: files.length } };
  }

  private async handoffIntent(
    page: Page,
    request: Extract<TurnRequest, { kind: "handoff" }>,
    sessionId: string,
  ): Promise<Intent> {
    return {
      notice:
        `Handed this tab to the user: ${request.reason}\n` +
        "Stop using the browser now. Tell the user what to do in this tab and to reply when they are done; " +
        "then continue on the same tab.",
      metadata: { handedOff: true },
      after: () => this.manager.presence.handOff(sessionId, page, request.reason),
    };
  }

  private async tabsIntent(
    page: Page,
    request: Extract<TurnRequest, { kind: "tabs" }>,
    sessionId: string,
  ): Promise<Intent> {
    const tabs = this.manager.tabs;
    switch (request.action) {
      case "list": {
        const active = tabs.active(sessionId);
        const lines = await Promise.all(
          tabs.list(sessionId).map(async ({ pageId, page: tab, url }) => {
            const title = await tab.title().catch(() => "");
            return `${tab === active ? "*" : " "} ${pageId} ${redactUrl(url)}${title ? ` — ${title}` : ""}`;
          }),
        );
        return { notice: ["## Tabs", ...lines].join("\n"), metadata: { tabs: lines.length } };
      }
      case "open": {
        const opened = await this.manager.openTabFor(sessionId);
        // The new tab's site rules must be in place before it loads anything.
        await this.manager.sitesReady();
        if (request.url !== undefined) {
          await this.withNetwork(opened, async (activity) => {
            await this.navigate(opened, "goto", request.url, undefined);
            await this.settle(opened, activity);
          });
        }
        return { metadata: { opened: tabs.idOf(opened) } };
      }
      case "switch": {
        await tabs.switchTo(request.tabId!, sessionId);
        return { metadata: { switched: request.tabId } };
      }
      case "close": {
        const target = request.tabId === undefined ? page : tabs.list().find((t) => t.pageId === request.tabId)?.page;
        if (target === undefined || target.isClosed()) throw new Error(`browser: tab ${request.tabId} not found or closed`);
        if (tabs.ownerOf(target) !== sessionId) {
          throw new Error(`browser: tab ${request.tabId} belongs to another session or to the user`);
        }
        const id = tabs.idOf(target);
        await target.close();
        // Closing the last tab leaves the session a fresh one on the same turn.
        if (tabs.active(sessionId) === null) await this.manager.openTabFor(sessionId);
        // The close is the agent's own doing; no "tab closed" notice for it.
        tabs.takeNotice(sessionId);
        return { metadata: { closed: id } };
      }
    }
  }

  private async readIntent(page: Page, request: Extract<TurnRequest, { kind: "read" }>): Promise<Intent> {
    await hud.status(page, "Reading the page");
    const { text } = await readPage(page, { selector: request.selector, links: request.links });
    const window = paginate(text, request.offset, request.maxChars);
    return {
      annotate: false,
      outcome: (snapshot, metadata) => ({
        kind: "read",
        snapshot,
        markdown: window.text,
        window: { total: window.total, offset: window.offset, nextOffset: window.nextOffset, length: window.text.length },
        metadata,
      }),
    };
  }

  private dialogIntent(page: Page, request: Extract<TurnRequest, { kind: "dialog" }>): Intent {
    this.manager.dialogs.plan(page, {
      accept: request.accept,
      ...(request.promptText === undefined ? {} : { promptText: request.promptText }),
    });
    return {
      notice: `The next dialog on this tab will be ${request.accept ? "accepted" : "dismissed"}.`,
      metadata: { accept: request.accept },
    };
  }

  private async waitIntent(page: Page, request: Extract<TurnRequest, { kind: "wait" }>): Promise<Intent> {
    await hud.status(page, "Waiting…");
    const result = await waitFor(page, request.conditions, request.timeoutMs);
    return {
      notice: result.summary,
      metadata: { waited: result.ok, waitedMs: result.waitedMs },
    };
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
      this.checkUrl(url);
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

  /** The scheme policy, then the site rules; both reject before anything loads. */
  private checkUrl(url: string): void {
    checkNavigationUrl(url, { allowFile: this.manager.getConfig().allowFileUrls });
    const reason = this.manager.sites.reasonFor(url);
    if (reason !== null) {
      throw new InvalidInputError(`browse: ${reason}`, "pick an allowed site, or change the site rules");
    }
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
