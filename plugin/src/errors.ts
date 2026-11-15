/**
 * Error taxonomy — mirrors `docs/IMPLEMENTATION-PLAN.md` §2.5.
 *
 * The daemon speaks `{ code, message, hint }`; this module is the single place
 * that vocabulary is defined on the shim side, so tools and the supervisor
 * can never invent a new code by accident.
 */

export const ERROR_CODES = [
  "DAEMON_UNAVAILABLE",
  "PROTOCOL_MISMATCH",
  "CHROME_DEAD",
  "NAV_FAILED",
  "NAV_TIMEOUT",
  "TAB_NOT_FOUND",
  "TAB_FORBIDDEN",
  "TAB_LIMIT",
  "UID_NOT_FOUND",
  "UID_STALE",
  "ELEMENT_OCCLUDED",
  "DIALOG_NOT_OPEN",
  "UPLOAD_DENIED",
  "BODY_UNAVAILABLE",
  "EVAL_ERROR",
  "PERMISSION_DENIED",
  "INTERNAL",
] as const;

export type DaemonErrorCode = (typeof ERROR_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

export function isDaemonErrorCode(code: unknown): code is DaemonErrorCode {
  return typeof code === "string" && KNOWN_CODES.has(code);
}

/** Wire shape of a daemon error: `{ code, message, hint }`. */
export interface DaemonErrorDetails {
  readonly code: DaemonErrorCode;
  readonly message: string;
  readonly hint: string;
}

/**
 * A failed daemon call. Thrown by the RPC layer and the supervisor; tools
 * translate it into a `Tool.Error` (see `toToolError` in `tools.ts`) so the
 * model always gets a code plus an actionable hint — never a bare socket error.
 */
export class DaemonError extends Error {
  readonly code: DaemonErrorCode;
  readonly hint: string;

  constructor(code: DaemonErrorCode, message: string, hint: string) {
    super(message);
    this.name = "DaemonError";
    this.code = code;
    this.hint = hint;
  }

  /** No socket / no binary / spawned daemon never answered. */
  static unavailable(socketPath: string, reason: string): DaemonError {
    return new DaemonError(
      "DAEMON_UNAVAILABLE",
      `browser daemon unavailable: ${reason}`,
      `socket: ${socketPath}. Start it with the prebuilt binary ` +
        `(prebuilds/<platform>/browserd) or 'cargo run -p browserd'; ` +
        `if it keeps failing, check the daemon log on stderr`,
    );
  }

  /** Daemon answered `hello` with the wrong protocol major. */
  static protocolMismatch(
    socketPath: string,
    actual: unknown,
  ): DaemonError {
    return new DaemonError(
      "PROTOCOL_MISMATCH",
      `daemon at ${socketPath} speaks protocol ${String(actual)}, shim wants 1`,
      `stop the old daemon (its socket carries the protocol major: .../v1/daemon.sock), ` +
        `then retry so the supervisor spawns a matching binary`,
    );
  }
}

/** Normalize a daemon `ok:false` error payload into a `DaemonError`. */
export function fromWire(error: unknown): DaemonError {
  if (typeof error === "object" && error !== null) {
    const { code, message, hint } = error as Record<string, unknown>;
    if (isDaemonErrorCode(code)) {
      return new DaemonError(
        code,
        typeof message === "string" && message.length > 0
          ? message
          : String(code),
        typeof hint === "string" && hint.length > 0 ? hint : "retry the call",
      );
    }
  }
  return new DaemonError(
    "INTERNAL",
    `malformed error from daemon: ${safePreview(error)}`,
    "the daemon sent a response outside the protocol; retry, then report a daemon bug",
  );
}

function safePreview(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 200 ? text.slice(0, 200) + "…" : text;
  } catch {
    return String(value);
  }
}

/**
 * True when a failure is a stale-uid generation mismatch. Checked
 * structurally so it matches both a raw `DaemonError` and the converted
 * `Tool.Error` (which carries the code in `metadata.code`) — the retry
 * wrapper in `tools.ts` only sees the converted shape.
 */
export function isUidStaleError(error: unknown): boolean {
  if (error instanceof DaemonError) return error.code === "UID_STALE";
  if (typeof error === "object" && error !== null) {
    const metadata = (error as { metadata?: unknown }).metadata;
    if (typeof metadata === "object" && metadata !== null) {
      return (metadata as Record<string, unknown>)["code"] === "UID_STALE";
    }
  }
  return false;
}
