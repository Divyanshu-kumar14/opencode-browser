# Implementation Plan — Close the browser tool-surface gaps

**Status:** v2 — 2026-11-15. Phase A, B, C2, E1–E3 **done** (see §10);
C1/C3/C4 and D/F still open.
**Input:** field review of the loaded plugin ("7 tools only", 7 limitation groups)
**Scope:** `plugin/src/tools.ts`, `plugin/src/index.ts`, `daemon/src/{rpc,dispatch,tabs,error,policy}.rs`
**Target:** Linux x86_64, OpenCode V2 plugin API, protocol `v1` (additive methods only)

---

## 0. Verdict first: 5 of the 7 findings are a stale registration, not missing code

The loaded plugin exposes 7 tools. The repository source registers 11 productive
tools (13 with the two probes). The daemon answers 16 methods. These three facts
were measured, not inferred:

| Layer | Measured surface | Evidence |
|---|---|---|
| Host (what `search` sees) | **7**: `ping`, `permission_probe`, `press_key`, `eval`, `network`, `list_tabs`, `close_tab` | `search({query:"browser"})` → 7 items, `remaining: 0` |
| Current shim source | **13**: the 11 productive tools below + `ping` + `permission_probe` | `bun /tmp/reg-check.ts` → `registered 11: …`; probes are added in `index.ts` |
| Running daemon | **16**: the 11 above + `hello`, `status`, `shutdown`, `bench`, `cancel` | raw socket `hello` → `capabilities: [...]` |

A raw-socket probe against the running daemon (session `probe2`, no shim involved)
proves the missing capabilities already work:

```text
navigate  → {"tab_id":"t4","url":"http://127.0.0.1:8787/fixture.html","title":"browserd smoke fixture","status":200}
snapshot  → 6 uids: g2-1 textbox "Email", g2-2 textbox "Password", g2-3 button "Sign in", …
fill      → {"ok":true}            (g2-1 = "agent@example.com")
click     → {"ok":true}            (g2-3 = Sign in)
eval      → {"n":3}                js = (() => { const rows = [1,2,3]; const n = rows.length; return {n}; })()
console   → 3 entries (log, verbose, error)
network   → 2 entries (document 200, fetch 404)
screenshot→ {"width":1280,"height":657,"path":"…/t4-1794728018570.png"}
list_tabs → 3 tabs
close_tab → {"closed":true}
```

**Why the host is stale:** the background server (`opencode2 serve --service`)
caches loaded plugin modules. It was already running when the full surface landed
(commits `79f2b11` 05:28 and `9102cb1` 05:50), so it still serves the earlier
7-tool module. The daemon is current (prebuild built 12:48, process started 12:51).
`@different-ai/opencode-browser` is **not** the source of the other tools — its load
failed on 2026-11-14 (`Plugin must export a default definition…`).

**Immediate fix (no code):**

```sh
opencode2 service restart          # reloads plugins; browserd survives (own socket)
opencode2 service status           # expect a new http://127.0.0.1:<port>
# then in a NEW session:
#   search "browser"  -> expect 13 tools (11 productive + 2 probes)
```

This alone closes findings **1, 2, 3, 4 (partially), 5 (console), and 6
(list/close)**. The exact eval expression from the review
(`(() => { const rows = [...document.querySelectorAll('.athing')]; … })()`) is
accepted by the current daemon; re-run it after the reload to confirm the old
failure was the pre-12:48 binary or the stale module.

**What the review still gets right:** even after the reload, the surface has real
gaps versus a full browser harness: no hover, no select-by-label, no file upload,
no dialog handling, no scroll tool, no tab create/select, no back/forward, no
resize, no network response bodies, and `networkidle` is a 500 ms sleep rather
than real idle detection. Those are Phases B–D.

---

## 1. Finding-by-finding disposition

