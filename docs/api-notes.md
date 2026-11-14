# API Notes — Phase 0 conformance spike (opencode v2.2.7 + `@opencode/plugin` 2.3.0)

Date: 2026-11-15. Scope: prove the V2 plugin contract on the installed runtime before any Rust work.

## Registration pattern (verified)

```ts
import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "browser",
  async setup(ctx) {
    const registration = await ctx.tool.transform((editor) => {
      editor.namespace({ name: "browser", description: "..." });
      editor.add({
        name: "ping",
        // ...
        options: { namespace: "browser" },   // <-- effective name comes from HERE
        execute: async (input, context) => { /* ... */ },
      });
    });
    return () => registration.dispose();
  },
});
```

Key facts (from `dist/promise/tool.d.ts`, `plugin.d.ts`, `permission.d.ts`, `@opencode/schema/tool.d.ts`):

- There is **no `ctx.tool.add`** — registration is `ctx.tool.transform(editor => editor.add(...))`, returning a `Registration` with `dispose()`.
- `editor.namespace(...)` alone does **not** name tools. The effective (flat) id is
  `options.namespace + "_" + name`. Server stderr confirms:
  `browser_ping (name=ping), browser_permission_probe (name=permission_probe)`.
- `ToolContext = { sessionID, signal: AbortSignal, progress }`. Reading `signal`
  opts into cooperative stop. `Tool.Context` also carries `agent`, `messageID`, `id`.
- Permission gating is **not** `execute.before` (that hook only exposes mutable
  `input`, no deny path). Gate is declarative + imperative:
  `options: { permission: "browser_eval" }` on the tool, then
  `await ctx.permission.assert({ sessionID, action: "browser_eval", resources: [url] })`
  inside the executor. Deny rejects; rethrow, don't swallow.
- Screenshot return shape when we need it later: `content: [{ type: "file", uri, mime, name? }]`
  (`@opencode/schema/tool.d.ts` `FileContent`).

## Effective tool names

| Declared (`options.namespace` + `name`) | Effective id (`ctx.tool.list()`) | Code-Mode call |
|---|---|---|
| `browser` + `ping` | `browser_ping` | `tools.browser.ping({ value: "ok" })` |
| `browser` + `permission_probe` | `browser_permission_probe` | `tools.browser.permission_probe()` |

`ctx.tool.list()` in setup logged:
`[browser] registered: browser_ping (name=ping), browser_permission_probe (name=permission_probe)`.

## Transcripts (isolated dir `/tmp/opencode/spike`, `opencode.jsonc` → absolute plugin path)

`browser_ping` (`tools.browser.ping({ value: "ok" })` via Code-Mode `execute`):

```
pong:ok
```

`browser_permission_probe`, allowed configuration:

```
permission: allowed
```

`browser_permission_probe`, non-interactive run (server auto-rejects the prompt):

```
permission requested: browser_eval (probe://local); auto-rejecting
```

and the tool correctly returned the rejection as data, not a crash:

```
permission: rejected — This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action.
```

Server stderr also logs per call (from the executor):
`[browser_ping] sessionID=<ses_...> signal=object aborted=false`.

## Permission behaviour

- `assert` with `action: "browser_eval"` triggers a real user-facing prompt
  (`permission requested: browser_eval (probe://local)`) — Gate A0 satisfied.
- In headless `opencode run` the prompt auto-rejects; the probe surfaces that as
  `permission: rejected — …`. Production tools must treat rejection as denial
  (return/throw `Tool.Error`), never fall through to the privileged action.
- `options.permission` on its own does not prompt inside `execute`; the explicit
  `assert` call is what enforces. Both are used together.

## Deviations / notes

1. **SDK vs server minor mismatch is benign.** `@opencode/plugin` **2.3.0** works
   against server **2.2.7** (registration, list, assert all observed working).
   No fallback to 2.2.x needed. R8 closed for Phase 0.
2. **Codemode:** `permission_probe` declares `options.codemode: true`; `ping` does not,
   yet both were callable from Code-Mode `execute` in the spike. `codemode: true`
   is kept on gated tools per plan §1; revisit if the server ever restricts
   non-codemode tools in Code Mode.
3. **Fresh-run re-verification blocked (2026-11-15):** `opencode run` currently fails
   before tool dispatch (`Free usage limit reached` / `User not found` on the
   configured model route). Transcripts above are from 2026-11-14 runs against the
   identical plugin source (only comments changed since). Re-run
   `timeout 180 opencode run "Call browser_ping..."` from `/tmp/opencode/spike`
   once credentials/quota are restored; no code change is expected.
4. **No `opencode.jsonc` added to the repo** — the spike config lives only in
   `/tmp/opencode/spike/opencode.jsonc`. Never commit one at repo root (it would
   hijack every developer's session).
5. One early spike iteration logged a different name format for built-in tools
   (`opencode_session_rename`); ours were consistently `browser_ping` /
   `browser_permission_probe`. No action.
