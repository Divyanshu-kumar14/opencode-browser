# Implementation Plan — `opencode-browser` (Rust CDP daemon + OpenCode V2 shim)

**Status:** Draft v1 — Nov 15 2026
**Input:** PRD "Rust-Native Browser Automation Plugin for OpenCode (v2)", Draft v0.1
**Target:** OpenCode V2 plugin API, Linux x86_64 v1

---

## 0. Verified baseline (not assumptions)

| Item | Verified value | How |
|---|---|---|
| Installed OpenCode | **v2.2.7** (`opencode` → `opencode2` binary) | `opencode --version` |
| V2 plugin API | `Plugin.define({id, setup(ctx)})` from `@opencode/plugin` **2.3.0** | npm tarball `.d.ts` read |
| Tool registration | `ctx.tool.transform(editor => editor.add(...))` (not `ctx.tool.add`) | `dist/promise/tool.d.ts` |
| Hooks | `ctx.tool.hook("execute.before"\|"execute.after", cb)` — **inspect/replace input only, cannot deny** | `dist/promise/tool.d.ts` |
| Permission gate | `Tool.Options.permission` + `ctx.permission.assert({sessionID, action, resources})` → prompts/denies | `dist/permission.d.ts` |
| Session id for ownership | `Tool.Context.sessionID` available to every executor | `@opencode/schema/tool.d.ts` |
| Cancellation | `ToolContext.signal: AbortSignal` (cooperative stop) | `dist/promise/tool.d.ts` |
| Screenshot return | `Result.content: {type:"file", uri, mime, name}[]` — real attachment, no base64 in text | `@opencode/schema/tool.d.ts` |
| Chrome | Chromium **157.0.8103.38** at `/usr/bin/chromium` + `google-chrome` | `--version` |
| Runtime dir | `XDG_RUNTIME_DIR=/run/user/1000`, mode `0700` | `ls -ld` |
| Host | 16 cores, 15 GiB RAM, ulimit -n 524288 | `nproc`, `free` |
| Rust | 1.99.1 | `rustc --version` |

---

## 1. Verdict on the PRD

**Build it — with four corrections.** The PRD's own risk analysis is right that the value claim is the weak point. Two of its assumptions need updating against the actual V2 runtime, and one design element is now available natively that the PRD assumed had to be hand-built.

### C1 — The "per-session JS process" premise is outdated (material)
In V2, plugins run inside a **single long-lived background server** (`opencode service`), not one process per session. So the JS shim is already amortized, and the marginal cost of a second OpenCode session is *already* near zero on the JS side.

Consequence: the honest baseline is **an in-process JS shim holding a warm CDP WebSocket**, not "Puppeteer per call". The Rust daemon's remaining defensible wins are narrower:

1. **Survives server restarts / version upgrades** — Chrome and its tabs stay warm across `opencode service restart`.
2. **Shared across multiple servers/projects** — one Chrome for N server instances, not one per instance.
3. **Isolation from the Bun event loop** — CDP JSON parsing, AX-tree joins, and screenshot encoding don't compete with agent/LLM I/O.
4. **Compiled, pinned CDP client** — no dependency drift from npm supply chain.

These are real but must be *measured* against baseline (C1) or the M3 kill gate will (correctly) fail.

### C2 — `execute.before` cannot deny; use the permission domain instead (fix)
PRD §10 proposes gating `browser_eval` through `ctx.tool.hook("execute.before")`. The hook event type exposes only mutable `input` — there is no deny/abort field. The native mechanism is:

```ts
// registration
options: { permission: "browser_eval" }
// inside the eval executor
await ctx.permission.assert({ sessionID: context.sessionID, action: "browser_eval", resources: [url] })
```

`assert` evaluates the session's permission rules, prompts the user when the rule is `ask`, and rejects on deny. This is *better* than the PRD design: user-configurable, per-session, with a UI prompt, and it composes with agent-level permissions.

