/**
 * E2E: perception-action engine against a local fixture page + real Chromium.
 *
 * Fixture contains: email input, submit button, ARIA combobox, a button
 * occluded behind a modal, and a button that fires console.error +
 * fetch("/api/missing") (404).
 *
 * Verifies:
 *   1. browse_navigate indexes visible interactive elements and skips the occluded one
 *   2. browse_interact batches type + click via elementId alone
 *   3. telemetry delta captures the console.error and the failed (404) fetch
 *   4. annotated screenshot is written and the SoM overlay is removed afterwards
 *
 * Requires system Chromium (OPENCODE_BROWSER_EXECUTABLE_PATH or autodetect).
 * Skips when Chromium cannot launch, unless OPENCODE_BROWSER_E2E=1, in which
 * case the launch failure fails the suite.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import type { BrowserSessionManager } from "../src/core/session-manager.ts";
import type { PlaywrightBrowserSession } from "../src/core/browser-session.ts";
import { execute as navigateExec } from "../src/tools/navigate.ts";
import { execute as interactExec, schema as interactSchema } from "../src/tools/interact.ts";
import { execute as snapshotExec } from "../src/tools/snapshot.ts";
import { execute as inspectExec } from "../src/tools/inspect.ts";
import { execute as viewportExec } from "../src/tools/viewport.ts";
import { execute as evalExec } from "../src/tools/evaluate.ts";
import {
  startBrowser,
  startFixtureServer,
  skipReason,
  type BrowserHandle,
  type FixtureServer,
} from "./harness.ts";

let server: FixtureServer | null = null;
let env: BrowserHandle | null = null;
let baseUrl = "";
let manager: BrowserSessionManager | null = null;
let session: PlaywrightBrowserSession | null = null;
let launchError: string | null = null;

interface SomEl {
  id: number;
  tag: string;
  role: string;
  label: string;
}

async function somElements(): Promise<SomEl[]> {
  const page = manager!.getActivePage()!;
  return (await page.evaluate(() => {
    const w = globalThis as unknown as Record<string, any>;
    const s = w["__opencodeSom"];
    if (!s) return [];
    return s.getElements();
  })) as SomEl[];
}

function firstContent(result: { content: unknown }): string {
  const c = result.content as Array<{ type: string; text?: string }>;
  return c.find((e) => e.type === "text")?.text ?? "";
}

/** Skip when allowed, fail when OPENCODE_BROWSER_E2E=1. */
function browserReady(): boolean {
  if (manager && session) return true;
  console.warn(`SKIP: ${skipReason(launchError)}`);
  return false;
}

// Launching real Chromium can exceed bun's default 5 s hook timeout on a
// cold CI runner; give it a generous budget instead of failing the suite.
beforeAll(
  async () => {
    server = startFixtureServer();
    baseUrl = server.url;
    try {
      env = await startBrowser();
      manager = env.manager;
      session = env.session;
    } catch (error) {
      launchError = error instanceof Error ? error.message : String(error);
      manager = null;
      session = null;
    }
  },
  { timeout: 60_000 },
);

afterAll(async () => {
  await env?.close();
  server?.stop();
});