| # | Review finding | After reload | Genuinely missing | Plan |
|---|---|---|---|---|
| 1 | No `navigate`; JS workaround, no wait/timeout | `browse_navigate` with `wait_until` (`load`/`domcontentloaded`/`networkidle`), `timeout_ms`, scheme allowlist, redirect re-check | back/forward, tab create/select, real network-idle | Phase D |
| 2 | No `snapshot`/AX tree; blind `press_key` uid | `browse_snapshot`: uids `g{gen}-{n}`, AX join, bounds, truncation, `UID_STALE` on generation change | none core | — |
| 3 | `eval` single-expression only | `Runtime.evaluate` verbatim; multi-statement IIFE returns `{n:3}`; `await_promise` default true; 1 MiB in / 100 KiB out caps | explicit `timeout_ms`; document expression contract | Phase B (small) |
| 4 | No interaction beyond `press_key` | `browse_click` (real mouse, occlusion check), `browse_fill` (focus + `Input.insertText`, select handling), `browse_press_key` | hover, select by label/index, file upload, dialog accept/dismiss, scroll | Phase B |
| 5 | `network` read-only ring; no console | `browse_console` + `browse_network`, 500-entry rings, level/URL filters | response bodies, headers, working `since` cursor | Phase C |
| 6 | Minimal tabs; no create/select/resize | `browse_list_tabs` / `browse_close_tab`, ownership, 10-min lease, max 8, LRU | create/select, resize, emulate media | Phase D |
| 7 | Probes do nothing useful | `ping` + `permission_probe` registered | they are noise for agents | Phase E (gate behind debug) |

---

## 2. Target surface

**After Phase A (today, no code):** 13 tools (11 productive + 2 probes).

**After Phase E (probes gated):** 11 productive tools.

**After Phases B–D (target):** 21 productive tools.

| Tool | Phase | Notes |
|---|---|---|
| `browse_navigate` | exists | + real `networkidle` in Phase D |
| `browse_snapshot` | exists | unchanged |
| `browse_screenshot` | exists | unchanged |
| `browse_click` | exists | unchanged |
| `browse_fill` | exists | unchanged |
| `browse_press_key` | exists | unchanged |
| `browse_eval` | exists | + `timeout_ms` |
| `browse_console` | exists | + `since` cursor |
| `browse_network` | exists | + headers, `since` |
| `browse_list_tabs` / `browse_close_tab` | exists | kept as aliases |
| `browse_hover` | B | mouse-move at uid center |
| `browse_select` | B | value / label / index |
| `browse_upload_file` | B | `DOM.setFileInputFiles`, permission-gated |
| `browse_dialog` | B | accept/dismiss JS dialogs |
| `browse_scroll` | B | up/down/top/bottom + amount |
| `browse_tabs` | D | list/new/select/close in one tool |
| `browse_navigate_back` | D | history entry −1 |
| `browse_reload` | D | optional `ignore_cache` |
| `browse_network_body` | C | one response body by `request_id` |
| `browse_status` | D | daemon status + pending dialog + session tab |

**P2 / optional (not required to close the review):** `browse_navigate_forward`,
`browse_resize`, `browse_emulate_media`, `browse_drag`, `browse_type`.
Deliberate non-goals (playwright-mcp parity but out of scope): network mocking,
video/trace capture, multi-browser, cross-origin iframe automation.

---

## 3. Phase plan

### Phase A — Reload + stale-load guard · 0.5 day · **P0**

| # | Task | Files |
|---|---|---|
| A1 | Restart the background server; verify 11 tools in a new session; re-run the exact failing eval | none (ops) |
| A2 | Add a build stamp logged at setup (`const BUILD = "<git-sha|date>"`; `console.error("[browser] build=… tools=…")`) so a stale module is visible in logs | `plugin/src/index.ts` |
| A3 | Add a startup cross-check: after `ctx.tool.list()`, compare the registered browser ids against the shim's expected list; warn on a shortfall | `plugin/src/index.ts` |
| A4 | Record the evidence (7 vs 13 vs 16, raw probe) in `docs/api-notes.md` | `docs/api-notes.md` |

**Verify:** `opencode2 service status`; new-session `search "browser"` → 13;
`browse_eval` with the HN IIFE returns a number, not `SyntaxError`.

**Exit:** host surface == source surface. No more silent stale loads.

---

### Phase B — Interaction completeness · 2 days · **P1**

