import { Plugin } from "@opencode/plugin";
import { getClient } from "./supervisor.ts";
import { NAMESPACE as BROWSER_NAMESPACE, registerBrowserTools } from "./tools.ts";

/**
 * Display namespace. NOTE: on the installed runtime (v2.2.7) this only describes the
 * namespace — the *effective tool name* comes from `options.namespace` on each tool,
 * which is why every `add()` below repeats it. Verified: `browser` + `ping` ->
 * `browser_ping`. See docs/api-notes.md.
 */
const NAMESPACE = {
  name: "browser",
  description:
    "Browser automation through the opencode-browser daemon (Chrome via CDP).",
};

/** Human-readable message from anything a `catch` can hand us. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

export default Plugin.define({
  id: "browser",

  async setup(ctx) {
    const registration = await ctx.tool.transform((editor) => {
      editor.namespace(NAMESPACE);

      editor.add({
        name: "ping",
        description:
          "Probe tool. Echoes `value` back as `pong:<value>` and logs the calling session to stderr.",
        input: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
          required: ["value"],
          additionalProperties: false,
        },
        options: { namespace: NAMESPACE.name, codemode: true },
        execute: async (input, context) => {
          // The JSON Schema above is the runtime contract; the framework hands the
          // executor `unknown`, so narrow at this single boundary. A non-string
          // must not stringify into "pong:undefined" — reject it instead.
          const { value } = input as { value: unknown };
          if (typeof value !== "string") {
            throw new Error("browser_ping: `value` must be a string");
          }

          // Reading `context.signal` opts this tool into a cooperative stop.
          console.error(
            `[browser_ping] sessionID=${context.sessionID} signal=${typeof context.signal} aborted=${context.signal.aborted}`,
          );

          return {
            content: "pong:" + value,
            metadata: { sessionID: context.sessionID },
          };
        },
      });

      editor.add({
        name: "permission_probe",
        description:
          "Probe tool. Asks the permission system for `browser_eval` on probe://local and reports the outcome.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        options: { namespace: NAMESPACE.name, permission: "browser_eval", codemode: true },
        execute: async (_input, context) => {
          try {
            await ctx.permission.assert({
              sessionID: context.sessionID,
              action: "browser_eval",
              resources: ["probe://local"],
            });
            return { content: "permission: allowed" };
          } catch (error) {
            // A denial is a valid outcome for this probe, not a crash.
            return { content: "permission: rejected — " + errorMessage(error) };
          }
        },
      });

      registerBrowserTools(editor, {
        permission: ctx.permission,
        getClient,
      });
    });

    // Evidence for docs/api-notes.md: the names the runtime actually registered.
    // Match on the effective id prefix (`browser_navigate`, …), not the declared
    // name, so this line survives every future tool addition.
    const registered = await ctx.tool.list();
    const ours = registered.filter((tool) =>
      tool.id.startsWith(BROWSER_NAMESPACE + "_"),
    );
    console.error(
      `[browser] registered: ${ours
        .map((tool) => `${tool.id} (name=${tool.name})`)
        .join(", ")}`,
    );

    // Drop our tools when the plugin is unloaded; the domain keeps them otherwise.
    return () => registration.dispose();
  },
});