describe("perception-action engine e2e", () => {
  test("navigate indexes visible elements, skips the occluded button", async () => {
    if (!browserReady()) return;
    const res = await navigateExec(
      { action: "goto", url: baseUrl },
      { session: session! },
    );
    const text = firstContent(res);
    expect(text).toContain("Sign In");
    expect(text).toContain("Select Environment");
    expect(text).not.toContain("Covered button");
    // The settle result is real, not a hardcoded `settled: true`.
    expect(text).toContain("Settled: yes");

    const els = await somElements();
    const labels = els.map((e) => e.label);
    expect(labels.some((l) => l.includes("Sign In"))).toBe(true);
    expect(labels.some((l) => l.includes("Select Environment"))).toBe(true);
    expect(labels.some((l) => l.includes("Covered button"))).toBe(false);
    // sequential [1..N]
    const ids = els.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids[0]).toBe(1);
  });

  test("interact batches type + click by elementId", async () => {
    if (!browserReady()) return;
    const els = await somElements();
    const email = els.find((e) => e.tag === "input");
    const submit = els.find((e) => e.label.includes("Sign In"));
    expect(email).toBeDefined();
    expect(submit).toBeDefined();
    const res = await interactExec(
      {
        actions: [
          { type: "clear_and_type", elementId: email!.id, text: "agent@work.com", pressEnter: false },
          { type: "click", elementId: submit!.id, pressEnter: false },
        ],
      },
      { session: session! },
    );
    expect(res.metadata?.["stoppedAt"]).toBeNull();
    const page = manager!.getActivePage()!;
    const value = await page.evaluate(() => {
      const g = globalThis as unknown as Record<string, any>;
      const doc = g["document"];
      return (doc.getElementById("email") as { value: string }).value;
    });
    expect(value).toBe("agent@work.com");
  });

  test("interact drag completes a real mouse drag", async () => {
    if (!browserReady()) return;
    // Batch form intentionally: per-action zod validation used to strip
    // toX/toY, silently breaking drag inside `actions[]`.
    const parsed = interactSchema.parse({
      actions: [{ type: "drag", x: 60, y: 120, toX: 260, toY: 220 }],
    });
    const first = parsed.actions?.[0];
    expect(first?.toX).toBe(260);
    expect(first?.toY).toBe(220);
    const res = await interactExec(
      { actions: [{ type: "drag", x: 60, y: 120, toX: 260, toY: 220, pressEnter: false }] },
      { session: session! },
    );
    expect(res.metadata?.["stoppedAt"]).toBeNull();
  });

  test("telemetry delta captures console.error + failed fetch", async () => {
    if (!browserReady()) return;
    const els = await somElements();
    const boom = els.find((e) => e.label.includes("Trigger error"));
    expect(boom).toBeDefined();
    // drain anything pending so this turn's delta is exactly the boom click
    await snapshotExec({ annotate: true, fullPage: false }, { session: session! });
    const res = await interactExec(
      { type: "click", elementId: boom!.id, pressEnter: false },
      { session: session! },
    );
    const text = firstContent(res);
    expect(text).toContain("Test runtime error");
    expect(text).toContain("404");
  });

  test("screenshot is written and the SoM overlay is removed", async () => {
    if (!browserReady()) return;
    const res = await snapshotExec(
      { annotate: true, fullPage: false },
      { session: session! },
    );
    const shot = res.metadata?.["screenshotPath"] as string | null;
    expect(shot).toBeTruthy();
    expect(fs.existsSync(shot!)).toBe(true);
    expect(fs.statSync(shot!).size).toBeGreaterThan(1000);
    const page = manager!.getActivePage()!;
    const overlay = await page.evaluate(() => {
      const g = globalThis as unknown as Record<string, any>;
      return !!g["document"].getElementById("opencode-som-overlay");
    });
    expect(overlay).toBe(false);
  });

  test("plain snapshot still writes a screenshot", async () => {
    if (!browserReady()) return;
    const res = await snapshotExec(
      { annotate: false, fullPage: false },
      { session: session! },
    );
    const shot = res.metadata?.["screenshotPath"] as string | null;
    expect(shot).toBeTruthy();
    expect(fs.existsSync(shot!)).toBe(true);
  });

  test("viewport + inspect + eval round-trip", async () => {
    if (!browserReady()) return;
    const vres = await viewportExec(
      { preset: "mobile" },
      { session: session! },
    );
    expect(vres.metadata?.["viewport"]).toMatchObject({ width: 390, height: 844 });

    const els = await somElements();
    const email = els.find((e) => e.tag === "input");
    expect(email).toBeDefined();
    const ires = await inspectExec(
      { elementId: email!.id },
      { session: session! },
    );
    expect(firstContent(ires)).toContain("bbox:");
    const inspectShot = ires.metadata?.["screenshotPath"] as string | null;
    expect(inspectShot).toBeTruthy();

    const eres = await evalExec(
      { expression: "document.title" },
      { session: session!, permission: { assert: async () => undefined } },
      { sessionID: "ses_e2e", messageID: "msg_e2e", id: "call_e2e" },
    );
    expect(firstContent(eres)).toContain("Fixture");
    // Regression: eval used to write an orphan screenshot and drop it.
    const evalShot = eres.metadata?.["screenshotPath"] as string | null;
    expect(evalShot).toBeTruthy();
    expect(fs.existsSync(evalShot!)).toBe(true);
    expect(eres.content).toHaveLength(2);
    expect(eres.content[1]).toMatchObject({ type: "file", mime: "image/png" });
  });

  test("settle waits for a request started by the click", async () => {
    if (!browserReady()) return;
    // Drain anything pending so this turn's delta is exactly the slow fetch.
    await snapshotExec({ annotate: false, fullPage: false }, { session: session! });
    const els = await somElements();
    const slow = els.find((e) => e.label.includes("Trigger slow error"));
    expect(slow).toBeDefined();
    const res = await interactExec(
      { type: "click", elementId: slow!.id, pressEnter: false },
      { session: session! },
    );
    const text = firstContent(res);
    expect(text).toContain("Settled: yes");
    expect(text).toContain("[HTTP 404]");
  });

  test("tab switch is reported with the loaded URL", async () => {
    if (!browserReady()) return;
    const els = await somElements();
    const popup = els.find((e) => e.label.includes("Open popup"));
    expect(popup).toBeDefined();
    try {
      const res = await interactExec(
        { type: "click", elementId: popup!.id, pressEnter: false },
        { session: session! },
      );
      const text = firstContent(res);
      expect(text).toContain("Switched to new tab");
      expect(text).toContain("/second");
      expect(text).not.toContain("Switched to new tab: about:blank");
    } finally {
      // Close the popup and let the manager re-point to the fixture tab.
      const active = manager!.getActivePage();
      if (active && active.url().includes("/second")) await active.close();
    }
  });
});
