/**
 * Child process for bugfix.signals.test.ts (1.22).
 *
 *   bun test/fixtures/teardown-child.ts bare          only the plugin's teardown
 *   bun test/fixtures/teardown-child.ts host-handler  plus a host SIGTERM handler
 *                                                     that exits 42 after 100 ms
 *
 * Prints "ready" once the handlers are installed, then idles.
 */

import { BrowserSessionManager } from "../../src/core/session-manager.ts";
import { processBrowser } from "../../src/core/process-browser.ts";

const mode = process.argv[2] ?? "bare";
await processBrowser.acquire(() => new BrowserSessionManager({ headless: true }));

if (mode === "host-handler") {
  process.on("SIGTERM", () => {
    setTimeout(() => process.exit(42), 100);
  });
}

setInterval(() => undefined, 1000);
process.stdout.write("ready\n");
