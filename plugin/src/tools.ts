/**
 * Browser tool surface (plan §Phase 2–3): 16 executors over the daemon RPC.
 *
 * Effective names come from `options.namespace` (`browse_navigate`, … —
 * see docs/api-notes.md), declared names below are the short suffixes.
 * Every tool sets `codemode: true`. Only `browse_eval` carries
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
import { DaemonError, isUidStaleError } from "./errors.ts";
import type { RpcClient } from "./rpc.ts";

/**
 * NOT "browser": the host ships a built-in `browser` namespace (tabs.*, snapshot,
 * click, fill, dialog, …). Tool ids are `${namespace}_${name}`, so any plugin tool
 * whose id matched a built-in one was shadowed — 10 of 16 never reached the Code
 * Mode catalog. `browse` is unused by the host, so every id survives.
 */
export const NAMESPACE = "browse";
export const EVAL_PERMISSION = "browser_eval";
/** Upload can read local files, so it is gated like eval. */
export const UPLOAD_PERMISSION = "browser_upload";
/** Console/network ring-buffer bound from the plan (per tab). */
export const MAX_LOG_ENTRIES = 500;
/** Mirrors `daemon/src/policy.rs`; the daemon is the real boundary. */
export const MAX_UPLOAD_FILES = 8;

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
// Stale-uid recovery (shim-only, exactly-once).
//
// A uid encodes its navigation generation (`g{gen}-{n}`), so acting on an
// element from a previous page fails with `UID_STALE`. The recovery is a
// fixed 4-step sequence with no loop: re-snapshot once, re-resolve the stale
// uid to a fresh one by matching its cached role+name, retry the action
// exactly once. Any miss surfaces the ORIGINAL error so the agent — not this
// wrapper — decides the next move.
// ---------------------------------------------------------------------------

/** Minimal identity of a snapshot node, enough to re-resolve it later. */
export interface SnapshotRefNode {
  readonly uid: string;
  readonly role: string;
  readonly name: string;
}

const SNAPSHOT_LINE_PATTERN = /^\[([^\]]+)\]\s+(\S+)(?:\s+"([^"]*)")?/;

/**
 * Pull re-resolvable nodes out of a snapshot result. Prefers the structured
 * `nodes` array; falls back to parsing the rendered `[uid] role "name"`
 * text lines so an older daemon shape still recovers.
 */
export function extractSnapshotNodes(result: unknown): SnapshotRefNode[] {
  const record = asRecord(result);
  const nodes = record["nodes"];
  if (Array.isArray(nodes)) {
    const structured: SnapshotRefNode[] = [];
    for (const entry of nodes) {
      const node = asRecord(entry);
      const uid = node["uid"];
      const role = node["role"];
      const name = node["name"];
      if (
        typeof uid === "string" &&
        typeof role === "string" &&
        typeof name === "string"
      ) {
        structured.push({ uid, role, name });
      }
    }
    if (structured.length > 0) return structured;
    // Empty/foreign `nodes` shape: try the text rendering below.
  }
  const text = textField(result, "text");
  if (text === undefined) return [];
  const parsed: SnapshotRefNode[] = [];
  for (const line of text.split("\n")) {
    const match = SNAPSHOT_LINE_PATTERN.exec(line.trim());
    const uid = match?.[1];
    const role = match?.[2];
    if (uid !== undefined && role !== undefined) {
      parsed.push({ uid, role, name: match?.[3] ?? "" });
    }
  }
  return parsed;
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
      const kind = typeof record["kind"] === "string" ? ` ${record["kind"]}` : "";
      const ms =
        typeof record["ms"] === "number" ? ` ${Math.round(record["ms"])}ms` : "";
      const cache = record["from_cache"] === true ? " (cache)" : "";
      return [
        `${method} ${url}${status}${kind}${ms}${cache}`,
        ...headerLines(record["request_headers"], ">"),
        ...headerLines(record["response_headers"], "<"),
      ].join("\n");
    })
    .join("\n");
}

/** `> name: value` / `< name: value` lines; values are already redacted. */
function headerLines(value: unknown, marker: ">" | "<"): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((header) => {
    const record = asRecord(header);
    const name = textField(record, "name");
    if (name === undefined) return [];
    return [`  ${marker} ${name}: ${textField(record, "value") ?? ""}`];
  });
}

