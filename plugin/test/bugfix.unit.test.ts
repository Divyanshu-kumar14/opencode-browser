/**
 * Bug-sweep unit tests (no browser). One `describe` per design group.
 * Spec: .kiro/specs/browser-plugin-bug-sweep/
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import type { ToolEditor } from "@opencode/plugin/promise/tool";
import { loadConfig } from "../src/config.ts";
import { InvalidInputError } from "../src/core/errors.ts";
import { checkNavigationUrl, redactUrl, redactUrlsInText } from "../src/core/url-policy.ts";
import { registerBrowserTools } from "../src/tools/index.ts";
import type { ToolDeps } from "../src/tools/types.ts";
import { FakeBrowserSession } from "./fake-session.ts";
import {
  AUTODETECT_CDP_URL,
  BrowserSessionManager,
  probeCdpEndpoint,
  resolveCdpEndpoint,
} from "../src/core/session-manager.ts";
import * as evaluateTool from "../src/tools/evaluate.ts";
import plugin from "../src/index.ts";
import { processBrowser } from "../src/core/process-browser.ts";
import { Telemetry } from "../src/core/telemetry.ts";
import { TabTracker } from "../src/core/tab-tracker.ts";
import { Presence } from "../src/core/presence.ts";
import { inspectElement } from "../src/core/inspect.ts";
import { IMPLICIT_ROLE_BY_TAG } from "../src/core/som.ts";
import { formatElementMap } from "../src/utils/formatter.ts";

export const CONTEXT = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" };

export interface Registered {
  name: string;
  options: Record<string, unknown>;
  execute: (input: unknown, context: unknown) => Promise<{ content: unknown; metadata?: unknown }>;
}

export function registerWith(deps: ToolDeps): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  const editor = { add: (t: Registered) => tools.set(t.name, t) } as unknown as ToolEditor;
  registerBrowserTools(editor, deps, "browse");
  return tools;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("Group 0: shared groundwork", () => {
  test("checkNavigationUrl accepts http, https, about", () => {
    for (const url of ["http://a.test/", "https://a.test/x?y=1", "about:blank", "HTTPS://A.TEST/"]) {
      expect(() => checkNavigationUrl(url, { allowFile: false })).not.toThrow();
    }
  });

  test("checkNavigationUrl rejects other schemes with InvalidInputError", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "chrome://version", "file:///etc/hostname", "ftp://x.test/"]) {
      expect(() => checkNavigationUrl(url, { allowFile: false })).toThrow(InvalidInputError);
    }
    try {
      checkNavigationUrl("file:///etc/hostname", { allowFile: false });
    } catch (error) {
      expect((error as Error).message).toContain('scheme "file:" is not allowed');
      expect((error as Error).message).toContain("OPENCODE_BROWSER_ALLOW_FILE_URLS=1");
    }
  });

  test("checkNavigationUrl allows file: only with the opt-in", () => {
    expect(() => checkNavigationUrl("file:///etc/hostname", { allowFile: true })).not.toThrow();
    expect(() => checkNavigationUrl("javascript:1", { allowFile: true })).toThrow(InvalidInputError);
  });

  test("checkNavigationUrl rejects non-absolute URLs and truncates the echo", () => {
    expect(() => checkNavigationUrl("example.com", { allowFile: false })).toThrow(/not an absolute URL/);
    try {
      checkNavigationUrl("x".repeat(1000), { allowFile: false });
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(320);
    }
  });

  test("redactUrl strips query, fragment, and userinfo", () => {
    expect(redactUrl("https://u:p@api.test/x?access_token=abc#f")).toBe("https://api.test/x");
    expect(redactUrl("http://a.test/")).toBe("http://a.test/");
    expect(redactUrl("not a url?q=1#h")).toBe("not a url");
  });

  test("redactUrlsInText keeps :line:col and leaves clean URLs untouched", () => {
    expect(redactUrlsInText("at f (https://x.test/a.js?v=1:10:5)")).toBe("at f (https://x.test/a.js:10:5)");
    expect(redactUrlsInText("at g (http://127.0.0.1:4000/app.js:1:2)")).toBe("at g (http://127.0.0.1:4000/app.js:1:2)");
    expect(redactUrlsInText("at h https://u:p@x.test/b.js#frag")).toBe("at h https://x.test/b.js");
  });

  test("config defaults and env parsing for the new fields", () => {
    const blank = {
      OPENCODE_BROWSER_ALLOW_FILE_URLS: undefined,
      OPENCODE_BROWSER_EVAL_PROMPT: undefined,
      OPENCODE_BROWSER_EVAL_TIMEOUT_MS: undefined,
    };
    const d = withEnv(blank, loadConfig);
    expect(d.allowFileUrls).toBe(false);
    expect(d.evalPrompt).toBe(true);
    expect(d.evalTimeoutMs).toBe(30000);
    expect(d.perceptionTimeoutMs).toBe(15000);
    const s = withEnv(
      { OPENCODE_BROWSER_ALLOW_FILE_URLS: "1", OPENCODE_BROWSER_EVAL_PROMPT: "0", OPENCODE_BROWSER_EVAL_TIMEOUT_MS: "1234" },
      loadConfig,
    );
    expect(s.allowFileUrls).toBe(true);
    expect(s.evalPrompt).toBe(false);
    expect(s.evalTimeoutMs).toBe(1234);
  });

  test("config autodetects a local DevTools browser unless disabled", () => {
    const on = withEnv({ OPENCODE_BROWSER_CDP_AUTODETECT: undefined }, loadConfig);
    expect(on.cdpAutoDetect).toBe(true);
    const off = withEnv({ OPENCODE_BROWSER_CDP_AUTODETECT: "0" }, loadConfig);
    expect(off.cdpAutoDetect).toBe(false);
  });

  test("resolveCdpEndpoint prefers an explicit URL, then a live 9222, then launch", async () => {
    const base = { cdpUrl: undefined, cdpAutoDetect: true };
    const calls: string[] = [];
    const live = async (url: string) => {
      calls.push(url);
      return true;
    };
    const dead = async (url: string) => {
      calls.push(url);
      return false;
    };

    expect(await resolveCdpEndpoint({ ...base, cdpUrl: "http://127.0.0.1:9333" }, dead)).toBe(
      "http://127.0.0.1:9333",
    );
    expect(calls).toEqual([]);
    expect(await resolveCdpEndpoint(base, live)).toBe(AUTODETECT_CDP_URL);
    expect(await resolveCdpEndpoint(base, dead)).toBeUndefined();
    expect(await resolveCdpEndpoint({ ...base, cdpAutoDetect: false }, live)).toBeUndefined();
    expect(calls).toEqual([AUTODETECT_CDP_URL, AUTODETECT_CDP_URL]);
  });

  test("probeCdpEndpoint accepts a DevTools listener and rejects a dead port", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/json/version") {
          return Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/test" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      expect(await probeCdpEndpoint(`http://127.0.0.1:${server.port}`)).toBe(true);
    } finally {
      await server.stop(true);
    }
    expect(await probeCdpEndpoint(`http://127.0.0.1:${server.port}`)).toBe(false);
  });

  test("InvalidInputError maps to INVALID_INPUT with its hint", async () => {
    const session = new FakeBrowserSession().fail(new InvalidInputError("bad selector", "fix it"));
    const tools = registerWith({ session, permission: { assert: async () => undefined } });
    const error = (await rejection(tools.get("snapshot")!.execute({}, CONTEXT))) as ToolError;
    expect(error).toBeInstanceOf(ToolError);
    expect(error.metadata?.["code"]).toBe("INVALID_INPUT");
    expect(error.metadata?.["hint"]).toBe("fix it");
    expect(error.message).toBe("bad selector");
  });

  test("a foreign Tool.Error still passes through", async () => {
    const original = Object.assign(new Error("denied"), { _tag: "Tool.Error", metadata: { code: "DENIED" } });
    const session = new FakeBrowserSession().fail(original);
    const tools = registerWith({ session, permission: { assert: async () => undefined } });
    expect(await rejection(tools.get("snapshot")!.execute({}, CONTEXT))).toBe(original);
  });

  test("the eval tool advertises permission browser_eval; others do not", () => {
    const tools = registerWith({ session: new FakeBrowserSession() });
    expect(tools.get("eval")!.options["permission"]).toBe("browser_eval");
    for (const name of ["navigate", "interact", "snapshot", "inspect", "viewport"]) {
      expect(tools.get(name)!.options["permission"]).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Group 1: security controls (1.21 eval permission gate)
// ---------------------------------------------------------------------------


interface Evaluation {
  action: string;
  effect: string;
  resources: readonly string[];
}

describe("Group 1: eval permission gate (1.21)", () => {
  test("permission.assert runs before the turn with the redacted page URL", async () => {
    const events: string[] = [];
    const session = new FakeBrowserSession();
    session.url = "http://127.0.0.1:9/page?token=abc#frag";
    const original = session.turn.bind(session);
    session.turn = async (request) => {
      events.push("turn");
      return original(request);
    };
    const calls: unknown[] = [];
    const permission = {
      assert: async (input: unknown) => {
        events.push("assert");
        calls.push(input);
      },
    };
    const tools = registerWith({ session, permission: permission as never });
    await tools.get("eval")!.execute({ expression: "1" }, CONTEXT);
    expect(events).toEqual(["assert", "turn"]);
    expect(calls[0]).toMatchObject({
      sessionID: CONTEXT.sessionID,
      agent: CONTEXT.agent,
      action: "browser_eval",
      resources: ["http://127.0.0.1:9/page"],
      source: { type: "tool", messageID: CONTEXT.messageID, id: CONTEXT.id },
    });
  });

  test("a rejected assert never runs the expression and propagates by identity", async () => {
    const session = new FakeBrowserSession();
    const denial = new Error("user rejected browser_eval");
    const tools = registerWith({
      session,
      permission: { assert: async () => Promise.reject(denial) } as never,
    });
    expect(await rejection(tools.get("eval")!.execute({ expression: "document.cookie" }, CONTEXT))).toBe(denial);
    expect(session.requests).toHaveLength(0);
  });

  test("the evaluate hook upgrades allow to ask for browser_eval only", async () => {
    const hooks: Array<(e: Evaluation) => void> = [];
    const domain = {
      hook: async (name: string, cb: (e: Evaluation) => void) => {
        expect(name).toBe("evaluate");
        hooks.push(cb);
        return { dispose: async () => undefined };
      },
    };
    const reg = await evaluateTool.registerEvalPrompt(domain as never, true);
    expect(reg).not.toBeNull();
    expect(hooks).toHaveLength(1);
    const run = (action: string, effect: string): string => {
      const e = { action, effect, resources: [] };
      hooks[0]!(e);
      return e.effect;
    };
    expect(run("browser_eval", "allow")).toBe("ask");
    expect(run("browser_eval", "deny")).toBe("deny");
    expect(run("browser_eval", "ask")).toBe("ask");
    expect(run("bash", "allow")).toBe("allow");
    expect(run("browser_upload", "allow")).toBe("allow");

    const none: unknown[] = [];
    const off = await evaluateTool.registerEvalPrompt(
      { hook: async (...args: unknown[]) => { none.push(args); return { dispose: async () => undefined }; } } as never,
      false,
    );
    expect(off).toBeNull();
    expect(none).toHaveLength(0);
  });

  test("plugin setup wires ctx.permission into browse_eval and registers the prompt hook", async () => {
    // Seed the process-global manager so nothing can launch Chromium here.
    const manager = new BrowserSessionManager({ headless: true });
    manager.ensureActivePage = async () => {
      throw new Error("no browser in unit tests");
    };
    const saved = processBrowser.replace(manager);
    try {
      const added: Registered[] = [];
      const hookNames: string[] = [];
      const asserted: unknown[] = [];
      const disposed: string[] = [];
      const denial = new Error("denied in test");
      const ctx = {
        tool: {
          transform: async (cb: (editor: unknown) => void) => {
            cb({ namespace: () => undefined, add: (t: Registered) => added.push(t) });
            return { dispose: async () => { disposed.push("tools"); } };
          },
          list: async () => [],
        },
        permission: {
          assert: async (input: unknown) => {
            asserted.push(input);
            throw denial;
          },
          hook: async (name: string) => {
            hookNames.push(name);
            return { dispose: async () => { disposed.push("hook"); } };
          },
        },
      };
      const cleanup = await plugin.setup(ctx as never);
      expect(hookNames).toEqual(["evaluate"]);
      const evalTool = added.find((t) => t.name === "eval")!;
      expect(await rejection(evalTool.execute({ expression: "1" }, CONTEXT))).toBe(denial);
      expect(asserted).toHaveLength(1);
      await (cleanup as () => Promise<void>)();
      expect(disposed.sort()).toEqual(["hook", "tools"]);
    } finally {
      processBrowser.replace(saved);
    }
  });
});

describe("plugin setup: the agent's presence", () => {
  /** A host `ctx` with a session domain that records hooks and interrupts. */
  function hostWithSession() {
    const hooks = new Map<string, (event: unknown) => unknown>();
    const disposed: string[] = [];
    const interrupted: string[] = [];
    const ctx = {
      tool: {
        transform: async (cb: (editor: unknown) => void) => {
          cb({ namespace: () => undefined, add: () => undefined });
          return { dispose: async () => undefined };
        },
        list: async () => [],
      },
      permission: { assert: async () => undefined, hook: async () => ({ dispose: async () => undefined }) },
      session: {
        hook: async (name: string, cb: (event: unknown) => unknown) => {
          hooks.set(name, cb);
          return { dispose: async () => void disposed.push(name) };
        },
        interrupt: async (input: { sessionID: string }) => void interrupted.push(input.sessionID),
      },
    };
    return { ctx, hooks, disposed, interrupted };
  }
  /** A tab that accepts HUD calls. */
  const hudTab = () => ({
    evaluate: async () => undefined,
    on: () => undefined,
    isClosed: () => false,
  });
  test("the idle hook ends presence, and Stop interrupts the sessions that used the browser", async () => {
    const manager = new BrowserSessionManager({ headless: true });
    manager.presence.enabled = true;
    const saved = processBrowser.replace(manager);
    const host = hostWithSession();
    try {
      const cleanup = (await plugin.setup(host.ctx as never)) as () => Promise<void>;
      expect([...host.hooks.keys()]).toEqual(["experimental.idle"]);
      await manager.presence.begin("ses_a", [hudTab() as never]);
      await manager.presence.begin("ses_b", [hudTab() as never]);
      await host.hooks.get("experimental.idle")!({ sessionID: "ses_a", background: [] });
      expect(manager.presence.sessionIds()).toEqual(["ses_b"]);
      await manager.presence.takeOver();
      expect(host.interrupted).toEqual(["ses_b"]);
      await cleanup();
      expect(host.disposed).toEqual(["experimental.idle"]);
      expect(manager.presence.getInterrupter()).toBeUndefined();
    } finally {
      processBrowser.replace(saved);
    }
  });
  test("a stale plugin instance's disposal does not remove the newer instance's interrupter", async () => {
    const manager = new BrowserSessionManager({ headless: true });
    const saved = processBrowser.replace(manager);
    try {
      const first = hostWithSession();
      const cleanupFirst = (await plugin.setup(first.ctx as never)) as () => Promise<void>;
      const second = hostWithSession();
      await plugin.setup(second.ctx as never);
      await cleanupFirst();
      expect(manager.presence.getInterrupter()).toBeDefined();
      manager.presence.enabled = true;
      await manager.presence.begin("ses_x", [hudTab() as never]);
      await manager.presence.takeOver();
      expect(second.interrupted).toEqual(["ses_x"]);
      expect(first.interrupted).toEqual([]);
    } finally {
      processBrowser.replace(saved);
    }
  });
  test("a host without a session domain still sets up", async () => {
    const manager = new BrowserSessionManager({ headless: true });
    const saved = processBrowser.replace(manager);
    try {
      const { session: _unused, ...ctx } = hostWithSession().ctx;
      await expect(plugin.setup(ctx as never)).resolves.toBeDefined();
    } finally {
      processBrowser.replace(saved);
    }
  });
});
// ---------------------------------------------------------------------------
// Group 2: formatter (1.23)
// ---------------------------------------------------------------------------

