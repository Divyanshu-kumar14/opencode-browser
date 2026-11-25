/**
 * Errors the registry must rethrow unchanged, tracked by identity.
 *
 * `permission.assert` rejects with an error that ends the current step; the
 * host relies on seeing that exact object, so it must never be rewrapped as
 * `INTERNAL`.
 */

const passthrough = new WeakSet<object>();

export function markPassthrough(error: unknown): void {
  if (typeof error === "object" && error !== null) passthrough.add(error);
}

export function isPassthrough(error: unknown): boolean {
  return typeof error === "object" && error !== null && passthrough.has(error);
}
