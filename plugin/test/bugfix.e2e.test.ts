/// <reference lib="dom" />
/**
 * Bug-sweep e2e tests against real headless Chromium. Durable home for every
 * /tmp/bugprobe probe. One `describe` per design group.
 * Spec: .kiro/specs/browser-plugin-bug-sweep/
 *
 * Skips when Chromium cannot launch unless OPENCODE_BROWSER_E2E=1.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Page } from "playwright";
import type { ToolResult } from "../src/core/turn.ts";
import type { Action } from "../src/core/action-engine.ts";
import { schema as interactSchema } from "../src/tools/interact.ts";
import { registerBrowserTools } from "../src/tools/index.ts";
import type { ToolEditor } from "@opencode/plugin/promise/tool";
import { BrowserSessionManager } from "../src/core/session-manager.ts";
import { PlaywrightBrowserSession } from "../src/core/browser-session.ts";
import {
  skipReason,
  startBrowser,
  startBugFixtureServer,
  withDeadline,
  type BrowserHandle,
  type FixtureServer,
} from "./harness.ts";

let server: FixtureServer | null = null;
let env: BrowserHandle | null = null;
let base = "";
let launchError: string | null = null;
const extra: BrowserHandle[] = [];

function text(result: ToolResult): string {
  const part = result.content.find((c) => c.type === "text");
  return part && part.type === "text" ? part.text : "";
}

function ready(): boolean {
  if (env) return true;
  console.warn(`SKIP: ${skipReason(launchError)}`);
  return false;
}

function page(): Page {
  return env!.manager.tabs.active()!;
}

async function goto(p: string): Promise<ToolResult> {
  return env!.session.turn({ kind: "navigate", action: "goto", url: base + p.replace(/^\//, "") });
}

/** A second browser with its own config, closed in afterAll. */
async function extraBrowser(overrides: Parameters<typeof startBrowser>[0]): Promise<BrowserHandle> {
  const handle = await startBrowser(overrides);
  extra.push(handle);
  return handle;
}

async function errorOf(p: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await p;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected the call to reject");
}

beforeAll(async () => {
  server = startBugFixtureServer();
  base = server.url;
  try {
    env = await startBrowser();
  } catch (error) {
    launchError = error instanceof Error ? error.message : String(error);
    env = null;
  }
}, 60000);

afterAll(async () => {
  for (const handle of extra) await handle.close();
  await env?.close();
  server?.stop();
}, 60000);

// ---------------------------------------------------------------------------
// Group 1: security controls (1.6, 1.7, 1.19; 1.21 is in bugfix.unit.test.ts)
// ---------------------------------------------------------------------------