describe("Group 2: formatter role, disabled, and redacted values (1.23)", () => {
  const line = (over: Partial<Parameters<typeof formatElementMap>[0][number]>) =>
    formatElementMap([{ id: 1, tag: "div", role: "", label: "L", value: "", selectorFallback: "", ...over }]);

  test("implicit roles are never printed", () => {
    for (const [tag, role] of Object.entries(IMPLICIT_ROLE_BY_TAG)) {
      expect(line({ tag, role })).not.toContain("role=");
      expect(line({ tag, role: tag })).not.toContain("role=");
    }
  });

  test("non-redundant roles are printed after attributes", () => {
    expect(line({ role: "combobox", label: "Select Environment" })).toBe('[1] <div role="combobox"> "Select Environment"');
    expect(line({ tag: "a", role: "button", href: "/x" })).toBe('[1] <a href="/x" role="button"> "L"');
    expect(line({ tag: "input", role: "switch", value: "on" })).toBe('[1] <input value="on" role="switch"> "L"');
  });

  test("disabled is printed only when set", () => {
    expect(line({ tag: "button", role: "button", disabled: true })).toBe('[1] <button disabled> "L"');
    expect(line({ tag: "button", role: "button", disabled: false })).toBe('[1] <button> "L"');
    expect(line({ role: "tab", disabled: true })).toBe('[1] <div role="tab" disabled> "L"');
  });

  test("redacted values print as [redacted]", () => {
    expect(line({ tag: "input", role: "textbox", value: "[redacted]", label: "" })).toBe('[1] <input value="[redacted]">');
  });
});

