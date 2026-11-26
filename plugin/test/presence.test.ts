/**
 * Presence: which sessions are using the browser, which tabs show the HUD,
 * when it goes away, and Take over. No browser: fake tabs record HUD calls.
 */
import { describe, expect, test } from "bun:test";
import { Presence, THINKING, type PresenceTimers } from "../src/core/presence.ts";

interface FakeTab {
  readonly name: string;
  readonly calls: string[];
  closed: boolean;
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
  on(event: string, listener: () => void): void;
  isClosed(): boolean;
  fire(event: string): void;
}

/** A tab that records the HUD calls it receives as "method(args)". */
function tab(name: string): FakeTab {
  const handlers = new Map<string, (() => void)[]>();
  const t: FakeTab = {
    name,
    calls: [],
    closed: false,
    evaluate: async (_fn, arg) => {
      const call = arg as { method: string; args: unknown[] };
      t.calls.push(`${call.method}(${call.args.join(",")})`);
      return undefined;
    },
    on: (event, listener) => void handlers.set(event, [...(handlers.get(event) ?? []), listener]),
    isClosed: () => t.closed,
    fire: (event) => handlers.get(event)?.forEach((fn) => fn()),
  };
  return t;
}

/** Manual timers: nothing fires until `advance`. */
function manualTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: PresenceTimers = {
    set: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (handle) => void pending.delete(handle as number),
  };
  return {
    timers,
    advance: async (ms: number) => {
      now += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at <= now) {
          pending.delete(id);
          entry.fn();
        }
      }
      await Promise.resolve();
      await Promise.resolve();
    },
    pending: () => pending.size,
  };
}

const page = (t: FakeTab) => t as never;
const make = (timeoutMs = 30000) => {
  const clock = manualTimers();
  const presence = new Presence({ timeoutMs }, clock.timers);
  presence.enabled = true;
  return { presence, clock };
};

