/**
 * Wait for page conditions: text, a selector, the URL, network idle, or a
 * plain delay. Every condition given must hold. They share one timeout, so
 * three conditions never wait three times as long.
 *
 * A timeout is a result, not an error: the agent still gets the page state and
 * a summary naming the condition that did not hold.
 */

import type { Page } from "playwright";
import { InvalidInputError } from "./errors.ts";

export interface WaitConditions {
  /** Visible page text contains this. */
  readonly text?: string;
  /** Visible page text no longer contains this. */
  readonly textGone?: string;
  /** This CSS selector matches a visible element. */
  readonly selector?: string;
  /** The page URL contains this. */
  readonly urlContains?: string;
  /** The network is idle (no connections for 500 ms). */
  readonly networkIdle?: boolean;
  /** Plain delay, in milliseconds. */
  readonly ms?: number;
}

export interface WaitResult {
  readonly ok: boolean;
  readonly waitedMs: number;
  /** One line for the agent: what held, or what timed out. */
  readonly summary: string;
}

type Step = { readonly label: string; readonly run: (remainingMs: number) => Promise<void> };

export async function waitFor(page: Page, conditions: WaitConditions, timeoutMs: number): Promise<WaitResult> {
  const steps = await plan(page, conditions);
  const started = Date.now();
  // An explicit delay is always waited in full, even past the timeout.
  const deadline = started + Math.max(timeoutMs, conditions.ms ?? 0);
  const held: string[] = [];
  for (const step of steps) {
    const remaining = deadline - Date.now();
    try {
      if (remaining <= 0) throw new Error("out of time");
      await step.run(remaining);
      held.push(step.label);
    } catch (error) {
      if (isInvalidSelector(error)) throw error;
      return {
        ok: false,
        waitedMs: Date.now() - started,
        summary: `Timed out after ${timeoutMs}ms waiting for ${step.label}.`,
      };
    }
  }
  return { ok: true, waitedMs: Date.now() - started, summary: `Waited for ${held.join(" and ")}.` };
}

class InvalidSelectorError extends InvalidInputError {}
const isInvalidSelector = (error: unknown): boolean => error instanceof InvalidSelectorError;

/** Turn the conditions into ordered steps, validating the selector first. */
async function plan(page: Page, c: WaitConditions): Promise<Step[]> {
  const steps: Step[] = [];
  if (c.ms !== undefined) {
    steps.push({ label: `${c.ms}ms`, run: () => sleep(c.ms!) });
  }
  if (c.selector !== undefined) {
    const selector = c.selector;
    try {
      await page.locator(selector).count();
    } catch (error) {
      const message = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
      throw new InvalidSelectorError(`invalid selector "${selector}": ${message}`, "fix the CSS selector");
    }
    steps.push({
      label: `${JSON.stringify(selector)} to be visible`,
      run: (left) => page.locator(selector).first().waitFor({ state: "visible", timeout: left }),
    });
  }
  if (c.text !== undefined) {
    const text = c.text;
    steps.push({
      label: `text ${JSON.stringify(text)} to appear`,
      run: (left) => page.waitForFunction(pageHasText, text, { timeout: left, polling: 100 }).then(() => undefined),
    });
  }
  if (c.textGone !== undefined) {
    const text = c.textGone;
    steps.push({
      label: `text ${JSON.stringify(text)} to disappear`,
      run: (left) => page.waitForFunction(pageLacksText, text, { timeout: left, polling: 100 }).then(() => undefined),
    });
  }
  if (c.urlContains !== undefined) {
    const part = c.urlContains;
    steps.push({
      label: `the URL to contain ${JSON.stringify(part)}`,
      run: (left) => page.waitForURL((url) => url.href.includes(part), { timeout: left, waitUntil: "commit" }),
    });
  }
  if (c.networkIdle === true) {
    steps.push({ label: "the network to be idle", run: (left) => page.waitForLoadState("networkidle", { timeout: left }) });
  }
  return steps;
}

/**
 * Page-side predicates. Playwright serializes them, so each must be
 * self-contained. The visible text of the document does not include shadow
 * trees such as the HUD.
 */
function pageHasText(text: string): boolean {
  const body = (globalThis as unknown as { document: { body: { innerText: string } | null } }).document.body;
  return !!body && body.innerText.includes(text);
}
function pageLacksText(text: string): boolean {
  const body = (globalThis as unknown as { document: { body: { innerText: string } | null } }).document.body;
  return !body || !body.innerText.includes(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