| # | Task | Design |
|---|---|---|
| B1 | `browse_hover` | Reuse `probe_click_point` (scroll-into-view + occlusion check); dispatch `MouseMoved` only. Params `{uid, tab_id?}`. Result `{ok, x, y}`. |
| B2 | `browse_select` | `{uid, value?, label?, index?, tab_id?}`. Resolve option by value → label → index; set `selectedIndex`; dispatch `input` + `change`. `fill` keeps its existing select path. |
| B3 | `browse_upload_file` | `{uid, paths: string[], tab_id?}`. Resolve `[data-oc-uid]` via `DOM.querySelector`; verify `input[type=file]`; `DOM.setFileInputFiles`. Validate: absolute paths, regular files, ≤ 8 files, ≤ 100 MB total, no `..`. **Permission-gated** (`browse_upload`, default ask) because it can exfiltrate local files. |
| B4 | `browse_dialog` | Subscribe to `Page.javascriptDialogOpening` in `setup_listeners` (after `Page.enable`). Per-tab `dialog: Option<{type,message,default_prompt,url}>`. Default policy: auto-dismiss `alert`/`confirm`/`prompt`; auto-accept `beforeunload` (otherwise navigation can wedge). Tool `{action:"accept"\|"dismiss", prompt_text?, tab_id?}` → `Page.handleJavaScriptDialog`. No dialog → `DIALOG_NOT_OPEN`. |
| B5 | `browse_scroll` | `{direction: up\|down\|top\|bottom\|left\|right, amount?: number, tab_id?}`. JS `scrollBy`/`scrollTo`; return `{scrollX, scrollY, at_bottom}`. Triggers scroll listeners for infinite feeds. |
| B6 | `eval timeout_ms` | Add `timeout_ms` to `EvalParams`; pass `Runtime.evaluate.timeout` when supported, else wrap the call in `tokio::time::timeout`. Default 30 s, cap 120 s. |

**Files:** `daemon/src/rpc.rs` (params), `daemon/src/dispatch.rs` (handlers),
`daemon/src/tabs.rs` (dialog slot + event pump), `daemon/src/error.rs`
(`DIALOG_NOT_OPEN`, `UPLOAD_DENIED`), `plugin/src/tools.ts` (5 executors +
schemas), `plugin/test/tools.test.ts`.

**Verify (fixture additions):** `<input type="file">`, `<select>` with 3 options,
`<button onclick="alert('hi')">`, a hover target, a tall page.

**Exit:** one `opencode run` does navigate → snapshot → hover → fill → select →
upload → dialog accept → scroll → screenshot with no manual CDP workaround.

---

### Phase C — Network/console depth · 1 day · **P2**

| # | Task | Design |
|---|---|---|
| C1 | `NetworkEntry` gains `request_id`, `resource_type`, `from_cache`, `encoded_bytes`, redacted request/response headers | Extend the struct in `tabs.rs`; populate in `pump_network`. Redact `authorization`, `cookie`, `set-cookie`. |
| C2 | `since` cursor for console + network | Add a monotonic `seq` per entry; `drain_*` filters `seq > since`; every response returns `next_since`. Removes the re-review P2 note (shim sent `since`, daemon ignored it). |
| C3 | `browse_network_body` | `{request_id, max_bytes?}` → `Network.getResponseBody`; decode base64 when flagged; truncate at 16 KiB default / 256 KiB cap; `BODY_UNAVAILABLE` when Chrome has evicted it. One body per call keeps list responses small. |
| C4 | `browse_network` `include_headers?: boolean` | Default false; headers redacted before serialization. |

**Exit:** fixture fetch body is readable; `since` returns only new entries; no
secret header value appears in output or logs.

---

### Phase D — Tabs, navigation, real idle · 1 day · **P2**

