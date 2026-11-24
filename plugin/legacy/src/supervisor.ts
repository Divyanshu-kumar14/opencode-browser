/**
 * Supervisor: connect to the daemon, or spawn it and retry (plan §Phase 2).
 *
 * - Socket lives at `$XDG_RUNTIME_DIR/opencode-browser/v1/daemon.sock`
 *   (mirrors `daemon/src/paths.rs`), overridable via `OPENCODE_BROWSER_SOCKET`.
 * - Binary resolves to `prebuilds/<platform>/browserd` inside the installed
 *   package (repo fallback: `<repo>/prebuilds/...`), overridable via
 *   `OPENCODE_BROWSERD_BIN`. The daemon is spawned detached with
 *   `stdio:"ignore"` and is **never killed on plugin unload** — it outlives
 *   server restarts by design.
 * - After connect, a `hello` handshake checks the protocol major; a mismatch
 *   throws `PROTOCOL_MISMATCH` with an actionable hint instead of talking to
 *   a daemon we cannot understand.
 * - Backoff between spawn retries is capped at 2 s per the plan.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DaemonError } from "./errors.ts";
import { PROTOCOL, RpcClient } from "./rpc.ts";

export const SOCKET_ENV = "OPENCODE_BROWSER_SOCKET";
export const BIN_ENV = "OPENCODE_BROWSERD_BIN";
/** Explicit opt-in for attach auto-detect. Never probed unless `"1"`. */
export const ATTACH_ENV = "OPENCODE_BROWSER_ATTACH";
/**
 * Explicit attach endpoint (`http://127.0.0.1:9222`); unset means probe the
 * default below. Also passed to the daemon child when a debuggable target
 * answers, so a capable daemon can attach instead of launching.
 */
export const ATTACH_URL_ENV = "OPENCODE_BROWSER_ATTACH_URL";
/** Localhost-only default probe. A literal IP, never a resolvable hostname. */
export const ATTACH_PROBE_URL = "http://127.0.0.1:9222/json/version";
/** Probe budget: a local Chrome answers in ms; bounds opt-in startup cost. */
export const ATTACH_PROBE_TIMEOUT_MS = 2_000;
/** Per-attempt pause after spawning, in ms. Capped at 2 s per the plan. */
const RETRY_DELAYS_MS = [50, 100, 250, 500, 1000, 1500, 2000];
const HELLO_TIMEOUT_MS = 5_000;

/** Mirrors `daemon/src/paths.rs::runtime_dir`. */
export function runtimeDir(): string {
  const xdg = process.env["XDG_RUNTIME_DIR"];
  if (xdg !== undefined && xdg.length > 0) {
    return path.join(xdg, "opencode-browser", "v1");
  }
  const tmp = process.env["TMPDIR"];
  const base = tmp !== undefined && tmp.length > 0 ? tmp : "/tmp";
  const euid =
    typeof process.geteuid === "function" ? process.geteuid() : 0;
  return path.join(base, `opencode-browser-${euid}`, "v1");
}

/** Test seam: `OPENCODE_BROWSER_SOCKET` wins, else the canonical path. */
export function socketPath(): string {
  const override = process.env[SOCKET_ENV];
  if (override !== undefined && override.length > 0) return override;
  return path.join(runtimeDir(), "daemon.sock");
}

/** This file lives in `<package>/src`; the package root is its parent. */
function packageRoot(): string {
  return path.resolve(import.meta.dir, "..");
}

function platformDir(): string {
  return `${os.platform()}-${os.arch()}`;
}

/**
 * Candidate binaries. An explicit `OPENCODE_BROWSERD_BIN` is exclusive: a
 * broken override must fail loudly instead of silently falling back to a
 * different binary. Otherwise try the installed package layout
 * (`<pkg>/prebuilds/<platform>/browserd`), then the repo checkout layout
 * (`<repo>/prebuilds/...`, one level above the plugin package).
 */
export function binaryCandidates(): string[] {
  const override = process.env[BIN_ENV];
  if (override !== undefined && override.length > 0) return [override];
  const rel = path.join("prebuilds", platformDir(), "browserd");
  return [
    path.join(packageRoot(), rel),
    path.resolve(packageRoot(), "..", rel),
  ];
}