// ---------------------------------------------------------------------------
// Group 3: telemetry (1.2, 1.20)
// ---------------------------------------------------------------------------

/** Minimal Playwright-page stand-in: an event emitter. */
export function fakePage(): { on(e: string, f: (a: unknown) => void): void; emit(e: string, a: unknown): void } {
  const handlers: Record<string, Array<(a: unknown) => void>> = {};
  return {
    on(e, f) {
      (handlers[e] ??= []).push(f);
    },
    emit(e, a) {
      for (const f of handlers[e] ?? []) f(a);
    },
  };
}

export const consoleMsg = (text: string, url = "") => ({
  type: () => "error",
  text: () => text,
  location: () => ({ url }),
});

export const responseEv = (status: number, url: string) => ({
  status: () => status,
  url: () => url,
  request: () => ({ method: () => "GET" }),
});

describe("Group 3: telemetry", () => {
  test("1.2 the ring keeps delivering new events after it fills", () => {
    const p = fakePage();
    const t = new Telemetry(2);
    t.attach(p as never);
    p.emit("console", consoleMsg("a"));
    p.emit("console", consoleMsg("b"));
    t.drain();
    p.emit("console", consoleMsg("c"));
    expect(t.drain().events.map((e) => e.text)).toEqual(["[ERROR] c ((inline))"]);
    p.emit("console", consoleMsg("d"));
    p.emit("console", consoleMsg("e"));
    expect(t.drain().events.map((e) => e.text)).toEqual(["[ERROR] d ((inline))", "[ERROR] e ((inline))"]);
  });

  test("1.2 duplicates still collapse after the ring has filled", () => {
    const p = fakePage();
    const t = new Telemetry(2);
    t.attach(p as never);
    p.emit("console", consoleMsg("a"));
    p.emit("console", consoleMsg("b"));
    t.drain();
    p.emit("console", consoleMsg("c"));
    p.emit("console", consoleMsg("c"));
    expect(t.drain().events.map((e) => e.text)).toEqual(["[ERROR] c ((inline)) (x2)"]);
  });

  test("1.20 URLs are redacted in text and source; :line:col is kept", () => {
    const p = fakePage();
    const t = new Telemetry(50);
    t.attach(p as never);
    const secret = "https://u:p@api.test/x?access_token=abc#f";
    p.emit("response", responseEv(404, secret));
    p.emit("requestfailed", { method: () => "POST", url: () => secret, failure: () => ({ errorText: "ERR_FAILED" }) });
    p.emit("console", consoleMsg("boom", "https://cdn.test/app.js?sig=zzz#x"));
    const err = new Error("kaput");
    err.stack = "Error: kaput\n    at f (https://cdn.test/app.js?sig=zzz:10:5)\n    at g (https://u:p@cdn.test/b.js#h:3:1)";
    p.emit("pageerror", err);
    const events = t.drain().events;
    expect(events.map((e) => e.text)).toEqual([
      "[HTTP 404] GET https://api.test/x",
      "[NET FAIL] POST https://api.test/x - net::ERR_FAILED",
      "[ERROR] boom (https://cdn.test/app.js)",
      "[PAGE ERROR] kaput |     at f (https://cdn.test/app.js:10:5) |     at g (https://cdn.test/b.js:3:1)",
    ]);
    for (const e of events) {
      for (const leak of ["access_token", "#f", "u:p@", "sig=", "#h", "#x"]) {
        expect(e.text).not.toContain(leak);
        expect(e.source).not.toContain(leak);
      }
    }
    expect(events[0]!.source).toBe("https://api.test/x");
    expect(events[1]!.source).toBe("https://api.test/x");
  });
});

