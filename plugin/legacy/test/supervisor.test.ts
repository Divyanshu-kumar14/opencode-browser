/**
 * supervisor.ts: hello handshake, PROTOCOL_MISMATCH, DAEMON_UNAVAILABLE with
 * a hint, and reconnect after a daemon restart. The spawn path is exercised
 * only for its preflight failure (no binary in the test env) so tests never
 * exec anything.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DaemonError } from "../src/errors.ts";
import { RpcClient } from "../src/rpc.ts";
import {
  __resetSupervisorForTests,
  ATTACH_ENV,
  ATTACH_URL_ENV,
  BIN_ENV,
  getClient,
  probeAttachTarget,
  resolveAttachEnv,
  resolveAttachProbeUrl,
  resolveBinary,
  SOCKET_ENV,
} from "../src/supervisor.ts";
import { startMockDaemon, type MockDaemon } from "./mock-daemon.ts";

const savedSocket = process.env[SOCKET_ENV];
const savedBin = process.env[BIN_ENV];
const savedAttach = process.env[ATTACH_ENV];
const savedAttachUrl = process.env[ATTACH_URL_ENV];
let mocks: MockDaemon[] = [];
const stubServers: Server[] = [];

async function closeStubs(): Promise<void> {
  while (stubServers.length > 0) {
    const server = stubServers.pop();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

/** Fake `:9222` origin: answers `/json/version` with the given handler. */
async function startVersionStub(
  handler: (reqBody: string) => { status: number; body: string },
): Promise<string> {
  const server = createServer((req, res) => {
    let incoming = "";
    req.on("data", (chunk: string) => {
      incoming += chunk;
    });
    req.on("end", () => {
      const { status, body } = handler(incoming);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  stubServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/json/version`;
}

afterEach(async () => {
  for (const mock of mocks) await mock.close();
  mocks = [];
  await closeStubs();
  __resetSupervisorForTests();
  if (savedSocket === undefined) delete process.env[SOCKET_ENV];
  else process.env[SOCKET_ENV] = savedSocket;
  if (savedBin === undefined) delete process.env[BIN_ENV];
  else process.env[BIN_ENV] = savedBin;
  if (savedAttach === undefined) delete process.env[ATTACH_ENV];
  else process.env[ATTACH_ENV] = savedAttach;
  if (savedAttachUrl === undefined) delete process.env[ATTACH_URL_ENV];
  else process.env[ATTACH_URL_ENV] = savedAttachUrl;
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

describe("attach auto-detect (D lane, C supervisor)", () => {
  const WS_URL = "ws://127.0.0.1:9222/devtools/browser/abc123";

  test("probe returns the debugger URL when a debuggable target answers", async () => {
    const probeUrl = await startVersionStub(() => ({
      status: 200,
      body: JSON.stringify({
        Browser: "Chrome/144.0",
        "webSocketDebuggerUrl": WS_URL,
      }),
    }));
    expect(await probeAttachTarget(probeUrl)).toBe(WS_URL);
  });

  test("accepts an IPv6 debugger URL returned by Chrome", async () => {
    const wsUrl = "ws://[::1]:9222/devtools/browser/ipv6";
    const probeUrl = await startVersionStub(() => ({
      status: 200, body: JSON.stringify({ webSocketDebuggerUrl: wsUrl }),
    }));
    expect(await probeAttachTarget(probeUrl)).toBe(wsUrl);
  });

  test("connects directly despite environment proxy settings", async () => {
    let proxyHits = 0;
    const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      proxyHits++;
      return new Response("proxy must not be used", { status: 502 });
    }});
    const probeUrl = await startVersionStub(() => ({
      status: 200, body: JSON.stringify({ webSocketDebuggerUrl: WS_URL }),
    }));
    try {
      const child = Bun.spawn([process.execPath, "-e", `
        import { probeAttachTarget } from ${JSON.stringify(new URL("../src/supervisor.ts", import.meta.url).pathname)};
        console.log(await probeAttachTarget(${JSON.stringify(probeUrl)}));
      `], {
        env: { ...process.env, HTTP_PROXY: proxy.url.toString(), HTTPS_PROXY: proxy.url.toString(),
          http_proxy: proxy.url.toString(), https_proxy: proxy.url.toString(), NO_PROXY: "", no_proxy: "" },
        stdout: "pipe", stderr: "pipe",
      });
      const output = await new Response(child.stdout).text();
      expect(output).toBe(`${WS_URL}\n`);
      expect(await child.exited).toBe(0);
      expect(proxyHits).toBe(0);
    } finally {
      proxy.stop(true);
    }
  });

  test("does not follow redirects", async () => {
    let destinationHits = 0;
    const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      destinationHits++;
      return Response.json({ webSocketDebuggerUrl: WS_URL });
    }});
    const redirect = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      return Response.redirect(destination.url.toString());
    }});
    try {
      expect(await probeAttachTarget(redirect.url.toString())).toBeNull();
      expect(destinationHits).toBe(0);
    } finally {
      redirect.stop(true);
      destination.stop(true);
    }
  });

  test("probe returns null when nothing listens (refused)", async () => {
    // Grab a loopback port, then close it: connecting must fail fast.
    const probeUrl = await startVersionStub(() => ({
      status: 200,
      body: "{}",
    }));
    await closeStubs();
    expect(await probeAttachTarget(probeUrl, 1_000)).toBeNull();
  });

  test("probe returns null on garbage: non-2xx, non-JSON, or no debugger URL", async () => {
    const missing = await startVersionStub(() => ({
      status: 404,
      body: "no such target",
    }));
    expect(await probeAttachTarget(missing)).toBeNull();

    const notJson = await startVersionStub(() => ({
      status: 200,
      body: "this is not json{{{",
    }));
    expect(await probeAttachTarget(notJson)).toBeNull();

    const noWsUrl = await startVersionStub(() => ({
      status: 200,
      body: JSON.stringify({ Browser: "Chrome/144.0" }),
    }));
    expect(await probeAttachTarget(noWsUrl)).toBeNull();
  });

  test("probe throws fail-closed on a non-loopback debugger URL", async () => {
    const probeUrl = await startVersionStub(() => ({
      status: 200,
      body: JSON.stringify({
        webSocketDebuggerUrl: "ws://203.0.3.9:9222/devtools/browser/evil",
      }),
    }));
    const error = await probeAttachTarget(probeUrl).catch((e) => e);
    expect(error).toBeInstanceOf(DaemonError);
    expect((error as DaemonError).code).toBe("PERMISSION_DENIED");
  });

  test("resolveAttachProbeUrl: no opt-in means no probe", () => {
    delete process.env[ATTACH_ENV];
    delete process.env[ATTACH_URL_ENV];
    expect(resolveAttachProbeUrl()).toBeNull();
  });

  test("resolveAttachProbeUrl: opt-in defaults to loopback :9222, explicit loopback override wins", () => {
    process.env[ATTACH_ENV] = "1";
    delete process.env[ATTACH_URL_ENV];
    expect(resolveAttachProbeUrl()).toBe(
      "http://127.0.0.1:9222/json/version",
    );
    process.env[ATTACH_URL_ENV] = "http://127.0.0.1:9333";
    expect(resolveAttachProbeUrl()).toBe("http://127.0.0.1:9333/json/version");
  });

  test("accepts an IPv6 loopback override", () => {
    process.env[ATTACH_ENV] = "1";
    process.env[ATTACH_URL_ENV] = "http://[::1]:9333";
    expect(resolveAttachProbeUrl()).toBe("http://[::1]:9333/json/version");
  });

  test("resolveAttachProbeUrl refuses non-loopback overrides, never fetched", () => {
    for (const override of [
      "http://example.com:9222",
      "http://192.168.1.10:9222",
      "file:///etc/passwd",
      "http://127.999.1.1:9222",
      "not a url",
    ]) {
      process.env[ATTACH_ENV] = "1";
      process.env[ATTACH_URL_ENV] = override;
      expect(() => resolveAttachProbeUrl()).toThrow(DaemonError);
    }
  });

  test("resolveAttachEnv: without opt-in there is no probe and no extra env", async () => {
    delete process.env[ATTACH_ENV];
    delete process.env[ATTACH_URL_ENV];
    expect(await resolveAttachEnv()).toEqual({});
  });

  test("resolveAttachEnv passes the probed WebSocket endpoint to the daemon", async () => {
    process.env[ATTACH_ENV] = "1";
    const probeUrl = await startVersionStub(() => ({
      status: 200, body: JSON.stringify({ webSocketDebuggerUrl: WS_URL }),
    }));
    process.env[ATTACH_URL_ENV] = probeUrl;
    expect(await resolveAttachEnv()).toEqual({ [ATTACH_URL_ENV]: WS_URL });
  });

  test("resolveAttachEnv: opt-in with no Chrome falls back to launch env", async () => {
    process.env[ATTACH_ENV] = "1";
    // Point at a closed loopback port: probe fails fast, fallback is `{}`.
    const probeUrl = await startVersionStub(() => ({
      status: 200,
      body: "{}",
    }));
    await closeStubs();
    process.env[ATTACH_URL_ENV] = probeUrl.replace("/json/version", "");
    expect(await resolveAttachEnv()).toEqual({});
  });
});