### C3 — `chromiumoxide` is stale; `chromey` is a drop-in fork (change)
| Crate | Latest | Last push | Stars | Note |
|---|---|---|---|---|
| chromiumoxide | 0.9.1 | 2026-04-03 | 1.4k | 62 open issues, 7 months quiet |
| chromey | 2.58.2 | 2026-10-18 | 52 | **Same module paths/API** (`chromiumoxide::browser::Browser`), SIMD parsing, concurrency features |
| chaser-oxide | 0.2.4 | 2026-04-20 | — | Stealth — out of scope per PRD §4 |

Decision: code against the **chromiumoxide-shaped API** through a thin `cdp` module, compile against **chromey pinned to an exact version**, keep `chromiumoxide` as a one-line fallback. Both are swappable because the fork preserves the API. M0 validates with an acceptance test rather than a guess.

### C4 — Attach mode is v1, not deferred (change)
PRD §12 lists "reuse my real logged-in Chrome" as a blind spot but leaves it out of milestones. Auth-gated localhost testing is a primary use case (UC1), so attach-to-existing-debug-Chrome moves into **Phase 4 (M2.5)**, opt-in, default off.

### Minor corrections
- **"OpenCode2" naming:** resolved — installed v2.2.7 uses the V2 plugin API (`opencode2` binary). No separate product.
- **Tool names:** use `editor.namespace({name:"browser"})`; effective names become `browser_navigate` etc., matching the PRD and the ecosystem. Don't hand-prefix names.
- **Screenshots:** return `{type:"file"}` content, not a path string. Path also goes in `metadata` for agents that want it.
- **`codemode: true`** on tools makes them callable from Code Mode sessions (like this one) at no extra cost.

---

## 2. Final architecture

```
┌─────────────────────────────┐
│ OpenCode V2 server (Bun)    │  long-lived, one per user
│  ┌───────────────────────┐  │
│  │ plugin "browser"      │  │  ~200 LOC TS: schema + socket I/O only
│  │ ctx.tool.transform    │  │  no CDP logic
│  │ ctx.permission.assert │  │
│  └───────────┬───────────┘  │
└──────────────┼──────────────┘
               │ NDJSON over Unix socket (0700 dir, SO_PEERCRED)
               │ $XDG_RUNTIME_DIR/opencode-browser/v1/daemon.sock
┌──────────────▼──────────────┐
│ browserd (Rust, tokio)      │  one per machine/user; survives server restarts
│  rpc · tabs · snapshot      │  idle RSS target <20MB
│  capture · bench            │
└──────────────┬──────────────┘
               │ CDP (pipe if available, else 127.0.0.1 random port)
┌──────────────▼──────────────┐
│ Chromium (shared, 1 process)│  1 process · N tabs · fresh profile by default
└─────────────────────────────┘
```

**Non-negotiable invariant:** one Chrome process, many targets. Per-session Chrome processes would make every memory claim false regardless of language.

### 2.1 Repo layout

```
rustBrowse1x/
├─ opencode.jsonc                  # dev config: { "plugins": ["./plugin"] }
├─ package.json                    # published npm package (shim + prebuilds/)
├─ plugin/                         # TypeScript shim (server part)
│  ├─ package.json                 # name, type:module, exports "." -> ./src/index.ts
│  ├─ src/index.ts                 # Plugin.define + tool registration
│  ├─ src/rpc.ts                   # NDJSON client: ids, timeouts, AbortSignal
│  ├─ src/supervisor.ts            # spawn/handshake/version/binary resolution
│  ├─ src/tools.ts                 # schemas + result mapping + error mapping
│  ├─ src/driver/js.ts             # raw-WS CDP baseline (M3, also fallback)
│  └─ test/*.test.ts               # bun test against a mock daemon
├─ daemon/                         # Rust crate `browserd`
│  ├─ Cargo.toml                   # pinned chromey; tokio, serde, fs2, libc
│  └─ src/{main,rpc,browser,tabs,snapshot,actions,capture,bench,cdp}.rs
├─ scripts/{smoke.mjs,build-native.mjs,fixture.html}
├─ prebuilds/linux-x64/browserd     # release, stripped
└─ docs/{IMPLEMENTATION-PLAN.md,api-notes.md,security.md}
```