/** First candidate that exists and is executable, or null. */
export function resolveBinary(): string | null {
  for (const candidate of binaryCandidates()) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not there / not executable — try the next candidate.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Attach auto-detect (explicit opt-in only).
//
// When `OPENCODE_BROWSER_ATTACH=1` and no `OPENCODE_BROWSER_ATTACH_URL` is
// set, the supervisor probes the loopback debug endpoint before spawning:
// a debuggable local Chrome yields its endpoint to the daemon child,
// anything else falls back to a fresh launch with a clear log line. No
// probe, no attach, and no log line unless the operator opted in.
// ---------------------------------------------------------------------------

/** True only on the explicit `"1"`: attach is never silent or default. */
export function attachOptIn(): boolean {
  return process.env[ATTACH_ENV] === "1";
}

/** Hosts that are unambiguously this machine. Anything else is refused. */
function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "127.0.0.1" || lower === "::1" || lower === "[::1]") {
    return true;
  }
  // 127/8 literals need no DNS; validate each octet so `127.999.1.1`
  // (which never routes to loopback) cannot slip through.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) {
    return lower
      .split(".")
      .slice(1)
      .every((octet) => Number(octet) <= 255);
  }
  return false;
}

function attachRefused(url: string, why: string): DaemonError {
  return new DaemonError(
    "PERMISSION_DENIED",
    `refusing Chrome attach target ${url}: ${why}`,
    `attach is localhost-only and explicit: set ${ATTACH_URL_ENV} to a ` +
      `127.0.0.1 http(s) URL from a debug-enabled Chrome ` +
      `(--remote-debugging-port=9222), or unset ${ATTACH_ENV} to launch a fresh browser`,
  );
}

/**
 * Endpoint to probe, or null when attach was not opted in. An explicit
 * `OPENCODE_BROWSER_ATTACH_URL` wins; otherwise the loopback default.
 * Throws (fail closed) on an unparseable, non-http(s), or non-loopback
 * override — such a URL is never fetched.
 */
export function resolveAttachProbeUrl(): string | null {
  if (!attachOptIn()) return null;
  const override = process.env[ATTACH_URL_ENV];
  if (override === undefined || override.length === 0) return ATTACH_PROBE_URL;
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw attachRefused(override, "not a parseable URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw attachRefused(override, `scheme ${parsed.protocol} is not http(s)`);
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw attachRefused(override, `host ${parsed.hostname} is not loopback`);
  }
  return `${parsed.origin}/json/version`;
}

/**
 * Probe a local Chrome's `/json/version`. Returns the debugger WebSocket URL
 * when a debuggable loopback target answers, null when nothing usable is
 * there (refused, timeout, non-2xx, or no debugger URL). Throws only for a
 * non-loopback debugger URL — fail closed, never hand a remote browser on.
 */
