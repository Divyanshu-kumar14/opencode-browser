/**
 * Baseline A — raw CDP WebSocket driver, in-process.
 *
 * This is the honest baseline for the M3 benchmark (IMPLEMENTATION-PLAN.md
 * Phase 5 §2.1): a ~400-line TypeScript client that holds one warm Chrome and
 * drives tabs over raw CDP WebSockets. No Puppeteer, no Playwright, no npm
 * CDP library — `globalThis.WebSocket` + `fetch` only.
 *
 * Contract (one sentence): given a session id, lazily create one tab in a
 * single shared Chrome and expose navigate/snapshot/click/fill/screenshot
 * with generation-tagged uids (`g{gen}-{n}`), where a uid from an older
 * generation fails as UID_STALE instead of clicking the wrong node.
 *
 * Empty/invalid inputs: unknown session → tab is created lazily (never an
 * error); malformed uid → UID_NOT_FOUND; uid from an older generation →
 * UID_STALE; Chrome missing/unreachable → CHROME_DEAD/INTERNAL with a hint.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Errors: same {code, message, hint} shape as the Rust daemon (§2.5) so the
// bench harness and the shim can treat both drivers uniformly.
// ---------------------------------------------------------------------------

export type DriverErrorCode =
  | "CHROME_DEAD"
  | "NAV_FAILED"
  | "NAV_TIMEOUT"
  | "TAB_NOT_FOUND"
  | "TAB_FORBIDDEN"
  | "UID_NOT_FOUND"
  | "UID_STALE"
  | "ELEMENT_OCCLUDED"
  | "INTERNAL";

export class DriverError extends Error {
  readonly code: DriverErrorCode;
  readonly hint: string;

  constructor(code: DriverErrorCode, message: string, hint: string) {
    super(message);
    this.name = "DriverError";
    this.code = code;
    this.hint = hint;
  }
}

// ---------------------------------------------------------------------------
// Minimal WebSocket access without depending on DOM lib types. The runtime
// (Node ≥22, Bun) provides a global WebSocket; the structural cast below
// keeps `tsc --noEmit` green under lib ES2022 while failing loudly at
// runtime when the global is absent.
// ---------------------------------------------------------------------------

interface RawSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message" | "open" | "error" | "close",
    listener: (event: Record<string, unknown>) => void,
  ): void;
}

function createRawSocket(url: string): RawSocket {
  const holder = globalThis as unknown as {
    WebSocket?: new (url: string) => RawSocket;
  };
  if (!holder.WebSocket) {
    throw new DriverError(
      "INTERNAL",
      "global WebSocket is unavailable",
      "run on Node >= 22 or Bun; the JS baseline driver needs a runtime WebSocket",
    );
  }
  return new holder.WebSocket(url);
}

// ---------------------------------------------------------------------------
// CDP connection: JSON-RPC over one WebSocket with id-keyed pending calls
// and one-shot listeners for browser/page events (e.g. Page.loadEventFired).
// ---------------------------------------------------------------------------

const CDP_TIMEOUT_MS = 30_000;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type EventListener = (params: Record<string, unknown>) => void;

export class CdpConnection {
  private socket: RawSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly events = new Map<string, Set<EventListener>>();
  private closed = false;

  get isClosed(): boolean {
    return this.closed || this.socket === null;
  }

  async connect(url: string, timeoutMs = 10_000): Promise<void> {
    if (this.socket) return;
    const socket = createRawSocket(url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new DriverError(
            "CHROME_DEAD",
            `CDP websocket timed out: ${url}`,
            "Chrome started but its debugger socket never accepted; retry — the port may still be coming up",
          ),
        );
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(
          new DriverError(
            "CHROME_DEAD",
            `CDP websocket failed: ${url}`,
            "Chrome may have exited; check that the binary runs headless on this machine",
          ),
        );
      });
      socket.addEventListener("message", (event) => this.onMessage(event));
      socket.addEventListener("close", () => this.onClose());
    });
  }

  private onMessage(event: Record<string, unknown>): void {
    const raw = event["data"];
    if (typeof raw !== "string") return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return; // Never let a malformed frame kill the connection.
    }
    if (typeof message["id"] === "number") {
      const pending = this.pending.get(message["id"]);
      if (!pending) return;
      this.pending.delete(message["id"]);
      clearTimeout(pending.timer);
      if ("error" in message) {
        const err = message["error"] as Record<string, unknown>;
        pending.reject(
          new DriverError(
            "INTERNAL",
            `CDP error: ${String(err["message"] ?? err)}`,
            "the browser rejected the command; retry once, then re-snapshot",
          ),
        );
      } else {
        pending.resolve(message["result"] ?? null);
      }
      return;
    }
    if (typeof message["method"] === "string") {
      const listeners = this.events.get(message["method"]);
      if (!listeners || listeners.size === 0) return;
      const params = (message["params"] ?? {}) as Record<string, unknown>;
      for (const listener of [...listeners]) {
        try {
          listener(params);
        } catch {
          // A listener must never break event dispatch.
        }
      }
    }
  }

  private onClose(): void {
    this.closed = true;
    this.socket = null;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(
        new DriverError(
          "CHROME_DEAD",
          "CDP connection closed mid-call",
          "the browser process may have died; retry — the driver relaunches Chrome on next use",
        ),
      );
    }
  }

  send<T>(method: string, params?: Record<string, unknown>, timeoutMs = CDP_TIMEOUT_MS): Promise<T> {
    const socket = this.socket;
    if (!socket || this.closed) {
      return Promise.reject(
        new DriverError(
          "CHROME_DEAD",
          `cannot send ${method}: connection is closed`,
          "the browser process may have died; retry the call",
        ),
      );
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params: params ?? {} });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new DriverError(
            "INTERNAL",
            `CDP call ${method} timed out after ${timeoutMs}ms`,
            "the page may be hung; retry with a smaller page or a fresh navigation",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        socket.send(payload);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new DriverError(
            "CHROME_DEAD",
            `CDP send failed: ${error instanceof Error ? error.message : String(error)}`,
            "the browser socket broke; retry the call",
          ),
        );
      }
    });
  }

  /** Resolve with the params of the next event named `method`. */
  waitForEvent(method: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const listeners = this.events.get(method) ?? new Set<EventListener>();
      this.events.set(method, listeners);
      const timer = setTimeout(() => {
        listeners.delete(onEvent);
        reject(
          new DriverError(
            "NAV_TIMEOUT",
            `timed out waiting for ${method} after ${timeoutMs}ms`,
            "the page did not finish loading; retry with a larger timeout, or snapshot what has rendered so far",
          ),
        );
      }, timeoutMs);
      const onEvent = (params: Record<string, unknown>): void => {
        clearTimeout(timer);
        listeners.delete(onEvent);
        resolve(params);
      };
      listeners.add(onEvent);
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.closed = true;
    try {
      socket?.close(1000, "driver shutdown");
    } catch {
      // Closing a dead socket is not an error.
    }
  }
}

