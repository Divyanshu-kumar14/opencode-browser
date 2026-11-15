# API notes — Phase 0 (OpenCode V2 plugin conformance)

**Date:** 2026-11-14/15 · **Installed server:** `opencode v2.2.7` (`opencode2` binary)
· **SDK in `plugin/`:** `@opencode/plugin@2.3.0` (pinned exact) · **Model used for E2E:**
`opencode/deepseek-v4.1-flash-free`, `opencode/beam-free` (free-tier; others hit quota)

All E2E runs were isolated in `/tmp/opencode/spike/` (own `opencode.jsonc`,
own `XDG_*_HOME`, `--standalone` private server). The live workspace repo was never touched.

---

## 1. Exact effective tool names (verified)

| Registration | Effective name the agent sees | Code-Mode handle |
|---|---|---|
| namespace `browser` + `ping` | **`browser_ping`** | `tools.browser.ping({value})` |
| namespace `browser` + `permission_probe` | **`browser_permission_probe`** | `tools.browser.permission_probe()` |

Server log proof (plugin setup, `--print-logs` run):

```
[browser] registered: browser_ping (name=ping), browser_permission_probe (name=permission_probe)
```

## 2. The namespace finding (deviation from the plan)

`IMPLEMENTATION-PLAN.md` §3 Phase 0 says to register via
`ctx.tool.transform(editor => { editor.namespace({name:"browser"}); editor.add({...}) })`
and expects `browser_<name>`. **On runtime 2.2.7 that is not sufficient:**
`editor.namespace()` alone leaves the tools named bare (`ping`, `permission_probe` —
observed live when the model reported only `ping` / `permission_probe` in its catalog).

The prefix comes from **`options.namespace` on each individual tool**
(`Tool.Options.namespace`, `@opencode/schema/tool.d.ts` line 39). Every `editor.add()`
must repeat `options: { namespace: "browser" }`. `editor.namespace()` is kept for the
display grouping only. `plugin/src/index.ts` documents this inline.

## 3. `opencode run` transcripts (trimmed)

### 3a. `browser_ping` — success

Prompt: `Call the browser_ping tool with value ok and report its exact output`

```
Exact output of `tools.browser.ping({ value: "ok" })`:

pong:ok
```

Plugin stderr in the same run:

```
[browser_ping] sessionID=ses_e2391622fffeRyHCQOeIJ56ne9 signal=object aborted=false
```

So: `Tool.Context.sessionID` is present, `signal` is a real `AbortSignal`
(`typeof` → `object`, `aborted=false`), and reading it opts into cooperative stop.
`metadata: { sessionID }` round-trips (executor returned it; no error).

### 3b. `browser_permission_probe` — allowed (default config, no rules)

Prompt: `Call the browser_permission_probe tool and report its exact output`

```
permission: allowed
```

`ctx.permission.assert({sessionID, action:"browser_eval", resources:["probe://local"]})`
resolves under the default config. No prompt appears in non-interactive `opencode run`
when nothing requires asking.

### 3c. `ask` rule + non-interactive run → auto-reject, returned as text (not a crash)

Config: `"permission": { "browser_eval": "ask" }` (deprecated key; same result expected
under `permissions`). stderr: `! permission requested: browser_eval (probe://local); auto-rejecting`.
Model reported:

```
permission: rejected — This non-interactive run cannot ask the user for permission,
so the request was rejected. Continue without this action.
```

The executor's try/catch converts the rejection into tool output. **Interactive TUI
prompting (`ask` → real user prompt) was NOT observed** — it cannot be exercised from
`opencode run`; Phase 2/3 must confirm the prompt path in a TUI session before relying
on `browser_eval` gating UX.

### 3d. `deny` rule → tool hidden from the agent catalog (not a call-time error)

Two configs, identical outcome:

- deprecated key: `"permission": { "browser_eval": "deny" }`
- current key: `"permissions": [{ "action": "browser_eval", "resource": "*", "effect": "deny" }]`

The plugin still registers both tools
(`[browser] registered: browser_ping …, browser_permission_probe …`), but the model
only sees `browser.ping`; calling the probe fails with
`ERROR: Unknown tool 'browser.permission_probe'. Did you mean tools.browser.ping?`
No `execute` call is ever issued. **A denied permission removes the tool from the
catalog instead of letting the call fail** — Phase 3 error taxonomy must treat
"tool absent" as a possible deny signal, not just catch executor rejections.

