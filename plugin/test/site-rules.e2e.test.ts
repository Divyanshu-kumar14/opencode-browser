/// <reference lib="dom" />
/**
 * Site rules in a real browser: the fixture answers on 127.0.0.1 and on
 * localhost, two different sites. Skips when Chromium cannot launch unless
 * OPENCODE_BROWSER_E2E=1.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ToolResult } from "../src/core/turn.ts";
import {
  skipReason,
  startBrowser,
  startBugFixtureServer,
  type BrowserHandle,
  type FixtureServer,
} from "./harness.ts";

let server: FixtureServer | null = null;
let launchError: string | null = null;
let base = "";
let other = "";
const handles: BrowserHandle[] = [];

beforeAll(() => {
  server = startBugFixtureServer();
  base = server.url;
  other = base.replace("127.0.0.1", "localhost");
});
afterAll(async () => {
  for (const h of handles) await h.close();
  server?.stop();
}, 60000);

async function browser(rules: { allowOrigins?: string; denyOrigins?: string }): Promise<BrowserHandle | null> {
  try {
    const h = await startBrowser({ allowOrigins: rules.allowOrigins ?? "", denyOrigins: rules.denyOrigins ?? "" });
    handles.push(h);
    return h;
  } catch (error) {
    launchError = error instanceof Error ? error.message : String(error);
    console.warn(`SKIP: ${skipReason(launchError)}`);
    return null;
  }
}
const text = (r: ToolResult): string => {
  const part = r.content.find((c) => c.type === "text");
  return part && part.type === "text" ? part.text : "";
};

describe("site rules", () => {
  test("goto and tabs-open refuse a denied site before loading it", async () => {
    const b = await browser({ denyOrigins: "localhost" });
    if (!b) return;
    await expect(b.session.turn({ kind: "navigate", action: "goto", url: other + "second" })).rejects.toThrow(
      "blocked by OPENCODE_BROWSER_DENY_ORIGINS",
    );
    await expect(b.session.turn({ kind: "tabs", action: "open", url: other + "second" })).rejects.toThrow(
      "blocked by OPENCODE_BROWSER_DENY_ORIGINS",
    );
    // An allowed site still works.
    expect(text(await b.session.turn({ kind: "navigate", action: "goto", url: base + "second" }))).toContain("URL: " + base);
  }, 60000);

  test("a click that leaves for a denied site lands on a blocked page and is reported", async () => {
    const b = await browser({ denyOrigins: "localhost" });
    if (!b) return;
    await b.session.turn({ kind: "navigate", action: "goto", url: base + "second" });
    await b.manager.tabs.active()!.evaluate((href) => {
      document.body.insertAdjacentHTML("beforeend", `<a id=out href="${href}">Leave</a>`);
    }, other + "second");
    const r = await b.session.turn({ kind: "act", actions: [{ type: "click", selector: "#out" }] });
    const out = text(r);
    expect(out).toContain("Blocked: localhost is blocked by OPENCODE_BROWSER_DENY_ORIGINS");
    expect(out).not.toContain("Only link on second");
    const body = await b.manager.tabs.active()!.evaluate(() => document.body.innerText);
    expect(body).toContain("Blocked by the OpenCode browser site rules");
  }, 60000);

  test("with an allow list, any other site is blocked, popups included", async () => {
    const b = await browser({ allowOrigins: "127.0.0.1" });
    if (!b) return;
    await b.session.turn({ kind: "navigate", action: "goto", url: base + "second" });
    await b.manager.tabs.active()!.evaluate((href) => {
      document.body.insertAdjacentHTML("beforeend", `<button id=pop onclick="window.open('${href}')">Pop</button>`);
    }, other + "second");
    const r = await b.session.turn({ kind: "act", actions: [{ type: "click", selector: "#pop" }] });
    const popup = b.manager.tabs.active()!;
    await popup.waitForFunction(() => document.body?.innerText.includes("Blocked by"), undefined, { timeout: 5000 });
    expect(await popup.evaluate(() => document.body.innerText)).not.toContain("Only link on second");
    const later = text(r) + text(await b.session.turn({ kind: "observe" }));
    expect(later).toContain("localhost is not in OPENCODE_BROWSER_ALLOW_ORIGINS");
  }, 60000);

  test("a tab no session owns (the user's) is never filtered", async () => {
    const b = await browser({ denyOrigins: "localhost" });
    if (!b) return;
    await b.session.turn({ kind: "navigate", action: "goto", url: base + "second" });
    const users = await b.manager.tabs.active()!.context().newPage();
    await users.goto(other + "second");
    const body = await users.evaluate(() => document.body.innerText);
    expect(body).toContain("Only link on second");
    expect(body).not.toContain("Blocked by");
    await users.close();
  }, 60000);

  test("subresources from a denied host are not blocked, only page loads", async () => {
    const b = await browser({ denyOrigins: "localhost" });
    if (!b) return;
    await b.session.turn({ kind: "navigate", action: "goto", url: base + "second" });
    const status = await b.manager.tabs.active()!.evaluate(async (href) => (await fetch(href, { mode: "no-cors" })).type, other + "second");
    expect(status).toBe("opaque");
  }, 60000);
});