| # | Task | Design |
|---|---|---|
| D1 | `browse_tabs` | `{action:"list"\|"new"\|"select"\|"close", tab_id?, url?}`. `new` creates an owned tab (optionally navigates) and makes it current; `select` only for owned tabs (`TAB_FORBIDDEN` otherwise); `close` reuses `close_tab`. Keep `list_tabs`/`close_tab` as aliases. |
| D2 | `browse_navigate_back` | `Page.getNavigationHistory` → `currentIndex−1` → `Page.navigateToHistoryEntry`; wait for `load`; bump generation; `NO_HISTORY` at index 0. |
| D3 | `browse_reload` | `Page.reload({ignoreCache})`; same wait path as navigate; bump generation. |
| D4 | Real `networkidle` | Track `inflight` per tab: `+1` on `Network.requestWillBeSent`, `−1` on `loadingFinished`/`loadingFailed`. `networkidle` = zero in-flight for 500 ms or the caller's timeout. Keep the existing 500 ms fallback only for tabs with listeners disabled. |
| D5 | `browse_status` | Expose daemon `status` + `{session_tab, pending_dialog, inflight}`. Read-only, cheap, makes stale/hung states debuggable. |
| D6 | `browse_resize` (P2) | `Emulation.setDeviceMetricsOverride`; `reset: true` clears it. Snapshot bounds are viewport-relative, so document that uids must be re-read after a resize. |

**Exit:** two tabs in one session switch without cross-session leakage; back
returns to the previous document with fresh uids; `networkidle` waits for the
fixture's `/api/ping` instead of sleeping 500 ms.

---

### Phase E — Cleanup + docs · 0.5 day · **P3**

| # | Task |
|---|---|
| E1 | Gate `ping` / `permission_probe` behind `OPENCODE_BROWSER_DEBUG=1` (default off). The permission probe stays available for gate testing, not for agents. |
| E2 | Fix `plugin/test/supervisor.test.ts:60`: make `OPENCODE_BROWSERD_BIN` **exclusive** when set (an explicit override that does not exist must fail, not silently fall back to the repo prebuild). Update the `binaryCandidates` doc comment; `bun test` goes 25/25. |
| E3 | Write the missing `docs/security.md`: eval risk, upload path/exfil risk, network-body exposure, dialog text is untrusted, attach mode, socket, profile, allowlist. |
| E4 | Update `README.md` tool table (11 → 21), remove "planned" wording, link this plan. |

---

### Phase F — Tests · 1 day (overlaps B–D) · **P3**

| Layer | Additions |
|---|---|
| Rust unit | param parsing, `since` filter, tab-select ownership, upload path validation, dialog state transitions, inflight counter, `truncate` boundaries |
| Rust integration (`--ignored`, real Chrome) | fixture upload, dialog accept/dismiss, hover, select, back/forward, resize, network body, real idle |
| Shim (`bun test`) | new executor param mapping + formatters; supervisor override; permission gate unchanged |
| Smoke (`scripts/smoke.mjs`) | 31 → ~45 checks: hover, select, upload, dialog, back, scroll, network body, `since` |
| CI | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, `bun test`, `tsc --noEmit` |

---

## 4. Wire protocol additions (additive, protocol stays `v1`)

| Method | Params | Result |
|---|---|---|
| `hover` | `{uid, tab_id?}` | `{ok, x, y}` |
| `select` | `{uid, value?, label?, index?, tab_id?}` | `{ok, value, label}` |
| `upload` | `{uid, paths[], tab_id?}` | `{ok, files}` |
| `dialog` | `{action, prompt_text?, tab_id?}` | `{ok, dialog}` |
| `scroll` | `{direction, amount?, tab_id?}` | `{ok, scrollX, scrollY, at_bottom}` |
| `tabs` | `{action, tab_id?, url?}` | `{tabs?}` / `{tab_id, url}` / `{closed}` |
| `navigate_back` | `{tab_id?, wait_until?, timeout_ms?}` | `{tab_id, url, title, status}` |
| `reload` | `{tab_id?, ignore_cache?, wait_until?, timeout_ms?}` | `{tab_id, url, title, status}` |
| `network_body` | `{request_id, max_bytes?}` | `{body, truncated, base64}` |
| `resize` | `{width, height, device_scale_factor?, mobile?, reset?, tab_id?}` | `{ok, width, height}` |
| `status` | `{}` | existing + `pending_dialog`, `inflight` |

`console`/`network` responses gain `next_since`. `list_tabs` output is unchanged
(additive `current: bool` is allowed).

---

## 5. Error codes to add

`DIALOG_NOT_OPEN`, `UPLOAD_DENIED`, `BODY_UNAVAILABLE`, `NO_HISTORY`,
`UNSUPPORTED` (e.g. resize on a dead tab). Each carries an actionable hint, same
shape as `daemon/src/error.rs` today.