Shim ships as TS source (`exports: "./src/index.ts"`), matching the official docs example — no build step, Bun transpiles.

### 2.2 Wire protocol

Framing: **NDJSON** (one JSON object per line). Safe because JSON escapes embedded newlines; debuggable with `socat`/`nc`. Cap frame at 32 MiB.

```jsonc
// request
{ "id": "01J...", "method": "navigate", "params": {...}, "session": "ses_..." }
// response
{ "id": "01J...", "ok": true,  "result": {...} }
{ "id": "01J...", "ok": false, "error": { "code": "UID_STALE", "message": "...", "hint": "..." } }
```

| Method | Params | Result |
|---|---|---|
| `hello` | `{protocol, shimVersion}` | `{protocol, daemonVersion, chrome:{version,pid}, capabilities}` |
| `navigate` | `{url, tab_id?, wait_until?, timeout_ms?}` | `{tab_id, url, title, status}` |
| `snapshot` | `{tab_id?, max_nodes?, include_ax?}` | `{tab_id, url, text, nodes, truncated}` |
| `click` | `{uid, button?, click_count?}` | `{ok, url?}` |
| `fill` | `{uid, value, submit?}` | `{ok}` |
| `press_key` | `{key, uid?}` | `{ok}` |
| `eval` | `{js, tab_id?, await_promise?}` | `{value, truncated}` |
| `screenshot` | `{tab_id?, full_page?}` | `{path, width, height}` |
| `console` | `{tab_id?, limit?, level?}` | `{messages:[{level,text,ts}]}` |
| `network` | `{tab_id?, limit?, filter?}` | `{requests:[{method,url,status,ms,type}]}` |
| `list_tabs` | `{}` | `{tabs:[{tab_id,url,title,owner,last_used}]}` |
| `close_tab` | `{tab_id}` | `{closed}` |
| `status` | `{}` | `{tabs, sessions, rss_mb, chrome_alive}` |
| `shutdown` | `{force?}` | `{}` |
| `bench` | `{sessions, calls}` | `{...}` |

