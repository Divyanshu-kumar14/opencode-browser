/**
 * Deterministic post-action settling.
 *
 * waitForSettled(page) waits for:
 *   1. 50 ms so synchronous click/input handlers can kick off state updates /
 *      fetch calls,
 *   2. in-flight mutable network requests (fetch / xhr / document) to reach 0
 *      for quietWindowMs (default 250 ms) or until maxTimeoutMs (default 2500 ms),
 *   3. 2 consecutive requestAnimationFrame ticks + a MutationObserver quiet
 *      window (default 100 ms) so React / Next.js re-renders finish painting.
 *
 * SSE, WebSocket, and analytics-ish resource types are ignored for the network
 * quiet test.
 */

import type { Page } from "playwright";

export interface SettleOptions {
  readonly maxTimeoutMs?: number;   // default 2500
  readonly quietWindowMs?: number;  // default 250 (network quiet)
}

export interface SettleResult {
  readonly settled: boolean;
  readonly networkQuiet: boolean;
  readonly renderQuiet: boolean;
  readonly durationMs: number;
}

const MUTABLE_RESOURCE_TYPES = new Set(["fetch", "xhr", "document"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestOf(value: { request?: () => { resourceType(): string } | null }): string | undefined {
  const req = value.request ? value.request() : null;
  return req?.resourceType();
}

export async function waitForSettled(
  page: Page,
  options: SettleOptions = {},
): Promise<SettleResult> {
  const maxTimeoutMs = options.maxTimeoutMs ?? 2500;
  const quietWindowMs = options.quietWindowMs ?? 250;
  const start = Date.now();

  // 1) Let synchronous handlers kick off state updates / fetches.
  await sleep(50);

  // 2) Network quiet: active mutable requests reach 0 for quietWindowMs.
  let active = 0;
  let lastActiveTime = Date.now();
  let networkQuiet = false;

  const onRequest = (req: { resourceType(): string }): void => {
    if (MUTABLE_RESOURCE_TYPES.has(req.resourceType())) {
      active += 1;
      lastActiveTime = Date.now();
    }
  };
  const onRequestDone = (ev: { request?: () => { resourceType(): string } | null }): void => {
    const rt = requestOf(ev);
    if (rt === undefined || !MUTABLE_RESOURCE_TYPES.has(rt)) return;
    active = Math.max(0, active - 1);
    if (active === 0) lastActiveTime = Date.now();
  };

  page.on("request", onRequest as any);
  page.on("response", onRequestDone as any);
  page.on("requestfailed", onRequestDone as any);

  try {
    const networkDeadline = start + maxTimeoutMs;
    while (Date.now() < networkDeadline) {
      if (active === 0 && Date.now() - lastActiveTime >= quietWindowMs) {
        networkQuiet = true;
        break;
      }
      await sleep(50);
    }
  } finally {
    page.off("request", onRequest as any);
    page.off("response", onRequestDone as any);
    page.off("requestfailed", onRequestDone as any);
  }

  // 3) In-page: 2 consecutive rAFs, then a MutationObserver quiet window.
  const renderQuiet = await page.evaluate<boolean, number>(
    (quietMs: number) => {
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
            // MutationObserver quiet window after 2 rAFs.
            let settleTimer: ReturnType<typeof setTimeout> | null = null;
            const observer = new w.MutationObserver(() => {
              if (settleTimer !== null) clearTimeout(settleTimer);
              settleTimer = setTimeout(() => {
                observer.disconnect();
                resolve(true);
              }, quietMs);
            });
            observer.observe(w.document.documentElement, {
              childList: true,
              subtree: true,
              attributes: true,
            });
            // Hard fallback so the page can never wedge settle forever.
            setTimeout(() => {
              observer.disconnect();
              resolve(false);
            }, quietMs + 300);
          });
        };
        nextRAF();
      });
    },
    quietWindowMs,
  );

  const durationMs = Date.now() - start;
  return {
    settled: networkQuiet && renderQuiet,
    networkQuiet,
    renderQuiet,
    durationMs,
  };
}
