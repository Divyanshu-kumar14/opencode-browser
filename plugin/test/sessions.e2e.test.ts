/// <reference lib="dom" />
/**
 * One tab per session, in a real browser: sessions never share a tab, a popup
 * belongs to the session that opened it, and in an attached browser the user's
 * own tabs are never taken. Skips when Chromium cannot launch unless
 * OPENCODE_BROWSER_E2E=1.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { loadConfig } from "../src/config.ts";
import type { ToolResult } from "../src/core/turn.ts";
import {
  skipReason,
  startBrowser,
  startBugFixtureServer,
  type BrowserHandle,
  type FixtureServer,
} from "./harness.ts";

let server: FixtureServer | null = null;
let env: BrowserHandle | null = null;
let launchError: string | null = null;
let base = "";
const extra: (() => Promise<void>)[] = [];

beforeAll(async () => {
  server = startBugFixtureServer();
  base = server.url;
  try {
    env = await startBrowser();
  } catch (error) {
    launchError = error instanceof Error ? error.message : String(error);
  }
}, 60000);
afterAll(async () => {
  for (const close of extra) await close();
  await env?.close();
  server?.stop();
}, 60000);

function ready(): boolean {
  if (env) return true;
  console.warn(`SKIP: ${skipReason(launchError)}`);
  return false;
}
const text = (r: ToolResult): string => {
  const part = r.content.find((c) => c.type === "text");
  return part && part.type === "text" ? part.text : "";
};
const go = (sessionId: string, p: string) =>
  env!.session.turn({ kind: "navigate", action: "goto", url: base + p }, { sessionId });

describe("one tab per session", () => {
  test("two sessions get separate tabs and never act on each other's page", async () => {
    if (!ready()) return;
    await go("ses_a", "second");
    await go("ses_b", "popup");
    const a = env!.manager.tabs.active("ses_a")!;
    const b = env!.manager.tabs.active("ses_b")!;
    expect(a).not.toBe(b);
    expect(a.url()).toBe(base + "second");
    expect(b.url()).toBe(base + "popup");
    // Each session observes its own page.
    expect(text(await env!.session.turn({ kind: "observe" }, { sessionId: "ses_a" }))).toContain("URL: " + base + "second");
    expect(text(await env!.session.turn({ kind: "observe" }, { sessionId: "ses_b" }))).toContain("URL: " + base + "popup");
    expect(env!.manager.tabs.ownerOf(a)).toBe("ses_a");
    expect(env!.manager.tabs.ownerOf(b)).toBe("ses_b");
  }, 90000);

  test("a popup belongs to the session that opened it, and the other session is not told", async () => {
    if (!ready()) return;
    await go("ses_c", "popup");
    await go("ses_d", "second");
    const before = env!.manager.tabs.active("ses_d")!;
    const out = text(
      await env!.session.turn({ kind: "act", actions: [{ type: "click", selector: "#pop" }] }, { sessionId: "ses_c" }),
    );
    expect(out).toMatch(/Switched to new tab: http:\/\/127\.0\.0\.1:\d+\/second/);
    const popup = env!.manager.tabs.active("ses_c")!;
    expect(env!.manager.tabs.ownerOf(popup)).toBe("ses_c");
    expect(env!.manager.tabs.active("ses_d")).toBe(before);
    const other = text(await env!.session.turn({ kind: "observe" }, { sessionId: "ses_d" }));
    expect(other).not.toContain("Switched to new tab");
    expect(env!.manager.tabs.list("ses_d")).toHaveLength(1);
  }, 90000);

  test("closing one session's tab leaves the other's alone", async () => {
    if (!ready()) return;
    await go("ses_e", "second");
    await go("ses_f", "second");
    const e = env!.manager.tabs.active("ses_e")!;
    const f = env!.manager.tabs.active("ses_f")!;
    await e.close();
    expect(env!.manager.tabs.active("ses_e")).toBeNull();
    expect(env!.manager.tabs.active("ses_f")).toBe(f);
    // The closed session simply gets a fresh tab on its next turn.
    const next = text(await env!.session.turn({ kind: "observe" }, { sessionId: "ses_e" }));
    expect(next).toContain("URL: about:blank");
    expect(env!.manager.tabs.active("ses_e")).not.toBe(e);
  }, 90000);
});

describe("parallel sessions", () => {
  const slowEval = (sessionId: string, marker: string) =>
    env!.session.turn(
      {
        kind: "evaluate",
        expression: `new Promise((r) => { console.error(${JSON.stringify(marker)}); setTimeout(() => r(${JSON.stringify(marker)}), 1500); })`,
      },
      { sessionId },
    );

  test("two sessions' turns run at the same time, not one after the other", async () => {
    if (!ready()) return;
    await go("ses_p1", "second");
    await go("ses_p2", "second");
    const started = Date.now();
    const [a, b] = await Promise.all([slowEval("ses_p1", "from-p1"), slowEval("ses_p2", "from-p2")]);
    const elapsed = Date.now() - started;
    expect(text(a)).toContain('"from-p1"');
    expect(text(b)).toContain('"from-p2"');
    // Serialized, the two would take over 3 s.
    expect(elapsed).toBeLessThan(2800);
  }, 90000);

  test("one session's turns still never overlap", async () => {
    if (!ready()) return;
    await go("ses_p3", "second");
    const started = Date.now();
    await Promise.all([slowEval("ses_p3", "one"), slowEval("ses_p3", "two")]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
  }, 90000);

  test("each session sees only its own console errors", async () => {
    if (!ready()) return;
    await go("ses_p4", "second");
    await go("ses_p5", "second");
    const [a, b] = await Promise.all([slowEval("ses_p4", "error-only-in-p4"), slowEval("ses_p5", "error-only-in-p5")]);
    expect(text(a)).toContain("error-only-in-p4");
    expect(text(a)).not.toContain("error-only-in-p5");
    expect(text(b)).toContain("error-only-in-p5");
    expect(text(b)).not.toContain("error-only-in-p4");
  }, 90000);

  test("a popup opened during parallel turns goes to the session that clicked", async () => {
    if (!ready()) return;
    await go("ses_p6", "popup");
    await go("ses_p7", "second");
    const p7Before = env!.manager.tabs.active("ses_p7")!;
    const [clicked] = await Promise.all([
      env!.session.turn({ kind: "act", actions: [{ type: "click", selector: "#pop" }] }, { sessionId: "ses_p6" }),
      slowEval("ses_p7", "busy"),
    ]);
    expect(text(clicked)).toMatch(/Switched to new tab: http:\/\/127\.0\.0\.1:\d+\/second/);
    expect(env!.manager.tabs.ownerOf(env!.manager.tabs.active("ses_p6")!)).toBe("ses_p6");
    expect(env!.manager.tabs.active("ses_p7")).toBe(p7Before);
  }, 90000);
});

describe("browse_tabs", () => {
  const tabsTurn = (sessionId: string, request: Record<string, unknown>) =>
    env!.session.turn({ kind: "tabs", ...request } as never, { sessionId });

  test("list shows only the session's own tabs, marking the active one", async () => {
    if (!ready()) return;
    await go("ses_t1", "second");
    await go("ses_t2", "popup");
    const listed = text(await tabsTurn("ses_t1", { action: "list" }));
    expect(listed).toContain("## Tabs");
    expect(listed).toContain(base + "second");
    expect(listed).not.toContain(base + "popup");
    expect(listed).toMatch(/\* page-\d+ /);
  }, 90000);

  test("open makes a new tab for the session; switch and close move between its tabs", async () => {
    if (!ready()) return;
    await go("ses_t3", "second");
    const first = env!.manager.tabs.active("ses_t3")!;
    const opened = await tabsTurn("ses_t3", { action: "open", url: base + "popup" });
    expect(text(opened)).toContain("URL: " + base + "popup");
    const second = env!.manager.tabs.active("ses_t3")!;
    expect(second).not.toBe(first);
    expect(env!.manager.tabs.ownerOf(second)).toBe("ses_t3");

    const firstId = env!.manager.tabs.idOf(first);
    const back = await tabsTurn("ses_t3", { action: "switch", tabId: firstId });
    expect(text(back)).toContain("URL: " + base + "second");
    expect(env!.manager.tabs.active("ses_t3")).toBe(first);

    const closed = await tabsTurn("ses_t3", { action: "close", tabId: env!.manager.tabs.idOf(second) });
    expect(second.isClosed()).toBe(true);
    expect(text(closed)).toContain("URL: " + base + "second");
    expect(env!.manager.tabs.list("ses_t3")).toHaveLength(1);
  }, 90000);

  test("open checks the URL policy, and another session's tab cannot be switched to or closed", async () => {
    if (!ready()) return;
    await go("ses_t4", "second");
    await go("ses_t5", "second");
    const theirs = env!.manager.tabs.idOf(env!.manager.tabs.active("ses_t5")!);
    await expect(tabsTurn("ses_t4", { action: "open", url: "javascript:alert(1)" })).rejects.toThrow("not allowed");
    await expect(tabsTurn("ses_t4", { action: "switch", tabId: theirs })).rejects.toThrow("another session");
    await expect(tabsTurn("ses_t4", { action: "close", tabId: theirs })).rejects.toThrow("another session");
    expect(env!.manager.tabs.active("ses_t5")!.isClosed()).toBe(false);
  }, 90000);

  test("closing the last tab leaves the session a fresh blank one", async () => {
    if (!ready()) return;
    await go("ses_t6", "second");
    const only = env!.manager.tabs.active("ses_t6")!;
    const after = await tabsTurn("ses_t6", { action: "close" });
    expect(only.isClosed()).toBe(true);
    expect(text(after)).toContain("URL: about:blank");
  }, 90000);
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

describe("an attached browser", () => {
  test("the user's tabs are never taken: the session opens its own tab", async () => {
    if (!ready()) return;
    const port = await freePort();
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-user-"));
    let user: BrowserContext | null = null;
    try {
      user = await chromium.launchPersistentContext(userDir, {
        headless: true,
        executablePath: loadConfig().executablePath,
        args: [`--remote-debugging-port=${port}`, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
      });
      const mine = user.pages()[0] ?? (await user.newPage());
      await mine.goto(base + "second");
      const userTabs = () => user!.pages().filter((p) => !p.isClosed()).length;
      const tabsBefore = userTabs();

      const attached = await startBrowser({ cdpUrl: `http://127.0.0.1:${port}`, cdpAutoDetect: false });
      extra.push(() => attached.close());
      await attached.session.turn({ kind: "navigate", action: "goto", url: base + "popup" }, { sessionId: "ses_att" });

      expect(mine.url()).toBe(base + "second");
      const agentTab = attached.manager.tabs.active("ses_att")!;
      expect(agentTab.url()).toBe(base + "popup");
      expect(userTabs()).toBeGreaterThan(tabsBefore);
      // The user's tab is tracked but owned by no session.
      const theirs = attached.manager.tabs.list().find((t) => t.url === base + "second");
      expect(theirs).toBeDefined();
      expect(attached.manager.tabs.ownerOf(theirs!.page)).toBeNull();
    } finally {
      await user?.close().catch(() => undefined);
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  }, 120000);
});
