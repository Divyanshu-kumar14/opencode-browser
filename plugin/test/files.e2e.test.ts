/// <reference lib="dom" />
/**
 * Uploads and downloads in a real browser. Skips when Chromium cannot launch
 * unless OPENCODE_BROWSER_E2E=1.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
let project = "";
let downloads = "";

beforeAll(async () => {
  server = startBugFixtureServer();
  base = server.url;
  project = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-upload-"));
  downloads = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-dl-parent-")), "downloads");
  fs.mkdirSync(path.join(project, "docs"));
  fs.writeFileSync(path.join(project, "docs", "cv.txt"), "Ada Lovelace, analyst");
  try {
    env = await startBrowser({ uploadDir: project, downloadDir: downloads });
  } catch (error) {
    launchError = error instanceof Error ? error.message : String(error);
  }
}, 60000);
afterAll(async () => {
  await env?.close();
  server?.stop();
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(path.dirname(downloads), { recursive: true, force: true });
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

async function uploadPage(): Promise<void> {
  await env!.session.turn({ kind: "navigate", action: "goto", url: base + "second" });
  await page().evaluate(() => {
    document.body.innerHTML =
      "<input type=file id=direct>" +
      "<input type=file id=hidden style='display:none'><button id=pick onclick=\"document.getElementById('hidden').click()\">Choose file</button>";
    for (const id of ["direct", "hidden"]) {
      document.getElementById(id)!.addEventListener("change", async (event) => {
        const file = (event.target as HTMLInputElement).files![0]!;
        document.title = `${id}:${file.name}:${await file.text()}`;
      });
    }
  });
}

describe("uploads", () => {
  test("a file input gets the file, read from the project folder", async () => {
    if (!ready()) return;
    await uploadPage();
    const r = await env!.session.turn({ kind: "upload", selector: "#direct", paths: ["docs/cv.txt"] });
    expect(text(r)).toContain("Uploaded: cv.txt");
    await page().waitForFunction(() => document.title.startsWith("direct:"));
    expect(await page().title()).toBe("direct:cv.txt:Ada Lovelace, analyst");
  }, 60000);

  test("a button that opens a file picker gets the file through the picker", async () => {
    if (!ready()) return;
    await uploadPage();
    await env!.session.turn({ kind: "upload", selector: "#pick", paths: ["docs/cv.txt"] });
    await page().waitForFunction(() => document.title.startsWith("hidden:"));
    expect(await page().title()).toBe("hidden:cv.txt:Ada Lovelace, analyst");
  }, 60000);

  test("a file outside the allowed folders is refused before the page is touched", async () => {
    if (!ready()) return;
    await uploadPage();
    await expect(
      env!.session.turn({ kind: "upload", selector: "#direct", paths: ["/etc/passwd"] }),
    ).rejects.toThrow("outside the folders uploads may read");
    expect(await page().title()).toBe("Second");
  }, 60000);

  test("a target that is neither a file input nor opens a picker says so", async () => {
    if (!ready()) return;
    await uploadPage();
    await page().evaluate(() => document.body.insertAdjacentHTML("beforeend", "<button id=plain>Plain</button>"));
    await expect(
      env!.session.turn({ kind: "upload", selector: "#plain", paths: ["docs/cv.txt"] }),
    ).rejects.toThrow("opened no file picker");
  }, 60000);
});

describe("downloads", () => {
  test("a download is saved privately under a safe name and reported in the turn", async () => {
    if (!ready()) return;
    await env!.session.turn({ kind: "navigate", action: "goto", url: base + "second" });
    await page().evaluate(() => {
      const a = document.createElement("a");
      a.id = "dl";
      a.textContent = "Get report";
      a.download = "../../escape.csv";
      a.href = URL.createObjectURL(new Blob(["a,b\n1,2\n"], { type: "text/csv" }));
      document.body.append(a);
    });
    const clicked = await env!.session.turn({ kind: "act", actions: [{ type: "click", selector: "#dl" }] });
    // The browser may begin the download just after the click's turn; it is
    // then reported on the next turn.
    const out = text(clicked).includes("Download:") ? text(clicked) : text(await env!.session.turn({ kind: "observe" }));
    // Chromium itself rewrites "../../escape.csv"; the name is a single file name either way.
    const match = out.match(/Download: saved "([^"\/]*escape\.csv)" \(\d+ KB\) to (\S+)/);
    expect(match).not.toBeNull();
    const file = match![2]!;
    expect(path.dirname(file)).toBe(downloads);
    expect(fs.readFileSync(file, "utf8")).toBe("a,b\n1,2\n");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(downloads).mode & 0o777).toBe(0o700);
    // Nothing was written outside the download folder.
    expect(fs.existsSync(path.join(path.dirname(downloads), "..", "escape.csv"))).toBe(false);
    // The saved download can be uploaded again.
    await uploadPage();
    await env!.session.turn({ kind: "upload", selector: "#direct", paths: [file] });
    await page().waitForFunction(() => document.title.startsWith("direct:"));
    expect(await page().title()).toContain("a,b");
  }, 60000);
});
