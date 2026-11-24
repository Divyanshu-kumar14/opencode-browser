/**
 * In-memory `BrowserSession` adapter.
 *
 * Tool handlers and the registry are tested through the same interface the
 * Playwright adapter implements; no browser, no page, no Playwright.
 */

import type { BrowserSession } from "../src/core/browser-session.ts";
import type { ToolResult, TurnRequest } from "../src/core/turn.ts";

const DEFAULT_RESULT: ToolResult = {
  content: [{ type: "text", text: "ok" }],
  metadata: {},
};

export class FakeBrowserSession implements BrowserSession {
  readonly requests: TurnRequest[] = [];
  private result: ToolResult = DEFAULT_RESULT;
  private failure: Error | null = null;

  respond(result: ToolResult): this {
    this.result = result;
    return this;
  }

  fail(error: Error): this {
    this.failure = error;
    return this;
  }

  async turn(request: TurnRequest): Promise<ToolResult> {
    this.requests.push(request);
    if (this.failure) throw this.failure;
    return this.result;
  }
}
