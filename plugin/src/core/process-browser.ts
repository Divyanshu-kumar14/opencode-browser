/**
 * The process-wide browser: one BrowserSessionManager per OpenCode server
 * process, shared by every plugin instance.
 *
 * The host re-instantiates plugins many times per process (292 loads observed
 * in one afternoon, ~9/minute during active turns). A per-setup manager meant
 * every disposal closed the shared Chromium, so the manager lives on
 * `globalThis` and only process teardown closes it.
 *
 * A hot reload can run newer code next to a manager built by older code. Each
 * slot entry records the build that created it: a fingerprint of the source
 * the manager instance carries (its class, the modules it holds, the page
 * scripts it installs). A different build is closed and replaced; an
 * identical re-evaluation is reused. Nobody bumps a version by hand.
 */

import * as crypto from "node:crypto";
import { BrowserSessionManager } from "./session-manager.ts";
import { TabTracker } from "./tab-tracker.ts";
import { Telemetry } from "./telemetry.ts";
import { Viewport } from "./viewport.ts";
import { pageScripts } from "./page-agent.ts";

const SLOT_KEY = Symbol.for("opencode.browser.process");
/** Where builds before the process-browser module kept a bare manager. */
const LEGACY_KEY = Symbol.for("opencode.browser.session-manager");

/** Fingerprint of the code a manager instance runs. */
export const MANAGER_BUILD = crypto
  .createHash("sha256")
  .update([BrowserSessionManager, Viewport, TabTracker, Telemetry].map(String).join("\n"))
  .update(pageScripts(1).join("\n"))
  .digest("hex")
  .slice(0, 16);

interface Entry {
  readonly manager: unknown;
  readonly build: string;
}

interface Slot {
  entry?: Entry;
  /** Signal handlers are armed once per process, whatever the build. */
  teardownArmed?: boolean;
}

function slot(): Slot {
  const g = globalThis as unknown as Record<symbol, Slot | undefined>;
  return (g[SLOT_KEY] ??= {});
}

async function closeQuietly(value: unknown): Promise<void> {
  const closable = value as { close?: () => Promise<void> } | null | undefined;
  if (typeof closable?.close === "function") await closable.close().catch(() => undefined);
}

/**
 * The manager for this build. A manager from another build (or from a build
 * that predates this module) is closed first, so no orphaned Chromium keeps
 * the profile lock. Arms process teardown once.
 */
async function acquire(
  create: () => BrowserSessionManager = () => new BrowserSessionManager(),
): Promise<BrowserSessionManager> {
  const s = slot();
  const legacy = globalThis as unknown as Record<symbol, unknown>;
  if (legacy[LEGACY_KEY] !== undefined) {
    await closeQuietly(legacy[LEGACY_KEY]);
    delete legacy[LEGACY_KEY];
  }
  const entry = s.entry;
  armTeardown(s);
  if (entry !== undefined && entry.build === MANAGER_BUILD) return entry.manager as BrowserSessionManager;
  if (entry !== undefined) await closeQuietly(entry.manager);
  const manager = create();
  s.entry = { manager, build: MANAGER_BUILD };
  return manager;
}

/**
 * Close the browser on SIGINT / SIGTERM / beforeExit so managed Chromium never
 * zombies. The handlers close whichever manager is current at that moment.
 *
 * Installing a signal handler replaces the default termination. After the
 * browser is closed (bounded at 5 s), the signal is re-raised only when no
 * other listener remains, so the default action ends the process with the
 * right signal status. When the host has its own handlers, they own
 * termination. Never process.exit(0): that reports success for a signal and
 * cuts off the host's asynchronous cleanup.
 */
function armTeardown(s: Slot): void {
  if (s.teardownArmed) return;
  s.teardownArmed = true;
  const closeCurrent = (): Promise<void> => closeQuietly(s.entry?.manager);
  const onSignal = (signal: NodeJS.Signals): void => {
    void Promise.race([closeCurrent(), sleepMs(5000)]).finally(() => {
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.on("beforeExit", () => void closeCurrent());
}

/**
 * Test seam: swap the cached manager (for this build) and get the previous
 * one back. `undefined` empties the slot. Nothing is closed.
 */
function replace(manager: unknown, build: string = MANAGER_BUILD): unknown {
  const s = slot();
  const previous = s.entry?.manager;
  s.entry = manager === undefined ? undefined : { manager, build };
  return previous;
}

/** The cached manager, if any (whatever its build). */
function current(): unknown {
  return slot().entry?.manager;
}

export const processBrowser = { acquire, replace, current };

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms) as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  });
}
