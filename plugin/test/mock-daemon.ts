/**
 * In-process NDJSON mock daemon for shim tests. Speaks the plan §2.2
 * envelope over a Unix socket: routes `{ id, method, params }` to a handler
 * table, echoes `id` verbatim, records every raw line (for `cancel`
 * assertions). Tests inject failures by swapping handlers or killing the
 * server.
 */

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export type Handler = (
  params: Record<string, unknown>,
  session: unknown,
) => unknown;

export interface MockDaemon {
  readonly socketPath: string;
  readonly received: string[];
  setHandler(method: string, handler: Handler): void;
  close(): Promise<void>;
}

function helloResult(params: Record<string, unknown>): unknown {
  const protocol =
    typeof params["protocol"] === "number" ? params["protocol"] : 1;
  return {
    protocol,
    daemonVersion: "0.0.0-mock",
    chrome: { version: "mock", pid: 0 },
    capabilities: [],
  };
}

export async function startMockDaemon(
  handlers: Record<string, Handler> = {},
): Promise<MockDaemon> {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "browserd-test-"),
  );
  const socketPath = path.join(dir, "daemon.sock");
  const received: string[] = [];
  const table = new Map<string, Handler>(Object.entries(handlers));
  const openSockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    openSockets.add(socket);
    socket.on("close", () => {
      openSockets.delete(socket);
    });
    socket.setEncoding("utf8");
    let incoming = "";

    // One async task per line, like the daemon's per-request spawn: a slow
    // handler must never hold up lines received after it.
    const dispatch = (line: string): void => {
      void (async () => {
        received.push(line);
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        // Id-less notifications (cancel) get no reply.
        if (message["id"] === undefined) return;
        const method =
          typeof message["method"] === "string" ? message["method"] : "";
        const params =
          typeof message["params"] === "object" && message["params"] !== null
            ? (message["params"] as Record<string, unknown>)
            : {};
        const handler =
          table.get(method) ??
          (method === "hello" ? helloResult : undefined);
        if (handler === undefined) {
          if (!socket.destroyed) {
            socket.write(
              JSON.stringify({
                id: message["id"],
                ok: false,
                error: {
                  code: "INTERNAL",
                  message: `unknown method ${method}`,
                  hint: "mock",
                },
              }) + "\n",
            );
          }
          return;
        }
        try {
          const result = await handler(params, message["session"]);
          if (!socket.destroyed) {
            socket.write(
              JSON.stringify({ id: message["id"], ok: true, result }) + "\n",
            );
          }
        } catch (error) {
          const wire =
            typeof error === "object" &&
            error !== null &&
            "code" in error
              ? error
              : {
                  code: "INTERNAL",
                  message: String(error),
                  hint: "mock handler threw",
                };
          if (!socket.destroyed) {
            socket.write(
              JSON.stringify({ id: message["id"], ok: false, error: wire }) +
                "\n",
            );
          }
        }
      })();
    };

    socket.on("data", (chunk: string) => {
      incoming += chunk;
      let newline: number;
      while ((newline = incoming.indexOf("\n")) >= 0) {
        const line = incoming.slice(0, newline);
        incoming = incoming.slice(newline + 1);
        if (line.trim().length === 0) continue;
        dispatch(line);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  return {
    socketPath,
    received,
    setHandler(method: string, handler: Handler): void {
      table.set(method, handler);
    },
    async close(): Promise<void> {
      for (const socket of openSockets) {
        try {
          socket.destroy();
        } catch {
          // Best-effort.
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.promises.rm(dir, { recursive: true, force: true });
    },
  };
}