// ---------------------------------------------------------------------------
// Group 5: session and tab lifecycle (unit)
// ---------------------------------------------------------------------------

interface FakeTab {
  on(e: string, f: (a: unknown) => void): void;
  emit(e: string, a?: unknown): void;
  isClosed(): boolean;
  url(): string;
  bringToFront(): Promise<void>;
  opener(): Promise<FakeTab | null>;
  close(): void;
  closed: boolean;
  fronted: number;
}
function fakeTab(url: string, opener: FakeTab | null = null): FakeTab {
  const em = fakePage();
  const tab: FakeTab = {
    opener: async () => opener,
    on: em.on,
    emit: (e, a) => em.emit(e, a),
    isClosed: () => tab.closed,
    url: () => url,
    bringToFront: async () => void (tab.fronted += 1),
    fronted: 0,
    close: () => {
      tab.closed = true;
      em.emit("close", undefined);
    },
    closed: false,
  };
  return tab;
}
/** A context double that opens tabs on demand. */
function fakeContext(initial: FakeTab[] = []) {
  const em = fakePage();
  return {
    on: (e: string, f: (p: FakeTab) => void) => em.on(e, f as (a: unknown) => void),
    pages: () => initial,
    open: (tab: FakeTab) => em.emit("page", tab),
  };
}
describe("Group 5: session lifecycle (unit)", () => {
  test("runExclusive runs turns one at a time, in order, and releases on rejection", async () => {
    const m = new BrowserSessionManager({ headless: true });
    expect(typeof m.runExclusive).toBe("function");
    const log: string[] = [];
    const step = (name: string, ms: number, fail = false) =>
      m.runExclusive!(async () => {
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${name}`);
        if (fail) throw new Error(`${name} failed`);
        return name;
      });
    const results = await Promise.allSettled([step("a", 30), step("b", 5, true), step("c", 1)]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(m.isTurnActive()).toBe(false);
  });
  test("runExclusive serializes one session's turns but lets different sessions run at once", async () => {
    const m = new BrowserSessionManager({ headless: true });
    const log: string[] = [];
    const step = (session: string, name: string, ms: number) =>
      m.runExclusive(async () => {
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${name}`);
      }, session);
    await Promise.all([step("ses_a", "a1", 40), step("ses_b", "b1", 10), step("ses_a", "a2", 1)]);
    // b1 runs alongside a1; a2 waits for a1.
    expect(log.indexOf("start b1")).toBeLessThan(log.indexOf("end a1"));
    expect(log.indexOf("end b1")).toBeLessThan(log.indexOf("end a1"));
    expect(log.indexOf("start a2")).toBeGreaterThan(log.indexOf("end a1"));
    expect(m.isTurnActive()).toBe(false);
  });

  test("1.24 tab-switch notices name the reason: opened vs closed", async () => {
    const tabs = new TabTracker<FakeTab>();
    const main = fakeTab("http://a.test/main");
    const ctx = fakeContext([main]);
    tabs.watch(ctx);
    tabs.activate(main, "s1");
    tabs.beginTurn("s1");
    const popup = fakeTab("http://a.test/popup", main);
    ctx.open(popup);
    await tabs.attributed();
    tabs.endTurn("s1");
    expect(tabs.active("s1")).toBe(popup);
    expect(tabs.takeNotice("s1")).toBe("Switched to new tab: http://a.test/popup");
    expect(tabs.takeNotice("s1")).toBeNull();
    popup.close();
    expect(tabs.active("s1")).toBe(main);
    expect(tabs.takeNotice("s1")).toBe("Active tab closed; switched to tab: http://a.test/main");
  });
  test("tabs: each session has its own active tab, and a popup belongs to the session whose turn opened it", async () => {
    const tabs = new TabTracker<FakeTab>();
    const ctx = fakeContext([]);
    tabs.watch(ctx);
    const a = fakeTab("http://a.test/");
    const b = fakeTab("http://b.test/");
    tabs.activate(a, "ses_a");
    tabs.activate(b, "ses_b");
    expect(tabs.active("ses_a")).toBe(a);
    expect(tabs.active("ses_b")).toBe(b);
    expect(tabs.ownerOf(a)).toBe("ses_a");
    tabs.beginTurn("ses_a");
    const popup = fakeTab("http://a.test/popup", a);
    ctx.open(popup);
    await tabs.attributed();
    tabs.endTurn("ses_a");
    expect(tabs.active("ses_a")).toBe(popup);
    expect(tabs.active("ses_b")).toBe(b);
    expect(tabs.ownerOf(popup)).toBe("ses_a");
    expect(tabs.takeNotice("ses_b")).toBeNull();
    expect(tabs.takeNotice("ses_a")).toContain("Switched to new tab");
  });
  test("tabs: with turns running in two sessions, a popup goes to the session that owns its opener", async () => {
    const tabs = new TabTracker<FakeTab>();
    const ctx = fakeContext([]);
    tabs.watch(ctx);
    const a = fakeTab("http://a.test/");
    const b = fakeTab("http://b.test/");
    tabs.activate(a, "ses_a");
    tabs.activate(b, "ses_b");
    tabs.beginTurn("ses_a");
    tabs.beginTurn("ses_b");
    const popup = fakeTab("http://b.test/popup", b);
    ctx.open(popup);
    await tabs.attributed();
    tabs.endTurn("ses_a");
    tabs.endTurn("ses_b");
    expect(tabs.ownerOf(popup)).toBe("ses_b");
    expect(tabs.active("ses_b")).toBe(popup);
    expect(tabs.active("ses_a")).toBe(a);
    expect(tabs.takeNotice("ses_a")).toBeNull();
  });
  test("tabs: a popup without an opener goes to the only running turn, or to nobody when several run", async () => {
    const tabs = new TabTracker<FakeTab>();
    const ctx = fakeContext([]);
    tabs.watch(ctx);
    tabs.activate(fakeTab("http://a.test/"), "ses_a");
    tabs.activate(fakeTab("http://b.test/"), "ses_b");
    tabs.beginTurn("ses_a");
    const one = fakeTab("http://noopener.test/1");
    ctx.open(one);
    await tabs.attributed();
    expect(tabs.ownerOf(one)).toBe("ses_a");
    tabs.beginTurn("ses_b");
    const two = fakeTab("http://noopener.test/2");
    ctx.open(two);
    await tabs.attributed();
    expect(tabs.ownerOf(two)).toBeNull();
  });
  test("tabs: a tab the user opens from their own tab stays theirs, even during an agent turn", async () => {
    const tabs = new TabTracker<FakeTab>();
    const users = fakeTab("http://users.test/");
    const ctx = fakeContext([users]);
    tabs.watch(ctx);
    tabs.activate(fakeTab("http://a.test/"), "ses_a");
    tabs.beginTurn("ses_a");
    const fromUser = fakeTab("http://users.test/link", users);
    ctx.open(fromUser);
    await tabs.attributed();
    expect(tabs.ownerOf(fromUser)).toBeNull();
    expect(tabs.takeNotice("ses_a")).toBeNull();
  });
  test("tabs: a page opened outside any turn is tracked but claimed by nobody", () => {
    const tabs = new TabTracker<FakeTab>();
    const ctx = fakeContext([]);
    tabs.watch(ctx);
    const mine = fakeTab("http://a.test/");
    tabs.activate(mine, "ses_a");
    const users = fakeTab("http://users-own-tab.test/");
    ctx.open(users);
    expect(tabs.active("ses_a")).toBe(mine);
    expect(tabs.ownerOf(users)).toBeNull();
    expect(tabs.takeNotice("ses_a")).toBeNull();
    expect(tabs.list().map((t) => t.url)).toContain("http://users-own-tab.test/");
    expect(tabs.list("ses_a").map((t) => t.url)).toEqual(["http://a.test/"]);
  });
  test("tabs: closing a session's active tab falls back to its own tabs only", () => {
    const tabs = new TabTracker<FakeTab>();
    const a1 = fakeTab("http://a1.test/");
    const a2 = fakeTab("http://a2.test/");
    const b1 = fakeTab("http://b1.test/");
    tabs.activate(a1, "ses_a");
    tabs.activate(b1, "ses_b");
    tabs.activate(a2, "ses_a");
    a2.close();
    expect(tabs.active("ses_a")).toBe(a1);
    b1.close();
    expect(tabs.active("ses_b")).toBeNull();
    // ses_a is never pointed at ses_b's tab, even though one existed.
    a1.close();
    expect(tabs.active("ses_a")).toBeNull();
  });
  test("tabs: a session cannot switch to another session's tab, and switching does not steal focus by default", async () => {
    const tabs = new TabTracker<FakeTab>();
    const a1 = fakeTab("http://a1.test/");
    const a2 = fakeTab("http://a2.test/");
    const b1 = fakeTab("http://b1.test/");
    tabs.activate(a1, "ses_a");
    tabs.add(a2);
    tabs.own(a2, "ses_a");
    tabs.activate(b1, "ses_b");
    await expect(tabs.switchTo(tabs.idOf(b1), "ses_a")).rejects.toThrow("another session");
    await tabs.switchTo(tabs.idOf(a2), "ses_a");
    expect(tabs.active("ses_a")).toBe(a2);
    expect(a2.fronted).toBe(0);
    await tabs.switchTo(tabs.idOf(a1), "ses_a", { focus: true });
    expect(a1.fronted).toBe(1);
  });
  test("tabs: each tracked page gets one stable id and runs the tracking hook once", () => {
    const tracked: FakeTab[] = [];
    const tabs = new TabTracker<FakeTab>((p) => void tracked.push(p));
    const a = fakeTab("http://a.test/");
    const b = fakeTab("http://b.test/");
    tabs.add(a);
    tabs.add(a);
    tabs.activate(b, "unknown");
    expect(tracked).toEqual([a, b]);
    expect(tabs.idOf(a)).toBe(tabs.idOf(a));
    expect(tabs.idOf(a)).not.toBe(tabs.idOf(b));
    expect(tabs.list().map((t) => t.url)).toEqual(["http://a.test/", "http://b.test/"]);
    b.close();
    expect(tabs.list().map((t) => t.url)).toEqual(["http://a.test/"]);
    // a was never owned, so closing the active tab leaves the session with none.
    expect(tabs.active("unknown")).toBeNull();
  });
  test("tabs: switchTo rejects unknown, closed and unowned tabs", async () => {
    const tabs = new TabTracker<FakeTab>();
    const a = fakeTab("http://a.test/");
    const users = fakeTab("http://users.test/");
    tabs.activate(a);
    tabs.add(users);
    await tabs.switchTo(tabs.idOf(a));
    expect(tabs.active()).toBe(a);
    await expect(tabs.switchTo(tabs.idOf(users))).rejects.toThrow("another session or to the user");
    await expect(tabs.switchTo("page-nope")).rejects.toThrow("not found or closed");
    a.close();
    await expect(tabs.switchTo(tabs.idOf(a))).rejects.toThrow("not found or closed");
  });
  test("tabs: after reset, a dead browser's tabs and context cannot touch new state", () => {
    const tabs = new TabTracker<FakeTab>();
    const old = fakeTab("http://old.test/");
    const oldCtx = fakeContext([old]);
    tabs.watch(oldCtx);
    oldCtx.open(fakeTab("http://old.test/popup"));
    tabs.reset();
    expect(tabs.active()).toBeNull();
    expect(tabs.list()).toEqual([]);
    expect(tabs.takeNotice()).toBeNull();
    // Late events from the old browser are ignored.
    const fresh = fakeTab("http://new.test/");
    tabs.activate(fresh);
    oldCtx.open(fakeTab("http://old.test/late"));
    old.close();
    expect(tabs.active()).toBe(fresh);
    expect(tabs.takeNotice()).toBeNull();
    expect(tabs.list().map((t) => t.url)).toEqual(["http://new.test/"]);
  });
  test("3.13 two plugin setups share one process-global manager and launch nothing", async () => {
    const saved = processBrowser.replace(undefined);
    const ctx = {
      tool: {
        transform: async (cb: (editor: unknown) => void) => {
          cb({ namespace: () => undefined, add: () => undefined });
          return { dispose: async () => undefined };
        },
        list: async () => [],
      },
      permission: { assert: async () => undefined, hook: async () => ({ dispose: async () => undefined }) },
    };
    try {
      await plugin.setup(ctx as never);
      const first = processBrowser.current() as BrowserSessionManager;
      expect(first).toBeInstanceOf(BrowserSessionManager);
      await plugin.setup(ctx as never);
      expect(processBrowser.current()).toBe(first);
      expect(first.tabs.active()).toBeNull();
      expect(first.tabs.list()).toEqual([]);
    } finally {
      processBrowser.replace(saved);
    }
  });

  test("3.14 a cached manager from another plugin build is closed and replaced, not reused", async () => {
    // Regression: a plugin hot reload can run newer code against a manager
    // created by an older build ("this.manager.runExclusive is not a
    // function"). Compatibility is the build fingerprint, not a hand-bumped
    // version number.
    let closed = 0;
    const stale = {
      ensureActivePage: async () => {
        throw new Error("stale manager must not be used");
      },
      close: async () => {
        closed += 1;
      },
    };
    const ctx = {
      tool: {
        transform: async (cb: (editor: unknown) => void) => {
          cb({ namespace: () => undefined, add: () => undefined });
          return { dispose: async () => undefined };
        },
        list: async () => [],
      },
      permission: { assert: async () => undefined, hook: async () => ({ dispose: async () => undefined }) },
    };
    const saved = processBrowser.replace(stale, "older-build");
    try {
      await plugin.setup(ctx as never);
      const manager = processBrowser.current() as BrowserSessionManager;
      expect(manager).not.toBe(stale as unknown);
      expect(manager).toBeInstanceOf(BrowserSessionManager);
      expect(closed).toBe(1);
      expect(manager.tabs.active()).toBeNull();
    } finally {
      processBrowser.replace(saved);
    }
  });
  test("the build fingerprint is stable within a process and covers presence", async () => {
    const { MANAGER_BUILD } = await import("../src/core/process-browser.ts");
    expect(MANAGER_BUILD).toMatch(/^[0-9a-f]{16}$/);
    const again = await import("../src/core/process-browser.ts");
    expect(again.MANAGER_BUILD).toBe(MANAGER_BUILD);
    expect(String(Presence)).toContain("takeOver");
  });
  test("a manager left under the pre-fingerprint key is closed and dropped", async () => {
    const legacyKey = Symbol.for("opencode.browser.session-manager");
    const g = globalThis as unknown as Record<symbol, unknown>;
    let closed = 0;
    g[legacyKey] = { close: async () => void (closed += 1) };
    const saved = processBrowser.replace(undefined);
    try {
      const manager = await processBrowser.acquire(() => new BrowserSessionManager({ headless: true }));
      expect(closed).toBe(1);
      expect(g[legacyKey]).toBeUndefined();
      expect(await processBrowser.acquire()).toBe(manager);
    } finally {
      processBrowser.replace(saved);
    }
  });
});
// ---------------------------------------------------------------------------
// Group 6: inspect on a stub page (1.17, 1.18)
// ---------------------------------------------------------------------------

