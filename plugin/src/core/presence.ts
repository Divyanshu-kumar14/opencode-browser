/**
 * Presence: the agent's visible presence in the browser, in the style of
 * Antigravity. While any session is using the browser, the tabs it works in
 * show the HUD (the current step, or "Thinking…" between calls, plus a Stop
 * button). Nothing blocks the user.
 *
 * It owns three things:
 *   - which sessions are using the browser (a tool call starts one; the host's
 *     idle signal ends it, unless the session still waits on a subagent);
 *   - which tabs are presented (only tabs the agent used, so the user's other
 *     tabs stay untouched, including in an attached browser);
 *   - Take over (the Stop button): release the HUD and interrupt every session.
 *   - Hand-off: a session hands a tab to the user ("Your turn: sign in"). The
 *     notice outlives the session going idle and every page load while the
 *     user works, and clears on that session's next browser call.
 *
 * A safety timer releases the HUD when no idle signal arrives (the host does
 * not send one after an interrupt or a failure). It counts from the end of the
 * last browser call and never fires while a call is still running, so a long
 * `goto` or `browse_eval` keeps the HUD up.
 */

import type { Page } from "playwright";
import { hud } from "./page-agent.ts";

/** The pill text between tool calls, while the model plans its next step. */
export const THINKING = "Thinking…";

/** The tab surface presence needs; Playwright's Page satisfies it. */
export interface PresencePage {
  evaluate: Page["evaluate"];
  on(event: "domcontentloaded" | "close", listener: () => void): unknown;
  isClosed(): boolean;
}

/** Background work the host reports when a session goes idle. */
export interface IdleBackground {
  readonly kind: string;
  /** The session that owns the work. */
  readonly sessionID: string;
  /** For a subagent: the child session doing the work. */
  readonly childSessionID?: string;
}

export interface PresenceTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: PresenceTimers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms) as unknown as { unref?: () => void };
    if (typeof handle.unref === "function") handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Presence {
  /** Set at launch: true for a headful or attached browser, false for headless. */
  enabled = false;

  private readonly sessions = new Set<string>();
  private readonly marked = new Set<PresencePage>();
  /** Tabs handed to the user, with the reason shown and the session that did it. */
  private readonly handoffs = new Map<PresencePage, { readonly reason: string; readonly sessionId: string }>();
  /** Tabs that already carry the navigation / close listeners. */
  private readonly watched = new WeakSet<PresencePage>();
  private timer: unknown = null;
  /** Browser calls that have begun and not yet settled. */
  private inFlight = 0;
  private interrupter: ((sessionId: string) => Promise<void> | void) | undefined;

  constructor(
    private readonly options: { readonly timeoutMs: number },
    private readonly timers: PresenceTimers = realTimers,
  ) {}

  isActive(): boolean {
    return this.sessions.size > 0;
  }

  sessionIds(): string[] {
    return [...this.sessions];
  }

  /** Who to interrupt on Take over; `undefined` removes it. */
  setInterrupter(fn: ((sessionId: string) => Promise<void> | void) | undefined): void {
    this.interrupter = fn;
  }

  /** The current interrupter, so a plugin instance can tell whether it still owns it. */
  getInterrupter(): ((sessionId: string) => Promise<void> | void) | undefined {
    return this.interrupter;
  }

  /** A browser tool call starts: `sessionId` is using the browser on `pages`. */
  async begin(sessionId: string, pages: readonly PresencePage[]): Promise<void> {
    if (!this.enabled) return;
    // The agent is back: its hand-offs are over.
    await Promise.all(
      [...this.handoffs]
        .filter(([, h]) => h.sessionId === sessionId)
        .map(([page]) => {
          this.handoffs.delete(page);
          return page.isClosed() ? undefined : hud.handoff(page, null);
        }),
    );
    this.inFlight += 1;
    this.sessions.add(sessionId);
    this.arm();
    await Promise.all(pages.map((page) => this.mark(page)));
  }

  /**
   * A browser tool call ended on `pages`. Active: show "Thinking…" while the
   * model plans. Inactive (headless, or already released): hide and clear.
   */
  async settle(pages: readonly PresencePage[]): Promise<void> {
    if (!this.enabled) {
      await Promise.all(pages.map((page) => hud.clear(page)));
      return;
    }
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.isActive()) this.arm();
    if (!this.isActive()) {
      await Promise.all(
        pages.map(async (page) => {
          await hud.present(page, false);
          await hud.clear(page);
        }),
      );
      return;
    }
    await Promise.all(
      pages.map(async (page) => {
        await this.mark(page);
        await hud.status(page, THINKING);
      }),
    );
  }

  /**
   * The host reports `sessionId` idle. A session that still waits on its own
   * subagent stays busy; the host runs the hook again when that work ends.
   */
  async end(sessionId: string, background: readonly IdleBackground[]): Promise<void> {
    if (!this.sessions.has(sessionId)) return;
    if (background.some((work) => work.kind === "subagent" && work.sessionID === sessionId)) return;
    this.sessions.delete(sessionId);
    if (this.sessions.size === 0) await this.release();
  }

  /** The Stop button: hand every tab back and interrupt every session. */
  async takeOver(): Promise<void> {
    if (!this.isActive()) return;
    const ids = this.sessionIds();
    await this.release();
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.interrupter?.(id);
        } catch {
          // The session may already be gone; the HUD is released either way.
        }
      }),
    );
  }

  /** Hand `page` to the user with `reason` until `sessionId` acts again. */
  async handOff(sessionId: string, page: PresencePage, reason: string): Promise<void> {
    if (!this.enabled) return;
    this.handoffs.set(page, { reason, sessionId });
    this.watch(page);
    await hud.handoff(page, reason);
  }

  /** The browser is gone: forget everything without touching dead tabs. */
  discard(): void {
    this.handoffs.clear();
    this.inFlight = 0;
    this.disarm();
    this.sessions.clear();
    this.marked.clear();
  }

  private async release(): Promise<void> {
    this.disarm();
    this.sessions.clear();
    const pages = [...this.marked].filter((page) => !page.isClosed());
    this.marked.clear();
    await Promise.all(pages.map((page) => hud.present(page, false)));
  }

  private arm(): void {
    this.disarm();
    this.timer = this.timers.set(() => {
      // A call is still running: keep the HUD and check again later.
      if (this.inFlight > 0) this.arm();
      else void this.release();
    }, this.options.timeoutMs);
  }

  private disarm(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  /**
   * Present `page` once and keep it presented across navigations while
   * active. A tab that is already presented costs no page call.
   */
  private async mark(page: PresencePage): Promise<void> {
    const alreadyPresented = this.marked.has(page);
    this.marked.add(page);
    this.watch(page);
    if (!alreadyPresented) await hud.present(page, true);
  }

  /** Re-apply this tab's HUD state on every new document; forget it on close. */
  private watch(page: PresencePage): void {
    if (this.watched.has(page)) return;
    this.watched.add(page);
    // A new document starts with a fresh, hidden HUD.
    page.on("domcontentloaded", () => {
      if (this.isActive() && this.marked.has(page)) void hud.present(page, true);
      const handoff = this.handoffs.get(page);
      if (handoff !== undefined) void hud.handoff(page, handoff.reason);
    });
    page.on("close", () => {
      this.marked.delete(page);
      this.handoffs.delete(page);
    });
  }
}