export async function probeAttachTarget(
  probeUrl: string,
  timeoutMs: number = ATTACH_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(probeUrl);
  } catch {
    return null;
  }
  // Belt and braces: even the default constant passes through the gate, so
  // no packet ever leaves this machine for a non-loopback host.
  if (!isLoopbackHost(parsed.hostname)) {
    throw attachRefused(probeUrl, `host ${parsed.hostname} is not loopback`);
  }
  let response: Response;
  try {
    response = await fetch(`${parsed.origin}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
      proxy: false,
    });
  } catch {
    // Unreachable or timed out: not an error, just no debuggable Chrome.
    return null;
  }
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const wsUrl =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)["webSocketDebuggerUrl"]
      : undefined;
  if (typeof wsUrl !== "string" || wsUrl.length === 0) return null;
  let ws: URL;
  try {
    ws = new URL(wsUrl);
  } catch {
    return null;
  }
  if (ws.protocol !== "ws:" && ws.protocol !== "wss:") return null;
  if (!isLoopbackHost(ws.hostname)) {
    throw attachRefused(probeUrl, `debugger URL points at ${ws.hostname}`);
  }
  return wsUrl;
}

/**
 * Extra env for the daemon child. `{}` unless explicitly opted in. On
 * opt-in the local probe runs (bounded by `ATTACH_PROBE_TIMEOUT_MS`): a
 * debuggable Chrome yields its endpoint, otherwise we log the fallback and
 * launch fresh. Only a non-loopback target throws (fail closed).
 */
export async function resolveAttachEnv(): Promise<Record<string, string>> {
  const probeUrl = resolveAttachProbeUrl();
  if (probeUrl === null) return {};
  const wsUrl = await probeAttachTarget(probeUrl);
  if (wsUrl === null) {
    console.error(
      `[browse] attach probe ${probeUrl} found no debuggable Chrome — ` +
        `launching a fresh browser (opt out: unset ${ATTACH_ENV})`,
    );
    return {};
  }
  console.error(
    `[browse] requesting attachment to the debuggable Chrome at ${probeUrl} ` +
      `(explicit opt-in ${ATTACH_ENV}=1)`,
  );
  return { [ATTACH_URL_ENV]: wsUrl };
}

let cachedVersion: string | null = null;

/** Version of the installed shim, for the `hello` handshake. */
export function shimVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const raw = fs.readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    const version =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["version"]
        : undefined;
    cachedVersion = typeof version === "string" ? version : "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Connect and handshake. Returns null when nothing is listening (spawn path);
 * throws when the daemon answers but is unusable (protocol mismatch, hello
 * rejection, wedged daemon) — spawning cannot fix those.
 */
async function tryHello(sock: string): Promise<RpcClient | null> {
  const client = new RpcClient(sock);
  try {
    await client.connect();
  } catch {
    client.dispose();
    return null;
  }
  let hello: unknown;
  try {
    hello = await client.request(
      "hello",
      { protocol: PROTOCOL, shimVersion: shimVersion() },
      { timeoutMs: HELLO_TIMEOUT_MS },
    );
  } catch (error) {
    client.dispose();
    throw error;
  }
  const protocol =
    typeof hello === "object" && hello !== null
      ? (hello as Record<string, unknown>)["protocol"]
      : undefined;
  if (protocol !== PROTOCOL) {
    client.dispose();
    throw DaemonError.protocolMismatch(sock, protocol);
  }
  return client;
}

/** Spawn detached, fully dissociated; never reaped or killed by us. */
function spawnDetached(
  binary: string,
  extraEnv: Record<string, string> = {},
): void {
  const child = spawn(binary, [], {
    detached: true,
    stdio: "ignore",
    // Clear the inherited probe override on fallback or opt-out. Only a
    // validated WebSocket endpoint may reach the daemon attach path.
    env: { ...process.env, [ATTACH_URL_ENV]: "", ...extraEnv },
  });
  // An async ENOENT (override removed between preflight and spawn) must not
  // crash the server as an unhandled 'error' event.
  child.once("error", () => {});
  child.unref();
}

async function connectOrSpawn(): Promise<RpcClient> {
  const sock = socketPath();
  const direct = await tryHello(sock);
  if (direct !== null) return direct;

  const binary = resolveBinary();
  if (binary === null) {
    throw DaemonError.unavailable(
      sock,
      `nothing listening and no browserd binary found (looked at: ${binaryCandidates().join(", ")})`,
    );
  }
  // Attach auto-detect (explicit opt-in only; {} and a plain launch otherwise).
  spawnDetached(binary, await resolveAttachEnv());

  let lastError: unknown = null;
  for (const delay of RETRY_DELAYS_MS) {
    await sleep(delay);
    try {
      const client = await tryHello(sock);
      if (client !== null) return client;
    } catch (error) {
      lastError = error;
      // A live answer that rejects us (protocol mismatch, wedged daemon) will
      // not heal by waiting — surface it now instead of burning the backoff.
      if (
        error instanceof DaemonError &&
        error.code !== "DAEMON_UNAVAILABLE"
      ) {
        throw error;
      }
    }
  }
  const detail =
    lastError instanceof Error ? `: ${lastError.message}` : "";
  throw DaemonError.unavailable(
    sock,
    `spawned ${binary} but no daemon answered the socket${detail}`,
  );
}

let cached: RpcClient | null = null;
let inflight: Promise<RpcClient> | null = null;

/**
 * Shared client for all tools in this server process. Concurrent callers share
 * one in-flight attempt; a dead connection is dropped so the next call
 * reconnects (or respawns). The daemon itself is never killed here.
 */
export async function getClient(): Promise<RpcClient> {
  if (cached !== null && cached.connected) return cached;
  if (cached !== null) {
    cached.dispose();
    cached = null;
  }
  inflight ??= connectOrSpawn().finally(() => {
    inflight = null;
  });
  const client = await inflight;
  cached = client;
  return client;
}

/** Test seam: drop the shared client so the next `getClient` redials. */
export function __resetSupervisorForTests(): void {
  inflight = null;
  const previous = cached;
  cached = null;
  try {
    previous?.dispose();
  } catch {
    // Best-effort.
  }
}
