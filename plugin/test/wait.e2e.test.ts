/// <reference lib="dom" />
/**
 * waitFor in a real Chromium page. Skips when Chromium cannot launch unless
 * OPENCODE_BROWSER_E2E=1.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { InvalidInputError } from "../src/core/errors.ts";
import { waitFor } from "../src/core/wait.ts";
import { loadConfig } from "../src/config.ts";
import { skipReason } from "./harness.ts";

let browser: Browser | null = null;
let launchError: string | null = null;

beforeAll(async () => {
  try {
    browser = await chromium.launch({
      executablePath: loadConfig().executablePath,
      args: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
    });
  } catch (error) {
    launchError = error instanceof Error ? error.message : String(error);
  }
}, 60000);
afterAll(async () => void (await browser?.close()), 30000);

function ready(): boolean {
  if (browser) return true;
  console.warn(`SKIP: ${skipReason(launchError)}`);
  return false;
}

async function pageWith(script: string): Promise<Page> {
  const page = await browser!.newPage();
  const html = `<body><div id=out>start</div><script>${script}</script></body>`;
  await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(html));
  return page;
}

describe("waitFor", () => {
  test("text appears after a delay", async () => {
    if (!ready()) return;
    const page = await pageWith("setTimeout(() => document.getElementById('out').textContent = 'Results loaded', 300)");
    const result = await waitFor(page, { text: "Results loaded" }, 5000);
    expect(result.ok).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(250);
    expect(result.summary).toContain("Results loaded");
    await page.close();
  });

  test("text disappears", async () => {
    if (!ready()) return;
    const page = await pageWith("setTimeout(() => document.getElementById('out').textContent = 'done', 300)");
    const result = await waitFor(page, { textGone: "start" }, 5000);
    expect(result.ok).toBe(true);
    await page.close();
  });

  test("a selector becomes visible", async () => {
    if (!ready()) return;
    const page = await pageWith(
      "const b = document.createElement('button'); b.id = 'late'; b.textContent = 'Late'; b.style.display = 'none'; document.body.append(b); setTimeout(() => b.style.display = 'block', 300)",
    );
    const result = await waitFor(page, { selector: "#late" }, 5000);
    expect(result.ok).toBe(true);
    await page.close();
  });

  test("the URL changes", async () => {
    if (!ready()) return;
    const page = await browser!.newPage();
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<title>x</title>" }));
    await page.goto("http://example.test/start");
    await page.evaluate("setTimeout(() => history.pushState({}, '', '/results?q=1'), 300)");
    const result = await waitFor(page, { urlContains: "/results" }, 5000);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("/results");
    await page.close();
  });

  test("a plain delay waits that long", async () => {
    if (!ready()) return;
    const page = await pageWith("");
    const result = await waitFor(page, { ms: 400 }, 5000);
    expect(result.ok).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(380);
    await page.close();
  });

  test("a condition that never holds times out with a readable summary, not an error", async () => {
    if (!ready()) return;
    const page = await pageWith("");
    const result = await waitFor(page, { text: "never appears" }, 600);
    expect(result.ok).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(550);
    expect(result.waitedMs).toBeLessThan(2500);
    expect(result.summary).toContain("Timed out");
    expect(result.summary).toContain("never appears");
    await page.close();
  });

  test("every condition must hold; the first failure names the one that did not", async () => {
    if (!ready()) return;
    const page = await pageWith("setTimeout(() => document.getElementById('out').textContent = 'ready', 100)");
    const ok = await waitFor(page, { text: "ready", textGone: "start" }, 3000);
    expect(ok.ok).toBe(true);
    const bad = await waitFor(page, { text: "ready", selector: "#missing" }, 500);
    expect(bad.ok).toBe(false);
    expect(bad.summary).toContain("#missing");
    await page.close();
  });

  test("an invalid selector is rejected up front as invalid input", async () => {
    if (!ready()) return;
    const page = await pageWith("");
    await expect(waitFor(page, { selector: "div[" }, 500)).rejects.toBeInstanceOf(InvalidInputError);
    await page.close();
  });

  test("the timeout is shared across conditions, not applied to each", async () => {
    if (!ready()) return;
    const page = await pageWith("");
    const started = Date.now();
    const result = await waitFor(page, { text: "nope", textGone: "also never", selector: "#nope" }, 700);
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    await page.close();
  });
});
