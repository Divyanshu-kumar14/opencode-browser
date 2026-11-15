# Re-review Gate — plugin/ + daemon/ vs docs/review.md P0-1..P0-5 + P1-1..P1-7

**Reviewer:** Agent-E2 (read-only) · **Date:** 2026-11-15
**Scope:** `daemon/src/**`, `plugin/src/**` vs prior `docs/review.md` verdict (NOT READY)
**Deltas since prior review:** `daemon/src/main.rs` + `dispatch.rs` + `snapshot.rs` + `policy.rs` implemented; listener race fixed (`tabs.rs::ensure_listeners` awaited in `navigate`/`eval`, subscribe-before-pump, `ready` flag) + `dispatch.rs`; orphans `server/`/`actions/`/`capture.rs` deleted (confirmed: no `mod actions|capture|server` refs; `daemon/src/` contains exactly `main, dispatch, policy, snapshot, tabs, chrome, frame, paths, rpc, error`).
**Docs:** `docs/api-notes.md` now exists (Gate A0 PASS recorded); `docs/security.md` still **missing**.

## Verdict: ✅ READY (with conditions) — all five P0s resolved in code; merge-blockers cleared, test evidence still unaudited

All P0 findings from `docs/review.md` are resolved **by code inspection**. The one thing I could *not* do is run the verification command: `shell` is permission-denied in this session, so `cargo test` was **not executed** and no live socket/Chrome test was performed. Treat this as **READY-to-merge pending a green `cargo test` + `scripts/smoke.mjs` run** by the builder/CI — do not ship the binary until those two outputs exist.

---

## 1. P0 re-verification (per-item PASS/FAIL + evidence)

| ID | Prior finding | Now | Evidence (file:line) |
|---|---|---|---|
| **P0-1** daemon stub | `main.rs` was `fn main(){}` | ✅ **PASS** | `main.rs:182-248` `serve()` binds socket (`198-204`: `ensure_private_dir` + stale-socket remove + `bind` + `make_owner_only`), per-request `tokio::spawn` (`234`), graceful shutdown (`226-242`); `250-281` `flock` + `probe_healthy` exit-0-if-healthy; `501-528` death watcher (`forget` + `remove_all` + one auto-relaunch); `531-555` 60 s TTL sweep + zero-tab idle shutdown; `557-579` SIGTERM/SIGINT |
| **P0-2** allowlist | no scheme validation | ✅ **PASS** | `policy.rs:39-59` `check_navigate_url`: `http\|https\|about` ok (case-insensitive via `url_scheme` lowercasing, `17-29`), `file:` only with `allow_file:true`, else `NAV_FAILED`; full URL never echoed (scheme name only). Called **before any tab/CDP** in `dispatch.rs:203`, plus redirect-target re-check `dispatch.rs:271-282` (redirect landing on disallowed scheme → `NAV_FAILED` with redacted URL). Unit tests `policy.rs:84-131` cover allow/deny/uppercase/`file:` opt-in/scheme-less |
| **P0-3** peercred | comment only | ✅ **PASS** | `main.rs:316-335` `peer_uid()` via `getsockopt(SO_PEERCRED)`; `main.rs:338-356` enforce `peer == euid()`, cross-uid → connection closed with `PERMISSION_DENIED` (fail closed). No bypass path |
| **P0-4** dispatch/cancel/unknown | types only, no routing | ✅ **PASS** | `dispatch.rs:105-135` routes all 16 methods in `METHODS` (`25-42`); unknown → `INTERNAL` + known-methods hint (`125-129`); `hello` protocol gate → `PROTOCOL_MISMATCH` (`145-157`). `cancel` honored at connection layer: `main.rs:371-372` per-connection `in_flight: AbortHandle` map, `420-446` id-bearing cancel aborts the task + `{cancelled}` reply, `449-489` id-less `cancel` treated as no-op notification, `486` + `493-495` responses remove key / abort on disconnect. Per-request timeouts: `dispatch.rs:46-56` (`navigate` = inner clamp 1–120 s + 10 s headroom, cap 130 s; else 30 s) applied via `tokio::time::timeout` in `main.rs:466-484` with `NAV_TIMEOUT` vs `INTERNAL` split |
| **P0-5** snapshot | UID machinery unwired | ✅ **PASS** | `snapshot.rs:82-143` full 3-call pipeline (JS inject `146-197` → `DOM.getDocument` walk `200-216` → AX join `219-268`); `tab.set_uids(all injected uids)` `132` (even past render cap, so truncated-node clicks resolve instead of misreporting); `dispatch.rs:305` `bump_generation()` on navigate (stale uids can never resolve); `tabs.rs:181-198` generation mismatch → `UID_STALE`, unknown → `UID_NOT_FOUND`. Occlusion: `dispatch.rs:341-382` center-point + `elementFromPoint` probe → `ELEMENT_OCCLUDED` naming the cover; render shape `snapshot.rs:106-128` matches plan (`url: … (gen gN)`, `[gN-m] role "name"`, `… N more (max_nodes=M, truncated)`) |

