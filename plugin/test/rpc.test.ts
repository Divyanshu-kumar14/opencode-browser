/**
 * rpc.ts: framing, multiplexing, timeouts, abort→cancel, error mapping.
 */

import { describe, expect, test } from "bun:test";
import * as net from "node:net";
import { DaemonError } from "../src/errors.ts";
import { RpcClient } from "../src/rpc.ts";
import { startMockDaemon } from "./mock-daemon.ts";

describe("RpcClient framing", () => {
  test("multiplexed concurrent requests resolve by id, even out of order", async () => {
    const mock = await startMockDaemon({
      slow: () =>
        new Promise((resolve) => setTimeout(() => resolve({ n: 1 }), 50)),
      fast: () => ({ n: 2 }),
    });
    try {
      const client = new RpcClient(mock.socketPath);
      await client.connect();
      const [slow, fast] = await Promise.all([
        client.request("slow"),
        client.request("fast"),
      ]);
      expect(slow).toEqual({ n: 1 });
      expect(fast).toEqual({ n: 2 });
      client.dispose();
    } finally {
      await mock.close();
    }
  });

  test("split writes and multiple lines per chunk reassemble", async () => {
    const received: string[] = [];
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let incoming = "";
      socket.on("data", (chunk: string) => {
        incoming += chunk;
        let newline: number;
        while ((newline = incoming.indexOf("\n")) >= 0) {
          const line = incoming.slice(0, newline);
          incoming = incoming.slice(newline + 1);
          if (line.trim().length === 0) continue;
          received.push(line);
          const message = JSON.parse(line) as { id: unknown };
          // One response split across two writes; two responses one chunk.
          if (received.length === 1) {
            const full = JSON.stringify({ id: message.id, ok: true, result: { a: 1 } }) + "\n";
            socket.write(full.slice(0, 10));
            setTimeout(() => socket.write(full.slice(10)), 5);
          } else {
            socket.write(
              JSON.stringify({ id: message.id, ok: true, result: { b: 2 } }) + "\n" +
                JSON.stringify({ id: "stray", ok: true, result: {} }) + "\n",
            );
          }
        }
      });
    });
    const socketPath = `/tmp/browserd-framing-${process.pid}.sock`;
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = new RpcClient(socketPath);
      await client.connect();
      expect(await client.request("one")).toEqual({ a: 1 });
      expect(await client.request("two")).toEqual({ b: 2 });
      client.dispose();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("daemon ok:false rejects with a DaemonError carrying code + hint", async () => {
    const mock = await startMockDaemon({
      click: () => {
        throw {
          code: "UID_STALE",
          message: "uid g7-3 belongs to a previous page generation",
          hint: "re-run browser_snapshot",
        };
      },
    });
    try {
      const client = new RpcClient(mock.socketPath);
      await client.connect();
      const error = await client.request("click", { uid: "g7-3" }).catch((e) => e);
      expect(error).toBeInstanceOf(DaemonError);
      expect((error as DaemonError).code).toBe("UID_STALE");
      expect((error as DaemonError).hint).toContain("browser_snapshot");
      client.dispose();
    } finally {
      await mock.close();
    }
  });

  test("30 s default is overridable: slow daemon hits a short timeout", async () => {
    const mock = await startMockDaemon({
      slow: () =>
        new Promise((resolve) => setTimeout(() => resolve({}), 500)),
    });
    try {
      const client = new RpcClient(mock.socketPath);
      await client.connect();
      const error = await client
        .request("slow", {}, { timeoutMs: 50 })
        .catch((e) => e);
      expect(error).toBeInstanceOf(DaemonError);
      expect((error as DaemonError).code).toBe("INTERNAL");
      expect((error as Error).message).toContain("50 ms");
      client.dispose();
    } finally {
      await mock.close();
    }
  });

  test("AbortSignal sends an id-less cancel notification and rejects", async () => {
    const mock = await startMockDaemon({
      slow: () =>
        new Promise((resolve) => setTimeout(() => resolve({}), 500)),
    });
    try {
      const client = new RpcClient(mock.socketPath);
      await client.connect();
      const controller = new AbortController();
      const pending = client.request("slow", {}, { signal: controller.signal });
      controller.abort();
      const error = await pending.catch((e) => e);
      expect((error as Error).message).toContain("aborted");
      // Give the cancel line a tick to arrive.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const cancel = mock.received.find((line) => line.includes('"cancel"'));
      expect(cancel).toBeDefined();
      expect(JSON.parse(cancel as string)).not.toHaveProperty("id");
      client.dispose();
    } finally {
      await mock.close();
    }
  });

  test("request without connect throws instead of hanging", async () => {
    const client = new RpcClient("/tmp/definitely-not-here.sock");
    const error = await client.request("hello").catch((e) => e);
    expect(error).toBeInstanceOf(DaemonError);
    client.dispose();
  });
});