---

## 6. Security notes (must land with Phase B)

- **Upload is exfiltration-capable.** Gate it with `options.permission:
  "browser_upload"` + `ctx.permission.assert({resources: paths})`, default
  `ask`. Validate absolute regular files, ≤ 8, no `..`; log basenames only.
- **Network bodies may contain tokens/PII.** Redact auth/cookie headers; do not
  log bodies; document that body reads are raw page data.
- **Dialog text is page-controlled.** Return it as data, never as instructions.
- **Auto-dismiss default** prevents a hostile page from wedging the tab; the
  explicit `browse_dialog` tool is the only way to accept.
- Existing invariants stay: uid generation, occlusion check, `TAB_FORBIDDEN`,
  scheme allowlist, `SO_PEERCRED`, 0700 socket dir.

---

## 7. Sequencing and estimates

| Phase | Deliverable | Days | Cumulative |
|---|---|---|---|
| A | Reload + guard | 0.5 | 0.5 |
| B | Interaction | 2 | 2.5 |
| C | Network depth | 1 | 3.5 |
| D | Tabs/nav/idle | 1 | 4.5 |
| E | Cleanup/docs | 0.5 | 5 |
| F | Tests | 1 | 6 |

P0 is Phase A alone: it turns the reported 7-tool plugin into the 11-tool surface
that already exists. Do not start B before A is verified, or the same stale-load
confusion recurs.

---

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Service restart interrupts the current TUI session | Run it when no agent turn is in flight; sessions persist in the server DB; `browserd` survives |
| 2 | Dialog events wedge CDP if unhandled | Subscribe at tab creation, auto-dismiss by default, explicit tool to accept |
| 3 | Upload becomes a file-exfiltration primitive | Permission gate + path validation + docs |
| 4 | Network bodies are large/evicted | Per-body tool, 16 KiB default, `BODY_UNAVAILABLE` instead of a failed list call |
| 5 | `networkidle` never settles (websockets/SSE) | Caller timeout wins; document the fallback |
| 6 | `chromey` lacks a convenience method | All planned calls exist as generated CDP params (`SetFileInputFilesParams`, `HandleJavaScriptDialogParams`, `GetNavigationHistoryParams`, `SetDeviceMetricsOverrideParams`, `GetResponseBodyParams`, `EventJavascriptDialogOpening`) — use `tab.exec(...)` |
| 7 | `since` semantics break old clients | Additive field; default `since` absent = current behavior |

---

## 9. Definition of done

- [ ] Host `search "browser"` shows the source surface (13 after A, 21 productive after B–D).
- [ ] The exact failing eval expression returns a value, not `SyntaxError`.
- [ ] Fixture E2E covers navigate → snapshot → hover → fill → select → upload →
      dialog accept → scroll → back → screenshot → network body.
- [ ] `cargo test`, `bun test` (25/25 → more), `tsc --noEmit`, smoke (~45 checks)
      all green, with raw output pasted into the PR/commit.
- [ ] `docs/security.md` exists; README tool table matches reality.
- [ ] No regression in ownership, `UID_STALE`, occlusion, or the URL allowlist.

---

## 10. Progress log — 2026-11-15

### Phase A — done

The stale module resolved itself: saving `plugin/src/index.ts` made the host
reload the plugin, and the tool catalog updated live (a new tool appeared
mid-session). A restart is therefore **not** required on this build; the
reload path is per-file-save. The `[browser] registered N: …` line now prints
the count, so a shortfall is visible in the log.

### Phase B — done (5 new tools)

| Tool | Method | Notes |
|---|---|---|
| `browse_hover` | `hover` | reuses the occlusion probe, dispatches `MouseMoved` only |
| `browse_select` | `select` | exactly one of `value` / `label` / `index`; sets `selectedIndex`, fires `input` + `change` |
| `browse_upload` | `upload` | `DOM.setFileInputFiles`; permission-gated; daemon re-validates paths |
| `browse_dialog` | `dialog` | `Page.handleJavaScriptDialog`; only reachable with `dialog_policy: "manual"` |
| `browse_scroll` | `scroll` | `scrollBy`/`scrollTo`; returns `scrollX`, `scrollY`, `at_bottom` |