describe("presence", () => {
  test("a disabled presence (headless) never shows anything and just clears the pill", async () => {
    const presence = new Presence({ timeoutMs: 1000 });
    const a = tab("a");
    await presence.begin("s1", [page(a)]);
    await presence.settle([page(a)]);
    expect(presence.isActive()).toBe(false);
    expect(a.calls).toEqual(["updateStatus()"]);
  });

  test("the first browser call presents the tab; the end of a turn shows Thinking…", async () => {
    const { presence } = make();
    const a = tab("a");
    await presence.begin("s1", [page(a)]);
    expect(presence.isActive()).toBe(true);
    expect(a.calls).toEqual(["setPresent(true)"]);
    await presence.settle([page(a)]);
    expect(a.calls.at(-1)).toBe(`updateStatus(${THINKING})`);
  });

  test("a tab that is already presented costs no further page call", async () => {
    const { presence } = make();
    const a = tab("a");
    await presence.begin("s1", [page(a)]);
    await presence.begin("s1", [page(a)]);
    await presence.settle([page(a)]);
    expect(a.calls.filter((c) => c === "setPresent(true)")).toHaveLength(1);
  });

  test("only tabs the agent used are presented, including a tab opened mid-turn", async () => {
    const { presence } = make();
    const used = tab("used");
    const popup = tab("popup");
    const untouched = tab("untouched");
    await presence.begin("s1", [page(used)]);
    await presence.settle([page(used), page(popup)]);
    expect(popup.calls).toContain("setPresent(true)");
    expect(untouched.calls).toEqual([]);
  });

  test("the HUD goes away only when every session that used the browser is idle", async () => {
    const { presence } = make();
    const a = tab("a");
    await presence.begin("s1", [page(a)]);
    await presence.begin("s2", [page(a)]);
    await presence.end("s1", []);
    expect(presence.isActive()).toBe(true);
    expect(a.calls.at(-1)).not.toBe("setPresent(false)");
    await presence.end("s2", []);
    expect(presence.isActive()).toBe(false);
    expect(a.calls.at(-1)).toBe("setPresent(false)");
  });

  test("an idle parent that waits on a running subagent counts as busy", async () => {
    const { presence } = make();
    const a = tab("a");
    await presence.begin("parent", [page(a)]);
    await presence.begin("child", [page(a)]);
    await presence.end("parent", [
      { kind: "subagent", sessionID: "parent", childSessionID: "child" },
    ]);
    expect(presence.sessionIds().sort()).toEqual(["child", "parent"]);
    await presence.end("child", []);
    expect(presence.isActive()).toBe(true);
    // The parent's idle hook runs again when the subagent finishes.
    await presence.end("parent", []);
    expect(presence.isActive()).toBe(false);
  });

  test("background work a descendant owns does not keep the parent busy", async () => {
    const { presence } = make();
    const a = tab("a");
    await presence.begin("parent", [page(a)]);
    await presence.end("parent", [{ kind: "shell", sessionID: "child" }]);
    expect(presence.isActive()).toBe(false);
  });

  test("the safety timer releases the HUD when no idle signal arrives, and each call re-arms it", async () => {
    const { presence, clock } = make(30000);
    const a = tab("a");
    await presence.begin("s1", [page(a)]);
    await clock.advance(20000);
    await presence.begin("s1", [page(a)]);
    await clock.advance(20000);
    expect(presence.isActive()).toBe(true);
    await clock.advance(10000);
    expect(presence.isActive()).toBe(false);
    expect(a.calls.at(-1)).toBe("setPresent(false)");
    expect(clock.pending()).toBe(0);
  });

  test("a call after a timed-out release presents the tab again", async () => {
    const { presence, clock } = make(1000);
    const a = tab("a");
    await presence.begin("s1", [page(a)]);
    await clock.advance(1000);
    a.calls.length = 0;
    await presence.begin("s1", [page(a)]);
    expect(presence.isActive()).toBe(true);
    expect(a.calls).toEqual(["setPresent(true)"]);
  });

  test("Take over releases the HUD and interrupts every session that used the browser", async () => {
    const { presence } = make();
    const a = tab("a");
    const interrupted: string[] = [];
    presence.setInterrupter(async (id) => void interrupted.push(id));
    await presence.begin("s1", [page(a)]);
    await presence.begin("s2", [page(a)]);
    await presence.takeOver();
    expect(interrupted.sort()).toEqual(["s1", "s2"]);
    expect(presence.isActive()).toBe(false);
    expect(a.calls.at(-1)).toBe("setPresent(false)");
  });

  test("Take over survives a failing interrupter and does nothing when idle", async () => {
    const { presence } = make();
    presence.setInterrupter(async () => {
      throw new Error("interrupt failed");
    });
    await presence.takeOver();
    await presence.begin("s1", [page(tab("a"))]);
    await expect(presence.takeOver()).resolves.toBeUndefined();
    expect(presence.isActive()).toBe(false);
  });

  test("a navigation re-presents the tab while active, and not after release", async () => {
    const { presence } = make();
    const a = tab("a");
    await presence.begin("s1", [page(a)]);
    a.calls.length = 0;
    a.fire("domcontentloaded");
    await Promise.resolve();
    expect(a.calls).toEqual(["setPresent(true)"]);
    await presence.end("s1", []);
    a.calls.length = 0;
    a.fire("domcontentloaded");
    await Promise.resolve();
    expect(a.calls).toEqual([]);
  });

  test("a closed tab is forgotten and never touched on release", async () => {
    const { presence } = make();
    const a = tab("a");
    await presence.begin("s1", [page(a)]);
    a.closed = true;
    a.fire("close");
    a.calls.length = 0;
    await presence.end("s1", []);
    expect(a.calls).toEqual([]);
  });

  test("settle on an inactive presence clears the pill and hides the tab", async () => {
    const { presence } = make();
    const a = tab("a");
    await presence.settle([page(a)]);
    expect(a.calls).toEqual(["setPresent(false)", "updateStatus()"]);
  });

  test("discard forgets sessions, tabs and the timer without touching the tabs", async () => {
    const { presence, clock } = make();
    const a = tab("a");
    await presence.begin("s1", [page(a)]);
    a.calls.length = 0;
    presence.discard();
    expect(presence.isActive()).toBe(false);
    expect(clock.pending()).toBe(0);
    expect(a.calls).toEqual([]);
  });
});