// ---------------------------------------------------------------------------
// Driver surface shared by the real driver and the mock (bench + tests).
// ---------------------------------------------------------------------------

export interface SnapshotNode {
  uid: string;
  role: string;
  name: string;
}

export interface SnapshotResult {
  tabId: string;
  url: string;
  text: string;
  nodes: SnapshotNode[];
  truncated: boolean;
  generation: number;
}

export interface NavigateResult {
  tabId: string;
  url: string;
  title: string;
  status: number;
}

export interface ScreenshotResult {
  bytes: number;
  width: number;
  height: number;
}

export interface BaselineDriver {
  readonly kind: string;
  launch(): Promise<void>;
  navigate(sessionId: string, url: string): Promise<NavigateResult>;
  snapshot(sessionId: string, maxNodes?: number): Promise<SnapshotResult>;
  click(sessionId: string, uid: string): Promise<{ ok: boolean }>;
  fill(sessionId: string, uid: string, value: string, submit?: boolean): Promise<{ ok: boolean }>;
  screenshot(sessionId: string): Promise<ScreenshotResult>;
  chromePid(): number | null;
  close(): Promise<void>;
}

export interface JsDriverOptions {
  chromePath?: string;
  headless?: boolean;
  timeoutMs?: number;
}

const LAUNCH_TIMEOUT_MS = 45_000;
const UID_SHAPE = /^g(\d+)-(\d+)$/;

