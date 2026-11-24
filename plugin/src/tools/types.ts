import type { BrowserSession } from "../core/browser-session.ts";

/** What every tool handler is given. One dependency, one seam. */
export interface ToolDeps {
  readonly session: BrowserSession;
}
