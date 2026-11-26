/// <reference lib="dom" />
/**
 * The HUD page object in a real Chromium page: presence, Stop button, layout.
 * Skips when Chromium cannot launch unless OPENCODE_BROWSER_E2E=1.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { hud, pageScripts } from "../src/core/page-agent.ts";
import { PAGE_GLOBALS } from "../src/core/som.ts";
import { loadConfig } from "../src/config.ts";
import { skipReason } from "./harness.ts";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let launchError: string | null = null;
let stops = 0;

beforeAll(async () => {
  try {
    browser = await chromium.launch({
      executablePath: loadConfig().executablePath,
      args: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
    });
    context = await browser.newContext({ viewport: { width: 900, height: 600 } });
    // Same order as the manager: the Stop binding first, then the page scripts.
    await context.exposeBinding(PAGE_GLOBALS.stop, () => {
      stops += 1;
    });
    for (const script of pageScripts(100)) await context.addInitScript(script);
  } catch (error) {
    launchError = error instanceof Error ? error.message : String(error);
    browser = null;
  }
}, 60000);

afterAll(async () => {
  await browser?.close();
}, 30000);

function ready(): boolean {
  if (browser) return true;
  console.warn(`SKIP: ${skipReason(launchError)}`);
  return false;
}

async function freshPage(html = "<button id=target style='position:fixed;left:40px;top:40px'>Target</button>"): Promise<Page> {
  const page = await context!.newPage();
  // A real navigation, so the init scripts run as they do in production.
  await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(html));
  stops = 0;
  return page;
}

const visibility = (page: Page) =>
  page.evaluate(() => (document.querySelector("opencode-agent-hud") as HTMLElement).style.visibility);

const stopCenter = (page: Page) =>
  page.evaluate(() => {
    const r = document.querySelector("opencode-agent-hud")!.shadowRoot!.querySelector(".stop")!.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

describe("HUD page object", () => {
  test("a tab the agent is not using shows nothing", async () => {
    if (!ready()) return;
    const page = await freshPage();
    expect(await visibility(page)).toBe("hidden");
    // Status and cursor calls on an unpresented tab stay invisible.
    await hud.status(page, "Acting on [1]");
    await hud.cursor(page, 100, 100);
    expect(await visibility(page)).toBe("hidden");
    await page.close();
  });

  test("presence shows the HUD; a clean frame hides it and restores the presence state", async () => {
    if (!ready()) return;
    const page = await freshPage();
    await hud.present(page, true);
    expect(await visibility(page)).toBe("visible");
    await page.evaluate((n) => (window as any)[n].hide(), PAGE_GLOBALS.hud);
    expect(await visibility(page)).toBe("hidden");
    await page.evaluate((n) => (window as any)[n].show(), PAGE_GLOBALS.hud);
    expect(await visibility(page)).toBe("visible");
    await hud.present(page, false);
    await page.evaluate((n) => (window as any)[n].show(), PAGE_GLOBALS.hud);
    expect(await visibility(page)).toBe("hidden");
    await page.close();
  });

  test("the status pill sits at the bottom centre, clear of the Stop button", async () => {
    if (!ready()) return;
    const page = await freshPage();
    await hud.present(page, true);
    await hud.status(page, "Thinking…");
    const rects = await page.evaluate(() => {
      const root = document.querySelector("opencode-agent-hud")!.shadowRoot!;
      const box = (sel: string) => {
        const r = root.querySelector(sel)!.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      return { pill: box(".pill"), stop: box(".stop"), width: innerWidth, height: innerHeight };
    });
    expect(Math.abs((rects.pill.left + rects.pill.right) / 2 - rects.width / 2)).toBeLessThan(2);
    expect(rects.pill.right).toBeLessThan(rects.stop.left);
    expect(rects.stop.right).toBeGreaterThan(rects.width - 40);
    expect(rects.stop.bottom).toBeGreaterThan(rects.height - 40);
    await page.close();
  });

  test("a real click on Stop calls the host once", async () => {
    if (!ready()) return;
    const page = await freshPage();
    await hud.present(page, true);
    const { x, y } = await stopCenter(page);
    await page.mouse.click(x, y);
    await page.waitForTimeout(100);
    expect(stops).toBe(1);
    await page.close();
  });

  test("a page script cannot press Stop or reach the binding", async () => {
    if (!ready()) return;
    const page = await freshPage();
    await hud.present(page, true);
    const result = await page.evaluate((stopName) => {
      const button = document.querySelector("opencode-agent-hud")!.shadowRoot!.querySelector(".stop") as HTMLElement;
      button.click();
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
      return typeof (window as any)[stopName];
    }, PAGE_GLOBALS.stop);
    await page.waitForTimeout(100);
    expect(result).toBe("undefined");
    expect(stops).toBe(0);
    await page.close();
  });

  test("the user is never blocked: the page under the HUD stays clickable", async () => {
    if (!ready()) return;
    const page = await freshPage(
      "<button id=target style='position:fixed;left:40px;top:40px' onclick='document.title=\"clicked\"'>Target</button>" +
        "<button id=bottom style='position:fixed;left:50%;bottom:24px' onclick='document.title=\"bottom\"'>Bottom</button>",
    );
    await hud.present(page, true);
    await hud.status(page, "Acting on [1]");
    await page.click("#target", { timeout: 2000 });
    expect(await page.title()).toBe("clicked");
    // The pill sits over this button but takes no pointer events.
    await page.click("#bottom", { timeout: 2000 });
    expect(await page.title()).toBe("bottom");
    await page.close();
  });

  test("the Stop button steps aside when the agent acts beneath it, and back again", async () => {
    if (!ready()) return;
    const page = await freshPage(
      "<button id=corner style='position:fixed;right:24px;bottom:24px;width:40px;height:40px' onclick='document.title=\"corner\"'>C</button>",
    );
    await hud.present(page, true);
    const { x, y } = await stopCenter(page);
    // The agent is about to act at the corner button.
    await hud.cursor(page, x, y);
    const moved = await stopCenter(page);
    expect(moved.x).toBeLessThan(100);
    await page.click("#corner", { timeout: 2000 });
    expect(await page.title()).toBe("corner");
    // Acting near the left corner sends it back.
    await hud.cursor(page, moved.x, moved.y);
    expect((await stopCenter(page)).x).toBeGreaterThan(800);
    await page.close();
  });

  test("the HUD survives a navigation in place and in a new document", async () => {
    if (!ready()) return;
    const page = await freshPage();
    await hud.present(page, true);
    await page.goto("data:text/html,<h1>next</h1>");
    // A new document has a fresh, unpresented HUD until the host re-presents it.
    expect(await visibility(page)).toBe("hidden");
    await hud.present(page, true);
    expect(await visibility(page)).toBe("visible");
    await page.close();
  });
});
