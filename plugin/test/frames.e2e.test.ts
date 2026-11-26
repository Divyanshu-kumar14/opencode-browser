/// <reference lib="dom" />
/**
 * Iframes: same-origin frames are indexed and actable by id; cross-origin
 * frames are listed by origin without their contents. Skips when Chromium
 * cannot launch unless OPENCODE_BROWSER_E2E=1.
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
let env: BrowserHandle | null = null;
let launchError: string | null = null;
let base = "";

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
const page = () => env!.manager.tabs.active()!;
const line = (out: string, label: string) => out.split("\n").find((l) => l.includes(`"${label}"`));
const idOf = (l: string | undefined) => Number(l?.match(/^\[(\d+)\]/)?.[1]);

/** A page with a same-origin frame (and a nested one) and a cross-origin frame. */
async function framedPage(): Promise<string> {
  await env!.session.turn({ kind: "navigate", action: "goto", url: base + "second" });
  const crossOrigin = base.replace("127.0.0.1", "localhost") + "second";
  // No double quotes: this markup is nested inside two srcdoc attributes.
  const inner = "<button>Nested button</button>";
  const frame =
    "<style>body{margin:0}</style>" +
    "<button id=pay onclick=\"top.document.title='frame-clicked'\">Pay now</button>" +
    "<input id=name placeholder='Card holder'>" +
    "<input type=password value='hunter2-in-frame'>" +
    "<div style='height:2000px'></div><button>Below the frame fold</button>" +
    `<iframe srcdoc="${inner}" style="width:300px;height:80px"></iframe>`;
  await page().evaluate(
    ({ frame, crossOrigin }) => {
      document.body.innerHTML =
        "<h1>Checkout</h1>" +
        `<iframe id=same srcdoc="${frame.replace(/"/g, "&quot;")}" style="width:500px;height:260px;border:4px solid #000"></iframe>` +
        `<iframe id=cross src="${crossOrigin}" style="width:300px;height:120px"></iframe>`;
    },
    { frame, crossOrigin },
  );
  await page().waitForFunction(() => {
    const same = document.getElementById("same") as HTMLIFrameElement | null;
    return same?.contentDocument?.getElementById("pay") !== null && same?.contentDocument?.readyState === "complete";
  });
  await page().waitForTimeout(300);
  return text(await env!.session.turn({ kind: "observe" }));
}

describe("iframes", () => {
  test("same-origin frame controls are in the element map, marked as in a frame", async () => {
    if (!ready()) return;
    const out = await framedPage();
    const pay = line(out, "Pay now");
    expect(pay).toBeDefined();
    expect(pay).toContain("(in frame)");
    expect(line(out, "Card holder")).toBeDefined();
  }, 60000);

  test("a nested same-origin frame is indexed too", async () => {
    if (!ready()) return;
    const out = await framedPage();
    // The nested frame sits below the fold of the outer frame, so it is out of view.
    expect(line(out, "Nested button")).toBeUndefined();
    await page().evaluate(() => {
      const same = document.getElementById("same") as HTMLIFrameElement;
      same.contentWindow!.scrollTo(0, 2000);
    });
    const scrolled = text(await env!.session.turn({ kind: "observe" }));
    expect(line(scrolled, "Nested button")).toContain("(in frame)");
  }, 60000);

  test("a control scrolled out of the frame's box is not listed", async () => {
    if (!ready()) return;
    const out = await framedPage();
    expect(line(out, "Below the frame fold")).toBeUndefined();
  }, 60000);

  test("clicking and typing by id act inside the frame", async () => {
    if (!ready()) return;
    const out = await framedPage();
    await env!.session.turn({
      kind: "act",
      actions: [
        { type: "click", elementId: idOf(line(out, "Card holder")) },
        { type: "type", elementId: idOf(line(out, "Card holder")), text: "Ada Lovelace" },
        { type: "click", elementId: idOf(line(out, "Pay now")) },
      ],
    });
    expect(await page().title()).toBe("frame-clicked");
    const typed = await page().evaluate(
      () => ((document.getElementById("same") as HTMLIFrameElement).contentDocument!.getElementById("name") as HTMLInputElement).value,
    );
    expect(typed).toBe("Ada Lovelace");
  }, 60000);

  test("a password in a frame is redacted like any other", async () => {
    if (!ready()) return;
    const out = await framedPage();
    expect(out).not.toContain("hunter2-in-frame");
  }, 60000);

  test("a cross-origin frame is listed by origin, its contents are not", async () => {
    if (!ready()) return;
    const out = await framedPage();
    expect(out).toContain("## Frames not indexed");
    expect(out).toMatch(/http:\/\/localhost:\d+ .*cross-origin/);
    expect(out).not.toContain("Second tab");
  }, 60000);

  test("inspect finds an element in a frame by id", async () => {
    if (!ready()) return;
    const out = await framedPage();
    const r = await env!.session.turn({ kind: "inspect", elementId: idOf(line(out, "Pay now")) });
    expect(text(r)).toContain("tag: <button");
    expect(text(r)).toContain('text: "Pay now"');
  }, 60000);
});
