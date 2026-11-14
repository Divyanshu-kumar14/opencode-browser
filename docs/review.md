# Code Review + Security Gate — plugin/ + daemon/ vs IMPLEMENTATION-PLAN.md

**Reviewer:** Agent-E (read-only) · **Date:** 2026-11-15
**Scope:** `plugin/src/**`, `daemon/src/**` against plan §2 (arch), §2.3–§2.5, §4–5 + `secure-coding` + `quality-code`
**Baseline verified:** plan §0 (V2 API `ctx.tool.transform`+namespace, permission `assert`, session ownership, 0700/0600 + `SO_PEERCRED`, fresh-profile default, bounded buffers, `UID_STALE`/`TAB_FORBIDDEN`, no `unwrap` on client input, redaction)
**Docs present:** `docs/IMPLEMENTATION-PLAN.md` only. **`docs/api-notes.md` and `docs/security.md` are missing** (plan Phase 0 / Phase 4 deliverables) — Gap G0.

## Verdict: ❌ NOT READY — do not merge, do not ship the daemon

Phase 0 (plugin probes) is **correctly implemented**. Everything else is **scaffolding + types with no server**:
`daemon/src/main.rs` is a one-line stub (`fn main() {}`), so every runtime security invariant
(socket perms, peercred, allowlist, buffers, supervision) currently has **no enforcement point**.
The `paths`/`frame`/`tabs`/`error`/`rpc` modules are good foundations, but they are dead code
until `main.rs` (socket accept loop, dispatch, supervision, sweep timers) exists.

---

## 1. Verification evidence (read-only greps)

| Check (plan requirement) | Command / location | Result |
|---|---|---|
| `ctx.tool.transform` + `namespace` (C2/C4: must use, must not hand-prefix) | `plugin/src/index.ts:26-27,41,68` | ✅ PASS — `transform` + `editor.namespace()` + `options.namespace` on each tool |
| `ctx.permission.assert` for eval; **no** `execute.before` gating | `index.ts:71-75`; grep `execute.before` → only plan/PRD prose hits | ✅ PASS (probe only; production `browser_eval` not yet built — see P1-7) |
| `codemode: true` on tools | `index.ts:68` (permission_probe) | ✅ PASS |
| No `unwrap()` on client input in non-test code | grep `\.unwrap\(` in `daemon/src` → **zero non-test hits** | ✅ PASS |
| `.expect()` only in `#[cfg(test)]` | `frame.rs:113-115,121,141`; `rpc.rs:229-247,259`; `error.rs:153-179` — all under `mod tests` | ✅ PASS (acceptable) |
| No `--no-sandbox` default | `chrome.rs:150-152` — `no_sandbox()` only when `CHROME_NO_SANDBOX=1` | ⚠️ PASS with concern → P1-1 (env backdoor, default safe) |
| No `javascript:` handling anywhere | grep `javascript:` → no src hits | ❌ FAIL by omission → P0-2 (no allowlist exists to reject it) |
| Socket 0700/0600 helpers | `paths.rs:62-70` `ensure_private_dir`/`make_owner_only` | ⚠️ Helpers exist, **zero callers** (`main.rs` stub) → P0-1 |
| `SO_PEERCRED` / peercred accept check | grep `peercred\|PEERCRED\|getsockopt` → only a **comment** in `paths.rs:18` | ❌ FAIL → P0-3 |
| Scheme allowlist (`http/https/about`, `file:` opt-in) | grep → only hint text `error.rs:89` | ❌ FAIL → P0-2 |
| Fresh profile default / attach opt-in off | `chrome.rs:128,133-148` fresh tmp profile, no attach code | ✅ PASS (so far) |
| Bounded console/network buffers (500 entries) | grep `buffer\|truncate` → none in src | ❌ FAIL (not built) → P1-6 |
| Log redaction (strip query/fragment) | grep `redact` → none | ❌ FAIL (not built) → P1-6 |
| UID gen + `UID_STALE` | `tabs.rs:36-46,140-154` parse/check ✅; **no producer** (`set_uids`/`bump_generation` never called — no snapshot/navigate) | ⚠️ Half-built → P0-5 |
| `TAB_FORBIDDEN` ownership | `tabs.rs:156-165,301-330,420-429` | ✅ PASS (logic correct; unwired — no RPC) |
| Secrets in code / logs | grep `secret\|password\|token` in src → none; logs carry no URLs | ✅ PASS |
| `panic!/todo!/unimplemented!` in src | grep → none | ✅ PASS |
| Poison-lock handling | `tabs.rs:31-33` `unwrap_or_else(PoisonError::into_inner)` | ✅ PASS (no poison panic) |
| Frame cap 32 MiB, incremental enforcement | `frame.rs:9,45-68` + tests | ✅ PASS |
| `unsafe` blocks | `paths.rs:21` (`geteuid`), `paths.rs:78` (`kill` sig 0), `chrome.rs:302-304` (`SIGKILL` after graceful wait) — all with SAFETY comments | ✅ PASS (minimal, justified) |

