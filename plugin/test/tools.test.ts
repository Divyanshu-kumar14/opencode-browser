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
  formatExpectText,
  formatWaitForUid,
  formatDialog,
  formatNetwork,
  formatScroll,
  formatSelect,
  formatUpload,
  MAX_LOG_ENTRIES,
  toToolError,
  UPLOAD_PERMISSION,
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
  sequences?: Record<string, Script[]>;
  calls?: { method: string; params: Record<string, unknown> }[];
  assertResources?: string[][];
  denyPermission?: boolean;
} = {}): BrowserDeps {
  const calls = options.calls ?? [];
  const assertResources = options.assertResources ?? [];
  const client = {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      const queue = options.sequences?.[method];
      if (queue !== undefined && queue.length > 0) {
        const next = queue.shift();
        if (next?.error !== undefined) {
          throw new DaemonError(
            next.error.code as DaemonError["code"],
            next.error.message,
            next.error.hint,
          );
        }
        return next?.result ?? {};
      }
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
            hint: "re-run browse_snapshot",
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
      hint: "re-run browse_snapshot",
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

  test("network forwards include_headers only when true", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({
      calls,
      scripts: { network: { result: { requests: [] } } },
    });
    await createExecutors(deps)["network"]?.({}, fakeContext());
    expect(calls[0]?.params).not.toHaveProperty("include_headers");
    await createExecutors(deps)["network"]?.(
      { include_headers: true },
      fakeContext(),
    );
    expect(calls[1]?.params).toMatchObject({ include_headers: true });
  });

  test("network renders redacted header lines", async () => {
    const deps = fakeDeps({
      scripts: {
        network: {
          result: {
            requests: [
              {
                method: "GET",
                url: "https://x.example/a",
                status: 200,
                kind: "xhr",
                ms: 12.4,
                request_headers: [
                  { name: "authorization", value: "[redacted]" },
                ],
                response_headers: [
                  { name: "content-type", value: "application/json" },
                ],
              },
            ],
          },
        },
      },
    });
    const out = await createExecutors(deps)["network"]?.(
      { include_headers: true },
      fakeContext(),
    );
    expect(out?.content).toContain("GET https://x.example/a 200 xhr 12ms");
    expect(out?.content).toContain("  > authorization: [redacted]");
    expect(out?.content).toContain("  < content-type: application/json");
  });

  test("network_body forwards request_id and formats the body", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({
      calls,
      scripts: {
        network_body: {
          result: {
            request_id: "r1",
            body: '{"ok":true}',
            bytes: 11,
            truncated: false,
          },
        },
      },
    });
    const out = await createExecutors(deps)["network_body"]?.(
      { request_id: "r1", max_bytes: 1024 },
      fakeContext(),
    );
    expect(calls[0]?.method).toBe("network_body");
    expect(calls[0]?.params).toMatchObject({
      request_id: "r1",
      max_bytes: 1024,
    });
    expect(out?.content).toBe('11/11 bytes\n{"ok":true}');
  });

  test("network_body marks truncation", async () => {
    const deps = fakeDeps({
      scripts: {
        network_body: {
          result: { body: "hello", bytes: 11, truncated: true },
        },
      },
    });
    const out = await createExecutors(deps)["network_body"]?.(
      { request_id: "r1" },
      fakeContext(),
    );
    expect(out?.content).toContain("5/11 bytes, truncated");
  });

  test("network_body surfaces BODY_UNAVAILABLE as a Tool.Error", async () => {
    const deps = fakeDeps({
      scripts: {
        network_body: {
          error: {
            code: "BODY_UNAVAILABLE",
            message: "no response body for request r1: gone",
            hint: "re-run the request",
          },
        },
      },
    });
    const error = await createExecutors(deps)["network_body"]?.(
      { request_id: "r1" },
      fakeContext(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).metadata).toMatchObject({
      code: "BODY_UNAVAILABLE",
    });
  });

  test("route forwards pattern, action and fulfill options", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({
      calls,
      scripts: {
        route: {
          result: { pattern: "/api/ping", action: "fulfill", routes: 1 },
        },
      },
    });
    const out = await createExecutors(deps)["route"]?.(
      {
        pattern: "/api/ping",
        action: "fulfill",
        kind: "substring",
        status: 200,
        body: '{"pong":"mock"}',
        content_type: "application/json",
      },
      fakeContext(),
    );
    expect(calls[0]?.method).toBe("route");
    expect(calls[0]?.params).toMatchObject({
      pattern: "/api/ping",
      action: "fulfill",
      kind: "substring",
      status: 200,
      body: '{"pong":"mock"}',
      content_type: "application/json",
    });
    expect(out?.content).toBe("route fulfill /api/ping (1 active)");
  });

  test("route omits unset optionals and rejects empty params before any RPC", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({
      calls,
      scripts: { route: { result: { pattern: "/ads/", action: "abort" } } },
    });
    const out = await createExecutors(deps)["route"]?.(
      { pattern: "/ads/", action: "abort" },
      fakeContext(),
    );
    expect(calls[0]?.params).toEqual({ pattern: "/ads/", action: "abort" });
    expect(out?.content).toBe("route abort /ads/");

    const denied = await createExecutors(deps)["route"]?.(
      { pattern: "/ads/" },
      fakeContext(),
    ).catch((e) => e);
    expect(denied).toBeInstanceOf(ToolError);
    expect(calls).toHaveLength(1);
  });

  test("route rejects oversized patterns before any RPC", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({ calls });
    const error = await createExecutors(deps)["route"]?.(
      { pattern: "p".repeat(513), action: "fulfill" },
      fakeContext(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).message).toContain("512 char limit");
    expect(calls).toEqual([]);
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

describe("interaction executors", () => {
  test("hover forwards the uid and tab id", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({
      calls,
      scripts: { hover: { result: { ok: true, x: 10, y: 20 } } },
    });
    const out = await createExecutors(deps)["hover"]?.(
      { uid: "g7-3", tab_id: "t2" },
      fakeContext(),
    );
    expect(calls[0]).toEqual({
      method: "hover",
      params: { uid: "g7-3", tab_id: "t2" },
    });
    expect(out?.content).toBe("hovered g7-3");
  });

  test("select forwards exactly one selector", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({
      calls,
      scripts: {
        select: { result: { ok: true, index: 1, value: "b", label: "Bravo" } },
      },
    });
    const out = await createExecutors(deps)["select"]?.(
      { uid: "g7-4", label: "Bravo" },
      fakeContext(),
    );
    expect(calls[0]?.params).toEqual({ uid: "g7-4", label: "Bravo" });
    expect(out?.content).toContain('selected "b"');
  });

  test("select surfaces the daemon's selector validation", async () => {
    const deps = fakeDeps({
      scripts: {
        select: {
          error: {
            code: "INTERNAL",
            message: "select needs exactly one of value, label or index (got 0)",
            hint: "pass value for option.value, label for the visible text, or index for the position",
          },
        },
      },
    });
    const error = await createExecutors(deps)["select"]?.(
      { uid: "g7-4" },
      fakeContext(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).metadata).toMatchObject({ code: "INTERNAL" });
    expect((error as ToolError).message).toContain("exactly one");
  });

  test("upload asserts browser_upload with the paths, then uploads", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const assertResources: string[][] = [];
    const deps = fakeDeps({
      calls,
      assertResources,
      scripts: { upload: { result: { ok: true, files: ["a.png"] } } },
    });
    const out = await createExecutors(deps)["upload"]?.(
      { uid: "g7-5", paths: ["/tmp/a.png"] },
      fakeContext(),
    );
    expect(assertResources).toEqual([["/tmp/a.png"]]);
    expect(calls[0]?.params).toEqual({ uid: "g7-5", paths: ["/tmp/a.png"] });
    expect(out?.content).toContain("a.png");
  });

  test("upload denial never reaches the daemon", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({ calls, denyPermission: true });
    const error = await createExecutors(deps)["upload"]?.(
      { uid: "g7-5", paths: ["/tmp/a.png"] },
      fakeContext(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect(calls).toEqual([]);
  });

  test("upload rejects relative paths and empty lists before any RPC", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({ calls });
    const executors = createExecutors(deps);
    for (const paths of [[], ["relative/a.png"]]) {
      const error = await executors["upload"]?.(
        { uid: "g7-5", paths },
        fakeContext(),
      ).catch((e) => e);
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).metadata).toMatchObject({
        code: "UPLOAD_DENIED",
      });
    }
    expect(calls).toEqual([]);
  });

  test("dialog forwards the action and prompt text", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({
      calls,
      scripts: {
        dialog: {
          result: {
            ok: true,
            action: "accept",
            dialog: { kind: "prompt", message: "Name?" },
          },
        },
      },
    });
    const out = await createExecutors(deps)["dialog"]?.(
      { action: "accept", prompt_text: "Ada" },
      fakeContext(),
    );
    expect(calls[0]?.params).toEqual({ action: "accept", prompt_text: "Ada" });
    expect(out?.content).toBe("accept prompt: Name?");
  });

  test("scroll forwards direction and amount", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({
      calls,
      scripts: {
        scroll: { result: { ok: true, scrollX: 0, scrollY: 640, at_bottom: false } },
      },
    });
    const out = await createExecutors(deps)["scroll"]?.(
      { direction: "down", amount: 640 },
      fakeContext(),
    );
    expect(calls[0]?.params).toEqual({ direction: "down", amount: 640 });
    expect(out?.content).toBe("scrolled to 0,640");
  });

  test("eval and navigate forward their optional deadlines", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({ calls });
    const executors = createExecutors(deps);
    await executors["eval"]?.({ js: "1", timeout_ms: 60_000 }, fakeContext());
    await executors["navigate"]?.(
      { url: "https://a.example", dialog_policy: "manual" },
      fakeContext(),
    );
    expect(calls[1]?.params).toMatchObject({ timeout_ms: 60_000 });
    expect(calls[2]?.params).toMatchObject({ dialog_policy: "manual" });
    expect(UPLOAD_PERMISSION).toBe("browser_upload");
  });
});