## 4. SDK 2.3.0 vs runtime 2.2.7 — deviations found

1. **Namespace must be per-tool** (`options.namespace`), not just `editor.namespace()`.
   Types allow both; only the per-tool one takes effect on 2.2.7. (§2 above)
2. **`permission` config key is deprecated** in the 2.2.7 config schema
   (`"deprecated": true`); the current key is **`permissions`** (ordered ruleset of
   `{action, resource, effect}`) plus a separate **`policies`** array for
   `tool.use`/`provider.use`/etc. Both keys were exercised; behavior is identical for
   our case. Prefer `permissions` going forward.
3. **No hard conflict from SDK 2.3.0 on server 2.2.7.** The plugin (compiled against
   2.3.0 types, `bun install` clean, `tsc --noEmit` clean) loads, registers, executes,
   and unloads on the 2.2.7 runtime with no version warnings in the server log.
   **Keep the 2.3.0 pin; do NOT downgrade to 2.2.x.** (R8 retired for now; re-check on
   any server upgrade.)
4. `ctx.tool.hook("execute.before")` confirmed inspect-only per types (mutable `input`,
   no deny field) — not exercised at runtime; the permission domain is the gating
   mechanism, as the plan already corrects (C2).
5. Code-Mode handle shape: agents call namespaced tools as `tools.browser.ping()`
   (dotted namespace object), while the flat `browser_ping` id is what appears in
   logs and `ctx.tool.list()`.

## 5. Environment notes for Phase 2

- Free-tier models are quota-flaky: `deepseek-v4.1-flash-free` and `glm-5.3-flash-free`
  returned "Free usage limit reached" mid-session; `beam-free` / `flint-40b-free` /
  `iceman-free` worked. For deterministic E2E, prefer a paid/provider key over
  free-tier rotation.
- `nvidia` and `groq` direct API keys in `auth.json` fail through opencode auth
  (`Authorization failed` / stale `openrouter` key `User not found`); the working path
  was `opencode/*` models via stored auth. Not our problem to fix, just don't depend
  on those providers for gates.
- The `[browse] registered: …` stderr line in `setup()` is intentional diagnostic
  logging, not leftover debug print — keep it; it is the cheapest registration proof
  in every future E2E run. Same for the per-call `[browse_ping] sessionID=…` line
  (remove or rate-limit it when call volume grows in Phase 3 chaos tests).

## 6. Gate A0 verdict

**PASS.** Tool callable from a real session (`pong:ok` transcript above); permission
prompt path characterized as far as non-interactive runs allow (allowed / auto-reject /
hidden-on-deny); zero unresolved API surprises — the one surprise found (per-tool
namespace) is resolved and encoded in `plugin/src/index.ts`.

## 7. Host tool-catalog collision — the namespace must not be `browser`

**Symptom (2026-11-15):** `ctx.tool.list()` reported all 16 plugin tools, but the
Code Mode catalog exposed only 6. The six were exactly the ids with no built-in
counterpart: `upload`, `press_key`, `eval`, `network`, `list_tabs`, `close_tab`.
The ten missing ones (`navigate`, `snapshot`, `screenshot`, `click`, `fill`,
`hover`, `select`, `dialog`, `scroll`, `console`) all collide with the host's
built-in `browser` namespace (`b_ = [ri("tabs.list", …)]`, 45 tools incl.
`navigate`, `snapshot`, `evaluate`, `click`, `fill`, `dialog`, `console`).

**Cause:** both registries key tools by `${namespace}_${name}`. A colliding
built-in wins; the plugin entry vanishes from the catalog while still appearing
in `ctx.tool.list()`. No permission rule is involved — the catalog filter only
drops tools matched by a `resource:"*", effect:"deny"` rule.

**Fix:** the plugin namespace is `browse` (`plugin/src/tools.ts` → `NAMESPACE`).
Verified live: the host pushed `browse (16 tools, 12 shown)` and removed
`browser`. Do not "restore" `browser` — every colliding tool would disappear
again.

## 8. Bounded waits — `wait_for_uid` + `expect_text` (D lane, additive)