---

## 2. Findings

### P0 — must fix before merge (blocking)

**P0-1 — `daemon/src/main.rs` is a stub; there is no daemon.**
File: `daemon/src/main.rs:1` (`fn main() {}`).
Plan §2.1/Phase 1 requires: socket server (`$XDG_RUNTIME_DIR/opencode-browser/v1/daemon.sock`,
dir 0700, socket 0600), `SO_PEERCRED` uid check on accept, NDJSON codec loop, per-request
`tokio::spawn`, single-instance `flock` on `daemon.lock` with healthy-socket probe, Chrome
supervision (death event → one auto-relaunch + `remove_all()` tab invalidation), SIGTERM/SIGINT
graceful shutdown, method dispatch for all §2.2 methods, `hello` protocol check → `PROTOCOL_MISMATCH`,
`cancel` id-less handling, TTL sweep timer + idle-shutdown timer.
Today `paths`/`frame`/`tabs`/`rpc`/`error`/`chrome` are **unreachable code**. Gate A1 cannot pass.
Fix pattern: implement `main.rs` per plan Phase 1 task list; wire `ensure_private_dir`,
`make_owner_only`, peercred check, `TabRegistry::sweep`, `ChromeManager::{ensure,forget,shutdown}`
before any other work. Success: `node scripts/smoke.mjs`-equivalent green (script itself is also missing).

**P0-2 — No navigation scheme allowlist (SSRF / file-access risk by omission).**
Files: (missing) navigate handler; only hint text at `daemon/src/error.rs:89`.
Plan §4 requires `http|https|about` + `file:` only with `allow_file:true`, reject `javascript:`.
When the navigate method is built, validation must happen **in the daemon** (never trust the shim),
fail closed with `NAV_FAILED` + actionable hint, and cover redirect targets too, not just the
initial URL. Also document the residual `remote-debugging-port` localhost risk (plan R4) in
`docs/security.md`. Success: unit tests for `http/https/about` allow, `javascript:`/`data:`/
`file:`(default)/uppercase-scheme bypass deny.

**P0-3 — No `SO_PEERCRED` enforcement (socket auth missing).**
File: `daemon/src/paths.rs:18-21` (comment + `euid()` only); no accept-path code exists.
Plan §2: 0700 dir + 0600 socket + peercred uid == euid, reject otherwise (Gate A4 `socat` test
as another uid must fail). Helpers without callers provide zero protection — wire them in the
accept loop from P0-1. Success: cross-uid `socat` connect → rejected; unit/integration test recorded.

**P0-4 — No RPC dispatch: `hello` version gate, method routing, `cancel`, timeouts unimplemented.**
Files: `daemon/src/rpc.rs` (types + `PROTOCOL:1` const only), `daemon/src/main.rs` (stub).
`PROTOCOL` is never compared; `RawRequest` id-less `cancel` shape is parsed in tests but nothing
acts on it; `CDP_TIMEOUT` exists in `tabs.rs:25` but no dispatcher applies per-request timeouts.
Fix: dispatcher mapping §2.2 table → handlers, `hello.protocol != 1` → `PROTOCOL_MISMATCH`,
unknown method → `INTERNAL` + hint, per-request `tokio::time::timeout` (default 30 s).
Success: `cargo test` dispatch tests + live `hello`/`status` round-trip.

**P0-5 — Snapshot pipeline (§2.4) entirely missing; UID machinery has no producer.**
Files: `daemon/src/tabs.rs:96-108,140-154` (`bump_generation`/`set_uids`/`check_uid` correct but
never called from any navigate/snapshot path — no such paths exist).
Plan §2.4 requires the 3-CDP-call algorithm (JS inject → `DOM.getDocument` → AX join),
`data-oc-uid="g{gen}-{n}"`, `UID_STALE` on generation mismatch, occlusion check →
`ELEMENT_OCCLUDED`, `max_nodes` default 300 + truncation marker. Nothing generates uids today,
so `check_uid` can only ever return `UID_NOT_FOUND`. Success: `snapshot` on fixture page returns
the `url: … (gen gN)` text shape from the plan; stale-uid click → `UID_STALE`.

### P1 — should fix before merge

**P1-1 — `CHROME_NO_SANDBOX=1` env backdoor disables the sandbox silently.**
File: `daemon/src/chrome.rs:150-152`. Default (unset) is safe, but any process that can set the
daemon's environment can permanently disable Chrome's sandbox with no log line. Plan says
"no `--no-sandbox` default". Fix pattern: remove the env bypass **or** gate behind an explicit
CLI flag (`--no-sandbox-acknowledged-risk`) plus a `warn!` at launch. Success: default launch args
never contain `--no-sandbox`; bypass (if kept) is loud and documented in `docs/security.md`.

