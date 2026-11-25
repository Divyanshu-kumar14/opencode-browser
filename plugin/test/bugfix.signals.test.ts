/**
 * 1.22: signal teardown must close the browser without forcing exit(0).
 * Spawns test/fixtures/teardown-child.ts and sends it SIGTERM.
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const CHILD = path.join(import.meta.dir, "fixtures", "teardown-child.ts");

async function runChild(mode: "bare" | "host-handler"): Promise<{ exitCode: number | null; signalCode: string | null }> {
  const child = Bun.spawn([process.execPath, CHILD, mode], { stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  let seen = "";
  const deadline = Date.now() + 10000;
  while (!seen.includes("ready")) {
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("child never became ready");
    }
    const { value, done } = await reader.read();
    if (done) throw new Error(`child exited early: ${seen}`);
    seen += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  child.kill("SIGTERM");
  const killer = setTimeout(() => child.kill("SIGKILL"), 10000);
  await child.exited;
  clearTimeout(killer);
  return { exitCode: child.exitCode, signalCode: child.signalCode === null ? null : String(child.signalCode) };
}

describe("Group 5: signal teardown (1.22)", () => {
  test("bare: the process ends by SIGTERM, not exit code 0", async () => {
    const r = await runChild("bare");
    expect(r.signalCode).toBe("SIGTERM");
    expect(r.exitCode).not.toBe(0);
  }, 30000);

  test("host-handler: the host's own exit code is preserved", async () => {
    const r = await runChild("host-handler");
    expect(r).toEqual({ exitCode: 42, signalCode: null });
  }, 30000);
});
