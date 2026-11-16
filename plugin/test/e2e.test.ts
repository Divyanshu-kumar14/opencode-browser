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
 * Skipped gracefully when Chromium cannot launch.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrowserSessionManager } from "../src/core/session-manager.ts";
import { execute as navigateExec } from "../src/tools/navigate.ts";
import { execute as interactExec, schema as interactSchema } from "../src/tools/interact.ts";
import { execute as snapshotExec } from "../src/tools/snapshot.ts";
import { execute as inspectExec } from "../src/tools/inspect.ts";
import { execute as viewportExec } from "../src/tools/viewport.ts";
import { execute as evalExec } from "../src/tools/evaluate.ts";

const FIXTURE = `<!doctype html><html><head><title>Fixture</title>
<style>
#modal{position:fixed;left:32px;top:292px;width:220px;height:64px;z-index:9999;background:rgba(0,0,0,.5);}
#occluded{position:fixed;left:40px;top:300px;z-index:1;}
button,input,[role=combobox]{font-size:16px;margin:8px;}
</style></head><body>
<h1>Hello fixture</h1>
<input id="email" type="email" placeholder="name@work.com">
<button id="submit">Sign In</button>
<div id="env" role="combobox" aria-label="Select Environment" tabindex="0">Production</div>
<button id="occluded">Covered button</button>
<div id="modal"></div>
<button id="boom">Trigger error</button>
<script>
document.getElementById("boom").addEventListener("click", () => {
  console.error("Test runtime error");
  fetch("/api/missing").catch(() => {});
});
</script>
</body></html>`;

let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl = "";
let manager: BrowserSessionManager | null = null;
let shotDir = "";
let profileDir = "";
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

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/missing") {
        return new Response("nope", { status: 404 });
      }
      return new Response(FIXTURE, { headers: { "content-type": "text/html" } });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}/`;

  shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-shots-"));
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-prof-"));
  manager = new BrowserSessionManager({
    headless: true,
    profileDir,
    screenshotDir: shotDir,
  } as never);
  try {
    await manager.ensureActivePage();
  } catch (e) {
    launchError = e instanceof Error ? e.message : String(e);
    manager = null;
  }
});

afterAll(async () => {
  await manager?.close().catch(() => undefined);
  server?.stop(true);
  fs.rmSync(shotDir, { recursive: true, force: true });
  fs.rmSync(profileDir, { recursive: true, force: true });
});

describe("perception-action engine e2e", () => {
  test("navigate indexes visible elements, skips the occluded button", async () => {
    if (!manager) {
      console.warn(`SKIP: chromium did not launch: ${launchError}`);
      return;
    }
    const res = await navigateExec(
      { action: "goto", url: baseUrl },
      { sessionManager: manager, screenshotDir: shotDir },
    );
    const text = firstContent(res);
    expect(text).toContain("Sign In");
    expect(text).toContain("Select Environment");
    expect(text).not.toContain("Covered button");

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
    if (!manager) {
      console.warn(`SKIP: chromium did not launch: ${launchError}`);
      return;
    }
    const els = await somElements();
    const email = els.find((e) => e.tag === "input");
    const submit = els.find((e) => e.label.includes("Sign In"));
    expect(email).toBeDefined();
    expect(submit).toBeDefined();
    const res = await interactExec(
      {
        actions: [
          { type: "clear_and_type", elementId: email!.id, text: "agent@work.com" },
          { type: "click", elementId: submit!.id },
        ],
      },
      { sessionManager: manager, screenshotDir: shotDir },
    );
    expect(res.metadata?.["stoppedAt"]).toBeNull();
    const page = manager.getActivePage()!;
    const value = await page.evaluate(() => {
      const g = globalThis as unknown as Record<string, any>;
      const doc = g["document"];
      return (doc.getElementById("email") as { value: string }).value;
    });
    expect(value).toBe("agent@work.com");
  });

  test("interact drag completes a real mouse drag", async () => {
    if (!manager) {
      console.warn(`SKIP: chromium did not launch: ${launchError}`);
      return;
    }
    // Batch form intentionally: per-action zod validation used to strip
    // toX/toY, silently breaking drag inside `actions[]`.
    const parsed = interactSchema.parse({
      actions: [{ type: "drag", x: 60, y: 120, toX: 260, toY: 220 }],
    });
    const first = parsed.actions?.[0];
    expect(first?.toX).toBe(260);
    expect(first?.toY).toBe(220);
    const res = await interactExec(
      { actions: [{ type: "drag", x: 60, y: 120, toX: 260, toY: 220 }] },
      { sessionManager: manager, screenshotDir: shotDir },
    );
    expect(res.metadata?.["stoppedAt"]).toBeNull();
  });

  test("telemetry delta captures console.error + failed fetch", async () => {
    if (!manager) {
      console.warn(`SKIP: chromium did not launch: ${launchError}`);
      return;
    }
    const els = await somElements();
    const boom = els.find((e) => e.label.includes("Trigger error"));
    expect(boom).toBeDefined();
    // drain anything pending so this turn's delta is exactly the boom click
    await snapshotExec({}, { sessionManager: manager, screenshotDir: shotDir });
    const res = await interactExec(
      { type: "click", elementId: boom!.id },
      { sessionManager: manager, screenshotDir: shotDir },
    );
    const text = firstContent(res);
    expect(text).toContain("Test runtime error");
    expect(text).toContain("404");
  });

  test("screenshot is written and the SoM overlay is removed", async () => {
    if (!manager) {
      console.warn(`SKIP: chromium did not launch: ${launchError}`);
      return;
    }
    const res = await snapshotExec(
      { annotate: true },
      { sessionManager: manager, screenshotDir: shotDir },
    );
    const shot = res.metadata?.["screenshotPath"] as string | null;
    expect(shot).toBeTruthy();
    expect(fs.existsSync(shot!)).toBe(true);
    expect(fs.statSync(shot!).size).toBeGreaterThan(1000);
    const page = manager.getActivePage()!;
    const overlay = await page.evaluate(() => {
      const g = globalThis as unknown as Record<string, any>;
      return !!g["document"].getElementById("opencode-som-overlay");
    });
    expect(overlay).toBe(false);
  });

  test("plain snapshot still writes a screenshot", async () => {
    if (!manager) {
      console.warn(`SKIP: chromium did not launch: ${launchError}`);
      return;
    }
    const res = await snapshotExec(
      { annotate: false },
      { sessionManager: manager, screenshotDir: shotDir },
    );
    const shot = res.metadata?.["screenshotPath"] as string | null;
    expect(shot).toBeTruthy();
    expect(fs.existsSync(shot!)).toBe(true);
  });

  test("viewport + inspect + eval round-trip", async () => {
    if (!manager) {
      console.warn(`SKIP: chromium did not launch: ${launchError}`);
      return;
    }
    const vres = await viewportExec(
      { preset: "mobile" },
      { sessionManager: manager, screenshotDir: shotDir },
    );
    expect(vres.metadata?.["viewport"]).toMatchObject({ width: 390, height: 844 });

    const els = await somElements();
    const email = els.find((e) => e.tag === "input");
    expect(email).toBeDefined();
    const ires = await inspectExec(
      { elementId: email!.id },
      { sessionManager: manager, screenshotDir: shotDir },
    );
    expect(firstContent(ires)).toContain("bbox:");

    const eres = await evalExec(
      { expression: "document.title" },
      { sessionManager: manager, screenshotDir: shotDir },
    );
    expect(firstContent(eres)).toContain("Fixture");
  });
});
