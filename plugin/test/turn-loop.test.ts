/**
 * The shared turn sequence, without a browser: a fake process browser with a
 * real TabTracker, fake tabs, and a stand-in perception adapter.
 */
import { describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { loadConfig } from "../src/config.ts";
import { PlaywrightBrowserSession, type SessionHost } from "../src/core/browser-session.ts";
import type { Perception, PerceiveOptions } from "../src/core/perception.ts";
import { TabTracker } from "../src/core/tab-tracker.ts";
import { Telemetry } from "../src/core/telemetry.ts";
import { Viewport } from "../src/core/viewport.ts";

interface Tab {
  readonly name: string;
  readonly hud: string[];
  closed: boolean;
  on(event: string, fn: () => void): void;
  isClosed(): boolean;
  url(): string;
  title(): Promise<string>;
  bringToFront(): Promise<void>;
  waitForLoadState(): Promise<void>;
  context(): { newCDPSession(): Promise<never> };
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
}

/** A tab whose page expressions (`browse_eval`) are handled by `onExpression`. */
function tab(name: string, onExpression: (expr: string) => unknown = () => 1): Tab {
  const hud: string[] = [];
  const t: Tab = {
    name,
    hud,
    closed: false,
    on: () => undefined,
    isClosed: () => t.closed,
    url: () => `http://${name}.test/`,
    title: async () => name,
    bringToFront: async () => undefined,
    waitForLoadState: async () => undefined,
    context: () => ({ newCDPSession: async () => Promise.reject(new Error("no CDP in tests")) }),
    evaluate: async (fn, arg) => {
      if (typeof fn === "string") return onExpression(fn);
      // A HUD call: { names, method, args }.
      const call = arg as { method?: string; args?: unknown[] } | undefined;
      if (call?.method) hud.push(`${call.method}(${(call.args ?? []).join(",")})`);
      return undefined;
    },
  };
  return t;
}

function host(main: Tab) {
  const tabs = new TabTracker<Tab>();
  let onPage: (p: Tab) => void = () => undefined;
  tabs.watch({ on: (_e, fn) => void (onPage = fn), pages: () => [main] });
  tabs.activate(main);
  const fake = {
    ensureActivePage: async () => tabs.active() ?? main,
    runExclusive: <T>(fn: () => Promise<T>) => fn(),
    getConfig: () => ({ ...loadConfig(), evalTimeoutMs: 1000 }),
    getTelemetry: () => new Telemetry(),
    getViewport: () => new Viewport("emulated"),
    tabs,
  };
  return { host: fake as unknown as SessionHost, open: (p: Tab) => onPage(p) };
}

function perceptionStandIn(seen: string[], notice: string | null = null) {
  return async (page: Page, opts: PerceiveOptions): Promise<Perception> => {
    seen.push(`${(page as unknown as Tab).name} annotate=${opts.annotate}`);
    return { elements: [], screenshotPath: null, width: 800, height: 600, telemetryEvents: [], notice };
  };
}

const textOf = (r: { content: { type: string; text?: string }[] }) =>
  r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

describe("turn loop", () => {
  test("a tab opened by the intent is the one perceived; both tabs' HUDs are cleared", async () => {
    const popup = tab("popup");
    let env!: ReturnType<typeof host>;
    const main = tab("main", () => {
      env.open(popup);
      return "opened";
    });
    env = host(main);
    const seen: string[] = [];
    const session = new PlaywrightBrowserSession(env.host, perceptionStandIn(seen));
    const result = await session.turn({ kind: "evaluate", expression: "window.open()" });
    expect(seen).toEqual(["popup annotate=false"]);
    expect(result.metadata["tabId"]).toBe(env.host.tabs.idOf(popup as unknown as Page));
    expect(textOf(result)).toContain("Switched to new tab: http://popup.test/");
    expect(main.hud).toContain("updateStatus()");
    expect(popup.hud).toContain("updateStatus()");
    // The notice is consumed by the turn that reported it.
    expect(env.host.tabs.takeNotice()).toBeNull();
  });

  test("a failing intent still clears the HUD and skips perception", async () => {
    const main = tab("main");
    const env = host(main);
    const seen: string[] = [];
    const session = new PlaywrightBrowserSession(env.host, perceptionStandIn(seen));
    await expect(
      session.turn({ kind: "evaluate", expression: "1", approvedUrl: "https://elsewhere.test/" }),
    ).rejects.toThrow("page changed since browse_eval was approved");
    expect(seen).toEqual([]);
    expect(main.hud).toEqual(["updateStatus()"]);
  });

  test("observe passes annotate/fullPage through and merges the perception notice", async () => {
    const main = tab("main");
    const env = host(main);
    const seen: string[] = [];
    const session = new PlaywrightBrowserSession(env.host, perceptionStandIn(seen, "Perception incomplete: test"));
    const result = await session.turn({ kind: "observe", annotate: false });
    expect(seen).toEqual(["main annotate=false"]);
    expect(textOf(result)).toContain("Perception incomplete: test");
    expect(result.metadata["tabId"]).toBe(env.host.tabs.idOf(main as unknown as Page));
  });
});
