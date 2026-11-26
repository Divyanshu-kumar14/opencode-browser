/**
 * Tab tracking: which tabs exist, which session owns each, which tab each
 * session acts on, and the one-shot "switched tab" notice for its next
 * response.
 *
 * Each session works in its own tabs, as in Antigravity. Sessions may run
 * turns at the same time, so a new page is attributed by who opened it:
 *   - A page whose opener is a session's tab belongs to that session, becomes
 *     its active tab, and queues an "opened" notice for that session only.
 *   - A page whose opener is nobody's (the user's own tab) stays nobody's.
 *   - A page with no opener (`noopener` links) goes to the session whose turn
 *     is running, when exactly one is; otherwise to nobody.
 *   - A page opened outside any turn is tracked but claimed by nobody. In an
 *     attached browser that is the user's own tab, which no session may touch.
 *   - When a session's active tab closes, its pointer moves to another of its
 *     own tabs (never another session's) and queues a "closed" notice.
 *   - `reset()` forgets everything. Listeners bound before a reset ignore
 *     later events, so a dead browser's tabs cannot touch new state.
 *
 * Page ids are stable for a page's lifetime and never reused. Turns without a
 * session id share the session named `DEFAULT_SESSION`.
 */

import type { Page } from "playwright";

/** The session turns belong to when the caller names none. */
export const DEFAULT_SESSION = "unknown";

/** The page surface tab tracking needs; Playwright's Page satisfies it. */
export interface TabPage {
  on(event: "close", listener: () => void): unknown;
  /** The page that opened this one (window.open, target=_blank), if known. */
  opener(): Promise<TabPage | null>;
  isClosed(): boolean;
  url(): string;
  bringToFront(): Promise<void>;
}

/** The context surface tab tracking needs; Playwright's BrowserContext satisfies it. */
export interface TabSource<P extends TabPage> {
  on(event: "page", listener: (page: P) => void): unknown;
  pages(): P[];
}

type Pending<P> = { readonly page: P; readonly reason: "opened" | "closed" };

let nextPageSeq = 0;
/** Page identity lives off-object, so nothing can collide with Playwright's Page. */
const pageIds = new WeakMap<object, string>();

export class TabTracker<P extends TabPage = Page> {
  private readonly pages = new Map<string, P>();
  private readonly owners = new WeakMap<object, string>();
  private readonly actives = new Map<string, P>();
  /** Pending tab-switch notice per session. The page is stored, not its URL: at the `page` event the URL is still about:blank. */
  private readonly pending = new Map<string, Pending<P>>();
  /** Sessions with a turn running, counted (a session runs one turn at a time). */
  private readonly running = new Map<string, number>();
  /** New pages whose owner is still being worked out (opener lookups). */
  private readonly attributing = new Set<Promise<void>>();
  /** Bumped by reset(); listeners from an older generation are ignored. */
  private generation = 0;

  /**
   * `onTrack` runs once per newly tracked page (telemetry, dialogs, page
   * scripts); `onOwn` runs each time a session takes a page (site rules).
   */
  constructor(
    private readonly onTrack: (page: P) => void = () => undefined,
    private readonly onOwn: (page: P, sessionId: string) => void = () => undefined,
  ) {}

  /** A session's turn starts; it may own pages opened while it runs. */
  beginTurn(sessionId: string): void {
    this.running.set(sessionId, (this.running.get(sessionId) ?? 0) + 1);
  }

  endTurn(sessionId: string): void {
    const left = (this.running.get(sessionId) ?? 1) - 1;
    if (left <= 0) this.running.delete(sessionId);
    else this.running.set(sessionId, left);
  }

  /** Resolves once every page opened so far has been given its owner. */
  async attributed(): Promise<void> {
    while (this.attributing.size > 0) await Promise.all([...this.attributing]);
  }

  /** Track the context's existing pages and every page it opens later. */
  watch(source: TabSource<P>): void {
    const generation = this.generation;
    source.on("page", (page) => {
      if (generation !== this.generation) return;
      this.add(page);
      // Capture who was running when the page appeared, before awaiting.
      const runningNow = [...this.running.keys()];
      const job = this.ownerFor(page, runningNow).then((owner) => {
        if (generation !== this.generation || owner === null || page.isClosed()) return;
        this.owners.set(page, owner);
        this.onOwn(page, owner);
        this.actives.set(owner, page);
        this.pending.set(owner, { page, reason: "opened" });
      });
      this.attributing.add(job);
      void job.finally(() => this.attributing.delete(job));
    });
    for (const page of source.pages()) this.add(page);
  }