**P1-2 — `focus_uid` interpolates the uid into JS via `format!`.**
File: `daemon/src/tabs.rs:222-234`. Safe *today* only because `check_uid` → `parse_uid`
restricts uids to `g{digits}-{digits}`. Defense-in-depth: keep the check **and** escape
(e.g. `serde_json::to_string(uid)` for the selector literal) so a future uid-shape change can't
become JS injection. Same rule will apply to every snapshot/click/fill/eval JS template.

**P1-3 — `eval_json` maps page JS exceptions to `INTERNAL` instead of `EVAL_ERROR`.**
File: `daemon/src/tabs.rs:201-219` (line 216: `RpcError::internal("internal page script failed…")`).
User JS that throws is **expected input**, not a daemon bug; plan taxonomy §2.5 reserves
`EVAL_ERROR` for it. Fix: page `exception_details` → `RpcError::eval_error(...)`; keep `INTERNAL`
for transport/CDP failures. Success: unit test asserting each path's code.

**P1-4 — Missing-session clients collapse onto one shared `"anonymous"` tab.**
Files: `daemon/src/rpc.rs:24-32`, `daemon/src/tabs.rs:289-342`. Every request without `session`
maps to owner `"anonymous"`, so two anonymous clients drive each other's tab — the exact
collision class §2.3 exists to prevent. The real shim always sends `Tool.Context.sessionID`,
so this is latent, but fail closed: reject empty session at the dispatcher (or mint a
per-connection ephemeral id), never share. Success: test with two anonymous sessions → isolated tabs.

**P1-5 — Shim beyond Phase 0 is missing (`rpc.ts`, `supervisor.ts`, `tools.ts`, `driver/js.ts`).**
Files: `plugin/src/` contains only `index.ts` (Phase-0 probes). Plan §§2.1/Phase 2–3 requires:
NDJSON client (request ids, 30 s default timeout, `AbortSignal` → best-effort `cancel`),
supervisor (spawn `prebuilds/linux-x64/browserd` detached on `ENOENT`/`ECONNREFUSED`, ≤2 s
backoff handshake, `PROTOCOL_MISMATCH` → actionable error, never kill daemon on unload),
tool schemas + `content:{type:"file"}` screenshot mapping + error→`Tool.Error` hints.
Gates A2/A3 blocked. Success: `bun test` rpc/supervisor/tools suites + fixture E2E.

**P1-6 — No bounded buffers, no redaction, no sweep/idle timers wired.**
Files: `daemon/src/tabs.rs:470-500` (`sweep()` correct but **no timer calls it**);
`remove_all()` (no death handler calls it); console/network methods absent.
Plan §2.3/Phase 3–4: 500 entries/tab ring buffers (~0.5 MB), `since` cursor, URL redaction
(strip query/fragment) in logs and stored tab metadata, 10-min lease sweep interval, 30-min
zero-tab idle shutdown. Unwired = unbounded growth (risk R9). Success: 30-min soak RSS drift <10 %.

**P1-7 — Production `browser_eval` permission wiring must mirror the (correct) probe.**
File: `plugin/src/index.ts:68-75` is the right pattern (`options.permission` +
`ctx.permission.assert({sessionID, action:"browser_eval", resources:[url]})`).
When the real tool lands: keep this exact shape with the **navigated URL** as resource,
never `execute.before` gating (plan C2 — it cannot deny), and confirm the prompt/deny path
in `docs/api-notes.md`. Success: eval denied without approval; allowed after approval.

### P2 — nice to have (non-blocking)

- **P2-1** Evidence log filter misses namespaced tools — `plugin/src/index.ts:87-89` filters
  `name === "ping"` but effective names are `browser_ping`; log line always prints empty.
  Fix filter to match `browser_ping`/`browser_permission_probe` (or log all).
- **P2-2** Unvalidated input cast — `index.ts:45` `as { value: string }`; add a runtime
  `typeof value === "string"` guard returning a `Tool.Error`-style message.
- **P2-3** Typo in limit message — `tabs.rs:394` `"tab limit ({} ) reached…"` stray space.
- **P2-4** `random_hex_32` time+pid fallback (`paths.rs:186-191`) is predictable — fine for
  profile dir names, but note it must never seed anything security-relevant.
- **P2-5** `frame.rs:70-72` returns a trailing partial frame (EOF without `\n`) as a message;
  dispatcher should reject trailing-partial as a framing error, not parse it.
- **P2-6** Gap G0: `docs/api-notes.md` (Phase 0 transcript) and `docs/security.md`
  (eval/attach/profile/socket/redaction model) do not exist — required by Gates A0/A4.

---

## 3. What is good (keep)

