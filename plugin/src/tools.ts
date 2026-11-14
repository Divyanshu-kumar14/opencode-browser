/**
 * Browser tool surface (plan §Phase 2–3): 11 executors over the daemon RPC.
 *
 * Effective names come from `options.namespace` (`browser_navigate`, … —
 * see docs/api-notes.md), declared names below are the short suffixes.
 * Every tool sets `codemode: true`. Only `browser_eval` carries
 * `options.permission: "browser_eval"` and asserts it inside the executor
 * with `resources: [url]`, mirroring the `permission_probe` pattern.
 *
 * Ownership: `ToolContext.sessionID` is forwarded as the RPC `session`, so
 * the daemon maps each OpenCode session to its own tab. When the daemon
 * socket is absent the supervisor throws `DAEMON_UNAVAILABLE` and every
 * executor surfaces it as a `Tool.Error` with a hint — never a crash.
 */

import { Error as ToolError } from "@opencode/plugin/promise/tool";
import type {
  Result as ToolResult,
  ToolContext,
  ToolEditor,
} from "@opencode/plugin/promise/tool";
import type { PermissionDomain } from "@opencode/plugin/promise/permission";
import { DaemonError } from "./errors.ts";
import type { RpcClient } from "./rpc.ts";

export const NAMESPACE = "browser";
export const EVAL_PERMISSION = "browser_eval";
/** Console/network ring-buffer bound from the plan (per tab). */
export const MAX_LOG_ENTRIES = 500;

export interface BrowserDeps {
  readonly permission: Pick<PermissionDomain, "assert">;
  readonly getClient: () => Promise<RpcClient>;
}

