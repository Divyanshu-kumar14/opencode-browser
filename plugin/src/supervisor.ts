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
 * Candidate binaries, in order: explicit env override, installed package
 * layout (`<pkg>/prebuilds/<platform>/browserd`), repo checkout layout
 * (`<repo>/prebuilds/...`, one level above the plugin package).
 */
export function binaryCandidates(): string[] {
  const override = process.env[BIN_ENV];
  const rel = path.join("prebuilds", platformDir(), "browserd");
  const candidates = [
    path.join(packageRoot(), rel),
    path.resolve(packageRoot(), "..", rel),
  ];
  return override !== undefined && override.length > 0
    ? [override, ...candidates]
    : candidates;
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
function spawnDetached(binary: string): void {
  const child = spawn(binary, [], {
    detached: true,
    stdio: "ignore",
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
  spawnDetached(binary);

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