interface TabState {
  targetId: string;
  conn: CdpConnection;
  generation: number;
  uids: Set<string>;
  url: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Parse `g{gen}-{n}`; null when the uid was never generated by us. */
export function parseUid(uid: string): { generation: number; index: number } | null {
  const match = UID_SHAPE.exec(uid);
  if (!match) return null;
  const generation = Number(match[1]);
  const index = Number(match[2]);
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(index)) return null;
  return { generation, index };
}

// ---------------------------------------------------------------------------
// JsDriver — one Chrome, N tabs, raw CDP only.
// ---------------------------------------------------------------------------

export class JsDriver implements BaselineDriver {
  readonly kind = "js";
  private readonly options: Required<JsDriverOptions>;
  private child: ChildProcess | null = null;
  private profileDir: string | null = null;
  private debugPort = 0;
  private browser: CdpConnection | null = null;
  private pid: number | null = null;
  private readonly tabs = new Map<string, TabState>();

  constructor(options: JsDriverOptions = {}) {
    this.options = {
      chromePath: options.chromePath ?? "",
      headless: options.headless ?? true,
      timeoutMs: options.timeoutMs ?? CDP_TIMEOUT_MS,
    };
  }

  chromePid(): number | null {
    return this.pid;
  }

  async launch(): Promise<void> {
    if (this.browser) return;
    const binary = this.options.chromePath || resolveChrome();
    if (!binary) {
      throw new DriverError(
        "CHROME_DEAD",
        "no Chrome binary found (CHROME_PATH, google-chrome, chromium)",
        "install Chromium or set CHROME_PATH to the binary",
      );
    }
    this.profileDir = mkdtempSync(join(tmpdir(), "jsdriver-profile-"));
    const args = [
      this.options.headless ? "--headless=new" : "--headless=old",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-extensions",
      "--mute-audio",
      "--hide-scrollbars",
      "--window-size=1280,800",
      `--user-data-dir=${this.profileDir}`,
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "about:blank",
    ];
    if (process.env["CHROME_NO_SANDBOX"] === "1") args.push("--no-sandbox");
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { stdio: "ignore" });
    } catch (error) {
      throw new DriverError(
        "CHROME_DEAD",
        `failed to spawn ${binary}: ${errorMessage(error)}`,
        "check that the binary is executable on this machine",
      );
    }
    this.child = child;
    this.pid = child.pid ?? null;
    child.on("exit", () => {
      this.pid = null;
    });

    const port = await readDebugPort(this.profileDir, LAUNCH_TIMEOUT_MS);
    this.debugPort = port;
    const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
      `http://127.0.0.1:${port}/json/version`,
      LAUNCH_TIMEOUT_MS,
    );
    const browserUrl = version.webSocketDebuggerUrl;
    if (!browserUrl) {
      throw new DriverError(
        "CHROME_DEAD",
        "Chrome answered /json/version without a debugger URL",
        "the Chrome build may not support remote debugging; try a stock Chromium",
      );
    }
    const browser = new CdpConnection();
    await browser.connect(browserUrl);
    this.browser = browser;
  }

  private async ensureTab(sessionId: string): Promise<TabState> {
    await this.launch();
    const existing = this.tabs.get(sessionId);
    if (existing && !existing.conn.isClosed) return existing;
    if (existing) this.tabs.delete(sessionId);

    const browser = this.browser;
    if (!browser) {
      throw new DriverError("CHROME_DEAD", "browser connection is gone", "retry the call");
    }
    let created: { targetId: string };
    try {
      created = await browser.send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });
    } catch (error) {
      throw new DriverError(
        "CHROME_DEAD",
        `Target.createTarget failed: ${errorMessage(error)}`,
        "Chrome may be at its target limit; retry after closing a tab",
      );
    }
    const wsUrl = await pollTargetWsUrl(this.debugPort, created.targetId, this.options.timeoutMs);
    const conn = new CdpConnection();
    await conn.connect(wsUrl);
    await conn.send("Page.enable");
    await conn.send("Runtime.enable");
    const tab: TabState = {
      targetId: created.targetId,
      conn,
      generation: 1,
      uids: new Set(),
      url: "about:blank",
    };
    this.tabs.set(sessionId, tab);
    return tab;
  }

  async navigate(sessionId: string, url: string): Promise<NavigateResult> {
    const tab = await this.ensureTab(sessionId);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new DriverError(
        "NAV_FAILED",
        `cannot navigate to ${url}: not a valid URL`,
        "pass an absolute http(s), about:, or data: URL",
      );
    }
    if (!["http:", "https:", "about:", "data:"].includes(parsed.protocol)) {
      throw new DriverError(
        "NAV_FAILED",
        `refusing to navigate to scheme ${parsed.protocol}`,
        "only http, https, about and data URLs are allowed in the JS baseline",
      );
    }
    const load = tab.conn.waitForEvent("Page.loadEventFired", this.options.timeoutMs);
    let status = 200;
    try {
      const result = await tab.conn.send<{ loaderId?: string }>("Page.navigate", { url });
      void result;
      await load;
    } catch (error) {
      if (error instanceof DriverError && error.code === "NAV_TIMEOUT") throw error;
      throw new DriverError(
        "NAV_FAILED",
        `navigation to ${url} failed: ${errorMessage(error)}`,
        "check the URL is reachable from this machine",
      );
    }
    const title = await this.evalTitle(tab);
    tab.generation += 1;
    tab.uids.clear();
    tab.url = url;
    return { tabId: tab.targetId, url, title, status };
  }

  async snapshot(sessionId: string, maxNodes = 300): Promise<SnapshotResult> {
    const tab = await this.ensureTab(sessionId);
    const limit = Math.max(1, Math.min(maxNodes, 2000));
    const expression = snapshotScript(tab.generation, limit);
    let raw: unknown;
    try {
      raw = await tab.conn.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
    } catch (error) {
      throw new DriverError(
        "INTERNAL",
        `snapshot script failed: ${errorMessage(error)}`,
        "retry the snapshot; if it keeps failing, re-navigate first",
      );
    }
    const payload = (raw as { result?: { value?: unknown } })?.result?.value as
      | { nodes?: SnapshotNode[]; url?: string; title?: string }
      | undefined;
    const nodes = Array.isArray(payload?.nodes) ? (payload?.nodes as SnapshotNode[]) : [];
    tab.uids = new Set(nodes.map((node) => node.uid));
    const pageUrl = typeof payload?.url === "string" ? payload.url : tab.url;
    const lines = [`url: ${pageUrl}  (gen g${tab.generation})`];
    for (const node of nodes) {
      lines.push(`[${node.uid}] ${node.role} "${node.name}"`);
    }
    const truncated = nodes.length >= limit;
    if (truncated) lines.push(`… capped at max_nodes=${limit}`);
    return {
      tabId: tab.targetId,
      url: pageUrl,
      text: lines.join("\n"),
      nodes,
      truncated,
      generation: tab.generation,
    };
  }

  async click(sessionId: string, uid: string): Promise<{ ok: boolean }> {
    const tab = await this.ensureTab(sessionId);
    const point = await this.resolvePoint(tab, uid);
    await tab.conn.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await tab.conn.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    return { ok: true };
  }

  async fill(
    sessionId: string,
    uid: string,
    value: string,
    submit = false,
  ): Promise<{ ok: boolean }> {
    const tab = await this.ensureTab(sessionId);
    this.checkUid(tab, uid);
    await this.evalExpression(
      tab,
      `((() => {
        const el = document.querySelector('[data-oc-uid="' + ${JSON.stringify(uid)} + '"]');
        if (!el) return { found: false };
        el.focus();
        try {
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
        } catch (e) { /* select() is best-effort on exotic inputs */ }
        return { found: true };
      })())`,
      "fill target is gone; re-run browse_snapshot",
    );
    await tab.conn.send("Input.insertText", { text: value });
    if (submit) {
      for (const type of ["keyDown", "keyUp"]) {
        await tab.conn.send("Input.dispatchKeyEvent", {
          type,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
      }
    }
    return { ok: true };
  }

  async screenshot(sessionId: string): Promise<ScreenshotResult> {
    const tab = await this.ensureTab(sessionId);
    const result = await tab.conn.send<{ data?: string }>("Page.captureScreenshot", {
      format: "png",
    });
    const data = result.data ?? "";
    return { bytes: Buffer.byteLength(data, "base64"), width: 1280, height: 800 };
  }

  async close(): Promise<void> {
    const tabs = [...this.tabs.values()];
    this.tabs.clear();
    for (const tab of tabs) {
      try {
        await tab.conn.close();
      } catch {
        // Best effort: every tab is torn down with the browser anyway.
      }
    }
    try {
      await this.browser?.close();
    } catch {
      // Ignore teardown errors; the process kill below is authoritative.
    }
    this.browser = null;
    const child = this.child;
    this.child = null;
    this.pid = null;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (this.profileDir) {
      const dir = this.profileDir;
      this.profileDir = null;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A stale temp profile is harmless; TMPDIR is swept by the OS.
      }
    }
  }

  // -- internals -----------------------------------------------------------

  private async evalTitle(tab: TabState): Promise<string> {
    try {
      const value = await this.evalExpression(tab, "document.title", "");
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }

  private async evalExpression(
    tab: TabState,
    expression: string,
    failHint: string,
  ): Promise<unknown> {
    let raw: unknown;
    try {
      raw = await tab.conn.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
    } catch (error) {
      throw new DriverError("INTERNAL", `page script failed: ${errorMessage(error)}`, failHint);
    }
    const result = (raw as { result?: Record<string, unknown> })?.result ?? {};
    if (result["subtype"] === "error" || result["exceptionDetails"] !== undefined) {
      throw new DriverError(
        "INTERNAL",
        "internal page script threw an exception",
        "retry the call; if it keeps failing, re-navigate first",
      );
    }
    const details = (raw as { exceptionDetails?: unknown })?.exceptionDetails;
    if (details !== undefined) {
      throw new DriverError("INTERNAL", "internal page script threw an exception", failHint);
    }
    return result["value"];
  }

  private checkUid(tab: TabState, uid: string): { generation: number; index: number } {
    const parsed = parseUid(uid);
    if (!parsed) {
      throw new DriverError(
        "UID_NOT_FOUND",
        `uid ${uid} was never issued by a snapshot`,
        "re-run browse_snapshot and use a uid from the new tree",
      );
    }
    if (parsed.generation !== tab.generation) {
      throw new DriverError(
        "UID_STALE",
        `uid ${uid} belongs to a previous page generation`,
        "the page changed; re-run browse_snapshot and use a uid from the new tree",
      );
    }
    if (!tab.uids.has(uid)) {
      throw new DriverError(
        "UID_NOT_FOUND",
        `uid ${uid} is not present in the current snapshot`,
        "re-run browse_snapshot; uids are only valid until the next navigation or snapshot",
      );
    }
    return parsed;
  }

  private async resolvePoint(tab: TabState, uid: string): Promise<{ x: number; y: number }> {
    this.checkUid(tab, uid);
    const value = (await this.evalExpression(
      tab,
      `((() => {
        const el = document.querySelector('[data-oc-uid="' + ${JSON.stringify(uid)} + '"]');
        if (!el) return { found: false };
        const r = el.getBoundingClientRect();
        const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
        const top = document.elementFromPoint(x, y);
        const blocked = !!top && top !== el && !el.contains(top);
        return { found: true, x, y, blockedBy: blocked ? top.tagName.toLowerCase() : null };
      })())`,
      "click target is gone; re-run browse_snapshot",
    )) as { found?: boolean; x?: number; y?: number; blockedBy?: string | null } | null;
    if (!value || value.found !== true || typeof value.x !== "number") {
      throw new DriverError(
        "UID_NOT_FOUND",
        `uid ${uid} is not present in the current snapshot`,
        "re-run browse_snapshot; uids are only valid until the next navigation or snapshot",
      );
    }
    if (value.blockedBy) {
      throw new DriverError(
        "ELEMENT_OCCLUDED",
        `click target is covered by ${value.blockedBy}`,
        "dismiss the covering element (cookie banner/modal) before clicking",
      );
    }
    return { x: value.x, y: value.y ?? 0 };
  }
}

// ---------------------------------------------------------------------------
// Chrome discovery helpers.
// ---------------------------------------------------------------------------

function resolveChrome(): string | null {
  const explicit = process.env["CHROME_PATH"];
  if (explicit) return explicit;
  for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
    const found = findOnPath(name);
    if (found) return found;
  }
  return null;
}