/** Translate any executor failure into a `Tool.Error` with code + hint. */
export function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  if (error instanceof DaemonError) {
    return new ToolError({
      message: `${error.code}: ${error.message}`,
      metadata: { code: error.code, hint: error.hint },
    });
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown error";
  return new ToolError({ message, error });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function textField(value: unknown, key: string): string | undefined {
  const field = asRecord(value)[key];
  return typeof field === "string" ? field : undefined;
}

/** `result` verbatim for `metadata`, so agents can read ids/urls programmatically. */
function rawMetadata(result: unknown): Record<string, unknown> {
  return { result: asRecord(result) };
}

async function daemonCall(
  deps: BrowserDeps,
  context: ToolContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  // Reading `signal` opts into cooperative stop (see ToolContext docs).
  const signal = context.signal;
  let client: RpcClient;
  try {
    client = await deps.getClient();
  } catch (error) {
    throw toToolError(error);
  }
  try {
    return await client.request(method, params, {
      sessionID: context.sessionID,
      signal,
    });
  } catch (error) {
    throw toToolError(error);
  }
}

/** Best-effort URL of the session's current tab, for the eval permission prompt. */
async function resolveTabUrl(
  deps: BrowserDeps,
  context: ToolContext,
  tabId: string | undefined,
): Promise<string> {
  try {
    const client = await deps.getClient();
    const tabs = asRecord(
      await client.request("list_tabs", {}, { sessionID: context.sessionID }),
    )["tabs"];
    if (!Array.isArray(tabs) || tabs.length === 0) return "unknown";
    if (tabId !== undefined) {
      const match = tabs.find(
        (tab) => asRecord(tab)["tab_id"] === tabId,
      );
      const url = match !== undefined ? textField(match, "url") : undefined;
      return url ?? "unknown";
    }
    const owned = tabs.find(
      (tab) => asRecord(tab)["owner"] === context.sessionID,
    );
    return textField(owned ?? tabs[0], "url") ?? "unknown";
  } catch {
    return "unknown";
  }
}

function clampLogLimit(limit: unknown): number {
  const fallback = 100;
  if (typeof limit !== "number" || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LOG_ENTRIES);
}

// ---------------------------------------------------------------------------
// Result formatters (pure; unit-tested). All tolerate missing/empty results —
// the daemon may stub console/network with empty arrays.
// ---------------------------------------------------------------------------

export function formatNavigate(result: unknown): string {
  const url = textField(result, "url") ?? "(unknown url)";
  const title = textField(result, "title");
  const status = asRecord(result)["status"];
  const statusText =
    typeof status === "number" ? ` [http ${status}]` : "";
  return `navigated to ${url}${title ? ` — ${title}` : ""}${statusText}`;
}

export function formatSnapshot(result: unknown): {
  content: string;
  metadata: Record<string, unknown>;
} {
  const text = textField(result, "text") ?? "(empty page)";
  const tabId = textField(result, "tab_id");
  const url = textField(result, "url");
  const truncated = asRecord(result)["truncated"] === true;
  return {
    content: truncated ? `${text}\n…(truncated)` : text,
    metadata: { tab_id: tabId, url, truncated },
  };
}

export function formatConsole(result: unknown): string {
  const messages = asRecord(result)["messages"];
  if (!Array.isArray(messages) || messages.length === 0) {
    return "(no console messages)";
  }
  return messages
    .map((entry) => {
      const record = asRecord(entry);
      const level =
        typeof record["level"] === "string" ? record["level"] : "log";
      const text =
        typeof record["text"] === "string"
          ? record["text"]
          : JSON.stringify(entry);
      return `[${level}] ${text}`;
    })
    .join("\n");
}

export function formatNetwork(result: unknown): string {
  const requests = asRecord(result)["requests"];
  if (!Array.isArray(requests) || requests.length === 0) {
    return "(no network requests)";
  }
  return requests
    .map((entry) => {
      const record = asRecord(entry);
      const method =
        typeof record["method"] === "string" ? record["method"] : "GET";
      const url =
        typeof record["url"] === "string" ? record["url"] : "(unknown url)";
      const status =
        typeof record["status"] === "number" ? ` ${record["status"]}` : "";
      return `${method} ${url}${status}`;
    })
    .join("\n");
}

export function formatTabsList(result: unknown): string {
  const tabs = asRecord(result)["tabs"];
  if (!Array.isArray(tabs) || tabs.length === 0) {
    return "(no tabs — navigate to open one)";
  }
  return tabs
    .map((tab) => {
      const record = asRecord(tab);
      const tabId =
        typeof record["tab_id"] === "string" ? record["tab_id"] : "?";
      const url =
        typeof record["url"] === "string" ? record["url"] : "(unknown url)";
      const title =
        typeof record["title"] === "string" ? ` — ${record["title"]}` : "";
      return `${tabId}: ${url}${title}`;
    })
    .join("\n");
}

export function formatEvalValue(result: unknown): string {
  const record = asRecord(result);
  let rendered: string;
  try {
    rendered =
      record["value"] === undefined
        ? "undefined"
        : JSON.stringify(record["value"]) ?? String(record["value"]);
  } catch {
    rendered = String(record["value"]);
  }
  return record["truncated"] === true ? `${rendered}\n…(truncated)` : rendered;
}

type Executor = (
  input: unknown,
  context: ToolContext,
) => Promise<ToolResult>;

function stringParam(
  input: unknown,
  key: string,
  opts: { required?: boolean } = {},
): string | undefined {
  const value = asRecord(input)[key];
  if (value === undefined) {
    if (opts.required === true) {
      throw new ToolError({
        message: `missing required parameter: ${key}`,
        metadata: { code: "INTERNAL", hint: `pass "${key}" and retry` },
      });
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ToolError({
      message: `parameter "${key}" must be a string`,
      metadata: { code: "INTERNAL", hint: `pass "${key}" as a string and retry` },
    });
  }
  return value;
}

function optionalTabId(input: unknown): Record<string, unknown> {
  const tabId = stringParam(input, "tab_id");
  return tabId === undefined ? {} : { tab_id: tabId };
}

/** The 11 browser executors, keyed by RPC method. Tested directly. */
export function createExecutors(deps: BrowserDeps): Record<string, Executor> {
  const navigate: Executor = async (input, context) => {
    const url = stringParam(input, "url", { required: true });
    const record = asRecord(input);
    const result = await daemonCall(deps, context, "navigate", {
      url,
      ...optionalTabId(input),
      ...(typeof record["wait_until"] === "string"
        ? { wait_until: record["wait_until"] }
        : {}),
      ...(typeof record["timeout_ms"] === "number"
        ? { timeout_ms: record["timeout_ms"] }
        : {}),
    });
    return { content: formatNavigate(result), metadata: rawMetadata(result) };
  };

  const snapshot: Executor = async (input, context) => {
    const record = asRecord(input);
    const result = await daemonCall(deps, context, "snapshot", {
      ...optionalTabId(input),
      ...(typeof record["max_nodes"] === "number"
        ? { max_nodes: record["max_nodes"] }
        : {}),
      ...(typeof record["include_ax"] === "boolean"
        ? { include_ax: record["include_ax"] }
        : {}),
    });
    const formatted = formatSnapshot(result);
    return { content: formatted.content, metadata: formatted.metadata };
  };

  const screenshot: Executor = async (input, context) => {
    const record = asRecord(input);
    const result = await daemonCall(deps, context, "screenshot", {
      ...optionalTabId(input),
      ...(typeof record["full_page"] === "boolean"
        ? { full_page: record["full_page"] }
        : {}),
    });
    const path = textField(result, "path");
    if (path === undefined) {
      throw new ToolError({
        message: "INTERNAL: daemon screenshot returned no path",
        metadata: {
          code: "INTERNAL",
          hint: "retry the screenshot; report a daemon bug if it persists",
        },
      });
    }
    const width = asRecord(result)["width"];
    const height = asRecord(result)["height"];
    return {
      content: [{ type: "file", uri: path, mime: "image/png" }],
      metadata: {
        path,
        ...(typeof width === "number" ? { width } : {}),
        ...(typeof height === "number" ? { height } : {}),
      },
    };
  };

  const click: Executor = async (input, context) => {
    const uid = stringParam(input, "uid", { required: true });
    const record = asRecord(input);
    const result = await daemonCall(deps, context, "click", {
      uid,
      ...optionalTabId(input),
      ...(typeof record["button"] === "string"
        ? { button: record["button"] }
        : {}),
      ...(typeof record["click_count"] === "number"
        ? { click_count: record["click_count"] }
        : {}),
    });
    return {
      content: `clicked ${uid}`,
      metadata: rawMetadata(result),
    };
  };

  const fill: Executor = async (input, context) => {
    const uid = stringParam(input, "uid", { required: true });
    const value = stringParam(input, "value", { required: true });
    const record = asRecord(input);
    const result = await daemonCall(deps, context, "fill", {
      uid,
      value,
      ...optionalTabId(input),
      ...(typeof record["submit"] === "boolean"
        ? { submit: record["submit"] }
        : {}),
    });
    return { content: `filled ${uid}`, metadata: rawMetadata(result) };
  };

  const pressKey: Executor = async (input, context) => {
    const key = stringParam(input, "key", { required: true });
    const uid = stringParam(input, "uid");
    const result = await daemonCall(deps, context, "press_key", {
      key,
      ...optionalTabId(input),
      ...(uid === undefined ? {} : { uid }),
    });
    return { content: `pressed ${key}`, metadata: rawMetadata(result) };
  };

  const evaluate: Executor = async (input, context) => {
    const js = stringParam(input, "js", { required: true });
    const record = asRecord(input);
    const tabId = stringParam(input, "tab_id");
    // Resolve the URL first so the permission prompt names the page being
    // evaluated; a denial below rejects and must be rethrown, never swallowed.
    const url = await resolveTabUrl(deps, context, tabId);
    await deps.permission.assert({
      sessionID: context.sessionID,
      action: EVAL_PERMISSION,
      resources: [url],
    });
    const result = await daemonCall(deps, context, "eval", {
      js,
      ...(tabId === undefined ? {} : { tab_id: tabId }),
      ...(typeof record["await_promise"] === "boolean"
        ? { await_promise: record["await_promise"] }
        : {}),
    });
    return { content: formatEvalValue(result), metadata: rawMetadata(result) };
  };

  const consoleLog: Executor = async (input, context) => {
    const record = asRecord(input);
    const result = await daemonCall(deps, context, "console", {
      ...optionalTabId(input),
      limit: clampLogLimit(record["limit"]),
      ...(typeof record["level"] === "string"
        ? { level: record["level"] }
        : {}),
      ...(typeof record["since"] === "number" ? { since: record["since"] } : {}),
    });
    return { content: formatConsole(result), metadata: rawMetadata(result) };
  };

  const network: Executor = async (input, context) => {
    const record = asRecord(input);
    const result = await daemonCall(deps, context, "network", {
      ...optionalTabId(input),
      limit: clampLogLimit(record["limit"]),
      ...(typeof record["filter"] === "string"
        ? { filter: record["filter"] }
        : {}),
      ...(typeof record["since"] === "number" ? { since: record["since"] } : {}),
    });
    return { content: formatNetwork(result), metadata: rawMetadata(result) };
  };

  const listTabs: Executor = async (_input, context) => {
    const result = await daemonCall(deps, context, "list_tabs", {});
    return { content: formatTabsList(result), metadata: rawMetadata(result) };
  };

  const closeTab: Executor = async (input, context) => {
    const tabId = stringParam(input, "tab_id", { required: true });
    const result = await daemonCall(deps, context, "close_tab", {
      tab_id: tabId,
    });
    return { content: `closed ${tabId}`, metadata: rawMetadata(result) };
  };

  return {
    navigate,
    snapshot,
    screenshot,
    click,
    fill,
    press_key: pressKey,
    eval: evaluate,
    console: consoleLog,
    network,
    list_tabs: listTabs,
    close_tab: closeTab,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const SCHEMA_TAB_ID = {
  type: "string",
  description: "Tab id from browser_list_tabs. Defaults to your session tab.",
} as const;

/** Register all browser tools on the editor. Called from `index.ts` setup. */
export function registerBrowserTools(
  editor: ToolEditor,
  deps: BrowserDeps,
): void {
  const executors = createExecutors(deps);
  const baseOptions = { namespace: NAMESPACE, codemode: true } as const;

  const schema = (
    properties: Record<string, unknown>,
    required: string[] = [],
  ): Record<string, unknown> => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });

  const specs: {
    name: string;
    description: string;
    input: Record<string, unknown>;
    options: { namespace: string; codemode: true; permission?: string };
  }[] = [
    {
      name: "navigate",
      description:
        "Navigate your session tab to a URL (http/https). Creates the tab on first use.",
      input: schema(
        {
          url: { type: "string", description: "URL to load." },
          tab_id: SCHEMA_TAB_ID,
          wait_until: {
            type: "string",
            description: "Readiness to wait for (e.g. load, idle).",
          },
          timeout_ms: { type: "number", description: "Navigation timeout." },
        },
        ["url"],
      ),
      options: { ...baseOptions },
    },
    {
      name: "snapshot",
      description:
        "Read the current page as compact text with stable [uid] references for click/fill. Re-run after navigation.",
      input: schema({
        tab_id: SCHEMA_TAB_ID,
        max_nodes: {
          type: "number",
          description: "Max nodes in the tree (default 300).",
        },
        include_ax: {
          type: "boolean",
          description: "Include the accessibility join.",
        },
      }),
      options: { ...baseOptions },
    },
    {
      name: "screenshot",
      description: "Capture the current page as a PNG image.",
      input: schema({
        tab_id: SCHEMA_TAB_ID,
        full_page: {
          type: "boolean",
          description: "Capture the full scrollable page.",
        },
      }),
      options: { ...baseOptions },
    },
    {
      name: "click",
      description: "Click the element with the given [uid] from browser_snapshot.",
      input: schema(
        {
          uid: { type: "string", description: "Element uid, e.g. g7-3." },
          tab_id: SCHEMA_TAB_ID,
          button: { type: "string", description: "Mouse button." },
          click_count: { type: "number", description: "1, 2 for double-click." },
        },
        ["uid"],
      ),
      options: { ...baseOptions },
    },
    {
      name: "fill",
      description: "Type text into the element with the given [uid].",
      input: schema(
        {
          uid: { type: "string", description: "Element uid, e.g. g7-1." },
          value: { type: "string", description: "Text to type." },
          tab_id: SCHEMA_TAB_ID,
          submit: { type: "boolean", description: "Press Enter afterwards." },
        },
        ["uid", "value"],
      ),
      options: { ...baseOptions },
    },
    {
      name: "press_key",
      description: "Press a key (Enter, Escape, Tab, arrows, …), optionally focused on a [uid].",
      input: schema(
        {
          key: { type: "string", description: "Key name, e.g. Enter." },
          uid: { type: "string", description: "Element uid to target." },
          tab_id: SCHEMA_TAB_ID,
        },
        ["key"],
      ),
      options: { ...baseOptions },
    },
    {
      name: "eval",
      description:
        "Run JavaScript in the page. Requires approval (browser_eval); the prompt names the page URL.",
      input: schema(
        {
          js: { type: "string", description: "Expression to evaluate." },
          tab_id: SCHEMA_TAB_ID,
          await_promise: {
            type: "boolean",
            description: "Await a returned promise.",
          },
        },
        ["js"],
      ),
      options: { ...baseOptions, permission: EVAL_PERMISSION },
    },
    {
      name: "console",
      description: "Read recent console messages for the tab (bounded ring buffer).",
      input: schema({
        tab_id: SCHEMA_TAB_ID,
        limit: { type: "number", description: "Max entries (default 100, cap 500)." },
        level: { type: "string", description: "Filter by level." },
        since: { type: "number", description: "Cursor for incremental reads." },
      }),
      options: { ...baseOptions },
    },
    {
      name: "network",
      description: "Read recent network requests for the tab (bounded ring buffer).",
      input: schema({
        tab_id: SCHEMA_TAB_ID,
        limit: { type: "number", description: "Max entries (default 100, cap 500)." },
        filter: { type: "string", description: "Substring filter on URL." },
        since: { type: "number", description: "Cursor for incremental reads." },
      }),
      options: { ...baseOptions },
    },
    {
      name: "list_tabs",
      description: "List tabs (tab_id, url, title, owner). Your session drives its own tab.",
      input: schema({}),
      options: { ...baseOptions },
    },
    {
      name: "close_tab",
      description: "Close a tab you own. Closing another session's tab is rejected (TAB_FORBIDDEN).",
      input: schema(
        {
          tab_id: { type: "string", description: "Tab id to close." },
        },
        ["tab_id"],
      ),
      options: { ...baseOptions },
    },
  ];

  for (const spec of specs) {
    const execute = executors[spec.name];
    if (execute === undefined) continue; // unreachable; keeps ids in sync
    editor.add({
      name: spec.name,
      description: spec.description,
      input: spec.input,
      options: spec.options,
      execute,
    });
  }
}