$XDG_RUNTIME_DIR/opencode-browser/`**v1**`/` — protocol major in the path, so a shim upgrade can never talk to an old daemon (no version-skew bug class).

### 2.3 Tab ownership and leases

- `session_id` comes from `Tool.Context.sessionID` — reliable, no extra plumbing.
- Daemon map: `session → tab_id`; each tab has `owner: Option<SessionId>`, `last_used`, `generation: u64`, `uid_map`.
- Tab created lazily on first call needing a tab (idle sessions cost **zero** tabs).
- Lease TTL 10 min of inactivity → tab closed, owner released. Max 8 tabs (configurable); LRU evicts unowned/idle first, never an actively-owned tab.
- Per-tab `tokio::sync::Mutex` serializes snapshot/click/fill; different tabs run in parallel.
- `close_tab` on a tab you don't own → `TAB_FORBIDDEN` (explicit collision signal, not silent takeover).

### 2.4 Snapshot algorithm (the quality-critical piece)

Three CDP round trips, no per-element calls:

1. **Inject JS** (`Runtime.evaluate`): candidates = interactive elements + landmark/text nodes; assign `data-oc-uid="g{gen}-{n}"`, capture `{uid, bounds, tag, type, value, checked, disabled, href, placeholder}`. Bounds are viewport-relative after `scrollIntoView`.
2. **`DOM.getDocument(depth:-1)`**: walk attributes to build `backendNodeId → uid` (1 call, no per-node queries).
3. **`Accessibility.getFullAXTree`**: drop `ignored` nodes, join `backendDOMNodeId → uid`, attach role/name/state.

Output is compact, token-efficient text (what the model actually reads):

```
url: http://localhost:5173/login  (gen g7)
[g7-1] textbox "Email" value=""
[g7-2] textbox "Password" type=password
[g7-3] button "Sign in"
[g7-4] link "Forgot password" → /forgot
… 12 more (max_nodes=300, truncated)
```

- Fallback if the AX join misses: heuristic role from tag/`role` attribute (never fail the snapshot).
- `uid` encodes the navigation generation → clicking an element from a stale snapshot returns `UID_STALE` ("page changed; re-run browser_snapshot") instead of clicking the wrong node.
- Click = `Input.dispatchMouseEvent` at element center (real events; works with React/Vue handlers), guarded by `document.elementFromPoint` occlusion check → `ELEMENT_OCCLUDED` with the intercepting element named.
- Fill = focus + select-all in JS, then `Input.insertText` (generates real input events; no React value-setter hacks).
- `select` = JS set value + dispatch `change`.

### 2.5 Error taxonomy (shim maps to `Tool.Error`)

`DAEMON_UNAVAILABLE`, `PROTOCOL_MISMATCH`, `CHROME_DEAD`, `NAV_FAILED`, `NAV_TIMEOUT`, `TAB_NOT_FOUND`, `TAB_FORBIDDEN`, `TAB_LIMIT`, `UID_NOT_FOUND`, `UID_STALE`, `ELEMENT_OCCLUDED`, `EVAL_ERROR`, `PERMISSION_DENIED`, `INTERNAL`.

Every error carries a `hint` the model can act on. Never a bare "socket error".

---

## 3. Phase plan

Estimates assume one developer, Linux, Chrome present. 15.5 dev-days total (~3 calendar weeks part-time).

### Phase 0 — API conformance spike · 0.5 day

**Goal:** prove the V2 plugin contract on the *installed* 2.2.7 before writing any Rust. Kills the "wrong API shape" risk for ~$0.

Tasks
- [ ] `plugin/package.json`: `{name:"opencode-browser", type:"module", exports:{".":"./src/index.ts"}, dependencies:{"@opencode/plugin":"2.3.0"}}` (verify compatibility with server 2.2.7; fall back to the matching 2.2.x if any).
- [ ] `plugin/src/index.ts`: `Plugin.define({id:"browser", setup})`, register `browser_ping` via `ctx.tool.transform(editor => { editor.namespace({name:"browser", ...}); editor.add({...}) })`.
- [ ] `opencode.jsonc`: `{"$schema":"https://opencode.ai/config.json","plugins":["./plugin"]}`.
- [ ] Confirm E2E: `opencode run "call browser_ping with value ok and report the exact output"`.
- [ ] Log `context.sessionID` + `context.signal` presence to stderr; confirm tool name is `browser_ping` in `ctx.tool.list()`.
- [ ] Add a second throwaway tool with `options:{permission:"browser_eval"}`; confirm `ctx.permission.assert` produces a UI prompt and rejects on deny.
- [ ] Record findings in `docs/api-notes.md`.

**Gate A0:** tool callable from a real session; permission prompt observed; zero unresolved API surprises.
**Verify:** `opencode run ...` transcript pasted into `docs/api-notes.md`.

> If Phase 0 fails, the whole design changes (e.g. MCP server instead of plugin). One hour of proof beats three days of Rust.

---

### Phase 1 — M0: daemon core · 3 days

**Goal:** PRD's M0 — Chrome + socket + navigate/snapshot/screenshot, driven by a hand-rolled client, no OpenCode involved.

Tasks
- [ ] `cargo new daemon --name browserd`; deps: `tokio`, `serde/serde_json`, `chromey` (exact pin), `clap`, `tracing`, `fs2`, `libc`, `anyhow`.
- [ ] **Socket server**: create `$XDG_RUNTIME_DIR/opencode-browser/v1/` (0700) → bind `daemon.sock` (0600); `SO_PEERCRED` uid check on accept; NDJSON codec; per-request `tokio::spawn`; graceful SIGTERM/SIGINT.
- [ ] **Single instance**: `flock` on `daemon.lock`; loser probes the socket, exits 0 if healthy.
- [ ] **Chrome launcher**: resolve `CHROME_PATH` → `google-chrome` → `chromium` → `chromium-browser`; args: `--headless=new --disable-gpu --no-first-run --no-default-browser-check --disable-background-networking --disable-sync --disable-extensions --mute-audio --hide-scrollbars --window-size=1280,800 --user-data-dir=<fresh tmp>`; no stealth flags.
- [ ] **Supervision**: event-pump task; detect target/process death; one automatic relaunch with backoff; stale tabs invalidated.
- [ ] **Tabs**: create target, registry, per-tab mutex, generation counter.
- [ ] **Methods**: `hello`, `status`, `navigate`, `snapshot` (full 3-call algorithm, §2.4), `screenshot`, `eval`, `shutdown`.
- [ ] **Transport**: decide pipe vs port — test `chromey` for pipe support in a 30-min spike; if unavailable, bind `--remote-debugging-port=0`, read `DevToolsActivePort`, document the residual local-port risk in `docs/security.md`.
- [ ] `scripts/smoke.mjs`: hello → navigate → snapshot → click a uid → screenshot → eval → assert all.
- [ ] `browserd bench --sessions N --calls M` stub reporting RSS.

**Gate A1:** `node scripts/smoke.mjs` green; snapshot p50 ≤150 ms on `example.com`; daemon idle RSS <20 MB; screenshot is a valid PNG; killing Chrome mid-call yields `CHROME_DEAD` + one clean relaunch.

---

### Phase 2 — M1: shim end-to-end · 2 days

**Goal:** PRD's M1 — three tools working through a real OpenCode session.

Tasks
- [ ] `plugin/src/rpc.ts`: NDJSON client over `node:net`; request ids; 30 s default timeout; `AbortSignal` → best-effort `cancel` notification.
- [ ] `plugin/src/supervisor.ts`: connect → if `ENOENT`/`ECONNREFUSED`, spawn `prebuilds/linux-x64/browserd` detached (`stdio:ignore`), retry with backoff ≤2 s; handshake; on `PROTOCOL_MISMATCH` refuse with an actionable error. Do **not** kill the daemon on plugin unload.
- [ ] `plugin/src/tools.ts`: `browser_navigate`, `browser_snapshot`, `browser_screenshot`; JSON-Schema inputs; `options:{codemode:true}`.
- [ ] Result mapping: snapshot → text; screenshot → `{content:[{type:"file", uri, mime:"image/png", name}], metadata:{path}}`.
- [ ] Error mapping → `Tool.Error` with hints.
- [ ] `scripts/fixture.html` + `python3 -m http.server 8787` for a deterministic test page.

**Gate A2:** a single `opencode run` instruction (no manual steps) navigates to the fixture, snapshots, screenshots; image renders in the transcript; second call in the same session reuses the same tab (verify via `browser_list_tabs` after Phase 3, or `status` here).

---

### Phase 3 — M2: full tool surface · 4 days

**Goal:** PRD's M2 — all tools, ownership, cleanup.

Tasks
- [ ] `browser_click`, `browser_fill`, `browser_press_key` (real input events, occlusion check).
- [ ] `browser_eval` with permission gate: `options:{permission:"browser_eval"}` + `ctx.permission.assert({sessionID, action:"browser_eval", resources:[url]})`.
- [ ] `browser_console` / `browser_network`: enable `Runtime`/`Log`/`Network` per tab at creation; bounded ring buffers (500 entries/tab, ~0.5 MB); monotonic `since` cursor.
- [ ] `browser_list_tabs` / `browser_close_tab` with ownership enforcement (`TAB_FORBIDDEN`).
- [ ] Lease/TTL/LRU/max-tabs per §2.3; idle daemon shutdown (30 min, zero tabs, configurable).
- [ ] `uid` generation + `UID_STALE`; snapshot truncation marker; `max_nodes` default 300.
- [ ] Chaos test: 8 sessions × 20 calls interleaved; assert zero cross-session tab access; assert 30-min soak RSS drift <10%.
- [ ] Unit tests: uid map, LRU, protocol codec, error mapping.

**Gate A3:** all 10 tools green; chaos test zero collisions; soak clean.

---

### Phase 4 — M2.5: attach mode + security · 2 days

**Goal:** close the PRD's "logged-in profile" blind spot and finish the hardening checklist.

Tasks
- [ ] Config (plugin options): `{driver:"rust"|"js", mode:"launch"|"attach", attach_url:"http://127.0.0.1:9222", profile:"fresh"|"persistent"|"<path>", max_tabs, idle_timeout_s}`.
- [ ] Attach: discover via `/json/version`, connect, **create** our own targets; never close user tabs; tag owned targets so restart cleanup can't hit user tabs.
- [ ] Persistent profile option (documented: cookies across runs; still separate from the user's real Chrome).
- [ ] Navigate scheme allowlist (`http`, `https`, `about`; `file:` only with `allow_file:true`; reject `javascript:`).
- [ ] Socket hardening: 0700 dir, 0600 socket, peercred uid check, reject non-owner.
- [ ] Log redaction: strip query strings/fragments from URLs in logs by default.
- [ ] `docs/security.md`: eval risk, attach-mode risk, profile isolation, socket model, what is *not* protected.

**Gate A4:** attach to a real debug-enabled Chrome (`--remote-debugging-port=9222`) works against an auth'd localhost app; eval denied without approval; another UID cannot connect (`socat` test).

---

### Phase 5 — M3: benchmark + kill gate · 2 days

**Goal:** PRD §8/§13/§14 — the go/no-go decision, with numbers published before any claim.

Baselines (same machine, same Chrome, same fixture)
- **A:** `plugin/src/driver/js.ts` — raw CDP WebSocket in-process (the *real* baseline; **not** Puppeteer).
- **B:** Rust daemon.

Workload: 1 / 4 / 8 concurrent sessions × 20 calls (`navigate → snapshot → click → fill → screenshot`), 3 runs, discard first (cold).

Metrics
| Metric | Method |
|---|---|
| Cold first call (daemon+Chrome) | wall clock, first ever call |
| Warm call p50/p95 | per-method timings |
| Daemon idle RSS | `/proc/<pid>/status` VmRSS |
| Marginal RSS / session | RSS(8 sessions) − RSS(1 session), Chrome tree by ppid |
| Total RSS (daemon + Chrome) | process tree sum, sampled @1 Hz |
| Cross-session collisions | chaos run counter |
| 30-min RSS drift | soak |

**Pre-registered kill rule (written before measuring):**
> If Rust shows **<20 % improvement** in marginal memory per session **and** **<20 %** in warm-call p95 versus baseline A, do **not** ship the daemon as the default. Ship the JS driver, and contribute pooling to `different-ai/opencode-browser` instead (PRD §14).

Deliverable: `bench/results/report.md` + `results.json` + a one-page decision memo. No "faster/lighter" wording in any README before this exists.

---

### Phase 6 — M4: packaging & release · 2 days

Tasks
- [ ] `scripts/build-native.mjs`: `cargo build --release`, `strip`, copy to `prebuilds/linux-x64/browserd`, `chmod 755`.
- [ ] `package.json`: `files:["plugin","prebuilds","README.md"]`, `exports`, `engines`, `os:["linux"]`, `cpu:["x64"]`.
- [ ] Distribution choice: ship the binary **inside** the package for v1 (simplest, no postinstall network). Defer per-platform `optionalDependencies` to v1.1 — revisit only when macOS/Windows are added.
- [ ] Size budget: package ≤20 MB compressed; fail CI if exceeded.
- [ ] README: quickstart (`plugins:["opencode-browser"]`), config table, security notes, tool reference, troubleshooting (`status`, where the socket lives, how to kill the daemon).
- [ ] CI: `cargo fmt --check`, `clippy -D warnings`, `cargo test`, `bun test`, `npm pack` smoke, E2E job with `opencode run`.
- [ ] Versioning: shim semver, `protocol:1` in the socket path, compatibility matrix in README.

**Gate A6:** clean-machine simulation — `npm pack`, install into a scratch project, one `opencode run` flow works with no manual binary placement.

---

### Phase 7 — Post-v1 (unscheduled, explicit non-goals for now)
macOS/Windows builds · CDP pipe transport · multi-Chrome pool · HAR/trace export · video capture · network mocking · cross-origin iframe support.

---

## 4. Test strategy

| Layer | Tool | Covered |
|---|---|---|
| Rust unit | `cargo test` | protocol codec, uid map, LRU/TTL, error mapping, scheme allowlist |
| Rust integration | `cargo test -- --ignored` (real Chrome) | launch, navigate, snapshot, click/fill, crash/relaunch |
| Shim unit | `bun test` | rpc framing/reconnect/abort, supervisor spawn races, result mapping |
| E2E | `opencode run` script | one happy path per phase; full surface from A3 |
| Chaos | script | 8 sessions, kill Chrome, kill daemon, socket denied by uid |
| Perf | `browserd bench` | gates A1 and A5 |

Every phase gate requires pasted raw output, not "should work".

---

## 5. Risk register

| # | Risk | L/I | Mitigation | Trigger |
|---|---|---|---|---|
| R1 | Rust advantage is marginal vs warm in-process JS | H/**Fatal** | Phase 5 pre-registered kill rule; JS driver kept as selectable backend | <20 % on both axes |
| R2 | Chrome dominates memory (60–150 MB/tab) | H/High | One Chrome, N tabs; publish honest numbers; never market as "low memory" | — |
| R3 | `chromey` young / API churn | M/Med | Exact pin; thin `cdp` adapter; chromiumoxide fallback (same API) | API break on upgrade |
| R4 | CDP pipe unsupported by crate | M/Low | Random localhost port + DevToolsActivePort; document residual risk | Phase 1 spike |
| R5 | Attach mode leaks user sessions to agent eval | M/High | Opt-in only, loud docs, permission gate, never close user tabs | — |
| R6 | Snapshot uids go stale / wrong element clicked | H/Med | Generation in uid → `UID_STALE`; occlusion check; re-snapshot hint | Misclick report |
| R7 | Packaging: binary missing/not executable | M/Med | `supervisor` preflight + actionable error; CI clean-install test | — |
| R8 | V2 API drift (2.2.7 installed vs 2.3.0 SDK) | M/Med | Phase 0 conformance test; pin to server minor | Type/runtime mismatch |
| R9 | Long-running daemon leaks | M/Med | 30-min soak in A3; bounded buffers; idle shutdown | RSS drift >10 % |

---

## 6. Timeline

| Phase | Deliverable | Days | Cumulative |
|---|---|---|---|
| 0 | API proof | 0.5 | 0.5 |
| 1 | M0 daemon core | 3 | 3.5 |
| 2 | M1 E2E | 2 | 5.5 |
| 3 | M2 full surface | 4 | 9.5 |
| 4 | M2.5 attach + security | 2 | 11.5 |
| 5 | M3 bench + go/no-go | 2 | 13.5 |
| 6 | M4 packaging | 2 | 15.5 |

Calendar: ~3 weeks at 5–6 h/day, or ~2 weeks full-time.

---

## 7. Decisions to confirm before Phase 1

1. **npm name** — `opencode-browser` is likely taken; prefer a scope (`@<you>/opencode-browser`) to avoid a squatting conflict. *Recommend: scoped.*
2. **Ship the JS driver as a selectable backend** (`driver:"js"`), or keep it benchmark-only? *Recommend: ship it — it removes the native-binary failure mode and keeps the benchmark honest.*
3. **Attach mode default** — off, per-project opt-in. *Recommend: off.*
4. **Profile default** — fresh per Chrome launch. *Recommend: fresh; `persistent` opt-in for repeated auth'd testing.*