function findOnPath(name: string): string | null {
  const pathEnv = process.env["PATH"];
  if (!pathEnv) return null;
  // Synchronous PATH scan without extra imports (node:fs/promises not needed).
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of pathEnv.split(sep)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not executable here; keep scanning.
    }
  }
  return null;
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function readDebugPort(profileDir: string, timeoutMs: number): Promise<number> {
  const file = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  const fs = await import("node:fs");
  while (Date.now() < deadline) {
    try {
      // Line 1 is the port, line 2 is the browser id ("/devtools/browser/…").
      const firstLine = (fs.readFileSync(file, "utf8").split("\n")[0] ?? "").trim();
      const port = Number(firstLine);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    } catch {
      // Chrome has not written the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new DriverError(
    "CHROME_DEAD",
    "Chrome did not write DevToolsActivePort in time",
    "the binary may have crashed on startup; try running it headless by hand",
  );
}

async function pollTargetWsUrl(
  debugPort: number,
  targetId: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson<Array<{ id?: string; webSocketDebuggerUrl?: string }>>(
        `http://127.0.0.1:${debugPort}/json/list`,
        5000,
      );
      const match = targets.find((target) => target.id === targetId);
      if (match?.webSocketDebuggerUrl) return match.webSocketDebuggerUrl;
    } catch {
      // Target list is eventually consistent right after creation.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new DriverError(
    "TAB_NOT_FOUND",
    `target ${targetId} never exposed a debugger URL`,
    "retry the call; if it keeps failing, restart the driver",
  );
}

