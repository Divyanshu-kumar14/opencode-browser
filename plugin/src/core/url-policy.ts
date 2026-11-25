/**
 * URL policy for the active plugin.
 *
 *   - `checkNavigationUrl` is the `browse_navigate goto` scheme allowlist.
 *   - `redactUrl` / `redactUrlsInText` strip query strings, fragments, and
 *     userinfo before a URL is stored in telemetry or shown in a prompt.
 */

import { InvalidInputError } from "./errors.ts";
import { sanitizePageText } from "../utils/formatter.ts";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "about:"]);
const ECHO_MAX = 200;

/** `raw` without its query string, fragment, and userinfo. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return raw.split(/[?#]/)[0] ?? "";
  }
}

/**
 * Redact every `scheme://…` token in free text (stack frames). A trailing
 * `:line:col` location suffix is kept so stacks stay useful.
 */
export function redactUrlsInText(text: string): string {
  return text.replace(/\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s()<>"'`]+/g, (token) => {
    const loc = /(:\d+(?::\d+)?)$/.exec(token);
    const suffix = loc ? loc[1]! : "";
    const body = suffix ? token.slice(0, -suffix.length) : token;
    // Leave tokens with nothing to redact byte-identical (no URL
    // normalization), so a bare `host:port` mistaken for `:line` is harmless.
    if (!/[?#@]/.test(body)) return token;
    return redactUrl(body) + suffix;
  });
}

function echo(raw: string): string {
  const clean = sanitizePageText(redactUrl(raw));
  return clean.length > ECHO_MAX ? clean.slice(0, ECHO_MAX - 1) + "…" : clean;
}

/**
 * Throw `InvalidInputError` unless `raw` is an absolute URL whose scheme is
 * `http`, `https`, or `about` (or `file` when `allowFile`).
 */
export function checkNavigationUrl(raw: string, opts: { readonly allowFile: boolean }): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidInputError(
      `browse_navigate: "${echo(raw)}" is not an absolute URL`,
      "pass an absolute http(s) URL, for example https://example.com/",
    );
  }
  const protocol = url.protocol.toLowerCase();
  if (ALLOWED_PROTOCOLS.has(protocol)) return;
  if (protocol === "file:") {
    if (opts.allowFile) return;
    throw new InvalidInputError(
      `browse_navigate: scheme "file:" is not allowed; set OPENCODE_BROWSER_ALLOW_FILE_URLS=1 to enable file: URLs (url: ${echo(raw)})`,
      "set OPENCODE_BROWSER_ALLOW_FILE_URLS=1 to allow file: URLs",
    );
  }
  throw new InvalidInputError(
    `browse_navigate: scheme "${sanitizePageText(protocol).slice(0, 40)}" is not allowed; only http:, https:, and about: URLs can be opened (url: ${echo(raw)})`,
    "pass an http(s) URL",
  );
}
