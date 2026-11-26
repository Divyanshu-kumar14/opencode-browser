/**
 * Engine tool tests: schema -> TurnRequest mapping, registry wiring, and the
 * advertised JSON Schema. These run against `FakeBrowserSession`; the real
 * browser is covered by e2e.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import type { ToolEditor } from "@opencode/plugin/promise/tool";
import { inputSchema, registerBrowserTools } from "../src/tools/index.ts";
import * as navigateTool from "../src/tools/navigate.ts";
import * as interactTool from "../src/tools/interact.ts";
import * as snapshotTool from "../src/tools/snapshot.ts";
import * as inspectTool from "../src/tools/inspect.ts";
import * as viewportTool from "../src/tools/viewport.ts";
import * as evaluateTool from "../src/tools/evaluate.ts";
import { FakeBrowserSession } from "./fake-session.ts";

interface RegisteredTool {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options: { codemode: boolean; namespace: string };
  execute: (input: unknown, context: unknown) => Promise<{ content: unknown; metadata?: unknown }>;
}

const FAKE_CONTEXT = { sessionID: "ses_test", agent: "build", messageID: "msg_test", id: "call_test" };
const FAKE_PERMISSION = { assert: async () => undefined };

function register(session = new FakeBrowserSession()): {
  session: FakeBrowserSession;
  tools: Map<string, { execute: (input: unknown) => Promise<{ content: unknown; metadata?: unknown }> } & Omit<RegisteredTool, "execute">>;
} {
  const tools = new Map<string, RegisteredTool>();
  const editor = {
    add: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
  } as unknown as ToolEditor;
  registerBrowserTools(editor, { session, permission: FAKE_PERMISSION }, "browse");
  const bound = new Map(
    [...tools].map(([name, tool]) => [
      name,
      { ...tool, execute: (input: unknown) => tool.execute(input, FAKE_CONTEXT) },
    ]),
  );
  return { session, tools: bound };
}

async function toolError(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    return error as ToolError;
  }
  throw new Error("expected the call to reject");
}

describe("tool registration", () => {
  test("registers the engine tools under the browse namespace", () => {
    const { tools } = register();
    expect([...tools.keys()]).toEqual([
      "navigate",
      "interact",
      "snapshot",
      "read",
      "inspect",
      "viewport",
      "wait",
      "tabs",
      "network",
      "upload",
      "handoff",
      "dialog",
      "eval",
    ]);
    for (const tool of tools.values()) {
      expect(tool.options.namespace).toBe("browse");
      expect(tool.options.codemode).toBe(true);
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  test("derives JSON Schema from zod, strict and without $schema", () => {
    const { tools } = register();
    const navigate = tools.get("navigate")!;
    expect(navigate.input["$schema"]).toBeUndefined();
    expect(navigate.input["additionalProperties"]).toBe(false);
    const properties = navigate.input["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["action"]?.["enum"]).toEqual(["goto", "back", "forward", "reload"]);
  });

  test("single-action drag endpoints survive into the advertised schema", () => {
    const { tools } = register();
    const interact = tools.get("interact")!;
    const properties = interact.input["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["toX"]?.["type"]).toBe("number");
    expect(properties["toY"]?.["type"]).toBe("number");
    const actions = properties["actions"] as { items: Record<string, unknown> };
    const itemProps = actions.items["properties"] as Record<string, Record<string, unknown>>;
    expect(itemProps["toX"]?.["type"]).toBe("number");
    expect(actions.items["additionalProperties"]).toBe(false);
  });

  test("validation failures become INVALID_INPUT Tool.Error", async () => {
    const { tools } = register();
    const navigate = tools.get("navigate")!;
    const error = await toolError(navigate.execute({ action: "goto" }));
    expect(error.metadata?.["code"]).toBe("INVALID_INPUT");
  });

  test("handler failures become INTERNAL Tool.Error", async () => {
    const session = new FakeBrowserSession().fail(new Error("page exploded"));
    const { tools } = register(session);
    const error = await toolError(tools.get("snapshot")!.execute({}));
    expect(error.metadata?.["code"]).toBe("INTERNAL");
    expect(error.message).toContain("page exploded");
  });

  test("Tool.Error from a handler passes through untouched", async () => {
    const original = new ToolError({ message: "denied", metadata: { code: "DENIED" } });
    const session = new FakeBrowserSession().fail(original);
    const { tools } = register(session);
    const error = await toolError(tools.get("eval")!.execute({ expression: "1" }));
    expect(error).toBe(original);
  });

  test("a Tool.Error from another module instance keeps its metadata", async () => {
    const original = Object.assign(new Error("denied"), {
      _tag: "Tool.Error",
      metadata: { code: "DENIED" },
    });
    const session = new FakeBrowserSession().fail(original);
    const { tools } = register(session);
    try {
      await tools.get("eval")!.execute({ expression: "1" });
      throw new Error("expected the call to reject");
    } catch (error) {
      expect(error).toBe(original);
      expect((error as { metadata?: { code?: string } }).metadata?.code).toBe("DENIED");
    }
  });

  test("rejects unknown fields instead of silently stripping them", async () => {
    const { session, tools } = register();
    const error = await toolError(
      tools.get("navigate")!.execute({ action: "back", bogus: true }),
    );
    expect(error.metadata?.["code"]).toBe("INVALID_INPUT");
    expect(session.requests).toHaveLength(0);
  });

  test("rejects an empty action batch and a target-less click", async () => {
    const { session, tools } = register();
    await toolError(tools.get("interact")!.execute({ actions: [] }));
    await toolError(tools.get("interact")!.execute({ type: "click" }));
    expect(session.requests).toHaveLength(0);
  });
});

describe("handler -> TurnRequest mapping", () => {
  test("navigate forwards goto fields", async () => {
    const { session, tools } = register();
    await tools.get("navigate")!.execute({
      action: "goto",
      url: "https://example.test/",
      waitUntil: "networkidle",
    });
    expect(session.requests).toEqual([
      { kind: "navigate", action: "goto", url: "https://example.test/", waitUntil: "networkidle" },
    ]);
  });

  test("navigate rejects goto without a url before the session", async () => {
    const { session, tools } = register();
    await toolError(tools.get("navigate")!.execute({ action: "goto" }));
    expect(session.requests).toHaveLength(0);
  });

  test("snapshot defaults annotate true and fullPage false", async () => {
    const { session, tools } = register();
    await tools.get("snapshot")!.execute({});
    expect(session.requests).toEqual([{ kind: "observe", annotate: true, fullPage: false }]);
  });

  test("interact forwards a single action", async () => {
    const { session, tools } = register();
    await tools.get("interact")!.execute({ type: "click", elementId: 3 });
    expect(session.requests).toEqual([
      { kind: "act", actions: [{ type: "click", elementId: 3, pressEnter: false }] },
    ]);
  });

  test("interact forwards a batch, including drag endpoints", async () => {
    const { session, tools } = register();
    await tools.get("interact")!.execute({
      actions: [
        { type: "click", elementId: 1 },
        { type: "drag", x: 10, y: 20, toX: 110, toY: 220 },
      ],
    });
    const request = session.requests[0];
    expect(request?.kind).toBe("act");
    if (request?.kind !== "act") throw new Error("expected act");
    expect(request.actions[1]).toMatchObject({ type: "drag", toX: 110, toY: 220 });
  });

  test("interact rejects a single drag without endpoints", async () => {
    const { session, tools } = register();
    await toolError(tools.get("interact")!.execute({ type: "drag", x: 1, y: 2 }));
    expect(session.requests).toHaveLength(0);
  });

  test("interact rejects an empty request", async () => {
    const { tools } = register();
    await toolError(tools.get("interact")!.execute({}));
  });

  test("inspect forwards the id target", async () => {
    const { session, tools } = register();
    await tools.get("inspect")!.execute({ elementId: 7, cssProperties: ["zIndex"] });
    expect(session.requests).toEqual([
      { kind: "inspect", elementId: 7, selector: undefined, cssProperties: ["zIndex"] },
    ]);
  });

  test("inspect rejects a request with neither target", async () => {
    const { session, tools } = register();
    await toolError(tools.get("inspect")!.execute({}));
    expect(session.requests).toHaveLength(0);
  });

  test("every tool forwards screenshot:false to the turn, and omits it by default", async () => {
    const { session, tools } = register();
    for (const [name, input] of [
      ["navigate", { url: "https://a.test/" }],
      ["interact", { type: "click", elementId: 1 }],
      ["snapshot", {}],
      ["inspect", { elementId: 1 }],
      ["viewport", { preset: "mobile" }],
    ] as const) {
      await tools.get(name)!.execute({ ...input, screenshot: false });
      await tools.get(name)!.execute(input);
    }
    const flags = session.requests.map((r) => r.screenshot);
    expect(flags).toEqual([false, undefined, false, undefined, false, undefined, false, undefined, false, undefined]);
  });
  test("wait forwards its conditions and a default timeout, and rejects a call with no condition", async () => {
    const { session, tools } = register();
    await tools.get("wait")!.execute({ text: "Results", urlContains: "/search", networkIdle: true });
    expect(session.requests[0]).toMatchObject({
      kind: "wait",
      conditions: { text: "Results", urlContains: "/search", networkIdle: true },
      timeoutMs: 10000,
    });
    await tools.get("wait")!.execute({ ms: 500, timeoutMs: 2000 });
    expect(session.requests[1]).toMatchObject({ kind: "wait", conditions: { ms: 500 }, timeoutMs: 2000 });
    await toolError(tools.get("wait")!.execute({}));
    await toolError(tools.get("wait")!.execute({ text: "x", timeoutMs: 999999 }));
    expect(session.requests).toHaveLength(2);
  });
  test("read forwards its scope and window, with text-friendly defaults", async () => {
    const { session, tools } = register();
    await tools.get("read")!.execute({});
    await tools.get("read")!.execute({ selector: "article", links: false, maxChars: 3000, offset: 500 });
    expect(session.requests).toMatchObject([
      { kind: "read", links: true, maxChars: 12000, offset: 0 },
      { kind: "read", selector: "article", links: false, maxChars: 3000, offset: 500 },
    ]);
    await toolError(tools.get("read")!.execute({ maxChars: 10 }));
    await toolError(tools.get("read")!.execute({ maxChars: 1000000 }));
    await toolError(tools.get("read")!.execute({ offset: -1 }));
    expect(session.requests).toHaveLength(2);
  });
  test("tabs forwards list/open/switch/close and validates each", async () => {
    const { session, tools } = register();
    await tools.get("tabs")!.execute({ action: "list" });
    await tools.get("tabs")!.execute({ action: "open", url: "https://a.test/" });
    await tools.get("tabs")!.execute({ action: "open" });
    await tools.get("tabs")!.execute({ action: "switch", tabId: "page-3" });
    await tools.get("tabs")!.execute({ action: "close", tabId: "page-3" });
    await tools.get("tabs")!.execute({ action: "close" });
    expect(session.requests).toMatchObject([
      { kind: "tabs", action: "list" },
      { kind: "tabs", action: "open", url: "https://a.test/" },
      { kind: "tabs", action: "open" },
      { kind: "tabs", action: "switch", tabId: "page-3" },
      { kind: "tabs", action: "close", tabId: "page-3" },
      { kind: "tabs", action: "close" },
    ]);
    await toolError(tools.get("tabs")!.execute({ action: "switch" }));
    await toolError(tools.get("tabs")!.execute({ action: "list", url: "https://a.test/" }));
    expect(session.requests).toHaveLength(6);
  });
  test("network forwards its query with defaults, never asking for a screenshot", async () => {
    const { session, tools } = register();
    await tools.get("network")!.execute({});
    await tools.get("network")!.execute({ show: "console", filter: "api", onlyErrors: true, limit: 5 });
    expect(session.requests).toMatchObject([
      { kind: "network", show: "both", onlyErrors: false, limit: 30, screenshot: false },
      { kind: "network", show: "console", filter: "api", onlyErrors: true, limit: 5 },
    ]);
    await toolError(tools.get("network")!.execute({ limit: 0 }));
    await toolError(tools.get("network")!.execute({ show: "bodies" }));
    expect(session.requests).toHaveLength(2);
  });
  test("upload forwards its target and paths, and needs a target and at least one path", async () => {
    const { session, tools } = register();
    await tools.get("upload")!.execute({ elementId: 4, paths: ["docs/cv.pdf"] });
    expect(session.requests[0]).toMatchObject({ kind: "upload", elementId: 4, paths: ["docs/cv.pdf"] });
    await toolError(tools.get("upload")!.execute({ paths: ["a"] }));
    await toolError(tools.get("upload")!.execute({ elementId: 4, paths: [] }));
    expect(session.requests).toHaveLength(1);
  });
  test("handoff forwards a trimmed reason and rejects empty or long ones", async () => {
    const { session, tools } = register();
    await tools.get("handoff")!.execute({ reason: "  Sign in to GitHub  " });
    expect(session.requests[0]).toMatchObject({ kind: "handoff", reason: "Sign in to GitHub" });
    await toolError(tools.get("handoff")!.execute({ reason: "  " }));
    await toolError(tools.get("handoff")!.execute({ reason: "x".repeat(161) }));
    await toolError(tools.get("handoff")!.execute({}));
    expect(session.requests).toHaveLength(1);
  });
  test("dialog forwards the answer for the next dialog and validates it", async () => {
    const { session, tools } = register();
    await tools.get("dialog")!.execute({ action: "accept" });
    await tools.get("dialog")!.execute({ action: "accept", promptText: "Ada" });
    await tools.get("dialog")!.execute({ action: "dismiss" });
    expect(session.requests).toMatchObject([
      { kind: "dialog", accept: true },
      { kind: "dialog", accept: true, promptText: "Ada" },
      { kind: "dialog", accept: false },
    ]);
    await toolError(tools.get("dialog")!.execute({}));
    await toolError(tools.get("dialog")!.execute({ action: "dismiss", promptText: "x" }));
    expect(session.requests).toHaveLength(3);
  });
  test("viewport forwards a preset and rejects half a custom size", async () => {
    const { session, tools } = register();
    await tools.get("viewport")!.execute({ preset: "mobile" });
    expect(session.requests).toEqual([
      { kind: "viewport", preset: "mobile", width: undefined, height: undefined },
    ]);
    await toolError(tools.get("viewport")!.execute({ width: 500 }));
    expect(session.requests).toHaveLength(1);
  });

  test("eval forwards the expression", async () => {
    const { session, tools } = register();
    await tools.get("eval")!.execute({ expression: "document.title" });
    expect(session.requests).toEqual([
      { kind: "evaluate", expression: "document.title", approvedUrl: "about:blank" },
    ]);
  });
});

describe("advertised schemas match the handler schemas", () => {
  test("every tool derives a strict object schema", () => {
    for (const schema of [
      navigateTool.schema,
      interactTool.schema,
      snapshotTool.schema,
      inspectTool.schema,
      viewportTool.schema,
      evaluateTool.schema,
    ]) {
      const json = inputSchema(schema);
      expect(json["type"]).toBe("object");
      expect(json["additionalProperties"]).toBe(false);
    }
  });

  test("inspect advertises both target fields", () => {
    const json = inputSchema(inspectTool.schema);
    const properties = json["properties"] as Record<string, unknown>;
    expect(properties["elementId"]).toBeDefined();
    expect(properties["selector"]).toBeDefined();
  });
});