function snapshotScript(generation: number, maxNodes: number): string {
  return `(() => {
    const GEN = ${generation};
    const MAX = ${maxNodes};
    const SELECTOR = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="switch"],[role="radio"],[role="tab"],[role="menuitem"],[tabindex]:not([tabindex="-1"])';
    const ROLE_FOR_TAG = { a: "link", button: "button", input: "textbox", select: "select", textarea: "textbox" };
    const out = [];
    const seen = new Set();
    let n = 0;
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (!(el instanceof HTMLElement)) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      n += 1;
      const uid = "g" + GEN + "-" + n;
      el.setAttribute("data-oc-uid", uid);
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || ROLE_FOR_TAG[tag] || tag;
      const rawName = el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("href") || "";
      const name = String(rawName).trim().replace(/\\s+/g, " ").slice(0, 80);
      out.push({ uid, tag, role, name });
      if (out.length >= MAX) break;
    }
    return { nodes: out, url: location.href, title: document.title };
  })()`;
}

// ---------------------------------------------------------------------------
// Mock driver — same method names and error codes, simulated latencies.
// Used by `scripts/bench.mjs --mock` and shim unit tests; never ships as
// the default backend without a real measurement behind it.
// ---------------------------------------------------------------------------

export interface MockDriverOptions {
  seed?: number;
  latencyMs?: { navigate?: number; snapshot?: number; click?: number; fill?: number; screenshot?: number };
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

export class MockDriver implements BaselineDriver {
  readonly kind = "mock";
  private readonly random: () => number;
  private readonly latency: Required<NonNullable<MockDriverOptions["latencyMs"]>>;
  private readonly tabs = new Map<string, { generation: number; uids: string[] }>();
  private launched = false;

