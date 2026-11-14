/**
 * NDJSON client for the browserd Unix socket (plan §2.2).
 *
 * Framing: one JSON object per line (embedded newlines are JSON-escaped, so a
 * `\n` split is safe). Frames are capped at 32 MiB. Requests carry string ids
 * echoed verbatim by the daemon; responses are multiplexed onto one connection
 * and routed by id, so out-of-order replies are fine.
 *
 * Timeout: 30 s default per request. `AbortSignal` sends a best-effort
 * `cancel` notification (`{ method:"cancel", params:{ id } }` — id-less, which
 * the daemon parses as a notification) and rejects the caller.
 */

import * as net from "node:net";
import { DaemonError, fromWire } from "./errors.ts";

export const PROTOCOL = 1;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export interface RequestOptions {
  readonly sessionID?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

function pendingKey(id: unknown): string {
  return typeof id === "string" ? `s:${id}` : `j:${JSON.stringify(id) ?? "null"}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export class RpcClient {
  private socket: net.Socket | null = null;
  private incoming = "";
  private readonly pending = new Map<string, Pending>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private nextId = 0;
  private disposed = false;
  private readonly timeoutMs: number;
  private readonly socketPath: string;

  constructor(socketPath: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  get connected(): boolean {
    const socket = this.socket;
    return (
      !this.disposed &&
      socket !== null &&
      !socket.destroyed &&
      !socket.pending
    );
  }

  /** Open the socket. Rejects with the raw system error; callers map it. */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.disposeSocket();
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const candidate = net.createConnection(this.socketPath);
      candidate.once("connect", () => resolve(candidate));
      candidate.once("error", reject);
    });
    this.attach(socket);
  }

  /**
   * One request → one `result` (or a `DaemonError` for `ok:false`).
   * Requires `connect()` first; throws `DaemonError(INTERNAL)` if not connected.
   */
  async request(
    method: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<unknown> {
    const socket = this.socket;
    if (this.disposed || socket === null || socket.destroyed) {
      throw new DaemonError(
        "INTERNAL",
        `not connected to the browser daemon (socket: ${this.socketPath})`,
        "this is a shim bug — the supervisor should have connected first; retry the call",
      );
    }
    const id = `c${++this.nextId}`;
    const key = pendingKey(id);
    const envelope: Record<string, unknown> = { id, method, params };
    if (options.sessionID) envelope["session"] = options.sessionID;
    const line = JSON.stringify(envelope) + "\n";

    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      const cleanup = (): void => {
        this.pending.delete(key);
        const timer = this.timers.get(key);
        if (timer !== undefined) {
          clearTimeout(timer);
          this.timers.delete(key);
        }
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (!this.pending.has(key)) return;
        cleanup();
        // Best-effort: the daemon treats an id-less `cancel` as a notification.
        this.notify("cancel", { id });
        reject(new Error(`request '${method}' aborted`));
      };

      if (options.signal?.aborted) {
        reject(new Error(`request '${method}' aborted`));
        return;
      }
      const timer = setTimeout(() => {
        if (!this.pending.has(key)) return;
        cleanup();
        reject(
          new DaemonError(
            "INTERNAL",
            `daemon did not answer '${method}' within ${timeoutMs} ms`,
            "the daemon may be overloaded or Chrome wedged; retry the call",
          ),
        );
      }, timeoutMs);
      // Unref so an in-flight request never keeps the server process alive.
      if (typeof timer.unref === "function") timer.unref();
      this.timers.set(key, timer);
      this.pending.set(key, {
        method,
        resolve: (value: unknown) => {
          cleanup();
          resolve(value);
        },
        reject: (error: unknown) => {
          cleanup();
          reject(error);
        },
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        socket.write(line, (error) => {
          if (error === null || error === undefined) return;
          if (!this.pending.has(key)) return;
          cleanup();
          reject(
            new DaemonError(
              "INTERNAL",
              `failed to send '${method}' to the daemon: ${errorMessage(error)}`,
              "the daemon socket broke mid-write; retry the call",
            ),
          );
        });
      } catch (error) {
        if (!this.pending.has(key)) return;
        cleanup();
        reject(
          new DaemonError(
            "INTERNAL",
            `failed to send '${method}' to the daemon: ${errorMessage(error)}`,
            "the daemon socket broke mid-write; retry the call",
          ),
        );
      }
    });
  }

  /** Fire-and-forget notification (no id, no response). Never throws. */
  notify(method: string, params: Record<string, unknown> = {}): void {
    try {
      this.socket?.write(JSON.stringify({ method, params }) + "\n");
    } catch {
      // Best-effort by design (cancel, shutdown hints).
    }
  }

  /** Reject everything in flight and destroy the socket. Idempotent. */
  dispose(): void {
    this.disposed = true;
    this.failAll(
      new DaemonError(
        "INTERNAL",
        "browser client was closed",
        "this is a shim bug; retry the call",
      ),
    );
    this.disposeSocket();
  }

  private attach(socket: net.Socket): void {
    this.disposeSocket();
    this.socket = socket;
    this.incoming = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (error: Error) => {
      this.failAll(
        new DaemonError(
          "INTERNAL",
          `daemon connection error: ${errorMessage(error)}`,
          "the daemon socket broke; retry the call to reconnect",
        ),
      );
    });
    socket.on("close", () => {
      this.disposeSocket();
      if (this.pending.size > 0) {
        this.failAll(
          new DaemonError(
            "INTERNAL",
            "daemon connection closed with requests in flight",
            "the daemon may have restarted; retry the call to reconnect",
          ),
        );
      }
    });
  }

  private onData(chunk: string): void {
    this.incoming += chunk;
    if (this.incoming.length > MAX_FRAME_BYTES + 1024) {
      this.failAll(
        new DaemonError(
          "INTERNAL",
          "daemon sent a frame larger than 32 MiB",
          "report this daemon bug; retry the call",
        ),
      );
      this.disposeSocket();
      return;
    }
    let newline: number;
    while ((newline = this.incoming.indexOf("\n")) >= 0) {
      const line = this.incoming.slice(0, newline);
      this.incoming = this.incoming.slice(newline + 1);
      if (line.trim().length === 0) continue;
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // NDJSON is newline-delimited, so one corrupt line cannot desync the
      // stream; skip it rather than killing healthy in-flight requests.
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const { id, ok, result, error } = message as Record<string, unknown>;
    if (id === undefined) return; // notification from the daemon; nothing waits on it
    const entry = this.pending.get(pendingKey(id));
    if (!entry) return; // late answer to an already timed-out/aborted request
    if (ok === true) {
      entry.resolve(result);
    } else {
      entry.reject(fromWire(error));
    }
  }

  private failAll(error: DaemonError): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const entry of waiting) entry.reject(error);
  }

  private disposeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.incoming = "";
    try {
      socket?.removeAllListeners("data");
      socket?.removeAllListeners("error");
      socket?.removeAllListeners("close");
      socket?.destroy();
    } catch {
      // Destroy is best-effort.
    }
  }
}
