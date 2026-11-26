/**
 * Network and console history per tab, no browser: fake pages emit events.
 */
import { describe, expect, test } from "bun:test";
import { NetworkLog } from "../src/core/network-log.ts";

function fakePage() {
  const handlers = new Map<string, ((arg: unknown) => void)[]>();
  return {
    on: (event: string, fn: (arg: unknown) => void) => void handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    emit: (event: string, arg: unknown) => handlers.get(event)?.forEach((fn) => fn(arg)),
  };
}

function request(url: string, method = "GET", type = "fetch", status: number | null = 200) {
  return {
    url: () => url,
    method: () => method,
    resourceType: () => type,
    response: async () => (status === null ? null : { status: () => status }),
    failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
  };
}

const consoleMsg = (type: string, text: string) => ({ type: () => type, text: () => text });

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("network log", () => {
  test("records requests with status, type and duration, URLs redacted", async () => {
    const log = new NetworkLog(100);
    const page = fakePage();
    log.attach(page as never);
    const r = request("https://api.test/items?token=SECRET&page=2", "POST", "xhr", 201);
    page.emit("request", r);
    page.emit("requestfinished", r);
    await flush();
    const [entry] = log.requests(page as never, {});
    expect(entry).toMatchObject({ method: "POST", type: "xhr", status: 201 });
    expect(entry!.url).toBe("https://api.test/items");
    expect(entry!.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("failed requests and HTTP errors are kept, and onlyErrors keeps just those", async () => {
    const log = new NetworkLog(100);
    const page = fakePage();
    log.attach(page as never);
    const ok = request("https://a.test/ok");
    const missing = request("https://a.test/missing", "GET", "fetch", 404);
    const refused = request("https://down.test/x", "GET", "fetch", null);
    for (const r of [ok, missing]) {
      page.emit("request", r);
      page.emit("requestfinished", r);
    }
    page.emit("request", refused);
    page.emit("requestfailed", refused);
    await flush();
    expect(log.requests(page as never, {}).map((e) => e.url)).toEqual(["https://a.test/ok", "https://a.test/missing", "https://down.test/x"]);
    const errors = log.requests(page as never, { onlyErrors: true });
    expect(errors.map((e) => e.status ?? e.failure)).toEqual([404, "net::ERR_CONNECTION_REFUSED"]);
  });

  test("console lines of every level are kept, sanitized and capped", () => {
    const log = new NetworkLog(100);
    const page = fakePage();
    log.attach(page as never);
    page.emit("console", consoleMsg("log", "hello"));
    page.emit("console", consoleMsg("warning", "careful\nnew line"));
    page.emit("console", consoleMsg("error", "x".repeat(1000)));
    const lines = log.console(page as never, {});
    expect(lines.map((l) => l.level)).toEqual(["log", "warning", "error"]);
    expect(lines[1]!.text).not.toContain("\n");
    expect(lines[2]!.text.length).toBeLessThanOrEqual(300);
    expect(log.console(page as never, { onlyErrors: true }).map((l) => l.level)).toEqual(["warning", "error"]);
  });

  test("a filter matches URL or text, case-insensitively, and a limit keeps the newest", async () => {
    const log = new NetworkLog(100);
    const page = fakePage();
    log.attach(page as never);
    for (let i = 0; i < 5; i++) {
      const r = request(`https://a.test/Items/${i}`);
      page.emit("request", r);
      page.emit("requestfinished", r);
      page.emit("console", consoleMsg("log", `Loaded item ${i}`));
    }
    await flush();
    expect(log.requests(page as never, { filter: "items/3" }).map((e) => e.url)).toEqual(["https://a.test/Items/3"]);
    expect(log.requests(page as never, { limit: 2 }).map((e) => e.url)).toEqual(["https://a.test/Items/3", "https://a.test/Items/4"]);
    expect(log.console(page as never, { filter: "ITEM 1" }).map((l) => l.text)).toEqual(["Loaded item 1"]);
  });

  test("the history is bounded per tab, and tabs do not see each other's", async () => {
    const log = new NetworkLog(3);
    const a = fakePage();
    const b = fakePage();
    log.attach(a as never);
    log.attach(b as never);
    for (let i = 0; i < 5; i++) a.emit("console", consoleMsg("log", `a${i}`));
    b.emit("console", consoleMsg("log", "b0"));
    expect(log.console(a as never, {}).map((l) => l.text)).toEqual(["a2", "a3", "a4"]);
    expect(log.console(b as never, {}).map((l) => l.text)).toEqual(["b0"]);
  });

  test("a request still in flight is listed as pending", () => {
    const log = new NetworkLog(100);
    const page = fakePage();
    log.attach(page as never);
    page.emit("request", request("https://slow.test/stream"));
    expect(log.requests(page as never, {})[0]).toMatchObject({ status: null, failure: null, pending: true });
  });
});
