/**
 * Typed errors the tool registry maps to specific `Tool.Error` codes.
 *
 * `InvalidInputError` marks a caller mistake (disallowed URL scheme, invalid
 * selector, a `select_option` that cannot select, …). The registry reports it
 * as `INVALID_INPUT`; every other error stays `INTERNAL`.
 */

export class InvalidInputError extends Error {
  readonly code = "INVALID_INPUT";

  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "InvalidInputError";
  }
}

/** True for an `InvalidInputError`, including one from another module copy. */
export function isInvalidInputError(error: unknown): error is InvalidInputError {
  if (error instanceof InvalidInputError) return true;
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "INVALID_INPUT" &&
    error.name === "InvalidInputError"
  );
}
