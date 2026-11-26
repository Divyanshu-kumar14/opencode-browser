/**
 * Dialogs: alert, confirm, prompt and beforeunload.
 *
 * A dialog freezes the page's JavaScript until someone answers it, and
 * Playwright answers by dismissing when nobody listens, without telling the
 * agent. Here every dialog is answered at once, so the page never blocks, and
 * every answer is reported in the turn that caused it.
 *
 * Defaults:
 *   - alert, beforeunload: accepted (nothing to decide; beforeunload only
 *     appears when the agent itself navigates away)
 *   - confirm, prompt: dismissed, the safe answer to "delete this?"
 *
 * Only the agent's own tabs are answered. A dialog on a tab no session owns
 * (the user's, in an attached browser) is left open for the user: the listener
 * itself keeps Playwright from dismissing it. With nobody watching (headless)
 * such a dialog is dismissed, so the page cannot freeze.
 *
 * The agent overrides the next dialog on a tab with `plan` (browse_dialog).
 * The message is page text, so it is sanitized and capped before it reaches the
 * agent.
 */

import type { Page } from "playwright";
import { sanitizePageText } from "../utils/formatter.ts";

export interface DialogPlan {
  readonly accept: boolean;
  /** Text typed into a prompt when accepting. */
  readonly promptText?: string;
}

/** The dialog surface used here; Playwright's Dialog satisfies it. */
interface DialogLike {
  type(): string;
  message(): string;
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}

const MAX_MESSAGE = 200;

export interface DialogsOptions {
  /** Whether a session owns the tab (default: every tab). */
  readonly isOwned?: (page: object) => boolean;
  /** Whether a person can answer dialogs in the browser window (default false). */
  readonly userPresent?: () => boolean;
}

export class Dialogs {
  private readonly plans = new WeakMap<object, DialogPlan>();
  private readonly notices = new WeakMap<object, string[]>();
  private readonly isOwned: (page: object) => boolean;
  private readonly userPresent: () => boolean;

  constructor(options: DialogsOptions = {}) {
    this.isOwned = options.isOwned ?? (() => true);
    this.userPresent = options.userPresent ?? (() => false);
  }

  /** Start answering this page's dialogs. */
  attach(page: Pick<Page, "on">): void {
    page.on("dialog", (dialog) => void this.answer(page, dialog));
  }

  /** Answer the next dialog on `page` this way (one-shot). */
  plan(page: object, plan: DialogPlan): void {
    this.plans.set(page, plan);
  }

  /** The planned answer that has not been used yet. */
  pending(page: object): DialogPlan | null {
    return this.plans.get(page) ?? null;
  }

  /** Reports for the dialogs answered since the last call. */
  take(page: object): string[] {
    const out = this.notices.get(page) ?? [];
    this.notices.delete(page);
    return out;
  }

  private async answer(page: object, dialog: DialogLike): Promise<void> {
    if (!this.isOwned(page)) {
      // The user's tab: leave the dialog for them when they can see it.
      if (this.userPresent()) return;
      await dialog.dismiss().catch(() => undefined);
      return;
    }
    const type = dialog.type();
    const planned = this.plans.get(page);
    this.plans.delete(page);
    const accept = planned?.accept ?? (type === "alert" || type === "beforeunload");
    const label = `${type} "${clip(dialog.message())}"`;
    let report: string;
    try {
      if (accept) {
        const text = type === "prompt" ? planned?.promptText : undefined;
        await dialog.accept(text);
        report = `${label} was accepted${text !== undefined ? ` and answered "${clip(text)}"` : ""}`;
      } else {
        await dialog.dismiss();
        report =
          `${label} was dismissed` +
          (planned === undefined && (type === "confirm" || type === "prompt")
            ? "; to accept the next one, call browse_dialog before the action that opens it"
            : "");
      }
    } catch {
      report = `${label} could not be answered (the page closed or navigated)`;
    }
    const list = this.notices.get(page) ?? [];
    list.push(report);
    this.notices.set(page, list);
  }
}

function clip(text: string): string {
  const clean = sanitizePageText(text);
  return clean.length > MAX_MESSAGE ? clean.slice(0, MAX_MESSAGE - 1) + "…" : clean;
}
