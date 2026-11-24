/**
 * Shared e2e harness: one fixture server, one headless Chromium lifecycle.
 *
 * Browser tests skip themselves when Chromium cannot launch so a fresh
 * checkout stays green. Set `OPENCODE_BROWSER_E2E=1` to turn that skip into a
 * hard failure: CI and release gates must never pass without a browser.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrowserSessionManager } from "../src/core/session-manager.ts";
import { PlaywrightBrowserSession } from "../src/core/browser-session.ts";

export const E2E_GATE_ENV = "OPENCODE_BROWSER_E2E";

export const FIXTURE_HTML = `<!doctype html><html><head><title>Fixture</title>
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
<button id="slow">Trigger slow error</button>
<button id="popup">Open popup</button>
<script>
document.getElementById("boom").addEventListener("click", () => {
  console.error("Test runtime error");
  fetch("/api/missing").catch(() => {});
});
document.getElementById("slow").addEventListener("click", () => {
  fetch("/api/slow").catch(() => {});
});
document.getElementById("popup").addEventListener("click", () => {
  window.open("/second", "_blank");
});
</script>
</body></html>`;

export interface FixtureServer {
  readonly url: string;
  stop(): void;
}

/** Serve the fixture page plus a 404 endpoint for the telemetry test. */
export function startFixtureServer(): FixtureServer {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/missing") {
        return new Response("nope", { status: 404 });
      }
      if (url.pathname === "/api/slow") {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return new Response("still nope", { status: 404 });
      }
      if (url.pathname === "/second") {
        return new Response("<!doctype html><title>Second</title><h1>Second tab</h1>", {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(FIXTURE_HTML, { headers: { "content-type": "text/html" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    stop: () => server.stop(true),
  };
}

export interface BrowserHandle {
  readonly manager: BrowserSessionManager;
  readonly session: PlaywrightBrowserSession;
  readonly shotDir: string;
  readonly profileDir: string;
  close(): Promise<void>;
}

/**
 * Launch a headless Chromium with throwaway profile + screenshot dirs.
 * Throws when the browser cannot start; the caller decides whether that is a
 * skip (`OPENCODE_BROWSER_E2E` unset) or a failure (set to `1`).
 */
export async function startBrowser(): Promise<BrowserHandle> {
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-shots-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-prof-"));
  const manager = new BrowserSessionManager({
    headless: true,
    profileDir,
    screenshotDir: shotDir,
  });
  const session = new PlaywrightBrowserSession(manager);
  try {
    await manager.ensureActivePage();
  } catch (error) {
    await manager.close().catch(() => undefined);
    fs.rmSync(shotDir, { recursive: true, force: true });
    fs.rmSync(profileDir, { recursive: true, force: true });
    throw error;
  }
  return {
    manager,
    session,
    shotDir,
    profileDir,
    close: async () => {
      await manager.close().catch(() => undefined);
      fs.rmSync(shotDir, { recursive: true, force: true });
      fs.rmSync(profileDir, { recursive: true, force: true });
    },
  };
}

/** True when the suite must fail instead of skipping on a launch failure. */
export function browserGateOpen(): boolean {
  return process.env[E2E_GATE_ENV] === "1";
}

/**
 * Re-throw a launch failure when the gate is open. Returns the message to log
 * when the suite is allowed to skip, so the reason is never silent.
 */
export function skipReason(launchError: string | null): string {
  const message = `chromium did not launch: ${launchError ?? "unknown error"}`;
  if (browserGateOpen()) {
    throw new Error(
      `${E2E_GATE_ENV}=1 but ${message}. Install Chromium or set OPENCODE_BROWSER_EXECUTABLE_PATH.`,
    );
  }
  return message;
}