**Date:** 2026-11-16 · **Protocol:** v1 additive only — two methods appended
to `METHODS` (`daemon/src/dispatch.rs`), two param structs appended to
`daemon/src/rpc.rs` (`WaitForUidParams`, `ExpectTextParams`), two executors +
specs appended in `plugin/src/tools.ts`. No existing method, error code, or
lock site touched.

**Shape:**

| Tool | Params | Success | Deadline blown |
|---|---|---|---|
| `browse_wait_for_uid` | `uid` (required), `tab_id?`, `timeout_ms?` | `{found: true, uid, elapsed_ms, timeout_ms}` | `NAV_TIMEOUT`: `uid {uid} did not appear within {ms}ms` |
| `browse_expect_text` | `text` (required, ≤10 KiB), `tab_id?`, `timeout_ms?` | `{matched: true, elapsed_ms, timeout_ms}` | `NAV_TIMEOUT`: `text did not appear within {ms}ms` |

**Budget:** `timeout_ms` clamps to 100 ms–30 s, default 5 s
(`clamp_wait_timeout_ms`, unit-tested in `rpc.rs`). Poll cadence 150 ms
(`WAIT_POLL_MS`): one short `eval_json` per interval. The outer
`request_timeout_ms` arm adds 5 s headroom (cap 40 s), so the handler's typed
`NAV_TIMEOUT` always wins the race — the connection layer can never mask it
with a bare `INTERNAL`.

**Locking:** the handlers resolve the tab (which enforces `assert_owned_by`)
but never take `op_lock`: the loop sleeps *between* CDP round trips, so a 30 s
wait cannot head-of-line block snapshot/click/fill on the same tab.
Transient eval failures (e.g. mid-navigation) keep polling until the deadline.

**Matching:** uid = verbatim `data-oc-uid` selector (JSON-escaped into the
page script, P1-2 style); text = plain case-sensitive `body.innerText`
substring — never a regex, so no backtracking bomb. Empty uid/text and an
over-cap needle are rejected before any tab or CDP call.

## 9. Route mocks — `route` (E lane, additive)

**Protocol:** v1 additive only — `route` appended to `METHODS`
(`daemon/src/dispatch.rs`), `RouteParams` + `StatusParams` appended to
`daemon/src/rpc.rs`, one executor + spec appended in `plugin/src/tools.ts`
(network-adjacent). No existing method, error code, or lock site touched.

**Shape:** `{pattern (required, ≤512 chars), action: fulfill|abort
(required), kind: substring|prefix|host, status?, body?, content_type?,
tab_id?}` → `{pattern, kind, action, routes}` (active-route count).
`status` (default 200, 100–599), `body` (default "", 256 KiB), and
`content_type` (default `text/plain`, printable ASCII, 128 chars) apply to
fulfill only — `abort` rejects them rather than silently dropping them.

**Enforcement (pinned-fork truth, not web lore):** chromey's per-target `NetworkManager` answers *every* `Fetch.requestPaused` it sees
(continue for allowed URLs) and always wins the race against a page-listener pump — a daemon-side `Fetch.enable` alone can therefore never mock
deterministically (every answer lost with `Invalid state for continueInterceptedRequest`, verified live). So the daemon launches Chrome with
`request_intercept`, under which the manager enables Fetch itself at target creation and then STEPS ASIDE (user+protocol flags), leaving the daemon
pump as the sole answerer. The pump is subscribed from tab birth in `setup_listeners` (awaited before every load-triggering op, so no pause can
predate it) and answers each pause with exactly one of continue/fulfill/fail (`BlockedByClient` for abort), so the page can never wedge on an
unanswered pause. Auth challenges (the manager enables with `handle_auth_requests`) are answered `Default` — browser default handling, identical to
no interception. First matching route (insertion order) wins; no match passes through. The table holds 20 routes max; `fetch_armed` gates `route`
so a mock is never recorded unenforced.

**Trust boundary:** substring/prefix/host are literal string operations
(`*`/`?` match themselves) — no regex crate touches untrusted input, so no
ReDoS. Fulfilled bodies carry exactly `content-type`; no secret header
(`authorization`, `cookie`, …) is ever reflected. Session-scoped via
`resolve` ownership; `mark_dead` clears the table, so `close_tab`,
`remove_all`, `sweep`, and eviction all drop every mock. `status` gained an
opt-in `verbose` flag reporting the global `op_lock` queue-wait mean
(counter sums only, no /proc walk).