- Plugin Phase-0 contract is **exactly per plan C2/C4**: `transform` + `namespace`, per-tool
  `options.namespace`, `permission` + `assert`, `codemode`, `context.sessionID`/`signal` use,
  dispose on unload. No `execute.before` misuse. No secrets, no `innerHTML`, no network calls.
- Strict `tsconfig` (`strict`, `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`,
  `verbatimModuleSyntax`) — hold this bar for `rpc.ts`/`supervisor.ts`/`tools.ts`.
- Daemon modules are well-documented ("why" comments), small, single-purpose; error taxonomy
  matches §2.5 codes + wire shape + actionable hints; tests cover framing/uid/eviction/codec —
  a solid foundation for the P0 dispatch work.
- No `unwrap`/`panic`/`todo` in non-test daemon code; poison-lock and `unsafe` handling exemplary.

---

## 4. Security checklist (secure-coding)

| # | Control | Status |
|---|---|---|
| 1 | Input validation at API boundary (DTO + types) | ⚠️ Partial — `rpc.rs` params default + typed; **no dispatcher, no URL validation** (P0-2/P0-4) |
| 2 | Auth enforced on protected surface (socket peercred) | ❌ FAIL — no server, no check (P0-3) |
| 3 | Authorization per resource (tab ownership) | ⚠️ Logic correct, unwired (P0-4) |
| 4 | No hardcoded secrets | ✅ PASS |
| 5 | XSS prevention (escaping, no raw HTML sinks) | ✅ PASS (no sinks; watch P1-2) |
| 6 | CSRF-equivalent (cross-session tab driving) | ⚠️ Logic exists; anonymous sharing gap (P1-4) |
| 7 | Injection prevention (no string-concat queries; JS templates escaped) | ⚠️ Pass today via uid shape; harden (P1-2/P1-3) |
| 8 | Rate/bound limits (frame cap, buffers, tab cap) | ⚠️ Frame cap ✅; buffers/timers missing (P1-6) |
| 9 | Secure headers / transport posture | N/A (Unix socket; TLS out of scope v1) |
| 10 | No sensitive data in logs/errors (redaction) | ❌ FAIL — no redaction (P1-6); error messages must never echo full URLs with query/fragment or page content |
| 11 | Sandbox posture (no `--no-sandbox` default, fresh profile) | ⚠️ Default safe; env bypass (P1-1) |
| 12 | Eval gating (permission assert, user prompt, deny path) | ⚠️ Probe correct; production tool missing (P1-7) |

**Security-impacting changes require re-review before merge** (this gate). No fake data or
placeholder security claims were found — but do not publish any "faster/lighter" wording
until the Phase 5 benchmark exists (plan kill rule).

---

## 5. Testing assessment (plan §4)

| Layer | Status |
|---|---|
| Rust unit (`cargo test`: codec, uid, LRU, error mapping, scheme allowlist) | ⚠️ Partial — codec/uid/eviction/error present and passing by inspection; **scheme-allowlist tests absent** (nothing to test yet) |
| Rust integration (real Chrome: launch/navigate/snapshot/crash) | ❌ Missing |
| Shim unit (`bun test`: framing/reconnect/abort/mapping) | ❌ Missing (no test dir) |
| E2E (`opencode run` happy paths) | ❌ Missing (`scripts/` absent); Phase-0 transcript not yet in `docs/api-notes.md` |
| Chaos (8 sessions, kill Chrome/daemon, uid-denied socket) | ❌ Missing |
| Perf (`browserd bench`) | ❌ Missing |

Tests must be deterministic, independent, and AAA-structured; note `frame.rs:129` has a
suspicious assertion (`contains("8960")` on a size error — likely a copy-paste constant worth
a second look when touching that file).

---

## 6. Delegation plan (for builders — no code fixed in this review)

1. `@node-developer`… (no — Rust work) → **daemon owner**: P0-1 → P0-4 → P0-2 → P0-5 (dependency order);
   then P1-1/P1-2/P1-3/P1-4/P1-6. Success per finding above; verify with `cargo fmt --check`,
   `cargo clippy -D warnings`, `cargo test`, live smoke.
2. **Shim owner** (`@frontend-nuxt`-style TS dev or plugin owner): P1-5 (rpc/supervisor/tools/js-driver),
   P1-7, P2-1/P2-2. Success: `tsc --noEmit`, `bun test`, fixture E2E transcript → `docs/api-notes.md`.
3. **Docs owner**: G0 (`docs/api-notes.md`, `docs/security.md`) + P2-6; required for Gates A0/A4.
4. **Re-review trigger**: any change touching socket auth, scheme validation, eval path, sandbox
   flags, or buffers requires a fresh Agent-E pass before merge.

**Definition of done for this gate:** all P0 resolved + re-review requested; P1 resolved or
tracked with justification; security checklist rows 1–3, 10–12 green; tests in §5 present per phase.