  constructor(options: MockDriverOptions = {}) {
    this.random = lcg(options.seed ?? 1234);
    this.latency = {
      navigate: options.latencyMs?.navigate ?? 9,
      snapshot: options.latencyMs?.snapshot ?? 11,
      click: options.latencyMs?.click ?? 5,
      fill: options.latencyMs?.fill ?? 5,
      screenshot: options.latencyMs?.screenshot ?? 13,
    };
  }

  chromePid(): number | null {
    return null;
  }

  async launch(): Promise<void> {
    this.launched = true;
    await this.sleep(120); // Simulated cold start (process + first browser).
  }

  async navigate(sessionId: string, url: string): Promise<NavigateResult> {
    this.ensureLaunched();
    const tab = this.tabFor(sessionId);
    tab.generation += 1;
    tab.uids = [`g${tab.generation}-1`, `g${tab.generation}-2`];
    await this.sleep(this.latency.navigate * (0.8 + this.random() * 0.4));
    return { tabId: `mock-${sessionId}`, url, title: "Mock page", status: 200 };
  }

  async snapshot(sessionId: string, maxNodes = 300): Promise<SnapshotResult> {
    this.ensureLaunched();
    const tab = this.tabFor(sessionId);
    const nodes: SnapshotNode[] = tab.uids.slice(0, maxNodes).map((uid, i) => ({
      uid,
      role: i === 0 ? "textbox" : "button",
      name: i === 0 ? "Email" : "Sign in",
    }));
    await this.sleep(this.latency.snapshot * (0.8 + this.random() * 0.4));
    const text = [`url: mock://page  (gen g${tab.generation})`]
      .concat(nodes.map((node) => `[${node.uid}] ${node.role} "${node.name}"`))
      .join("\n");
    return {
      tabId: `mock-${sessionId}`,
      url: "mock://page",
      text,
      nodes,
      truncated: false,
      generation: tab.generation,
    };
  }

