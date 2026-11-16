/**
 * opencode-browser plugin entry point — Antigravity-grade stateful
 * perception-action engine.
 *
 * Registers 6 tools under the `browse` namespace (the host reserves `browser`
 * for its built-in tools, so `browse_*` avoids silent id shadowing):
 *   browse_navigate, browse_interact, browse_snapshot, browse_inspect,
 *   browse_viewport, browse_eval
 *
 * Every mutating tool runs the closed loop:
 *   Update HUD -> Execute Action(s) -> waitForSettled() -> Re-index SoM +
 *   annotated screenshot -> Drain new telemetry -> Formatted payload.
 *
 * The workflow guide is embedded in each tool description (the V2 plugin API
 * exposes no global system-prompt hook in setup), so the agent learns to:
 *   - prefer elementId from the [1..N] map over guessing CSS selectors,
 *   - batch fill+submit in a single browser_interact turn,
 *   - check the Telemetry section after every action,
 *   - use browser_inspect for CSS/layout debugging.
 */

import { Plugin } from "@opencode/plugin";
import { loadConfig } from "./config.ts";
import { BrowserSessionManager } from "./core/session-manager.ts";
import { registerBrowserTools } from "./tools/index.ts";

const NAMESPACE = "browse";

/**
 * The host re-instantiates plugins many times per server process (292 loads
 * observed in one afternoon, ~9/minute during active turns). A per-setup
 * manager meant every disposal closed the shared Chromium — i.e. one browser
 * open/close per agent step. The browser session therefore lives on
 * `globalThis`, shared by every plugin instance, and only process teardown
 * (SIGINT/SIGTERM) closes it.
 */
const MANAGER_KEY = Symbol.for("opencode.browser.session-manager");
const TEARDOWN_KEY = Symbol.for("opencode.browser.teardown-armed");

interface ManagerSlot {
  [MANAGER_KEY]?: BrowserSessionManager;
  [TEARDOWN_KEY]?: boolean;
}

function globalSlot(): ManagerSlot {
  return globalThis as unknown as ManagerSlot;
}

function getSessionManager(): BrowserSessionManager {
  const slot = globalSlot();
  const existing = slot[MANAGER_KEY];
  if (existing && typeof existing.ensureActivePage === "function") return existing;
  const created = new BrowserSessionManager();
  slot[MANAGER_KEY] = created;
  return created;
}

export default Plugin.define({
  id: "browser",

  async setup(ctx) {
    const config = loadConfig();
    const sessionManager = getSessionManager();

    // Graceful teardown: never leave zombie Chromium behind. Arm the signal
    // handlers once per process, not once per plugin instance.
    const slot = globalSlot();
    if (!slot[TEARDOWN_KEY]) {
      sessionManager.registerTeardown();
      slot[TEARDOWN_KEY] = true;
    }

    const deps = {
      sessionManager,
      screenshotDir: config.screenshotDir,
    };

    const registration = await ctx.tool.transform((editor) => {
      editor.namespace({
        name: NAMESPACE,
        description:
          "Stateful browser perception-action engine (Playwright/CDP): SoM " +
          "perception, live HUD, deterministic settling, passive telemetry.",
      });
      registerBrowserTools(editor, deps, NAMESPACE);
    });

    const registered = await ctx.tool.list();
    const ours = registered.filter((tool) => tool.id.startsWith(NAMESPACE + "_"));
    console.error(
      `[browse] registered ${ours.length}: ${ours.map((tool) => tool.id).join(", ")}`,
    );

    return () => {
      registration.dispose();
      // Intentionally do NOT close the browser: the next plugin instance (or
      // the next turn) reuses the same process-global session. Closing here is
      // what caused a fresh Chromium launch on every agent step.
    };
  },
});