Supporting changes:

- `Page.enable` + `Page.javascriptDialogOpening` are wired at tab setup. The
  default policy auto-dismisses `alert`/`confirm`/`prompt` and accepts
  `beforeunload`, so a page cannot wedge the tab.
- `eval` gained `timeout_ms` (default 30 s, cap 120 s) with a dedicated
  `EVAL_ERROR` rather than the generic `INTERNAL` timeout.
- `navigate` gained `dialog_policy`.
- New error codes `DIALOG_NOT_OPEN` and `UPLOAD_DENIED`, mirrored in
  `plugin/src/errors.ts` (otherwise `fromWire` would downgrade them to
  `INTERNAL`).

### Phase C2 — done (pulled forward)

`browse_console` / `browse_network` already advertised `since` but the daemon
ignored it — a lying API. Entries now carry a monotonic `seq`; `since` returns
the **oldest unread** entries and `next_since` advances only over what was
returned, so a polling loop cannot skip rows. `network` entries also carry
`request_id`, ready for `browse_network_body` (C3).

### Phase E — done

- E1: `ping` / `permission_probe` are behind `OPENCODE_BROWSER_DEBUG=1`.
  Verified live: both disappeared from the tool catalog on save.
- E2: `OPENCODE_BROWSERD_BIN` is exclusive; `bun test` is green.
- E3: `docs/security.md` written.

### Verification (raw)

```text
cargo test                  37 passed; 0 failed
cargo clippy --all-targets   Finished (no warnings)
cargo fmt --check            clean
bun test                    35 pass, 0 fail
bunx tsc --noEmit            exit 0
node scripts/smoke.mjs      54/54 checks passed
```

Smoke additions (23 new checks): hover fires `mouseenter`; select by label
lands in the DOM and a miss is a typed error; upload reaches the file input and
a relative path is `UPLOAD_DENIED`; scroll down/top report the right offsets;
manual-policy dialog accept resumes the page and a second accept is
`DIALOG_NOT_OPEN`; `since` returns the oldest unread entries and advances.

### Phase B fix — tool surface exposed (2026-11-15)

All 16 tools were registered (`ctx.tool.list()`) but only 6 reached the Code
Mode catalog. Root cause: the host ships a built-in `browser` namespace (45
tools: `tabs.*`, `snapshot`, `evaluate`, `click`, `fill`, `dialog`, `console`,
…); tool ids are `${namespace}_${name}`, so the 10 plugin tools whose names
collide with built-ins were shadowed. No permission rule was involved.

Fix: plugin namespace is now `browse`. Verified live — the host pushed
`browse (16 tools, 12 shown)` and removed `browser`. Tool names in this plan
are updated accordingly; permission actions stay `browser_eval` /
`browser_upload` (renaming those would break existing configs).

### Still open

D (tabs create/select, back/reload, real `networkidle`,
`status`), F (Rust integration tests behind `--ignored`).

### Phase C — done (2026-11-15)

- C1: `NetworkEntry` gains `kind` (already captured), `from_cache`,
  `encoded_bytes`, and redacted `request_headers` / `response_headers`
  (`authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`
  → `[redacted]`; 32 headers/direction, 512 chars/value). Logged at
  `DEBUG` only as counts — secret values never reach output or logs.
- C4: `browse_network` sends headers only with `include_headers: true`.
- C3: `browse_network_body` (`{request_id, max_bytes?}`, default 16 KiB, cap
  256 KiB, 10 s Chrome timeout) with `BODY_UNAVAILABLE` for evicted bodies.
  Base64 decoded, truncation is UTF-8 safe.
- Fixture: `scripts/fixture-server.mjs` (node) serves `/api/ping` JSON with a
  server-side `x-api-key` secret; the page sends its own `x-api-key` with the
  fetch. Smoke asserts both sides redact and no secret leaks into the payload.

### Verification (raw)

```text
cargo test                  43 passed; 0 failed
cargo clippy --all-targets   Finished (no warnings)
cargo fmt --check            clean
bun test                    40 pass, 0 fail (103 expect() calls)
bunx tsc --noEmit            exit 0
node scripts/smoke.mjs      61/61 checks passed (twice: fresh-network and from-cache states)
```
