/**
 * Deterministic post-action settling.
 *
 * `waitForSettled(page)` waits for:
 *   1. 50 ms so synchronous click/input handlers can kick off state updates /
 *      fetch calls,
 *   2. in-flight mutable network requests (fetch / xhr / document) to reach 0
 *      for quietWindowMs (default 250 ms) or until maxTimeoutMs (default 2500 ms),
 *   3. 2 consecutive requestAnimationFrame ticks + a MutationObserver quiet
 *      window (default 250 ms) so React / Next.js re-renders finish painting.
 *
 * Requests start *during the action*, before `waitForSettled` is called. To see
 * them, create the activity tracker before executing the action and pass it in:
 *
 *   const activity = trackNetwork(page);
 *   try { await execBatch(...); await waitForSettled(page, { activity }); }
 *   finally { activity.dispose(); }
 *
 * SSE, WebSocket, and analytics-ish resource types are ignored for the network
 * quiet test.
 */

import type { Page } from "playwright";

export interface SettleOptions {
  readonly maxTimeoutMs?: number; // default 2500
  readonly quietWindowMs?: number; // default 250 (network quiet)
  /** Tracker created before the action, so in-flight requests are not missed. */
  readonly activity?: NetworkActivity;
}

export interface SettleResult {
  readonly settled: boolean;
  readonly networkQuiet: boolean;
  readonly renderQuiet: boolean;
  readonly durationMs: number;
}

/** Live view of mutable network activity for one page. */
export interface NetworkActivity {
  activeRequests(): number;
  lastActivityAt(): number;
  dispose(): void;
}

const MUTABLE_RESOURCE_TYPES = new Set(["fetch", "xhr", "document"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resourceTypeOf(value: {
  resourceType?: () => string;
  request?: () => { resourceType(): string } | null;
}): string | undefined {
  if (value.request) {
    const req = value.request();
    return req?.resourceType();
  }
  return value.resourceType?.();
}

/**
 * Start tracking requests now. Call this **before** the action so a fetch
 * started by the click handler is counted; a tracker created after the action
 * can only see later requests.
 */
export function trackNetwork(page: Page): NetworkActivity {
  let active = 0;
  let last = Date.now();

  const onRequest = (req: { resourceType(): string }): void => {
    if (!MUTABLE_RESOURCE_TYPES.has(req.resourceType())) return;
    active += 1;
    last = Date.now();
  };
  const onDone = (ev: {
    resourceType?: () => string;
    request?: () => { resourceType(): string } | null;
  }): void => {
    const rt = resourceTypeOf(ev);
    if (rt === undefined || !MUTABLE_RESOURCE_TYPES.has(rt)) return;
    active = Math.max(0, active - 1);
    if (active === 0) last = Date.now();
  };

  page.on("request", onRequest as never);
  page.on("response", onDone as never);
  page.on("requestfailed", onDone as never);

  return {
    activeRequests: () => active,
    lastActivityAt: () => last,
    dispose: () => {
      page.off("request", onRequest as never);
      page.off("response", onDone as never);
      page.off("requestfailed", onDone as never);
    },
  };
}

export async function waitForSettled(
  page: Page,
  options: SettleOptions = {},
): Promise<SettleResult> {
  const maxTimeoutMs = options.maxTimeoutMs ?? 2500;
  const quietWindowMs = options.quietWindowMs ?? 250;
  const start = Date.now();

  // Callers that ran an action pass a tracker created before it. Standalone
  // callers start one here; it cannot see requests that are already in flight.
  const own = options.activity === undefined ? trackNetwork(page) : null;
  const activity = options.activity ?? own!;

  try {
    // 1) Let synchronous handlers kick off state updates / fetches.
    await sleep(50);

    // 2) Network quiet: active mutable requests reach 0 for quietWindowMs.
    let networkQuiet = false;
    const networkDeadline = start + maxTimeoutMs;
    while (Date.now() < networkDeadline) {
      if (
        activity.activeRequests() === 0 &&
        Date.now() - activity.lastActivityAt() >= quietWindowMs
      ) {
        networkQuiet = true;
        break;
      }
      await sleep(50);
    }

    // 3) In-page: 2 consecutive rAFs, then a MutationObserver quiet window.
    // A navigation can destroy the context mid-evaluate; that only means the
    // render state is unknown, never that the completed action failed.
    const renderQuiet = await page
      .evaluate<boolean, number>((quietMs: number) => {
        const w = globalThis as unknown as Record<string, any>;
        return new Promise<boolean>((resolve) => {
          let rafs = 0;
          const nextRAF = (): void => {
            w.requestAnimationFrame(() => {
              rafs += 1;
              if (rafs < 2) {
                nextRAF();
                return;
              }
              // MutationObserver quiet window after 2 rAFs. The timer starts
              // armed: a page that never mutates is settled, not timed out.
              let quietTimer: ReturnType<typeof setTimeout> | null = null;
              let hardTimer: ReturnType<typeof setTimeout> | null = null;
              let done = false;
              const finish = (value: boolean): void => {
                if (done) return;
                done = true;
                observer.disconnect();
                if (quietTimer !== null) clearTimeout(quietTimer);
                if (hardTimer !== null) clearTimeout(hardTimer);
                resolve(value);
              };
              const observer = new w.MutationObserver(() => {
                if (quietTimer !== null) clearTimeout(quietTimer);
                quietTimer = setTimeout(() => finish(true), quietMs);
              });
              observer.observe(w.document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
              });
              quietTimer = setTimeout(() => finish(true), quietMs);
              // Hard fallback so a continuously-mutating page cannot wedge settle.
              hardTimer = setTimeout(() => finish(false), quietMs + 300);
            });
          };
          nextRAF();
        });
      }, quietWindowMs)
      .catch(() => false);

    const durationMs = Date.now() - start;
    return {
      settled: networkQuiet && renderQuiet,
      networkQuiet,
      renderQuiet,
      durationMs,
    };
  } finally {
    own?.dispose();
  }
}