export function formatNetworkBody(result: unknown): string {
  const record = asRecord(result);
  const body = typeof record["body"] === "string" ? record["body"] : "";
  const total =
    typeof record["bytes"] === "number" ? record["bytes"] : body.length;
  const truncated = record["truncated"] === true;
  const summary = `${body.length}/${total} bytes${truncated ? ", truncated" : ""}`;
  return body.length === 0 ? `(empty body; ${summary})` : `${summary}\n${body}`;
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

export function formatSelect(result: unknown): string {
  const record = asRecord(result);
  const value = textField(result, "value") ?? "(unknown value)";
  const label = textField(result, "label");
  const index = record["index"];
  const at = typeof index === "number" ? ` (index ${index})` : "";
  const text = label !== undefined && label !== value ? ` — ${label}` : "";
  return `selected ${JSON.stringify(value)}${text}${at}`;
}

export function formatUpload(result: unknown): string {
  const files = asRecord(result)["files"];
  if (!Array.isArray(files) || files.length === 0) return "attached files";
  return `attached ${files.length} file(s): ${files.map(String).join(", ")}`;
}

export function formatDialog(result: unknown): string {
  const dialog = asRecord(asRecord(result)["dialog"]);
  const kind = textField(dialog, "kind") ?? "dialog";
  const message = textField(dialog, "message") ?? "";
  const action = textField(result, "action") ?? "handled";
  return `${action} ${kind}${message ? `: ${message}` : ""}`;
}

export function formatScroll(result: unknown): string {
  const record = asRecord(result);
  const x = typeof record["scrollX"] === "number" ? record["scrollX"] : 0;
  const y = typeof record["scrollY"] === "number" ? record["scrollY"] : 0;
  const bottom = record["at_bottom"] === true ? " (at bottom)" : "";
  return `scrolled to ${x},${y}${bottom}`;
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

/** Upload paths: non-empty absolute strings, capped at the daemon's limit. */
function pathsParam(input: unknown, key: string): string[] {
  const value = asRecord(input)[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolError({
      message: `parameter "${key}" must be a non-empty array of file paths`,
      metadata: {
        code: "UPLOAD_DENIED",
        hint: "pass absolute paths to regular files, e.g. [\"/tmp/receipt.pdf\"]",
      },
    });
  }
  if (value.length > MAX_UPLOAD_FILES) {
    throw new ToolError({
      message: `at most ${MAX_UPLOAD_FILES} files per upload (got ${value.length})`,
      metadata: {
        code: "UPLOAD_DENIED",
        hint: `split the upload into batches of ${MAX_UPLOAD_FILES}`,
      },
    });
  }
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new ToolError({
        message: `every entry in "${key}" must be a non-empty string`,
        metadata: {
          code: "UPLOAD_DENIED",
          hint: "pass absolute file paths, not objects or empty strings",
        },
      });
    }
    if (!entry.startsWith("/")) {
      throw new ToolError({
        message: `upload path is not absolute: ${entry}`,
        metadata: {
          code: "UPLOAD_DENIED",
          hint: "the daemon resolves paths itself; pass an absolute path like /tmp/file.pdf",
        },
      });
    }
    paths.push(entry);
  }
  return paths;
}

