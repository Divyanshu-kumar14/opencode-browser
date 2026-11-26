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
import { PlaywrightBrowserSession } from "./core/browser-session.ts";
import { processBrowser } from "./core/process-browser.ts";
import { registerBrowserTools } from "./tools/index.ts";
import { registerEvalPrompt } from "./tools/evaluate.ts";

const NAMESPACE = "browse";

export default Plugin.define({
  id: "browser",

  async setup(ctx) {
    // One browser per process, shared across plugin instances and reloads;
    // process teardown (not disposal) closes it.
    const sessionManager = await processBrowser.acquire();

    const config = sessionManager.getConfig();
    const deps = {
      session: new PlaywrightBrowserSession(sessionManager),
      permission: ctx.permission,
      evalPrompt: config.evalPrompt,
    };

    // browse_eval runs arbitrary page JS: prompt even when no rule exists.
    const evalPrompt = await registerEvalPrompt(ctx.permission, config.evalPrompt);

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

    return async () => {
      await Promise.all([registration.dispose(), evalPrompt?.dispose()]);
      // Intentionally do NOT close the browser: the next plugin instance (or
      // the next turn) reuses the same process-global session. Closing here is
      // what caused a fresh Chromium launch on every agent step.
    };
  },
});