**P0 grep verification (read-only, via `grep` tool):**
- `unwrap\(` in `daemon/src` → **zero matches** ✅ (no `unwrap` on client input; prior review's PASS holds and now covers ~10× more code)
- `.expect(` → only startup-internal (`main.rs` tokio runtime, `json!` serialization in bench/probe paths, signal handlers) + `#[cfg(test)]` assertions — acceptable, no client-input path ✅
- `--no-sandbox` → only `chrome.rs:60-62,160-162` behind explicit `--no-sandbox-acknowledged-risk` CLI flag with `warn!` at launch; **no env var path** ✅ (P1-1 fix confirmed at the source)
- `javascript:` in src → only `policy.rs:35` doc comment + `policy.rs:102` test vector (deny-case) ✅
- `execute.before` in `plugin/src` → **zero matches** ✅

---

## 2. P1 deltas

| ID | Status | Evidence |
|---|---|---|
| **P1-1** `CHROME_NO_SANDBOX=1` env backdoor | ✅ **FIXED** | Env override gone; `ChromeManager::new(binary, profiles_root, allow_no_sandbox)` takes it only from the CLI flag (`main.rs:206-210`, `chrome.rs:72-92`); loud `warn!` when set |
| **P1-2** `focus_uid` format!-interpolation | ✅ **FIXED** | All uid→JS interpolations now go through `serde_json::to_string` first: `tabs.rs:272-274` (`focus_uid`), `dispatch.rs:342-343` (click probe), `dispatch.rs:452-454` (fill). Residual risk if uid shape widens is contained by the string-literal encoding |
| **P1-3** page JS exceptions → `INTERNAL` | ✅ **FIXED** | `tabs.rs:252-263` `eval_json` maps `exception_details` → `EVAL_ERROR` (P1-3, never `INTERNAL`); `dispatch.rs:542-551` `handle_eval` preserves `EVAL_ERROR` for user-thrown errors, `INTERNAL` only for transport/CDP failures; empty/oversize expressions → `EVAL_ERROR` |
| **P1-4** anonymous shared tab | ✅ **FIXED** | `dispatch.rs:98-103` `effective_session`: blank/missing session → per-connection `anon:{conn_tag}` (`main.rs:233-234` `c{seq}` tag); two anonymous clients can never share. Unit test `dispatch.rs:720-726` pins isolation |
| **P1-5** shim beyond Phase 0 | ✅ **PRESENT** (unverified live) | `plugin/src/rpc.ts` (NDJSON, 30 s default, `AbortSignal` → best-effort id-less `cancel`), `supervisor.ts` (spawn detached `stdio:ignore`, ≤2 s backoff, `hello` handshake, `PROTOCOL_MISMATCH` actionable, never kills daemon), `tools.ts` (11 executors, `codemode:true`, `Tool.Error`+hint mapping), `driver/js.ts` present. **Not exercised here** — needs `bun test` + fixture E2E |
| **P1-6** buffers/redaction/timers | ✅ **FIXED** | `tabs.rs:37` `BUFFER_CAP=500` ring buffers, `push_console/push_network` evict-front (`498-512`), `drain_*` cap `limit` clamp 1–500 (`515-541`); `redact_url` (strip query/fragment, 512 cap) applied in console pump (`429`), log pump (`438-443`), network pump (`472`), `list_tabs` (`643`), navigate-redirect error; sweep timer + idle shutdown wired (`main.rs:531-555`); supervision calls `remove_all` (`512`) |
| **P1-7** production `browser_eval` gating | ✅ **CORRECT SHAPE** | `tools.ts:369-389`: resolves tab URL first, `permission.assert({sessionID, action:"browser_eval", resources:[url]})`, denial rethrown (never swallowed); `options.permission` set at registration (`tools.ts:581`). Interactive-TUI prompt path still unobserved (same caveat as `api-notes.md` §3c) — confirm in a TUI session before relying on UX |

## 3. P2 / residual notes (non-blocking)

- **P2-1 FIXED:** `index.ts:99-102` filters on effective-id prefix `browser_`, survives future tools.
- **P2-2 FIXED:** `index.ts:48-51` `typeof value !== "string"` guard.
- **P2-3 FIXED:** `tabs.rs:717-723` message has no stray space.
- **P2-4 OPEN (accepted):** `paths.rs:188-193` time+pid fallback still present — documented profile-dir-only use; must never seed anything security-relevant.
- **P2-5 OPEN:** `frame.rs:72-77` trailing partial frame at EOF is still returned as a message; the connection layer parses it as a request instead of rejecting it as a framing error. Minor; consider rejecting in a future touch.
- **G0 PARTIAL:** `docs/api-notes.md` exists with Gate A0 PASS; **`docs/security.md` still missing** (eval/attach/profile/socket/redaction model, plan R4 residual port risk). Required before v1 claims, not before merge.
- **New minor (non-blocking):** `tools.ts:399,411` forward a `since` cursor the daemon's `ConsoleParams`/`NetworkParams` ignore (serde ignores unknown fields, so harmless). Either add server-side `since` filtering or stop sending it, to avoid implying cursor semantics that don't exist.
- **Prior-review test nit closed:** `frame.rs` size-error assertion now checks a live-computed message (`read at least 10 bytes` for a 10-byte frame at limit 8) — no stale constant.

## 4. Security checklist delta (secure-coding)

| # | Control | Prior | Now |
|---|---|---|---|
| 1 | Input validation at boundary | ⚠️ Partial | ✅ **PASS** — allowlist + 8 KiB URL cap + empty-target reject + `wait_until`/button/click-count/`fill` 1 MiB/`eval` 1 MiB/`press_key` non-empty validation, all fail-closed before CDP |
| 2 | Auth (peercred) | ❌ | ✅ **PASS** |
| 3 | Authorization (ownership) | ⚠️ unwired | ✅ **PASS** — `resolve`/`close` enforce `assert_owned_by` (`tabs.rs:626-656, 746-763`); anonymous sharing closed |
| 4 | Secrets | ✅ | ✅ PASS (no new hits) |
| 5 | XSS/escaping | ✅ | ✅ PASS + hardened (P1-2) |
| 6 | CSRF-equivalent | ⚠️ | ✅ **PASS** (P1-4) |
| 7 | Injection | ⚠️ | ✅ **PASS** (P1-2/P1-3) |
| 8 | Bounds | ⚠️ frame only | ✅ **PASS** — frame cap + 500-entry buffers + eval 100 KiB truncation + `max_nodes` clamp 1–2000 + pending-network 1000-entry guard |
| 10 | Redaction | ❌ | ✅ **PASS** — `redact_url` at all log/store/error sites; allowlist errors echo scheme only |
| 11 | Sandbox posture | ⚠️ env bypass | ✅ **PASS** — explicit flag + warn, default safe, fresh tmp profile |
| 12 | Eval gating | ⚠️ probe only | ✅ **PASS** (shape; live prompt UX still to confirm in TUI) |

## 5. Testing assessment delta

| Layer | Prior | Now |
|---|---|---|
| Rust unit | partial (codec/uid/LRU/error) | ✅ **extended** — allowlist (5 tests), redaction, snapshot render/heuristic/AX-join, anon-isolation, timeout table, eval truncation, method-routing coverage, frame limits. **Presence verified by inspection; execution NOT verified (shell denied) — `cargo test` must go green before merge** |
| Rust integration (real Chrome) | missing | ⚠️ still missing as a recorded run (`scripts/smoke.mjs` exists now — run it) |
| Shim unit (`bun test`) | missing | ⚠️ unknown — `plugin/test/` not inspected in this pass; run `tsc --noEmit` + `bun test` |
| E2E / chaos / perf | missing | ⚠️ `scripts/smoke.mjs` + `scripts/bench.mjs` + fixture exist; no outputs recorded yet |

## 6. Conditions to clear before shipping (not before merge)

1. `cargo test` green (paste tail) + `cargo fmt --check` + `cargo clippy -D warnings`.
2. `node scripts/smoke.mjs` green against a live daemon (covers Gate A1 round-trip).
3. `docs/security.md` written (G0 remainder) before any release wording.
4. TUI session confirming the `browser_eval` `ask` prompt path (P1-7 residual caveat).
5. Re-review trigger stands: any future change to socket auth, scheme validation, eval path, sandbox flags, or buffers requires a fresh gate.

**Definition of done for this gate:** all P0 resolved ✅ (code) · P1 resolved ✅ (code; P1-5/P1-7 live behavior pending runs) · security rows 1–3, 10–12 green ✅ · tests present ✅ in source, execution pending per conditions 1–2.
