/**
 * Environment / configuration loader for the perception-action engine.
 *
 * Defaults follow the task spec: persistent profile launch, headful (visible)
 * browser by default, element cap 100, telemetry ring 200, settle max 2500 ms
 * with a 250 ms quiet window.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ResolvedConfig {
  /** Launch Chromium headless (true) or headful/visible (false default). */
  readonly headless: boolean;
  /** CDP URL for attach mode (OPENCODE_BROWSER_CDP_URL). */
  readonly cdpUrl: string | undefined;
  /**
   * When no explicit CDP URL is set, probe the conventional local DevTools
   * endpoint (127.0.0.1:9222) and attach to that browser
   * (OPENCODE_BROWSER_CDP_AUTODETECT, default true).
   */
  readonly cdpAutoDetect: boolean;
  /** Chromium executable override (OPENCODE_BROWSER_EXECUTABLE_PATH, auto-detected). */
  readonly executablePath: string | undefined;
  /** Persistent user-data-dir for profile launch. */
  readonly profileDir: string;
  /** Max interactive elements indexed per page (default 100). */
  readonly maxElements: number;
  /** Pass --no-sandbox (default: only when root, or OPENCODE_BROWSER_NO_SANDBOX=1). */
  readonly noSandbox: boolean;
  /** Max telemetry events in the ring buffer (default 200). */
  readonly maxTelemetry: number;
  /** waitForSettled hard deadline (default 2500 ms). */
  readonly settleMaxTimeoutMs: number;
  /** waitForSettled quiet window (default 250 ms). */
  readonly settleQuietWindowMs: number;
  /** Navigation timeout (default 30000 ms). */
  readonly navigationTimeoutMs: number;
  /** Directory for saved screenshot PNGs. */
  readonly screenshotDir: string;
  /** Allow `file:` URLs in browse_navigate (OPENCODE_BROWSER_ALLOW_FILE_URLS, default false). */
  readonly allowFileUrls: boolean;
  /**
   * Upgrade browse_eval's permission effect from allow to ask, so the user is
   * prompted even with no rules (OPENCODE_BROWSER_EVAL_PROMPT, default true).
   */
  readonly evalPrompt: boolean;
  /** browse_eval deadline (OPENCODE_BROWSER_EVAL_TIMEOUT_MS, default 30000 ms). */
  readonly evalTimeoutMs: number;
  /** Perception budget per turn (no env var, default 15000 ms). */
  readonly perceptionTimeoutMs: number;
}

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === "1" || v === "true" || v === "yes";
}

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** `--no-sandbox` only where it is needed (root/containers) or opted in. */
function defaultNoSandbox(): boolean {
  if (process.env["OPENCODE_BROWSER_NO_SANDBOX"] !== undefined) {
    return envBool("OPENCODE_BROWSER_NO_SANDBOX", false);
  }
  try {
    return typeof process.getuid === "function" && process.getuid() === 0;
  } catch {
    return false;
  }
}

/** Auto-detect a system Chromium when Playwright ships no bundled browser. */
function detectChromium(): string | undefined {
  const explicit = process.env["CHROME_PATH"];
  const home = process.env["HOME"] ?? "";
  const candidates = [
    explicit,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    home ? home + "/.local/bin/google-chrome" : undefined,
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      // not executable — keep scanning
    }
  }
  return undefined;
}

export function loadConfig(): ResolvedConfig {
  const profileDir =
    process.env["OPENCODE_BROWSER_PROFILE_DIR"] ?? ".opencode/browser-profile";
  return {
    headless: envBool("OPENCODE_BROWSER_HEADLESS", false),
    cdpUrl: process.env["OPENCODE_BROWSER_CDP_URL"] ?? undefined,
    cdpAutoDetect: envBool("OPENCODE_BROWSER_CDP_AUTODETECT", true),
    executablePath: process.env["OPENCODE_BROWSER_EXECUTABLE_PATH"] ?? detectChromium(),
    profileDir: path.resolve(profileDir),
    maxElements: envNum("OPENCODE_BROWSER_MAX_ELEMENTS", 100),
    noSandbox: defaultNoSandbox(),
    maxTelemetry: envNum("OPENCODE_BROWSER_MAX_TELEMETRY", 200),
    settleMaxTimeoutMs: envNum("OPENCODE_BROWSER_SETTLE_MAX_TIMEOUT_MS", 2500),
    settleQuietWindowMs: envNum("OPENCODE_BROWSER_SETTLE_QUIET_WINDOW_MS", 250),
    navigationTimeoutMs: envNum("OPENCODE_BROWSER_NAVIGATION_TIMEOUT_MS", 30000),
    // Temporary by default: screenshots are per-turn artifacts, not state.
    // The OS clears the temp directory on reboot.
    screenshotDir:
      process.env["OPENCODE_BROWSER_SCREENSHOT_DIR"] ??
      path.join(os.tmpdir(), "opencode", "browser-screenshots"),
    allowFileUrls: envBool("OPENCODE_BROWSER_ALLOW_FILE_URLS", false),
    evalPrompt: envBool("OPENCODE_BROWSER_EVAL_PROMPT", true),
    evalTimeoutMs: envNum("OPENCODE_BROWSER_EVAL_TIMEOUT_MS", 30000),
    perceptionTimeoutMs: 15000,
  };
}
