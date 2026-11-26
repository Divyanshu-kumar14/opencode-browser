/**
 * Tab tracking: which tabs exist, which one the agent acts on, and the
 * one-shot "switched tab" notice for the next tool response.
 *
 *   - Every page the context opens (target=_blank, OAuth popups, …) is
 *     tracked, becomes the active tab, and queues an "opened" notice.
 *   - When the active tab closes, the pointer moves to another live tab and
 *     queues a "closed" notice.
 *   - `reset()` forgets everything. Listeners bound before a reset ignore
 *     later events, so a dead browser's tabs cannot touch new state.
 *
 * Page ids are stable for a page's lifetime and never reused.
 */

import type { Page } from "playwright";

/** The page surface tab tracking needs; Playwright's Page satisfies it. */
export interface TabPage {
  on(event: "close", listener: () => void): unknown;
  isClosed(): boolean;
  url(): string;
  bringToFront(): Promise<void>;
}

/** The context surface tab tracking needs; Playwright's BrowserContext satisfies it. */
export interface TabSource<P extends TabPage> {
  on(event: "page", listener: (page: P) => void): unknown;
  pages(): P[];
}

let nextPageSeq = 0;
/** Page identity lives off-object, so nothing can collide with Playwright's Page. */
const pageIds = new WeakMap<object, string>();

export class TabTracker<P extends TabPage = Page> {
  private readonly pages = new Map<string, P>();
  private activePage: P | null = null;
  /**
   * Pending tab switch for the next tool response. The page is stored, not its
   * URL: at the `page` event the URL is still about:blank.
   */
  private pending: { readonly page: P; readonly reason: "opened" | "closed" } | null = null;
  /** Bumped by reset(); listeners from an older generation are ignored. */
  private generation = 0;

  /** `onTrack` runs once per newly tracked page (telemetry, page scripts). */
  constructor(private readonly onTrack: (page: P) => void = () => undefined) {}

  /** Track the context's existing pages and every page it opens later. */
  watch(source: TabSource<P>): void {
    const generation = this.generation;
    source.on("page", (page) => {
      if (generation !== this.generation) return;
      this.add(page);
      this.activePage = page;
      this.pending = { page, reason: "opened" };
    });
    for (const page of source.pages()) this.add(page);
  }

  /** Track one page (idempotent). */
  add(page: P): void {
    const id = this.idOf(page);
    if (this.pages.has(id)) return;
    this.pages.set(id, page);
    this.onTrack(page);
    const generation = this.generation;
    page.on("close", () => {
      if (generation !== this.generation) return;
      this.pages.delete(id);
      if (this.activePage !== page) return;
      this.activePage = null;
      for (const candidate of this.pages.values()) {
        if (!candidate.isClosed()) {
          this.activePage = candidate;
          this.pending = { page: candidate, reason: "closed" };
          break;
        }
      }
    });
  }

  /** The tab the agent acts on, or null. */
  active(): P | null {
    return this.activePage;
  }

  /** Make `page` the active tab, tracking it if needed. */
  activate(page: P): void {
    this.add(page);
    this.activePage = page;
  }

  /** Bring a tracked tab to the front and make it active. */
  async switchTo(pageId: string): Promise<void> {
    const page = this.pages.get(pageId);
    if (page === undefined || page.isClosed()) {
      throw new Error(`browser: tab ${pageId} not found or closed`);
    }
    await page.bringToFront();
    this.activePage = page;
  }

  /** All tracked, open tabs. */
  list(): { pageId: string; page: P; url: string }[] {
    const out: { pageId: string; page: P; url: string }[] = [];
    for (const [pageId, page] of this.pages) {
      if (!page.isClosed()) out.push({ pageId, page, url: page.url() });
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

  /** Consume the pending tab-switch notice, if any. */
  takeNotice(): string | null {
    const pending = this.pending;
    this.pending = null;
    if (!pending || pending.page.isClosed()) return null;
    if (pending.reason === "closed") return `Active tab closed; switched to tab: ${pending.page.url()}`;
    return `Switched to new tab: ${pending.page.url()}`;
  }

  /** Forget every tab, the active pointer and any pending notice. */
  reset(): void {
    this.generation += 1;
    this.pages.clear();
    this.activePage = null;
    this.pending = null;
  }
}
