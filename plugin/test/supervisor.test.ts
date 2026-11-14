/**
 * supervisor.ts: hello handshake, PROTOCOL_MISMATCH, DAEMON_UNAVAILABLE with
 * a hint, and reconnect after a daemon restart. The spawn path is exercised
 * only for its preflight failure (no binary in the test env) so tests never
 * exec anything.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { DaemonError } from "../src/errors.ts";
import { RpcClient } from "../src/rpc.ts";
import {
  __resetSupervisorForTests,
  BIN_ENV,
  getClient,
  resolveBinary,
  SOCKET_ENV,
} from "../src/supervisor.ts";
import { startMockDaemon, type MockDaemon } from "./mock-daemon.ts";

const savedSocket = process.env[SOCKET_ENV];
const savedBin = process.env[BIN_ENV];
let mocks: MockDaemon[] = [];

afterEach(async () => {
  for (const mock of mocks) await mock.close();
  mocks = [];
  __resetSupervisorForTests();
  if (savedSocket === undefined) delete process.env[SOCKET_ENV];
  else process.env[SOCKET_ENV] = savedSocket;
  if (savedBin === undefined) delete process.env[BIN_ENV];
  else process.env[BIN_ENV] = savedBin;
});

describe("supervisor", () => {
  test("connects and handshakes with a matching daemon", async () => {
    const mock = await startMockDaemon();
    mocks.push(mock);
    process.env[SOCKET_ENV] = mock.socketPath;
    process.env[BIN_ENV] = "/nonexistent/browserd";
    const client = await getClient();
    expect(client).toBeInstanceOf(RpcClient);
    expect(client.connected).toBe(true);
  });

  test("protocol mismatch refuses with an actionable error, no spawn", async () => {
    const mock = await startMockDaemon({
      hello: () => ({ protocol: 999, daemonVersion: "x" }),
    });
    mocks.push(mock);
    process.env[SOCKET_ENV] = mock.socketPath;
    const error = await getClient().catch((e) => e);
    expect(error).toBeInstanceOf(DaemonError);
    expect((error as DaemonError).code).toBe("PROTOCOL_MISMATCH");
    expect((error as DaemonError).hint).toContain("v1");
  });

  test("absent socket + no binary yields DAEMON_UNAVAILABLE with a hint, not a crash", async () => {
    process.env[SOCKET_ENV] = "/tmp/browserd-missing-test/daemon.sock";
    process.env[BIN_ENV] = "/nonexistent/browserd";
    expect(resolveBinary()).toBeNull();
    const error = await getClient().catch((e) => e);
    expect(error).toBeInstanceOf(DaemonError);
    expect((error as DaemonError).code).toBe("DAEMON_UNAVAILABLE");
    expect((error as DaemonError).hint.length).toBeGreaterThan(0);
  });

  test("reconnects after the daemon restarts", async () => {
    const first = await startMockDaemon({
      navigate: () => ({ tab_id: "t1", url: "https://a.example" }),
    });
    mocks.push(first);
    process.env[SOCKET_ENV] = first.socketPath;
    process.env[BIN_ENV] = "/nonexistent/browserd";

    const before = await getClient();
    expect(
      await before.request("navigate", { url: "https://a.example" }),
    ).toEqual({ tab_id: "t1", url: "https://a.example" });

    // Kill the daemon mid-session: in-flight client must not take us down.
    await first.close();
    mocks = [];
    __resetSupervisorForTests();

    // Restart on the same path; the next call must recover on its own.
    const second = await startMockDaemon({
      navigate: () => ({ tab_id: "t2", url: "https://b.example" }),
    });
    mocks.push(second);
    process.env[SOCKET_ENV] = second.socketPath;

    const after = await getClient();
    expect(
      await after.request("navigate", { url: "https://b.example" }),
    ).toEqual({ tab_id: "t2", url: "https://b.example" });
  });
});