describe("stale-uid retry", () => {
  const STALE_HINT =
    "the page changed; re-run browse_snapshot and use a uid from the new tree";

  function staleError(uid: string): Script {
    return {
      error: {
        code: "UID_STALE",
        message: `uid ${uid} belongs to a previous page generation`,
        hint: STALE_HINT,
      },
    };
  }

  function snapshotResult(nodes: { uid: string; role: string; name: string }[]) {
    return {
      result: {
        tab_id: "t1",
        url: "https://a.example",
        text: nodes.map((n) => `[${n.uid}] ${n.role} "${n.name}"`).join("\n"),
        nodes,
        truncated: false,
      },
    };
  }

  test("stale→recovered: one re-snapshot, retry with the role+name match", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({
      calls,
      sequences: {
        snapshot: [
          snapshotResult([{ uid: "g7-1", role: "button", name: "Sign in" }]),
          snapshotResult([{ uid: "g8-1", role: "button", name: "Sign in" }]),
        ],
        click: [staleError("g7-1"), { result: { ok: true, x: 5, y: 6 } }],
      },
    });
    const executors = createExecutors(deps);
    await executors["snapshot"]?.({}, fakeContext());
    const out = await executors["click"]?.({ uid: "g7-1" }, fakeContext());
    expect(out?.content).toBe("clicked g8-1");
    expect(out?.metadata).toMatchObject({
      recovered_from: "g7-1",
      recovered_uid: "g8-1",
    });
    expect(
      calls.filter((c) => c.method === "click").map((c) => c.params),
    ).toEqual([{ uid: "g7-1" }, { uid: "g8-1" }]);
    // Seed + exactly one recovery snapshot: never loops.
    expect(calls.filter((c) => c.method === "snapshot")).toHaveLength(2);
  });

  test("stale→miss: no role+name match surfaces the original error", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({
      calls,
      sequences: {
        snapshot: [
          snapshotResult([{ uid: "g7-1", role: "button", name: "Sign in" }]),
          snapshotResult([{ uid: "g8-2", role: "link", name: "Elsewhere" }]),
        ],
      },
      scripts: { click: staleError("g7-1") },
    });
    const executors = createExecutors(deps);
    await executors["snapshot"]?.({}, fakeContext());
    const error = await executors["click"]?.(
      { uid: "g7-1" },
      fakeContext(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).metadata).toMatchObject({
      code: "UID_STALE",
      hint: STALE_HINT,
    });
    expect(calls.filter((c) => c.method === "click")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "snapshot")).toHaveLength(2);
  });

  test("stale without a cached snapshot surfaces the original error", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({ calls, scripts: { click: staleError("g7-3") } });
    const error = await createExecutors(deps)["click"]?.(
      { uid: "g7-3" },
      fakeContext(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).metadata).toMatchObject({
      code: "UID_STALE",
      hint: STALE_HINT,
    });
    expect(calls.map((c) => c.method)).toEqual(["click"]);
  });

  test("fresh→passthrough: success issues no extra snapshot call", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({
      calls,
      scripts: { click: { result: { ok: true } } },
    });
    const out = await createExecutors(deps)["click"]?.(
      { uid: "g7-1" },
      fakeContext(),
    );
    expect(out?.content).toBe("clicked g7-1");
    expect(calls.map((c) => c.method)).toEqual(["click"]);
  });

  test("non-stale errors never trigger a recovery snapshot", async () => {
    for (const code of ["UID_NOT_FOUND", "TAB_FORBIDDEN", "ELEMENT_OCCLUDED"]) {
      const calls: { method: string; params: Record<string, unknown> }[] = [];
      const deps = fakeDeps({
        calls,
        scripts: {
          click: {
            error: { code, message: `${code} happened`, hint: "fix it" },
          },
        },
      });
      const error = await createExecutors(deps)["click"]?.(
        { uid: "g7-1" },
        fakeContext(),
      ).catch((e) => e);
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).metadata).toMatchObject({ code });
      expect(calls.map((c) => c.method)).toEqual(["click"]);
    }
  });

  test("text fallback: re-resolves from snapshot text when nodes are absent", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const textOnly = (text: string) => ({
      result: { tab_id: "t1", url: "https://a.example", text, truncated: false },
    });
    const deps = fakeDeps({
      calls,
      sequences: {
        snapshot: [
          textOnly('[g7-2] textbox "Email"'),
          textOnly('[g8-5] textbox "Email"'),
        ],
        fill: [staleError("g7-2"), { result: { ok: true } }],
      },
    });
    const executors = createExecutors(deps);
    await executors["snapshot"]?.({}, fakeContext());
    const out = await executors["fill"]?.(
      { uid: "g7-2", value: "a@b.c" },
      fakeContext(),
    );
    expect(out?.content).toBe("filled g8-5");
    expect(
      calls.filter((c) => c.method === "fill").map((c) => c.params),
    ).toEqual([
      { uid: "g7-2", value: "a@b.c" },
      { uid: "g8-5", value: "a@b.c" },
    ]);
  });

  test("retry failure surfaces the fresh error, not the stale one", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({
      calls,
      sequences: {
        snapshot: [
          snapshotResult([{ uid: "g7-1", role: "button", name: "Sign in" }]),
          snapshotResult([{ uid: "g8-1", role: "button", name: "Sign in" }]),
        ],
        click: [
          staleError("g7-1"),
          {
            error: {
              code: "ELEMENT_OCCLUDED",
              message: "click target is covered by div",
              hint: "dismiss the covering element",
            },
          },
        ],
      },
    });
    const executors = createExecutors(deps);
    await executors["snapshot"]?.({}, fakeContext());
    const error = await executors["click"]?.(
      { uid: "g7-1" },
      fakeContext(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).metadata).toMatchObject({
      code: "ELEMENT_OCCLUDED",
    });
    expect(calls.filter((c) => c.method === "click")).toHaveLength(2);
    expect(calls.filter((c) => c.method === "snapshot")).toHaveLength(2);
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

  test("interaction formatters tolerate stub shapes", () => {
    expect(formatSelect({})).toContain("(unknown value)");
    expect(formatSelect({ index: 2, value: "c", label: "Charlie" })).toBe(
      'selected "c" — Charlie (index 2)',
    );
    expect(formatUpload({})).toBe("attached files");
    expect(formatUpload({ files: ["a.png", "b.pdf"] })).toContain("2 file(s)");
    expect(formatDialog({})).toBe("handled dialog");
    expect(formatDialog({ action: "dismiss", dialog: { kind: "alert" } })).toBe(
      "dismiss alert",
    );
    expect(formatScroll({})).toBe("scrolled to 0,0");
    expect(formatScroll({ scrollY: 900, at_bottom: true })).toBe(
      "scrolled to 0,900 (at bottom)",
    );
  });

  test("wait formatters tolerate stub shapes", () => {
    expect(formatWaitForUid({})).toBe("uid not found");
    expect(formatWaitForUid({ found: true, uid: "g7-3", elapsed_ms: 12 })).toBe(
      "found uid g7-3 in 12ms",
    );
    expect(formatExpectText({})).toBe("text not matched");
    expect(formatExpectText({ matched: true, elapsed_ms: 150 })).toBe(
      "matched text in 150ms",
    );
  });
});

