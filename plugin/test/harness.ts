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
import type { ResolvedConfig } from "../src/config.ts";

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
export async function startBrowser(
  overrides: Partial<ResolvedConfig> = {},
): Promise<BrowserHandle> {
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-shots-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-prof-"));
  const manager = new BrowserSessionManager({
    headless: true,
    profileDir,
    screenshotDir: shotDir,
    ...overrides,
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

/**
 * Race a call against an explicit deadline. Calls that hang on the unfixed
 * plugin then fail an assertion instead of tripping the runner timeout.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Bug-sweep fixture server. Page markup is taken from the /tmp/bugprobe probes
// so the durable tests reproduce the probe conditions exactly.
// ---------------------------------------------------------------------------

const SHADOW_EL_SCRIPT =
  "customElements.define('my-el', class extends HTMLElement{constructor(){super();" +
  "const s=this.attachShadow({mode:'open'});" +
  "s.innerHTML='<button id=shadowbtn style=\"width:120px;height:40px\">ShadowBtn</button>';" +
  "s.getElementById('shadowbtn').onclick=()=>{document.title='shadow-clicked'};}});";

/** probe.test.ts PAGE: Top/Bottom 1500 px apart, password, #corner, <my-el>. */
export const STALE_HTML = `<!doctype html><title>P</title><style>body{margin:0}</style>
<div style="height:40px"></div>
<button id="top">Top</button>
<div style="height:1500px"></div>
<button id="bottom">Bottom</button>
<div style="height:1500px"></div>
<input id="pw" type="password" value="hunter2-secret">
<button id="corner" style="position:fixed;right:30px;bottom:28px;width:60px;height:20px">Corner</button>
<my-el></my-el>
<script>${SHADOW_EL_SCRIPT}
document.getElementById('corner').onclick=()=>{document.title='corner-clicked'};</script>`;

/** probe2.test.ts MAIN. */
export const POPUP_HTML = `<!doctype html><title>Main</title>
<button id="pop" onclick="window.open('/second','_blank')">Open popup</button>
<my-el></my-el>
<script>${SHADOW_EL_SCRIPT}</script>`;

export const SECOND_HTML = `<!doctype html><title>Second</title><a href="/x">Only link on second</a>`;

export const LOOP_HTML = `<!doctype html><title>Loop</title><button>b</button><script>setTimeout(()=>location.reload(), 20)</script>`;

export const REDIRECT_HTML = `<!doctype html><title>Redirect</title>
<button id="go" onclick="setTimeout(()=>{location.href='/second'}, 600)">Go later</button>`;

export const SENSITIVE_HTML = `<!doctype html><title>Sensitive</title>
<input id="pw" type="password" value="hunter2-secret">
<input id="cc" autocomplete="cc-number" value="4111111111111111">
<input id="csc" autocomplete="section-x billing cc-csc" value="737">
<input id="otp" autocomplete="one-time-code" value="902113">
<input id="em" type="email" value="ada@example.test">
<input id="q" type="search" value="kittens">
<input id="pwempty" type="password" placeholder="Password">`;

export const WIDGETS_HTML = `<!doctype html><title>Widgets</title>
<style>body{margin:0;height:3000px} #list{overflow:auto;height:120px;width:200px} #list div{height:60px}</style>
<div id="not-a-select" tabindex="0" style="width:120px;height:30px">Not a select</div>
<select id="sel"><option>Alpha</option><option>Beta</option></select>
<input id="cat" style="position:absolute;left:100px;top:300px;width:120px;height:30px">
<input id="email" type="email">
<div id="hidden-handle" style="display:none">handle</div>
<svg id="sv" class="ic" width="10" height="10"></svg>
<button id="dis" disabled>Disabled</button>
<div id="env" role="combobox" aria-label="Select Environment" tabindex="0">Production</div>
<span id="first">Ada</span><span id="last">Lovelace</span>
<input id="named" aria-labelledby="first last" placeholder="placeholder text">
<div id="list" style="position:absolute;left:400px;top:300px">
  <div>1</div><div>2</div><div>3</div><div>4</div><div>5</div><div>6</div><div>7</div><div>8</div>
</div>
<script>
window.__mousedowns = 0;
document.addEventListener('mousedown', () => { window.__mousedowns += 1; });
</script>`;

export const OAUTH_HTML = `<!doctype html><title>OAuth start</title>
<button id="signin" onclick="window.open('/oauth-close','_blank')">Sign in with popup</button>`;

export const OAUTH_CLOSE_HTML = `<!doctype html><title>OAuth popup</title>
<p>Authorizing…</p><script>setTimeout(()=>window.close(), 1500)</script>`;

const BUG_ROUTES: Record<string, string> = {
  "/stale": STALE_HTML,
  "/popup": POPUP_HTML,
  "/second": SECOND_HTML,
  "/loop": LOOP_HTML,
  "/redirect": REDIRECT_HTML,
  "/sensitive": SENSITIVE_HTML,
  "/widgets": WIDGETS_HTML,
  "/oauth": OAUTH_HTML,
  "/oauth-close": OAUTH_CLOSE_HTML,
};

/** Serve the bug-sweep fixture routes; unknown paths get the popup page. */
export function startBugFixtureServer(): FixtureServer {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/missing") return new Response("nope", { status: 404 });
      const body = BUG_ROUTES[url.pathname] ?? POPUP_HTML;
      return new Response(body, { headers: { "content-type": "text/html" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    stop: () => server.stop(true),
  };
}