/** Run inspect's page callback in-process against a stub document. */
function stubInspectPage(doc: { querySelector(sel: string): unknown }) {
  return {
    evaluate: async (fn: (args: unknown) => unknown, args: unknown) => {
      const g = globalThis as unknown as Record<string, unknown>;
      const saved = { document: g["document"], getComputedStyle: g["getComputedStyle"] };
      g["document"] = doc;
      g["getComputedStyle"] = () => ({ display: "inline", visibility: "visible", opacity: "1", pointerEvents: "auto" });
      try {
        return fn(args);
      } finally {
        g["document"] = saved.document;
        g["getComputedStyle"] = saved.getComputedStyle;
      }
    },
  };
}

describe("Group 6: inspect (stub page)", () => {
  const svg = {
    tagName: "svg",
    className: { baseVal: "ic", animVal: "ic" },
    getAttribute: (n: string) => (n === "class" ? "ic" : n === "id" ? "sv" : null),
    getAttributeNames: () => ["id", "class"],
    getBoundingClientRect: () => ({ x: 1, y: 2, width: 10, height: 10 }),
    parentElement: { tagName: "BODY" },
    children: [],
  };

  test("1.17 an SVG target prints its class attribute", async () => {
    const page = stubInspectPage({ querySelector: () => svg });
    const r = await inspectElement(page as never, { selector: "#sv" });
    expect(r.found).toBe(true);
    expect(r.lines[0]).toBe('tag: <svg class="ic">');
  });

  test("1.18 an invalid selector throws InvalidInputError naming it", async () => {
    const page = stubInspectPage({
      querySelector: (sel: string) => {
        throw new SyntaxError(`Failed to execute 'querySelector' on 'Document': '${sel}' is not a valid selector.`);
      },
    });
    const error = await rejection(inspectElement(page as never, { selector: "div[" }));
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as Error).message).toContain('invalid selector "div["');
  });
});