/** The 16 browser executors, keyed by RPC method. Tested directly. */
export function createExecutors(deps: BrowserDeps): Record<string, Executor> {
  // Last good snapshot nodes per session+tab, so a UID_STALE failure can be
  // re-resolved by role+name. Populated by the snapshot executor and by every
  // recovery re-snapshot below.
  const snapshotCache = new Map<string, SnapshotRefNode[]>();
  const cacheKey = (sessionID: string, tabId: string | undefined): string =>
    `${sessionID} ${tabId ?? ""}`;

  const rememberSnapshot = (
    context: ToolContext,
    tabId: string | undefined,
    result: unknown,
  ): void => {
    snapshotCache.set(
      cacheKey(context.sessionID, tabId),
      extractSnapshotNodes(result),
    );
  };

  /**
   * Run `attempt` with `uid`; on `UID_STALE` only, re-snapshot once and retry
   * exactly once with the fresh uid whose role+name matches the stale one.
   * No loop: every miss (unknown uid, failed re-snapshot, no match) rethrows
   * the ORIGINAL error. A failure of the retry itself surfaces as-is — it is
   * the freshest signal (e.g. the new node is occluded).
   */
  async function callWithStaleUidRetry(
    context: ToolContext,
    uid: string | undefined,
    tabId: string | undefined,
    attempt: (uid: string | undefined) => Promise<ToolResult>,
  ): Promise<ToolResult> {
    let original: unknown;
    try {
      return await attempt(uid);
    } catch (error) {
      original = error;
    }
    // Only a generation mismatch can heal via a fresh snapshot. Anything
    // else (UID_NOT_FOUND, occlusion, permission) retries nothing.
    if (!isUidStaleError(original)) throw original;
    const wanted = snapshotCache
      .get(cacheKey(context.sessionID, tabId))
      ?.find((node) => node.uid === uid);
    if (wanted === undefined) throw original;
    let fresh: unknown;
    try {
      fresh = await daemonCall(
        deps,
        context,
        "snapshot",
        tabId === undefined ? {} : { tab_id: tabId },
      );
    } catch {
      throw original;
    }
    const freshNodes = extractSnapshotNodes(fresh);
    snapshotCache.set(cacheKey(context.sessionID, tabId), freshNodes);
    const match = freshNodes.find(
      (node) => node.role === wanted.role && node.name === wanted.name,
    );
    if (match === undefined) throw original;
    const retried = await attempt(match.uid);
    return {
      content: retried.content,
      metadata: {
        ...asRecord(retried.metadata),
        recovered_from: uid,
        recovered_uid: match.uid,
      },
    };
  }

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
      ...(typeof record["dialog_policy"] === "string"
        ? { dialog_policy: record["dialog_policy"] }
        : {}),
    });
    return { content: formatNavigate(result), metadata: rawMetadata(result) };
  };

  const snapshot: Executor = async (input, context) => {
    const record = asRecord(input);
    const tabId = stringParam(input, "tab_id");
    const result = await daemonCall(deps, context, "snapshot", {
      ...(tabId === undefined ? {} : { tab_id: tabId }),
      ...(typeof record["max_nodes"] === "number"
        ? { max_nodes: record["max_nodes"] }
        : {}),
      ...(typeof record["include_ax"] === "boolean"
        ? { include_ax: record["include_ax"] }
        : {}),
    });
    rememberSnapshot(context, tabId, result);
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
    const tabId = stringParam(input, "tab_id");
    const extras = {
      ...(typeof record["button"] === "string"
        ? { button: record["button"] }
        : {}),
      ...(typeof record["click_count"] === "number"
        ? { click_count: record["click_count"] }
        : {}),
    };
    return callWithStaleUidRetry(context, uid, tabId, (nextUid) =>
      daemonCall(deps, context, "click", {
        uid: nextUid,
        ...(tabId === undefined ? {} : { tab_id: tabId }),
        ...extras,
      }).then((result) => ({
        content: `clicked ${nextUid}`,
        metadata: rawMetadata(result),
      })),
    );
  };

  const fill: Executor = async (input, context) => {
    const uid = stringParam(input, "uid", { required: true });
    const value = stringParam(input, "value", { required: true });
    const record = asRecord(input);
    const tabId = stringParam(input, "tab_id");
    const extras = {
      ...(typeof record["submit"] === "boolean"
        ? { submit: record["submit"] }
        : {}),
    };
    return callWithStaleUidRetry(context, uid, tabId, (nextUid) =>
      daemonCall(deps, context, "fill", {
        uid: nextUid,
        value,
        ...(tabId === undefined ? {} : { tab_id: tabId }),
        ...extras,
      }).then((result) => ({
        content: `filled ${nextUid}`,
        metadata: rawMetadata(result),
      })),
    );
  };

  const hover: Executor = async (input, context) => {
    const uid = stringParam(input, "uid", { required: true });
    const tabId = stringParam(input, "tab_id");
    return callWithStaleUidRetry(context, uid, tabId, (nextUid) =>
      daemonCall(deps, context, "hover", {
        uid: nextUid,
        ...(tabId === undefined ? {} : { tab_id: tabId }),
      }).then((result) => ({
        content: `hovered ${nextUid}`,
        metadata: rawMetadata(result),
      })),
    );
  };

  const select: Executor = async (input, context) => {
    const uid = stringParam(input, "uid", { required: true });
    const record = asRecord(input);
    const tabId = stringParam(input, "tab_id");
    const extras = {
      ...(typeof record["value"] === "string" ? { value: record["value"] } : {}),
      ...(typeof record["label"] === "string" ? { label: record["label"] } : {}),
      ...(typeof record["index"] === "number" ? { index: record["index"] } : {}),
    };
    return callWithStaleUidRetry(context, uid, tabId, (nextUid) =>
      daemonCall(deps, context, "select", {
        uid: nextUid,
        ...(tabId === undefined ? {} : { tab_id: tabId }),
        ...extras,
      }).then((result) => ({
        content: formatSelect(result),
        metadata: rawMetadata(result),
      })),
    );
  };

  const upload: Executor = async (input, context) => {
    const uid = stringParam(input, "uid", { required: true });
    const paths = pathsParam(input, "paths");
    const tabId = stringParam(input, "tab_id");
    // The prompt names the files: reading them is the risky half, not the page.
    // Asserted once up front — the retry reuses the same paths, so it must
    // not prompt twice for one user action.
    await deps.permission.assert({
      sessionID: context.sessionID,
      action: UPLOAD_PERMISSION,
      resources: paths,
    });
    return callWithStaleUidRetry(context, uid, tabId, (nextUid) =>
      daemonCall(deps, context, "upload", {
        uid: nextUid,
        paths,
        ...(tabId === undefined ? {} : { tab_id: tabId }),
      }).then((result) => ({
        content: formatUpload(result),
        metadata: rawMetadata(result),
      })),
    );
  };

  const dialog: Executor = async (input, context) => {
    const action = stringParam(input, "action", { required: true });
    const record = asRecord(input);
    const result = await daemonCall(deps, context, "dialog", {
      action,
      ...optionalTabId(input),
      ...(typeof record["prompt_text"] === "string"
        ? { prompt_text: record["prompt_text"] }
        : {}),
    });
    return { content: formatDialog(result), metadata: rawMetadata(result) };
  };

  const scroll: Executor = async (input, context) => {
    const direction = stringParam(input, "direction", { required: true });
    const record = asRecord(input);
    const result = await daemonCall(deps, context, "scroll", {
      direction,
      ...optionalTabId(input),
      ...(typeof record["amount"] === "number" ? { amount: record["amount"] } : {}),
    });
    return { content: formatScroll(result), metadata: rawMetadata(result) };
  };

  const pressKey: Executor = async (input, context) => {
    const key = stringParam(input, "key", { required: true });
    const uid = stringParam(input, "uid");
    const tabId = stringParam(input, "tab_id");
    const attempt = (nextUid: string | undefined): Promise<ToolResult> =>
      daemonCall(deps, context, "press_key", {
        key,
        ...(tabId === undefined ? {} : { tab_id: tabId }),
        ...(nextUid === undefined ? {} : { uid: nextUid }),
      }).then((result) => ({
        content: `pressed ${key}`,
        metadata: rawMetadata(result),
      }));
    // Without a uid there is nothing that can go stale — skip the recovery
    // path (and its extra snapshot) entirely.
    if (uid === undefined) return attempt(uid);
    return callWithStaleUidRetry(context, uid, tabId, attempt);
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
      ...(typeof record["timeout_ms"] === "number"
        ? { timeout_ms: record["timeout_ms"] }
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
      ...(record["include_headers"] === true
        ? { include_headers: true }
        : {}),
      ...(typeof record["since"] === "number" ? { since: record["since"] } : {}),
    });
    return { content: formatNetwork(result), metadata: rawMetadata(result) };
  };

  const networkBody: Executor = async (input, context) => {
    const record = asRecord(input);
    const requestId = stringParam(input, "request_id", { required: true });
    const result = await daemonCall(deps, context, "network_body", {
      ...optionalTabId(input),
      request_id: requestId,
      ...(typeof record["max_bytes"] === "number"
        ? { max_bytes: record["max_bytes"] }
        : {}),
    });
    return { content: formatNetworkBody(result), metadata: rawMetadata(result) };
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
    hover,
    select,
    upload,
    dialog,
    scroll,
    press_key: pressKey,
    eval: evaluate,
    console: consoleLog,
    network,
    network_body: networkBody,
    list_tabs: listTabs,
    close_tab: closeTab,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const SCHEMA_TAB_ID = {
  type: "string",
  description: "Tab id from browse_list_tabs. Defaults to your session tab.",
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
          dialog_policy: {
            type: "string",
            description:
              "auto (default) dismisses dialogs so a page cannot wedge the tab; manual leaves them for browse_dialog.",
          },
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
      description: "Click the element with the given [uid] from browse_snapshot.",
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
      name: "hover",
      description: "Move the mouse over the element with the given [uid].",
      input: schema(
        {
          uid: { type: "string", description: "Element uid, e.g. g7-3." },
          tab_id: SCHEMA_TAB_ID,
        },
        ["uid"],
      ),
      options: { ...baseOptions },
    },
    {
      name: "select",
      description:
        "Choose an option in a <select> by value, visible label or index. Pass exactly one of the three.",
      input: schema(
        {
          uid: { type: "string", description: "The <select> uid from browse_snapshot." },
          value: { type: "string", description: "Option value attribute." },
          label: { type: "string", description: "Visible option text." },
          index: { type: "number", description: "Zero-based option position." },
          tab_id: SCHEMA_TAB_ID,
        },
        ["uid"],
      ),
      options: { ...baseOptions },
    },
    {
      name: "upload",
      description:
        "Attach local files to an <input type=\"file\"> uid. Requires approval (browser_upload).",
      input: schema(
        {
          uid: { type: "string", description: "The file input uid from browse_snapshot." },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Absolute paths to regular files (max 8, 100 MiB total).",
          },
          tab_id: SCHEMA_TAB_ID,
        },
        ["uid", "paths"],
      ),
      options: { ...baseOptions, permission: UPLOAD_PERMISSION },
    },
    {
      name: "dialog",
      description:
        "Accept or dismiss a JavaScript dialog. Only applies after navigating with dialog_policy: manual.",
      input: schema(
        {
          action: { type: "string", description: "accept or dismiss." },
          prompt_text: { type: "string", description: "Text for a prompt dialog." },
          tab_id: SCHEMA_TAB_ID,
        },
        ["action"],
      ),
      options: { ...baseOptions },
    },
    {
      name: "scroll",
      description:
        "Scroll the page (up, down, left, right, top, bottom). Fires real scroll events, so infinite feeds load.",
      input: schema({
        direction: { type: "string", description: "up, down, left, right, top or bottom." },
        amount: { type: "number", description: "Pixels; defaults to 80% of the viewport." },
        tab_id: SCHEMA_TAB_ID,
      }),
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
          timeout_ms: {
            type: "number",
            description: "Evaluation deadline (default 30000, max 120000).",
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
      description:
        "Read recent network requests for the tab (bounded ring buffer). Set include_headers for redacted request/response headers.",
      input: schema({
        tab_id: SCHEMA_TAB_ID,
        limit: { type: "number", description: "Max entries (default 100, cap 500)." },
        filter: { type: "string", description: "Substring filter on URL." },
        include_headers: {
          type: "boolean",
          description: "Include redacted request/response headers (default false).",
        },
        since: { type: "number", description: "Cursor for incremental reads." },
      }),
      options: { ...baseOptions },
    },
    {
      name: "network_body",
      description:
        "Read one response body by request_id from browse_network. Default 16 KiB, max 256 KiB; BODY_UNAVAILABLE once Chrome evicts it.",
      input: schema(
        {
          request_id: {
            type: "string",
            description: "request_id from browse_network.",
          },
          tab_id: SCHEMA_TAB_ID,
          max_bytes: {
            type: "number",
            description: "Truncation bound (default 16384, cap 262144).",
          },
        },
        ["request_id"],
      ),
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
