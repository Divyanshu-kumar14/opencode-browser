/**
 * Enforces the site rules on the agent's own tabs: every page load (main frame
 * and frames) whose host is not allowed is answered with a small "blocked"
 * page instead, and reported to the tab's next turn. Subresources are not
 * filtered. A tab no session owns (the user's) is never touched.
 *
 * Interception only happens when a rule is set: routing disables the HTTP
 * cache for the routed tab.
 */

import type { Page, Route } from "playwright";
import { blockedReason, type SiteRules } from "./site-rules.ts";

export class SiteGuard {
  private readonly guarded = new WeakSet<object>();
  private readonly notices = new WeakMap<object, string[]>();

  constructor(private readonly rules: SiteRules) {}

  get active(): boolean {
    return this.rules.active;
  }

  /** Why `url` may not be loaded, or null. */
  reasonFor(url: string): string | null {
    return blockedReason(url, this.rules);
  }

  /** Start filtering `page`'s loads. A page already on a blocked site is reloaded through the filter. */
  async guard(page: Page): Promise<void> {
    if (!this.rules.active || this.guarded.has(page) || page.isClosed()) return;
    this.guarded.add(page);
    await page.route("**/*", (route) => this.handle(page, route)).catch(() => undefined);
    // A popup may have started loading before it was handed to its session.
    if (this.reasonFor(page.url()) !== null) {
      await page.goto(page.url(), { waitUntil: "commit", timeout: 10_000 }).catch(() => undefined);
    }
  }

  /** Reports for the loads blocked since the last call. */
  take(page: object): string[] {
    const out = this.notices.get(page) ?? [];
    this.notices.delete(page);
    return out;
  }

  private async handle(page: object, route: Route): Promise<void> {
    const request = route.request();
    if (!request.isNavigationRequest()) {
      await route.fallback().catch(() => undefined);
      return;
    }
    const reason = this.reasonFor(request.url());
    if (reason === null) {
      await route.fallback().catch(() => undefined);
      return;
    }
    const list = this.notices.get(page) ?? [];
    list.push(reason);
    this.notices.set(page, list);
    await route
      .fulfill({ status: 403, contentType: "text/html; charset=utf-8", body: blockedPage(reason) })
      .catch(() => undefined);
  }
}

function blockedPage(reason: string): string {
  const safe = reason.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return (
    "<!doctype html><title>Blocked</title>" +
    "<body style='font:15px system-ui;padding:48px;color:#1f2937'>" +
    "<h1 style='font-size:20px'>Blocked by the OpenCode browser site rules</h1>" +
    `<p>${safe}</p></body>`
  );
}