describe("Group 1: security controls", () => {
  test("1.6 sensitive input values never reach the element map", async () => {
    if (!ready()) return;
    const out = text(await goto("/sensitive"));
    for (const secret of ["hunter2-secret", "4111111111111111", "737", "902113"]) {
      expect(out).not.toContain(secret);
    }
    expect(out.match(/value="\[redacted\]"/g)?.length).toBe(4);
  }, 30000);

  test("3.10 non-sensitive input values are still shown", async () => {
    if (!ready()) return;
    const out = text(await goto("/sensitive"));
    expect(out).toContain('value="ada@example.test"');
    expect(out).toContain('value="kittens"');
  }, 30000);

  test("1.7 goto rejects disallowed schemes with INVALID_INPUT and leaves the page alone", async () => {
    if (!ready()) return;
    await goto("/second");
    const before = page().url();
    for (const url of ["file:///etc/hostname", "javascript:alert(1)", "data:text/html,x", "chrome://version"]) {
      const error = await errorOf(env!.session.turn({ kind: "navigate", action: "goto", url }));
      expect({ url, code: error.code }).toEqual({ url, code: "INVALID_INPUT" });
      expect(page().url()).toBe(before);
    }
  }, 60000);

  test("3.8 http, https, and about:blank navigation keeps waitUntil and timeout", async () => {
    if (!ready()) return;
    const p = page();
    await p.route("https://secure.test/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>secure</title><a href='/'>s</a>" }),
    );
    const calls: unknown[] = [];
    const original = p.goto.bind(p);
    (p as unknown as { goto: unknown }).goto = (url: string, opts: unknown) => {
      calls.push([url, opts]);
      return original(url, opts as never);
    };
    try {
      const waits = ["load", "domcontentloaded", "networkidle"] as const;
      const urls = [base + "second", "https://secure.test/x", "about:blank"];
      for (const url of urls) {
        for (const waitUntil of waits) {
          await env!.session.turn({ kind: "navigate", action: "goto", url, waitUntil });
          expect(p.url()).toBe(url);
        }
      }
      const timeout = env!.manager.getConfig().navigationTimeoutMs;
      expect(calls).toEqual(urls.flatMap((url) => waits.map((waitUntil) => [url, { waitUntil, timeout }])));
    } finally {
      (p as unknown as { goto: unknown }).goto = original;
      await p.unroute("https://secure.test/**");
    }
  }, 60000);

  test("1.21 an eval approved for one page refuses to run on another", async () => {
    if (!ready()) return;
    await goto("/second");
    const marker = "window.__ranAfterMismatch = true";
    const error = await errorOf(
      env!.session.turn({ kind: "evaluate", expression: marker, approvedUrl: base + "popup" }),
    );
    expect(error.message).toContain("page changed since browse_eval was approved");
    expect(error.message).toContain(`approved ${base}popup, now ${base}second`);
    expect(await page().evaluate("window.__ranAfterMismatch === true")).toBe(false);
  }, 30000);

  test("1.19 screenshots are owner-only (dir 0700, files 0600)", async () => {
    if (!ready()) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-mode-"));
    const dir = path.join(root, "shots");
    try {
      const b = await extraBrowser({ screenshotDir: dir });
      const r1 = await b.session.turn({ kind: "navigate", action: "goto", url: base + "second" });
      const shot1 = r1.metadata["screenshotPath"] as string;
      expect((fs.statSync(dir).mode & 0o777).toString(8)).toBe("700");
      expect((fs.statSync(shot1).mode & 0o777).toString(8)).toBe("600");
      // A pre-existing 0755 directory is tightened on the next turn.
      fs.chmodSync(dir, 0o755);
      const r2 = await b.session.turn({ kind: "observe" });
      expect((fs.statSync(dir).mode & 0o777).toString(8)).toBe("700");
      expect((fs.statSync(r2.metadata["screenshotPath"] as string).mode & 0o777).toString(8)).toBe("600");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// Group 2: annotator and HUD (1.1, 1.3, 1.12, 1.23, 1.25, 1.26)
// ---------------------------------------------------------------------------

/** Count of nodes per data-opencode-id across the document and open shadow roots. */
async function idCounts(p: Page): Promise<Record<string, number>> {
  return p.evaluate(() => {
    const counts: Record<string, number> = {};
    const visit = (root: Document | ShadowRoot): void => {
      for (const el of Array.from(root.querySelectorAll("[data-opencode-id]"))) {
        const k = el.getAttribute("data-opencode-id")!;
        counts[k] = (counts[k] ?? 0) + 1;
      }
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    return counts;
  });
}

function mapLine(out: string, label: string): string | undefined {
  return out.split("\n").find((l) => /^\[\d+\] </.test(l) && l.includes(`"${label}"`));
}

function idOf(line: string | undefined): number {
  const m = /^\[(\d+)\]/.exec(line ?? "");
  if (!m) throw new Error(`no element line: ${line}`);
  return Number(m[1]);
}

describe("Group 2: annotator and HUD", () => {
  test("1.1 ids stay unique after scrolling and re-indexing; clicking id 1 works", async () => {
    if (!ready()) return;
    await goto("/stale");
    await env!.session.turn({
      kind: "act",
      actions: [{ type: "scroll", scrollDirection: "down", scrollAmount: 1500 }],
    });
    const dup = Object.entries(await idCounts(page())).filter(([, n]) => n > 1);
    expect(dup).toEqual([]);
    await env!.session.turn({ kind: "act", actions: [{ type: "click", elementId: 1 }] });
  }, 30000);

  test("1.3 the HUD pill never intercepts clicks on elements under it", async () => {
    if (!ready()) return;
    const out = text(await goto("/stale"));
    const hit = await page().evaluate(() => {
      const r = document.getElementById("corner")!.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.tagName;
    });
    expect(hit).toBe("BUTTON");
    expect(mapLine(out, "Corner")).toBeDefined();
    await page().locator("#corner").click({ timeout: 3000 });
    expect(await page().title()).toBe("corner-clicked");
  }, 30000);

  test("1.12 open shadow-DOM controls are indexed and clickable by id", async () => {
    if (!ready()) return;
    const out = text(await goto("/popup"));
    const line = mapLine(out, "ShadowBtn");
    expect(line).toBeDefined();
    await env!.session.turn({ kind: "act", actions: [{ type: "click", elementId: idOf(line) }] });
    expect(await page().title()).toBe("shadow-clicked");
  }, 30000);

  test("1.23 non-redundant role and disabled state are printed", async () => {
    if (!ready()) return;
    const out = text(await goto("/widgets"));
    expect(out).toMatch(/\[\d+\] <div role="combobox"> "Select Environment"/);
    expect(out).toMatch(/\[\d+\] <button disabled> "Disabled"/);
  }, 30000);

  test("1.25 the HUD cursor is drawn at (x, y)", async () => {
    if (!ready()) return;
    await goto("/second");
    const { hud } = await import("../src/core/page-agent.ts");
    await hud.cursor(page(), 300, 200);
    await new Promise((r) => setTimeout(r, 250));
    const rect = await page().evaluate(() => {
      const host = document.querySelector("opencode-agent-hud")!;
      const r = host.shadowRoot!.querySelector(".cursor")!.getBoundingClientRect();
      return { x: r.x, y: r.y };
    });
    expect(Math.abs(rect.x - 300)).toBeLessThanOrEqual(1);
    expect(Math.abs(rect.y - 200)).toBeLessThanOrEqual(1);
  }, 30000);

  test("1.26 multi-id aria-labelledby joins every referenced label", async () => {
    if (!ready()) return;
    const out = text(await goto("/widgets"));
    expect(mapLine(out, "Ada Lovelace")).toBeDefined();
  }, 30000);

  test("3.1/3.2 a fresh id acts on one element; a removed batch target stops the batch", async () => {
    if (!ready()) return;
    await goto("/widgets");
    await page().evaluate(() => {
      document.body.insertAdjacentHTML(
        "afterbegin",
        '<button id="rm" onclick="document.getElementById(\'victim\').remove()">Remove</button>' +
        '<button id="victim" onclick="document.title=\'victim\'">Victim</button>',
      );
    });
    const out = text(await env!.session.turn({ kind: "observe" }));
    const rm = idOf(mapLine(out, "Remove"));
    const victim = idOf(mapLine(out, "Victim"));
    const r = await env!.session.turn({
      kind: "act",
      actions: [
        { type: "click", elementId: rm },
        { type: "click", elementId: victim },
      ],
    });
    expect(text(r)).toContain(`Stopped at action #2: Element [${victim}] became stale`);
    expect(await page().title()).toBe("Widgets");
  }, 30000);

  test("3.6 the HUD is visible again after every turn", async () => {
    if (!ready()) return;
    await goto("/second");
    for (const req of [{ kind: "observe" as const }, { kind: "observe" as const, annotate: false }]) {
      await env!.session.turn(req);
      const vis = await page().evaluate(
        () => (document.querySelector("opencode-agent-hud") as HTMLElement | null)?.style.visibility,
      );
      expect(vis).toBe("visible");
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// Group 4: perception and timeouts (1.5, 1.9, 1.10)
// ---------------------------------------------------------------------------

const RACE = /Execution context was destroyed|frame was detached|Cannot find context|Timeout .*screenshot|page\.screenshot/i;

describe("Group 4: perception and timeouts", () => {
  test("1.5 turns on a self-reloading page return a map or a Perception incomplete notice", async () => {
    if (!ready()) return;
    const perceptionTimeoutMs = 3000;
    const b = await extraBrowser({ perceptionTimeoutMs });
    const cfg = b.manager.getConfig();
    // A goto also settles first (bounded at settleMax + quietWindow + 550 ms);
    // perception itself must finish within its budget plus slack.
    const settleBound = cfg.settleMaxTimeoutMs + cfg.settleQuietWindowMs + 550;
    const failures: string[] = [];
    const run = async (label: string, call: () => Promise<ToolResult>): Promise<void> => {
      const bound = perceptionTimeoutMs + 2000 + (label.startsWith("goto") ? settleBound : 0);
      const started = Date.now();
      const r = await withDeadline(
        call().then(
          (v) => ({ ok: true as const, v }),
          (e: unknown) => ({ ok: false as const, e: e instanceof Error ? e.message : String(e) }),
        ),
        bound,
      );
      if (r.timedOut) {
        failures.push(`${label}: no result within ${bound}ms`);
        return;
      }
      const outcome = r.value;
      if (!outcome.ok) {
        // A goto aborted by the page's own navigation is a real navigation failure (A8).
        if (label.startsWith("goto") && /ERR_ABORTED|interrupted by another navigation/.test(outcome.e)) return;
        failures.push(`${label}: ${outcome.e.split("\n")[0]}`);
        return;
      }
      const out = text(outcome.v);
      if (!out.includes("## Interactive elements") && !out.includes("Perception incomplete")) {
        failures.push(`${label}: neither a map nor a notice`);
      }
      if (Date.now() - started > bound) failures.push(`${label}: too slow`);
    };
    for (let i = 0; i < 5; i++) {
      await run(`goto#${i}`, () => b.session.turn({ kind: "navigate", action: "goto", url: base + "loop" }));
    }
    for (let i = 0; i < 5; i++) await run(`observe#${i}`, () => b.session.turn({ kind: "observe" }));
    expect(failures).toEqual([]);
    expect(failures.filter((f) => RACE.test(f))).toEqual([]);
  }, 120000);

  test("1.5 a click that navigates later does not fail the next turn", async () => {
    if (!ready()) return;
    await goto("/redirect");
    const r1 = await env!.session.turn({ kind: "act", actions: [{ type: "click", selector: "#go" }] });
    expect(text(r1)).toContain("URL:");
    const r2 = await withDeadline(env!.session.turn({ kind: "observe" }), 20000);
    expect(r2.timedOut).toBe(false);
  }, 60000);

  test("1.9 a never-settling or blocking eval times out and the next turn succeeds", async () => {
    if (!ready()) return;
    const b = await extraBrowser({ evalTimeoutMs: 500 });
    await b.session.turn({ kind: "navigate", action: "goto", url: base + "second" });
    for (const expression of ["new Promise(() => {})", "while (true) {}"]) {
      const started = Date.now();
      const r = await withDeadline(b.session.turn({ kind: "evaluate", expression }), 1500);
      expect({ expression, timedOut: r.timedOut }).toEqual({ expression, timedOut: false });
      if (r.timedOut) continue;
      expect(text(r.value)).toContain("Error: timed out after 500ms");
      expect(r.value.metadata["timedOut"]).toBe(true);
      expect(Date.now() - started).toBeLessThan(1500 + 50);
      const next = await withDeadline(b.session.turn({ kind: "observe" }), 10000);
      const nextOk = !next.timedOut && text(next.value).includes(`URL: ${base}second`) && text(next.value).includes('[1] <a href="/x">');
      expect({ expression, next: next.timedOut ? "hung" : nextOk }).toEqual({
        expression,
        next: true,
      });
    }
  }, 60000);

  test("1.10 settle resolves with renderQuiet false when requestAnimationFrame never fires", async () => {
    if (!ready()) return;
    await goto("/second");
    const { waitForSettled } = await import("../src/core/settle.ts");
    await page().evaluate(() => {
      (window as unknown as { requestAnimationFrame: () => number }).requestAnimationFrame = () => 0;
    });
    const maxTimeoutMs = 1000;
    const quietWindowMs = 250;
    const started = Date.now();
    const r = await withDeadline(waitForSettled(page(), { maxTimeoutMs, quietWindowMs }), maxTimeoutMs + quietWindowMs + 500);
    expect(r.timedOut).toBe(false);
    if (!r.timedOut) {
      expect(r.value.renderQuiet).toBe(false);
      expect(r.value.settled).toBe(false);
    }
    expect(Date.now() - started).toBeLessThanOrEqual(maxTimeoutMs + quietWindowMs + 550);
    await goto("/second"); // fresh document restores rAF
  }, 30000);

  test("3.6 a turn with no navigation race returns the map and the screenshot attachment", async () => {
    if (!ready()) return;
    const r = await goto("/widgets");
    expect(text(r)).toContain('"Select Environment"');
    expect(text(r)).not.toContain("Perception incomplete");
    expect(r.content).toHaveLength(2);
    expect(r.content[1]).toMatchObject({ type: "file", mime: "image/png" });
  }, 30000);
});

// ---------------------------------------------------------------------------
// Group 5: session and tab lifecycle (1.4, 1.8, 1.11, 1.24; 1.22 and 1.27
// are in bugfix.signals.test.ts and bugfix.unit.test.ts)
// ---------------------------------------------------------------------------

/** A manager + session that has not launched Chromium yet. */
function coldSession(): { manager: BrowserSessionManager; session: PlaywrightBrowserSession; cleanup(): Promise<void> } {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cold-prof-"));
  const screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cold-shots-"));
  const manager = new BrowserSessionManager({ headless: true, profileDir, screenshotDir });
  const session = new PlaywrightBrowserSession(manager);
  return {
    manager,
    session,
    cleanup: async () => {
      await manager.close().catch(() => undefined);
      fs.rmSync(profileDir, { recursive: true, force: true });
      fs.rmSync(screenshotDir, { recursive: true, force: true });
    },
  };
}

/** Eval that records how many evaluate turns overlap (window.__max). */
const OVERLAP_PROBE =
  "(async () => { window.__c = (window.__c || 0) + 1; window.__max = Math.max(window.__max || 0, window.__c);" +
  " await new Promise((r) => setTimeout(r, 50)); window.__c -= 1; return window.__max; })()";

describe("Group 5: session and tab lifecycle", () => {
  test("1.4 a click that opens a tab perceives the new tab", async () => {
    if (!ready()) return;
    const b = await extraBrowser({});
    await b.session.turn({ kind: "navigate", action: "goto", url: base + "popup" });
    const r = await b.session.turn({ kind: "act", actions: [{ type: "click", selector: "#pop" }] });
    const out = text(r);
    const active = b.manager.tabs.active()!;
    expect(out).toContain(`URL: ${base}second`);
    expect(out).toContain('<a href="/x">');
    expect(out).not.toContain('"Open popup"');
    expect(r.metadata["tabId"]).toBe(b.manager.tabs.idOf(active));
    expect(r.metadata["url"]).toBe(`${base}second`);
    expect(out).toContain(`Tab: Switched to new tab: ${base}second`);
    expect(out).not.toContain("about:blank");
    // Act on an id from the returned map: the click lands in the new tab.
    const linkId = Number(/\[(\d+)\] <a href="\/x">/.exec(out)![1]);
    await b.session.turn({ kind: "act", actions: [{ type: "click", elementId: linkId }] });
    expect(b.manager.tabs.active()!.url()).toBe(`${base}x`);
  }, 60000);

  test("1.24 an active tab that closes itself is reported on the next turn", async () => {
    if (!ready()) return;
    const b = await extraBrowser({});
    await b.session.turn({ kind: "navigate", action: "goto", url: base + "oauth" });
    const opened = text(await b.session.turn({ kind: "act", actions: [{ type: "click", selector: "#signin" }] }));
    expect(opened).toContain(`Tab: Switched to new tab: ${base}oauth-close`);
    const deadline = Date.now() + 5000;
    while (b.manager.tabs.list().length > 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const out = text(await b.session.turn({ kind: "observe" }));
    expect(out).toContain(`Tab: Active tab closed; switched to tab: ${base}oauth`);
    expect(out).toContain(`URL: ${base}oauth`);
  }, 60000);

  test("1.8 concurrent cold turns launch once and both succeed", async () => {
    if (!ready()) return;
    const cold = coldSession();
    try {
      const r = await withDeadline(
        Promise.allSettled([cold.session.turn({ kind: "observe" }), cold.session.turn({ kind: "observe" })]),
        30000,
      );
      expect(r.timedOut).toBe(false);
      if (!r.timedOut) {
        expect(r.value.map((x) => (x.status === "fulfilled" ? "ok" : String(x.reason).split("\n")[0]))).toEqual(["ok", "ok"]);
      }
    } finally {
      await cold.cleanup();
    }
  }, 60000);

  test("1.8 warm turns never interleave", async () => {
    if (!ready()) return;
    await goto("/second");
    await page().evaluate("window.__c = 0; window.__max = 0");
    const results = await Promise.allSettled(
      [0, 1, 2, 3].map(() => env!.session.turn({ kind: "evaluate", expression: OVERLAP_PROBE })),
    );
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
    expect(await page().evaluate("window.__max")).toBe(1);
  }, 60000);

  test("1.11 a setup failure after launch is retried in full on the next call", async () => {
    if (!ready()) return;
    const cold = coldSession();
    try {
      // Fail the last setup step once, through the tab tracker's interface.
      const tabs = cold.manager.tabs;
      const original = tabs.watch.bind(tabs);
      let thrown = false;
      tabs.watch = (source) => {
        if (!thrown) {
          thrown = true;
          throw new Error("injected setup failure");
        }
        original(source);
      };
      expect((await errorOf(cold.manager.ensureActivePage())).message).toContain("injected setup failure");
      const p = await cold.manager.ensureActivePage();
      expect(cold.manager.tabs.list().length).toBeGreaterThanOrEqual(1);
      cold.manager.getTelemetry().drain();
      await p.goto(base + "second");
      await p.evaluate("console.error('after-recovery')");
      await new Promise((r) => setTimeout(r, 100));
      expect(cold.manager.getTelemetry().drain().events.map((e) => e.text).join("\n")).toContain("after-recovery");
    } finally {
      await cold.cleanup();
    }
  }, 60000);

  test("3.11 an opened tab is reported with its loaded URL, never about:blank", async () => {
    if (!ready()) return;
    const b = await extraBrowser({});
    await b.session.turn({ kind: "navigate", action: "goto", url: base + "popup" });
    const out = text(await b.session.turn({ kind: "act", actions: [{ type: "click", selector: "#pop" }] }));
    expect(out).toMatch(/Tab: Switched to new tab: http:\/\/127\.0\.0\.1:\d+\/second/);
    expect(out).not.toContain("about:blank");
  }, 60000);

  test("3.19 headless keeps the 1280x720 viewport", async () => {
    if (!ready()) return;
    const b = await extraBrowser({});
    await b.session.turn({ kind: "observe" });
    expect(b.manager.tabs.active()!.viewportSize()).toEqual({ width: 1280, height: 720 });
  }, 60000);

  test("3.18 a killed browser is relaunched cleanly on the next turn", async () => {
    if (!ready()) return;
    const b = await extraBrowser({});
    await b.session.turn({ kind: "navigate", action: "goto", url: base + "second" });
    const before = b.manager.tabs.active()!;
    const pids = Bun.spawnSync(["pgrep", "-f", "--", `--user-data-dir=${b.profileDir}`]).stdout.toString().trim().split(/\s+/).filter(Boolean);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // already gone
      }
    }
    const deadline = Date.now() + 5000;
    while (!before.isClosed() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const r = await withDeadline(b.session.turn({ kind: "navigate", action: "goto", url: base + "second" }), 30000);
    expect(r.timedOut).toBe(false);
    if (!r.timedOut) expect(text(r.value)).toContain(`URL: ${base}second`);
  }, 60000);
});

// ---------------------------------------------------------------------------
// Group 6: action engine and inspect (1.13–1.18)
// ---------------------------------------------------------------------------

async function widgets(): Promise<Page> {
  await goto("/widgets");
  const p = page();
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.mouse.move(50, 650); // over the page body, away from #list
  return p;
}

function act(...actions: Action[]): Promise<ToolResult> {
  return env!.session.turn({ kind: "act", actions });
}

describe("Group 6: action engine and inspect", () => {
  test("1.13 select_option on a non-<select> fails with INVALID_INPUT", async () => {
    if (!ready()) return;
    await widgets();
    const error = await errorOf(act({ type: "select_option", selector: "#not-a-select", text: "A" }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("select_option target is <div>, not <select>");
  }, 30000);

  test("1.13 select_option without text is rejected by the schema", () => {
    expect(interactSchema.safeParse({ type: "select_option", selector: "#sel" }).success).toBe(false);
    expect(interactSchema.safeParse({ actions: [{ type: "select_option", selector: "#sel" }] }).success).toBe(false);
  });

  test("1.13 select_option with an unknown label fails fast and names the options", async () => {
    if (!ready()) return;
    const p = await widgets();
    const started = Date.now();
    const error = await errorOf(act({ type: "select_option", selector: "#sel", text: "Gamma" }));
    expect(Date.now() - started).toBeLessThan(1000 + 1500); // turn overhead on top of the 1 s bound
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain('no option labelled "Gamma"');
    expect(error.message).toContain("Alpha");
    expect(error.message).toContain("Beta");
    expect(await p.evaluate(() => (document.getElementById("sel") as HTMLSelectElement).value)).toBe("Alpha");
  }, 30000);

  test("1.14 clear_and_type at coordinates fills the field there", async () => {
    if (!ready()) return;
    const p = await widgets();
    await act({ type: "clear_and_type", x: 160, y: 315, text: "hello" });
    expect(await p.evaluate(() => (document.getElementById("cat") as HTMLInputElement).value)).toBe("hello");
  }, 30000);

  test("1.15 a targeted scroll scrolls the target's container, not the page", async () => {
    if (!ready()) return;
    const p = await widgets();
    await act({ type: "scroll", selector: "#list", scrollDirection: "down" });
    const r = await p.evaluate(() => ({ list: document.getElementById("list")!.scrollTop, y: window.scrollY }));
    expect(r.list).toBeGreaterThan(0);
    expect(r.y).toBe(0);
  }, 30000);

  test("1.16 drag from an element with no layout box fails without pressing the mouse", async () => {
    if (!ready()) return;
    const p = await widgets();
    await p.evaluate(() => {
      (window as unknown as { __mousedowns: number }).__mousedowns = 0;
    });
    const error = await errorOf(act({ type: "drag", selector: "#hidden-handle", toX: 300, toY: 300 }));
    expect(error.message).toContain("drag: could not resolve the position of #hidden-handle");
    expect(await p.evaluate(() => (window as unknown as { __mousedowns: number }).__mousedowns)).toBe(0);
  }, 30000);

  test("1.17 inspect prints an SVG element's class attribute", async () => {
    if (!ready()) return;
    await widgets();
    const out = text(await env!.session.turn({ kind: "inspect", selector: "#sv" }));
    expect(out).toContain('tag: <svg class="ic">');
  }, 30000);

  test("1.18 an invalid selector is INVALID_INPUT in inspect and in a batch, and no step runs", async () => {
    if (!ready()) return;
    const p = await widgets();
    const inspectError = await errorOf(env!.session.turn({ kind: "inspect", selector: "div[" }));
    expect(inspectError.code).toBe("INVALID_INPUT");
    expect(inspectError.message).toContain('invalid selector "div["');
    const batchError = await errorOf(
      act({ type: "type", selector: "#email", text: "x" }, { type: "click", selector: "div[" }),
    );
    expect(batchError.code).toBe("INVALID_INPUT");
    expect(batchError.message).toContain('invalid selector "div["');
    expect(await p.evaluate(() => (document.getElementById("email") as HTMLInputElement).value)).toBe("");
  }, 30000);

  // Preservation (Property 12)

  test("3.15 a native <select> with a matching label is selected", async () => {
    if (!ready()) return;
    const p = await widgets();
    await act({ type: "select_option", selector: "#sel", text: "Beta" });
    expect(await p.evaluate(() => (document.getElementById("sel") as HTMLSelectElement).value)).toBe("Beta");
  }, 30000);

  test("3.16 untargeted type goes to the focused element", async () => {
    if (!ready()) return;
    const p = await widgets();
    await p.focus("#email");
    await act({ type: "type", text: "abc" });
    expect(await p.evaluate(() => (document.getElementById("email") as HTMLInputElement).value)).toBe("abc");
  }, 30000);

  test("3.17 untargeted scroll wheels the page by 400 at the mouse position", async () => {
    if (!ready()) return;
    const p = await widgets();
    await act({ type: "scroll", scrollDirection: "down" });
    expect(await p.evaluate(() => window.scrollY)).toBe(400);
    expect(await p.evaluate(() => document.getElementById("list")!.scrollTop)).toBe(0);
  }, 30000);

  test("Property 12: inspect output for string-class elements and valid selectors matches F", async () => {
    if (!ready()) return;
    const p = await widgets();
    await p.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<button id="cls" class="a  b" title="t">C</button>'));
    const { inspectElement } = await import("../src/core/inspect.ts");
    const { inspectElement: oracleInspect } = await import("./oracle/inspect.ts");
    for (const selector of ["#env", "#email", "#sel", "#dis", "#named", "#list", "#cls", "select > option", "#missing"]) {
      const live = await inspectElement(p, { selector, cssProperties: ["zIndex"] });
      const oracle = await oracleInspect(p, { selector, cssProperties: ["zIndex"] });
      expect({ selector, live }).toEqual({ selector, live: oracle });
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// Integration flows (task 30). Recovery flows are covered above: 1.11 (setup
// failure), 3.18 (killed browser), 1.9 (turn after an eval timeout).
// ---------------------------------------------------------------------------


const CALL = { sessionID: "ses_flow", agent: "build", messageID: "msg_flow", id: "call_flow" };

function evalToolWith(assert: () => Promise<void>) {
  const tools = new Map<string, { execute(input: unknown, ctx: unknown): Promise<ToolResult> }>();
  const editor = { add: (t: { name: string }) => tools.set(t.name, t as never) } as unknown as ToolEditor;
  registerBrowserTools(editor, { session: env!.session, permission: { assert } as never }, "browse");
  return tools.get("eval")!;
}

describe("Integration flows", () => {
  test("security: query URLs are redacted in telemetry", async () => {
    if (!ready()) return;
    env!.manager.getTelemetry().drain();
    const out = text(await env!.session.turn({ kind: "navigate", action: "goto", url: `${base}api/missing?access_token=abc#frag` }));
    // The URL: line is the page's own address; the property covers telemetry.
    const telemetry = out.slice(out.indexOf("## Telemetry"));
    expect(telemetry).toContain(`[HTTP 404] GET ${base}api/missing`);
    expect(telemetry).not.toContain("access_token");
    expect(telemetry).not.toContain("#frag");
  }, 30000);

  test("security: sign-in on a password form shows a redacted map; the batch behaves as before", async () => {
    if (!ready()) return;
    await goto("/sensitive");
    const r = await act(
      { type: "clear_and_type", selector: "#pw", text: "s3cret-typed" },
      { type: "click", selector: "#em" },
    );
    const out = text(r);
    expect(r.metadata["stoppedAt"]).toBeNull();
    expect(out).not.toContain("s3cret-typed");
    expect(out).toMatch(/\[1\] <input value="\[redacted\]">/);
    expect(await page().evaluate(() => (document.getElementById("pw") as HTMLInputElement).value)).toBe("s3cret-typed");
  }, 30000);

  test("security: an approved eval returns its value; a denied one never touches the page", async () => {
    if (!ready()) return;
    await goto("/second");
    const allowed = await evalToolWith(async () => undefined).execute({ expression: "document.title" }, CALL);
    expect(text(allowed)).toContain('"Second"');
    const denial = new Error("denied by user");
    const error = await errorOf(
      evalToolWith(async () => Promise.reject(denial)).execute({ expression: "window.__touched = true" }, CALL),
    );
    expect(error).toBe(denial);
    expect(await page().evaluate("window.__touched === true")).toBe(false);
  }, 30000);

  test("tabs: switching back to the original tab works after a popup", async () => {
    if (!ready()) return;
    const b = await extraBrowser({});
    await b.session.turn({ kind: "navigate", action: "goto", url: base + "popup" });
    const mainId = b.manager.tabs.idOf(b.manager.tabs.active()!);
    const r = await b.session.turn({ kind: "act", actions: [{ type: "click", selector: "#pop" }] });
    expect(r.metadata["tabId"]).not.toBe(mainId);
    await b.manager.tabs.switchTo(mainId);
    const back = await b.session.turn({ kind: "observe" });
    expect(back.metadata["tabId"]).toBe(mainId);
    expect(text(back)).toContain(`URL: ${base}popup`);
  }, 60000);

  test("navigation race: a delayed redirect after a click, then a snapshot, both return", async () => {
    if (!ready()) return;
    await goto("/redirect");
    const p = page();
    const click = await withDeadline(act({ type: "click", selector: "#go" }), 20000);
    const snap = await withDeadline(env!.session.turn({ kind: "observe" }), 20000);
    expect([click.timedOut, snap.timedOut]).toEqual([false, false]);
    const deadline = Date.now() + 5000;
    while (!p.url().endsWith("/second") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const after = await env!.session.turn({ kind: "observe" });
    expect(text(after)).toContain(`URL: ${base}second`);
  }, 60000);
});