  /** Track one page (idempotent). It has no owner until `own` or `activate`. */
  add(page: P): void {
    const id = this.idOf(page);
    if (this.pages.has(id)) return;
    this.pages.set(id, page);
    this.onTrack(page);
    const generation = this.generation;
    page.on("close", () => {
      if (generation !== this.generation) return;
      this.pages.delete(id);
      const owner = this.owners.get(page);
      if (owner === undefined || this.actives.get(owner) !== page) return;
      this.actives.delete(owner);
      for (const candidate of this.pages.values()) {
        if (this.owners.get(candidate) === owner && !candidate.isClosed()) {
          this.actives.set(owner, candidate);
          this.pending.set(owner, { page: candidate, reason: "closed" });
          break;
        }
      }
    });
  }

  /** The session a new page belongs to, by its opener or the running turn. */
  private async ownerFor(page: P, runningNow: readonly string[]): Promise<string | null> {
    const opener = await page.opener().catch(() => null);
    if (opener !== null) return this.owners.get(opener) ?? null;
    return runningNow.length === 1 ? runningNow[0]! : null;
  }

  /** Give `page` to `sessionId`. */
  own(page: P, sessionId: string): void {
    this.add(page);
    this.owners.set(page, sessionId);
    this.onOwn(page, sessionId);
  }

  /** The session that owns `page`, or null (the user's, or nobody's). */
  ownerOf(page: P): string | null {
    return this.owners.get(page) ?? null;
  }

  /** The tab `sessionId` acts on, or null. */
  active(sessionId: string = DEFAULT_SESSION): P | null {
    return this.actives.get(sessionId) ?? null;
  }

  /** Make `page` the active tab of `sessionId`, owned by it. */
  activate(page: P, sessionId: string = DEFAULT_SESSION): void {
    this.own(page, sessionId);
    this.actives.set(sessionId, page);
  }

  /**
   * Make one of `sessionId`'s own tabs its active tab. The tab is not brought
   * to the front unless asked: the window may be showing the user's tab.
   */
  async switchTo(
    pageId: string,
    sessionId: string = DEFAULT_SESSION,
    options: { readonly focus?: boolean } = {},
  ): Promise<void> {
    const page = this.pages.get(pageId);
    if (page === undefined || page.isClosed()) {
      throw new Error(`browser: tab ${pageId} not found or closed`);
    }
    if (this.owners.get(page) !== sessionId) {
      throw new Error(`browser: tab ${pageId} belongs to another session or to the user`);
    }
    if (options.focus === true) await page.bringToFront();
    this.actives.set(sessionId, page);
  }

  /** Tracked, open tabs: all of them, or only those owned by `sessionId`. */
  list(sessionId?: string): { pageId: string; page: P; url: string }[] {
    const out: { pageId: string; page: P; url: string }[] = [];
    for (const [pageId, page] of this.pages) {
      if (page.isClosed()) continue;
      if (sessionId !== undefined && this.owners.get(page) !== sessionId) continue;
      out.push({ pageId, page, url: page.url() });
    }
    return out;
  }

  /** Stable id for a page; the one place page identity is assigned. */
  idOf(page: P): string {
    const existing = pageIds.get(page);
    if (existing) return existing;
    const generated = `page-${++nextPageSeq}`;
    pageIds.set(page, generated);
    return generated;
  }

  /** Consume the pending tab-switch notice for `sessionId`, if any. */
  takeNotice(sessionId: string = DEFAULT_SESSION): string | null {
    const pending = this.pending.get(sessionId);
    this.pending.delete(sessionId);
    if (!pending || pending.page.isClosed()) return null;
    if (pending.reason === "closed") return `Active tab closed; switched to tab: ${pending.page.url()}`;
    return `Switched to new tab: ${pending.page.url()}`;
  }

  /** Forget every tab, owner, active pointer and pending notice. */
  reset(): void {
    this.generation += 1;
    this.pages.clear();
    this.actives.clear();
    this.pending.clear();
    this.running.clear();
    this.attributing.clear();
  }
}
