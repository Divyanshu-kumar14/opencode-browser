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

export class Dialogs {
  private readonly plans = new WeakMap<object, DialogPlan>();
  private readonly notices = new WeakMap<object, string[]>();

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
