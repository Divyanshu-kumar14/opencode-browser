/**
 * tools.ts: executor mapping, Tool.Error translation, eval permission gate,
 * screenshot file-content shape, and the 500-entry console/network bound.
 * The daemon is a scripted RpcClient double — no socket involved.
 */

import { describe, expect, test } from "bun:test";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { DaemonError } from "../src/errors.ts";
import { RpcClient } from "../src/rpc.ts";
import {
  createExecutors,
  EVAL_PERMISSION,
  formatConsole,
  formatNetwork,
  MAX_LOG_ENTRIES,
  toToolError,
  type BrowserDeps,
} from "../src/tools.ts";

function fakeContext(sessionID = "ses_test"): ToolContext {
  return {
    sessionID,
    agent: "agent_test",
    messageID: "msg_test",
    id: "call_test",
    signal: new AbortController().signal,
    progress: async () => {},
  } as unknown as ToolContext;
}

interface Script {
  result?: unknown;
  error?: { code: string; message: string; hint: string };
}

function fakeDeps(options: {
  scripts?: Record<string, Script>;
  calls?: { method: string; params: Record<string, unknown> }[];
  assertResources?: string[][];
  denyPermission?: boolean;
} = {}): BrowserDeps {
  const calls = options.calls ?? [];
  const assertResources = options.assertResources ?? [];
  const client = {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "list_tabs" && options.scripts?.["list_tabs"] === undefined) {
        return { tabs: [{ tab_id: "t1", url: "https://page.example", owner: "ses_test" }] };
      }
      const script = options.scripts?.[method];
      if (script?.error !== undefined) {
        throw new DaemonError(
          script.error.code as DaemonError["code"],
          script.error.message,
          script.error.hint,
        );
      }
      return script?.result ?? {};
    },
  } as unknown as RpcClient;
  return {
    permission: {
      assert: async (input: {
        sessionID: string;
        action: string;
        resources: string[];
      }) => {
        assertResources.push(input.resources);
        if (options.denyPermission === true) {
          throw new ToolError({
            message: "permission denied",
            metadata: { code: "PERMISSION_DENIED" },
          });
        }
      },
    },
    getClient: async () => client,
  };
}

describe("toToolError", () => {
  test("DaemonError keeps code + hint in metadata", () => {
    const converted = toToolError(
      new DaemonError("TAB_FORBIDDEN", "nope", "use your own tab"),
    );
    expect(converted).toBeInstanceOf(ToolError);
    expect(converted.message).toContain("TAB_FORBIDDEN");
    expect(converted.metadata).toMatchObject({
      code: "TAB_FORBIDDEN",
      hint: "use your own tab",
    });
  });

  test("Tool.Error passes through untouched", () => {
    const original = new ToolError({ message: "denied" });
    expect(toToolError(original)).toBe(original);
  });

  test("plain failures are wrapped, never thrown raw", () => {
    const converted = toToolError(new Error("boom"));
    expect(converted).toBeInstanceOf(ToolError);
    expect(converted.message).toContain("boom");
  });
});

