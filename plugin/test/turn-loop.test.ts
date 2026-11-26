/**
 * The shared turn sequence, without a browser: a fake process browser with a
 * real TabTracker, fake tabs, and a stand-in perception adapter.
 */
import { describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { loadConfig } from "../src/config.ts";
import { PlaywrightBrowserSession, type SessionHost } from "../src/core/browser-session.ts";
import type { Perception, PerceiveOptions } from "../src/core/perception.ts";
import { Dialogs } from "../src/core/dialogs.ts";
import { Downloads } from "../src/core/files.ts";
import { SiteGuard } from "../src/core/site-guard.ts";
import { NetworkLog } from "../src/core/network-log.ts";
import { parseSiteRules } from "../src/core/site-rules.ts";
import { Presence, THINKING } from "../src/core/presence.ts";
import { TabTracker } from "../src/core/tab-tracker.ts";
import { Telemetry } from "../src/core/telemetry.ts";
import { Viewport } from "../src/core/viewport.ts";

interface Tab {
  readonly name: string;
  readonly hud: string[];
  closed: boolean;
  on(event: string, fn: (arg?: never) => void): void;
  emit(event: string, arg?: unknown): void;
  isClosed(): boolean;
  url(): string;
  title(): Promise<string>;
  bringToFront(): Promise<void>;
  opener(): Promise<Tab | null>;
  waitForLoadState(): Promise<void>;
  context(): { newCDPSession(): Promise<never> };
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
}

/** A tab whose page expressions (`browse_eval`) are handled by `onExpression`. */
function tab(name: string, onExpression: (expr: string) => unknown = () => 1): Tab {
  const hud: string[] = [];
  const handlers = new Map<string, ((arg?: unknown) => void)[]>();
  const t: Tab = {
    name,
    hud,
    closed: false,
    on: (event, fn) => void handlers.set(event, [...(handlers.get(event) ?? []), fn as (a?: unknown) => void]),
    emit: (event, arg) => handlers.get(event)?.forEach((fn) => fn(arg)),
    isClosed: () => t.closed,
    url: () => `http://${name}.test/`,
    title: async () => name,
    bringToFront: async () => undefined,
    opener: async () => null,
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

function host(main: Tab, presence = new Presence({ timeoutMs: 30000 }), screenshots = true, dialogs = new Dialogs()) {
  const tabs = new TabTracker<Tab>();
  let onPage: (p: Tab) => void = () => undefined;
  tabs.watch({ on: (_e, fn) => void (onPage = fn), pages: () => [main] });
  tabs.activate(main);
  const fake = {
    ensureActivePage: async () => tabs.active() ?? main,
    runExclusive: <T>(fn: () => Promise<T>) => fn(),
    getConfig: () => ({ ...loadConfig(), evalTimeoutMs: 1000, screenshots }),
    getTelemetry: () => new Telemetry(),
    getViewport: () => new Viewport("emulated"),
    presence,
    dialogs,
    downloads: new Downloads("/tmp/opencode-turn-loop-downloads"),
    sites: new SiteGuard(parseSiteRules("", "")),
    sitesReady: async () => undefined,
    network: new NetworkLog(),
    tabs,
  };
  return { host: fake as unknown as SessionHost, open: (p: Tab) => onPage(p) };
}

const shots: (boolean | undefined)[] = [];
function perceptionStandIn(seen: string[], notice: string | null = null) {
  return async (page: Page, opts: PerceiveOptions): Promise<Perception> => {
    seen.push(`${(page as unknown as Tab).name} annotate=${opts.annotate}`);
    shots.push(opts.screenshot);
    return { elements: [], frames: [], screenshotPath: null, width: 800, height: 600, telemetryEvents: [], notice };
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

  test("with presence on, the session id reaches presence and the pill says Thinking… after the turn", async () => {
    const main = tab("main");
    const presence = new Presence({ timeoutMs: 30000 });
    presence.enabled = true;
    const env = host(main, presence);
    const session = new PlaywrightBrowserSession(env.host, perceptionStandIn([]));
    await session.turn({ kind: "observe" }, { sessionId: "ses_42" });
    expect(presence.sessionIds()).toEqual(["ses_42"]);
    expect(main.hud).toEqual(["setPresent(true)", `updateStatus(${THINKING})`]);
  });

  test("a failing intent leaves the agent Thinking…, not showing a stale step", async () => {
    const main = tab("main");
    const presence = new Presence({ timeoutMs: 30000 });
    presence.enabled = true;
    const env = host(main, presence);
    const session = new PlaywrightBrowserSession(env.host, perceptionStandIn([]));
    await expect(
      session.turn({ kind: "evaluate", expression: "1", approvedUrl: "https://elsewhere.test/" }, { sessionId: "s" }),
    ).rejects.toThrow("page changed");
    expect(main.hud.at(-1)).toBe(`updateStatus(${THINKING})`);
  });

  test("a popup the turn opens is presented too", async () => {
    const popup = tab("popup");
    let env!: ReturnType<typeof host>;
    const main = tab("main", () => {
      env.open(popup);
      return "opened";
    });
    const presence = new Presence({ timeoutMs: 30000 });
    presence.enabled = true;
    env = host(main, presence);
    const session = new PlaywrightBrowserSession(env.host, perceptionStandIn([]));
    await session.turn({ kind: "evaluate", expression: "window.open()" }, { sessionId: "s" });
    expect(popup.hud).toContain("setPresent(true)");
    expect(popup.hud.at(-1)).toBe(`updateStatus(${THINKING})`);
  });

  test("a screenshot is taken unless the call or the environment opts out", async () => {
    shots.length = 0;
    const on = new PlaywrightBrowserSession(host(tab("a")).host, perceptionStandIn([]));
    await on.turn({ kind: "observe" });
    await on.turn({ kind: "observe", screenshot: false });
    const off = new PlaywrightBrowserSession(host(tab("b"), undefined, false).host, perceptionStandIn([]));
    await off.turn({ kind: "observe" });
    expect(shots).toEqual([true, false, false]);
  });

  test("a dialog turn sets the plan for the tab it ran on", async () => {
    const main = tab("main");
    const dialogs = new Dialogs();
    const session = new PlaywrightBrowserSession(host(main, undefined, true, dialogs).host, perceptionStandIn([]));
    const result = await session.turn({ kind: "dialog", accept: true, promptText: "Ada" });
    expect(textOf(result)).toContain("The next dialog on this tab will be accepted.");
    expect(dialogs.pending(main as never)).toEqual({ accept: true, promptText: "Ada" });
  });

  test("a dialog answered during a turn is reported in that turn, once", async () => {
    const dialogs = new Dialogs();
    let env!: ReturnType<typeof host>;
    const main = tab("main", () => {
      // The page opens a confirm while the expression runs.
      main.emit("dialog", {
        type: () => "confirm",
        message: () => "Delete?",
        accept: async () => undefined,
        dismiss: async () => undefined,
      });
      return "ran";
    });
    dialogs.attach(main as never);
    env = host(main, undefined, true, dialogs);
    const session = new PlaywrightBrowserSession(env.host, perceptionStandIn([]));
    const first = await session.turn({ kind: "evaluate", expression: "confirm('Delete?')" });
    await Promise.resolve();
    // The answer lands asynchronously; a later turn reports it exactly once.
    const second = await session.turn({ kind: "observe" });
    const reported = [first, second].map(textOf).filter((t) => t.includes('Dialog: confirm "Delete?" was dismissed'));
    expect(reported).toHaveLength(1);
    expect(textOf(await session.turn({ kind: "observe" }))).not.toContain("Dialog:");
  });
});
