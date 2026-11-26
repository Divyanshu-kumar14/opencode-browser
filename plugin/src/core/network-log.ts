/**
 * Recent network requests and console lines per tab, for browse_network.
 *
 * Telemetry reports new errors once; this keeps a bounded history the agent
 * can query. It never stores bodies or headers (tokens live there). URLs are
 * redacted (query, fragment, user info) and console text is sanitized, because
 * all of it is page data.
 */

import type { Page } from "playwright";
import { redactUrl } from "./url-policy.ts";
import { sanitizePageText } from "../utils/formatter.ts";

export interface RequestEntry {
  readonly method: string;
  readonly url: string;
  readonly type: string;
  status: number | null;
  failure: string | null;
  pending: boolean;
  durationMs: number | null;
  readonly startedAt: number;
}

export interface ConsoleEntry {
  readonly level: string;
  readonly text: string;
  readonly at: number;
}

export interface HistoryQuery {
  /** Case-insensitive substring of the URL or the console text. */
  readonly filter?: string;
  /** Only HTTP >= 400 and failed requests; only warning and error console lines. */
  readonly onlyErrors?: boolean;
  /** Keep the newest N (default all). */
  readonly limit?: number;
}

const MAX_TEXT = 300;

interface RequestLike {
  url(): string;
  method(): string;
  resourceType(): string;
  response(): Promise<{ status(): number } | null>;
  failure(): { errorText: string } | null;
}

interface PageHistory {
  readonly requests: RequestEntry[];
  readonly console: ConsoleEntry[];
  readonly open: WeakMap<object, RequestEntry>;
}

export class NetworkLog {
  private readonly pages = new WeakMap<object, PageHistory>();

  /** `max` bounds each tab's request list and console list. */
  constructor(private readonly max = 300) {}

  attach(page: Pick<Page, "on">): void {
    if (this.pages.has(page)) return;
    const history: PageHistory = { requests: [], console: [], open: new WeakMap() };
    this.pages.set(page, history);
    const on = page.on.bind(page) as unknown as (event: string, fn: (arg: never) => void) => void;
    on("request", (req: RequestLike) => {
      const entry: RequestEntry = {
        method: req.method(),
        url: redactUrl(req.url()),
        type: req.resourceType(),
        status: null,
        failure: null,
        pending: true,
        durationMs: null,
        startedAt: Date.now(),
      };
      history.open.set(req, entry);
      push(history.requests, entry, this.max);
    });
    on("requestfinished", (req: RequestLike) => {
      const entry = history.open.get(req);
      if (!entry) return;
      entry.pending = false;
      entry.durationMs = Date.now() - entry.startedAt;
      void req
        .response()
        .then((response) => {
          entry.status = response?.status() ?? null;
        })
        .catch(() => undefined);
    });
    on("requestfailed", (req: RequestLike) => {
      const entry = history.open.get(req);
      if (!entry) return;
      entry.pending = false;
      entry.durationMs = Date.now() - entry.startedAt;
      entry.failure = sanitizePageText(req.failure()?.errorText ?? "failed").slice(0, 120);
    });
    on("console", (msg: { type(): string; text(): string }) => {
      push(history.console, { level: msg.type(), text: clip(msg.text()), at: Date.now() }, this.max);
    });
  }

  requests(page: object, query: HistoryQuery): RequestEntry[] {
    const list = this.pages.get(page)?.requests ?? [];
    const needle = query.filter?.toLowerCase();
    const kept = list.filter((e) => {
      if (query.onlyErrors && !(e.failure !== null || (e.status !== null && e.status >= 400))) return false;
      return needle === undefined || e.url.toLowerCase().includes(needle);
    });
    return newest(kept, query.limit);
  }

  console(page: object, query: HistoryQuery): ConsoleEntry[] {
    const list = this.pages.get(page)?.console ?? [];
    const needle = query.filter?.toLowerCase();
    const kept = list.filter((e) => {
      if (query.onlyErrors && e.level !== "error" && e.level !== "warning") return false;
      return needle === undefined || e.text.toLowerCase().includes(needle);
    });
    return newest(kept, query.limit);
  }
}

function push<T>(list: T[], item: T, max: number): void {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

function newest<T>(list: readonly T[], limit: number | undefined): T[] {
  return limit === undefined ? [...list] : list.slice(Math.max(0, list.length - limit));
}

function clip(text: string): string {
  const clean = sanitizePageText(text);
  return clean.length > MAX_TEXT ? clean.slice(0, MAX_TEXT - 1) + "…" : clean;
}
