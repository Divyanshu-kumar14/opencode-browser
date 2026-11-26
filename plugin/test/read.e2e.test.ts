/// <reference lib="dom" />
/**
 * browse_read: the page as markdown. Extraction runs against real Chromium;
 * pagination is pure.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { paginate, readPage } from "../src/core/read.ts";
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

const ARTICLE = `<!doctype html><title>Papers</title>
<nav><a href="/home">Home</a> <a href="/about">About</a></nav>
<main>
  <h1>Latest papers</h1>
  <p>Fresh <b>results</b> from <a href="https://example.test/p/1?token=SECRET123&page=2">the archive</a>.</p>
  <h2>Top three</h2>
  <ol><li>Attention is all you need</li><li>Scaling laws</li><li>Chinchilla</li></ol>
  <ul><li>alpha</li><li>beta</li></ul>
  <table><tr><th>Name</th><th>Score</th></tr><tr><td>A</td><td>91</td></tr><tr><td>B</td><td>87</td></tr></table>
  <pre>const x = 1;
const y = 2;</pre>
  <p>Inline <code>code()</code> and an image <img alt="a chart" src="/c.png">.</p>
  <p style="display:none">HIDDEN TEXT</p>
  <p aria-hidden="true">ARIA HIDDEN TEXT</p>
  <p hidden>HIDDEN ATTR</p>
  <script>window.leak = "SCRIPT TEXT"</script>
  <style>.x { color: red }</style>
  <noscript>NOSCRIPT TEXT</noscript>
  <label>Email <input type="email" value="ada@example.test" placeholder="you@work.com"></label>
  <input type="password" value="hunter2-secret">
  <textarea>draft body</textarea>
  <div id="host"></div>
</main>
<footer>Footer text</footer>
<script>
  const root = document.getElementById("host").attachShadow({ mode: "open" });
  root.innerHTML = "<p>Shadow paragraph</p>";
</script>`;

async function article(): Promise<Page> {
  const page = await browser!.newPage();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: ARTICLE }));
  await page.goto("http://papers.test/latest");
  return page;
}

describe("readPage", () => {
  test("renders structure as markdown and prefers the main content", async () => {
    if (!ready()) return;
    const page = await article();
    const { text } = await readPage(page, {});
    expect(text).toContain("# Latest papers");
    expect(text).toContain("## Top three");
    expect(text).toContain("1. Attention is all you need");
    expect(text).toContain("3. Chinchilla");
    expect(text).toContain("- alpha");
    expect(text).toContain("| Name | Score |");
    expect(text).toContain("| A | 91 |");
    expect(text).toContain("const x = 1;\nconst y = 2;");
    expect(text).toContain("**results**");
    expect(text).toContain("`code()`");
    expect(text).toContain("[image: a chart]");
    // main content only: nav and footer are outside <main>
    expect(text).not.toContain("Footer text");
    expect(text).not.toContain("[About]");
    await page.close();
  });

  test("keeps links, with secrets in URLs redacted", async () => {
    if (!ready()) return;
    const page = await article();
    const { text } = await readPage(page, {});
    expect(text).toContain("[the archive](https://example.test/p/1");
    expect(text).not.toContain("SECRET123");
    await page.close();
  });

  test("links can be left out", async () => {
    if (!ready()) return;
    const page = await article();
    const { text } = await readPage(page, { links: false });
    expect(text).toContain("the archive");
    expect(text).not.toContain("](");
    await page.close();
  });

  test("never includes hidden content, scripts, styles or form values", async () => {
    if (!ready()) return;
    const page = await article();
    const { text } = await readPage(page, { selector: "body" });
    for (const secret of ["HIDDEN TEXT", "ARIA HIDDEN TEXT", "HIDDEN ATTR", "SCRIPT TEXT", "color: red", "NOSCRIPT TEXT", "hunter2-secret", "ada@example.test", "draft body"]) {
      expect(text).not.toContain(secret);
    }
    // controls are shown by label/placeholder, never by their value
    expect(text).toContain("[input: you@work.com]");
    expect(text).toContain("[password field]");
    await page.close();
  });

  test("reads open shadow roots", async () => {
    if (!ready()) return;
    const page = await article();
    const { text } = await readPage(page, {});
    expect(text).toContain("Shadow paragraph");
    await page.close();
  });

  test("a selector scopes the read, and a missing one is invalid input", async () => {
    if (!ready()) return;
    const page = await article();
    const scoped = await readPage(page, { selector: "ol" });
    expect(scoped.text).toContain("Scaling laws");
    expect(scoped.text).not.toContain("Latest papers");
    await expect(readPage(page, { selector: "#nope" })).rejects.toThrow("no element matches");
    await expect(readPage(page, { selector: "div[" })).rejects.toThrow("invalid selector");
    await page.close();
  });

  test("the HUD is never part of the page text", async () => {
    if (!ready()) return;
    const page = await article();
    await page.evaluate(() => {
      const host = document.createElement("opencode-agent-hud");
      host.attachShadow({ mode: "open" }).innerHTML = "<button>Stop the agent</button>";
      document.body.append(host);
    });
    const { text } = await readPage(page, { selector: "body" });
    expect(text).not.toContain("Stop the agent");
    await page.close();
  });
});

describe("paginate", () => {
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");

  test("a short page comes back whole", () => {
    expect(paginate("short", 0, 100)).toEqual({ text: "short", total: 5, offset: 0, nextOffset: null });
  });

  test("a long page is cut at a line break, with the next offset", () => {
    const first = paginate(body, 0, 60);
    expect(first.text.length).toBeLessThanOrEqual(60);
    expect(first.text.endsWith("\n")).toBe(false);
    expect(first.nextOffset).toBe(first.text.length + 1);
    expect(first.total).toBe(body.length);
    const second = paginate(body, first.nextOffset!, 60);
    expect(second.text.startsWith("line")).toBe(true);
  });

  test("walking nextOffset reads every line exactly once", () => {
    const lines: string[] = [];
    let offset: number | null = 0;
    for (let guard = 0; offset !== null && guard < 100; guard++) {
      const part = paginate(body, offset, 50);
      lines.push(...part.text.split("\n"));
      offset = part.nextOffset;
    }
    expect(lines.join("\n")).toBe(body);
  });

  test("a single line longer than the limit is hard-cut, and an offset past the end is empty", () => {
    const long = paginate("x".repeat(300), 0, 100);
    expect(long.text).toHaveLength(100);
    expect(long.nextOffset).toBe(100);
    expect(paginate("abc", 10, 100)).toEqual({ text: "", total: 3, offset: 10, nextOffset: null });
  });
});