  async click(sessionId: string, uid: string): Promise<{ ok: boolean }> {
    this.ensureLaunched();
    this.checkUid(sessionId, uid);
    await this.sleep(this.latency.click * (0.8 + this.random() * 0.4));
    return { ok: true };
  }

  async fill(sessionId: string, uid: string, value: string): Promise<{ ok: boolean }> {
    this.ensureLaunched();
    void value;
    this.checkUid(sessionId, uid);
    await this.sleep(this.latency.fill * (0.8 + this.random() * 0.4));
    return { ok: true };
  }

  async screenshot(sessionId: string): Promise<ScreenshotResult> {
    this.ensureLaunched();
    this.tabFor(sessionId);
    await this.sleep(this.latency.screenshot * (0.8 + this.random() * 0.4));
    return { bytes: 42_000, width: 1280, height: 800 };
  }

  async close(): Promise<void> {
    this.launched = false;
  }

  private ensureLaunched(): void {
    if (!this.launched) {
      throw new DriverError("CHROME_DEAD", "mock driver is not launched", "call launch() first");
    }
  }

  private tabFor(sessionId: string): { generation: number; uids: string[] } {
    let tab = this.tabs.get(sessionId);
    if (!tab) {
      tab = { generation: 1, uids: ["g1-1", "g1-2"] };
      this.tabs.set(sessionId, tab);
    }
    return tab;
  }

  private checkUid(sessionId: string, uid: string): void {
    const tab = this.tabFor(sessionId);
    const parsed = parseUid(uid);
    if (!parsed) {
      throw new DriverError(
        "UID_NOT_FOUND",
        `uid ${uid} was never issued by a snapshot`,
        "re-run browse_snapshot and use a uid from the new tree",
      );
    }
    if (parsed.generation !== tab.generation) {
      throw new DriverError(
        "UID_STALE",
        `uid ${uid} belongs to a previous page generation`,
        "the page changed; re-run browse_snapshot and use a uid from the new tree",
      );
    }
    if (!tab.uids.includes(uid)) {
      throw new DriverError(
        "UID_NOT_FOUND",
        `uid ${uid} is not present in the current snapshot`,
        "re-run browse_snapshot; uids are only valid until the next navigation or snapshot",
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export type BaselineDriverKind = "js" | "mock";

export function createBaselineDriver(
  kind: BaselineDriverKind = "js",
  options: JsDriverOptions & MockDriverOptions = {},
): BaselineDriver {
  if (kind === "mock") return new MockDriver(options);
  return new JsDriver(options);
}