describe("executors", () => {
  test("navigate maps the result to text + metadata", async () => {
    const deps = fakeDeps({
      scripts: {
        navigate: {
          result: { tab_id: "t1", url: "https://a.example", title: "A", status: 200 },
        },
      },
    });
    const out = await createExecutors(deps)["navigate"]?.(
      { url: "https://a.example" },
      fakeContext(),
    );
    expect(out?.content).toContain("https://a.example");
    expect(out?.metadata).toMatchObject({
      result: expect.objectContaining({ tab_id: "t1" }),
    });
  });

  test("daemon failure surfaces as Tool.Error with code + hint", async () => {
    const deps = fakeDeps({
      scripts: {
        click: {
          error: {
            code: "UID_STALE",
            message: "uid g7-3 belongs to a previous page generation",
            hint: "re-run browser_snapshot",
          },
        },
      },
    });
    const error = await createExecutors(deps)["click"]?.(
      { uid: "g7-3" },
      fakeContext(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).metadata).toMatchObject({
      code: "UID_STALE",
      hint: "re-run browser_snapshot",
    });
  });

  test("DAEMON_UNAVAILABLE from getClient surfaces with its hint, not a crash", async () => {
    const deps: BrowserDeps = {
      permission: { assert: async () => {} },
      getClient: async () => {
        throw DaemonError.unavailable("/run/x.sock", "nothing listening");
      },
    };
    const error = await createExecutors(deps)["list_tabs"]?.(
      {},
      fakeContext(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).metadata).toMatchObject({
      code: "DAEMON_UNAVAILABLE",
    });
    expect((error as ToolError).message).toContain("nothing listening");
  });

  test("screenshot returns file content + path metadata", async () => {
    const deps = fakeDeps({
      scripts: {
        screenshot: { result: { path: "/tmp/shot.png", width: 1280, height: 800 } },
      },
    });
    const out = await createExecutors(deps)["screenshot"]?.({}, fakeContext());
    expect(out?.content).toEqual([
      { type: "file", uri: "/tmp/shot.png", mime: "image/png" },
    ]);
    expect(out?.metadata).toMatchObject({ path: "/tmp/shot.png" });
  });

  test("screenshot without a path is an INTERNAL Tool.Error", async () => {
    const deps = fakeDeps({ scripts: { screenshot: { result: {} } } });
    const error = await createExecutors(deps)["screenshot"]?.(
      {},
      fakeContext(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).metadata).toMatchObject({ code: "INTERNAL" });
  });

  test("eval asserts browser_eval with the tab URL, then evaluates", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const assertResources: string[][] = [];
    const deps = fakeDeps({ calls, assertResources });
    const out = await createExecutors(deps)["eval"]?.(
      { js: "document.title", await_promise: true },
      fakeContext(),
    );
    expect(assertResources).toEqual([["https://page.example"]]);
    expect(calls.map((c) => c.method)).toEqual(["list_tabs", "eval"]);
    expect(calls[1]?.params).toMatchObject({
      js: "document.title",
      await_promise: true,
    });
    expect(typeof out?.content).toBe("string");
  });

  test("eval denial rejects with the permission error, never evaluates", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({ calls, denyPermission: true });
    const error = await createExecutors(deps)["eval"]?.(
      { js: "1+1" },
      fakeContext(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect(calls.map((c) => c.method)).toEqual(["list_tabs"]);
  });

  test("console caps limit at 500 and formats empty arrays", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({
      calls,
      scripts: { console: { result: { messages: [] } } },
    });
    const out = await createExecutors(deps)["console"]?.(
      { limit: 9999 },
      fakeContext(),
    );
    expect(calls[0]?.params).toMatchObject({ limit: MAX_LOG_ENTRIES });
    expect(MAX_LOG_ENTRIES).toBe(500);
    expect(out?.content).toBe("(no console messages)");
  });

  test("network forwards since cursor and formats rows", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({
      calls,
      scripts: {
        network: {
          result: {
            requests: [{ method: "GET", url: "https://x.example/a", status: 200 }],
          },
        },
      },
    });
    const out = await createExecutors(deps)["network"]?.(
      { since: 42, filter: "x.example" },
      fakeContext(),
    );
    expect(calls[0]?.params).toMatchObject({ since: 42, filter: "x.example" });
    expect(out?.content).toContain("GET https://x.example/a 200");
  });

  test("missing required params fail before any RPC", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({ calls });
    const error = await createExecutors(deps)["fill"]?.(
      { uid: "g7-1" },
      fakeContext(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect(calls).toEqual([]);
  });

  test("EVAL_PERMISSION constant matches the probe contract", () => {
    expect(EVAL_PERMISSION).toBe("browser_eval");
  });
});

describe("formatters", () => {
  test("console/network tolerate stub shapes", () => {
    expect(formatConsole({})).toBe("(no console messages)");
    expect(formatConsole({ messages: [{ level: "error", text: "x" }] })).toBe(
      "[error] x",
    );
    expect(formatNetwork({})).toBe("(no network requests)");
    expect(formatNetwork({ requests: [] })).toBe("(no network requests)");
  });
});