describe("wait executors", () => {
  test("wait_for_uid forwards uid, tab id and timeout", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({
      calls,
      scripts: {
        wait_for_uid: {
          result: { found: true, uid: "g7-3", elapsed_ms: 155, timeout_ms: 5000 },
        },
      },
    });
    const out = await createExecutors(deps)["wait_for_uid"]?.(
      { uid: "g7-3", tab_id: "t2", timeout_ms: 5000 },
      fakeContext(),
    );
    expect(calls[0]).toEqual({
      method: "wait_for_uid",
      params: { uid: "g7-3", tab_id: "t2", timeout_ms: 5000 },
    });
    expect(out?.content).toBe("found uid g7-3 in 155ms");
    expect(out?.metadata).toMatchObject({
      result: expect.objectContaining({ found: true }),
    });
  });

  test("wait_for_uid timeout surfaces NAV_TIMEOUT with its hint", async () => {
    const deps = fakeDeps({
      scripts: {
        wait_for_uid: {
          error: {
            code: "NAV_TIMEOUT",
            message: "uid g7-9 did not appear within 100ms",
            hint: "the page did not finish loading",
          },
        },
      },
    });
    const error = await createExecutors(deps)["wait_for_uid"]?.(
      { uid: "g7-9", timeout_ms: 100 },
      fakeContext(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).metadata).toMatchObject({ code: "NAV_TIMEOUT" });
    expect((error as ToolError).message).toContain("did not appear");
  });

  test("expect_text forwards text and timeout, then formats the match", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({
      calls,
      scripts: {
        expect_text: {
          result: { matched: true, elapsed_ms: 310, timeout_ms: 5000 },
        },
      },
    });
    const out = await createExecutors(deps)["expect_text"]?.(
      { text: "Sign in", timeout_ms: 5000 },
      fakeContext(),
    );
    expect(calls[0]).toEqual({
      method: "expect_text",
      params: { text: "Sign in", timeout_ms: 5000 },
    });
    expect(out?.content).toBe("matched text in 310ms");
  });

  test("expect_text timeout surfaces NAV_TIMEOUT, not a silent miss", async () => {
    const deps = fakeDeps({
      scripts: {
        expect_text: {
          error: {
            code: "NAV_TIMEOUT",
            message: "text did not appear within 100ms",
            hint: "retry with a larger timeout_ms",
          },
        },
      },
    });
    const error = await createExecutors(deps)["expect_text"]?.(
      { text: "Nope", timeout_ms: 100 },
      fakeContext(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).metadata).toMatchObject({ code: "NAV_TIMEOUT" });
  });

  test("missing uid/text fails before any RPC", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const deps = fakeDeps({ calls });
    const executors = createExecutors(deps);
    const missingUid = await executors["wait_for_uid"]?.({}, fakeContext()).catch(
      (e) => e,
    );
    expect(missingUid).toBeInstanceOf(ToolError);
    const missingText = await executors["expect_text"]?.({}, fakeContext()).catch(
      (e) => e,
    );
    expect(missingText).toBeInstanceOf(ToolError);
    expect(calls).toEqual([]);
  });
});