// ---------------------------------------------------------------------------
// Group 7: documentation matches the enforced controls (1.28)
// ---------------------------------------------------------------------------


const REPO = path.resolve(import.meta.dir, "..", "..");
const DAEMON_SECTION = "## Daemon and legacy shim only";

function configTableVars(readme: string): Set<string> {
  const vars = new Set<string>();
  for (const line of readme.split("\n")) {
    const m = /^\| `(OPENCODE_BROWSER_[A-Z_]+)`/.exec(line);
    if (m) vars.add(m[1]!);
  }
  return vars;
}

describe("Group 7: documentation (1.28)", () => {
  const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
  const security = fs.readFileSync(path.join(REPO, "docs", "security.md"), "utf8");

  test("every OPENCODE_BROWSER_* variable read by config.ts is in the README table", () => {
    const config = fs.readFileSync(path.join(REPO, "plugin", "src", "config.ts"), "utf8");
    const read = new Set(config.match(/OPENCODE_BROWSER_[A-Z_]+/g) ?? []);
    const documented = configTableVars(readme);
    expect([...read].filter((v) => !documented.has(v)).sort()).toEqual([]);
  });

  test("variables documented before the sweep are still documented", () => {
    const before = Bun.spawnSync(["git", "-C", REPO, "show", "c4bf2d5:README.md"]);
    if (before.exitCode !== 0) return; // no git history available
    const documented = configTableVars(readme);
    const old = [...configTableVars(before.stdout.toString())];
    expect(old.filter((v) => !documented.has(v))).toEqual([]);
  });

  test("daemon-only controls appear only under the daemon section of docs/security.md", () => {
    const start = security.indexOf(DAEMON_SECTION);
    let outside = security;
    if (start !== -1) {
      const rest = security.slice(start + DAEMON_SECTION.length);
      const next = rest.search(/\n## /);
      outside = security.slice(0, start) + (next === -1 ? "" : rest.slice(next));
    }
    for (const token of ["dispatch.rs", "policy.rs", "browser_upload", "$XDG_CACHE_HOME"]) {
      expect({ token, outside: outside.includes(token) }).toEqual({ token, outside: false });
    }
  });
});
