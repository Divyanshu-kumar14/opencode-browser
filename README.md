# opencode-browser

Browser automation for OpenCode: a TypeScript shim plus a Rust CDP daemon that keeps **one shared Chromium** warm across sessions. Built for agents — token-efficient snapshots, session-scoped tabs, and a permission model that treats page content as data, never instructions.

**Status: v1 on Linux x64.** The full tool surface is implemented, the 61-check smoke suite passes, and CI is green (typecheck, tests, pack budget, end-to-end). macOS/Windows are post-v1.

## Why this exists

General-purpose automation (Playwright, raw CDP) optimizes for test authors. This plugin optimizes for an LLM driving a browser inside OpenCode:

- **Cheap to observe.** Snapshots are compact accessibility trees with stable `[uid]` references, so an agent reads the page in hundreds of tokens instead of dumping DOM.
- **Cheap to run.** One daemon-owned Chromium stays warm across sessions — no per-task browser launch.
- **Safe by construction.** Tabs are owned per session with leases, risky actions are permission-gated per page, and secrets are redacted at capture time, before they can reach a transcript.

## How it works

```text
agent → browse_* tools (shim, in OpenCode server)
          ↕ NDJSON over Unix socket ($XDG_RUNTIME_DIR/opencode-browser/v1/daemon.sock)
      browserd (Rust daemon, own process group)
          ↕ CDP
      one shared Chromium (daemon-owned profile, isolated from your real Chrome)
```

The shim (`plugin/`) translates tool calls into daemon RPCs. The daemon owns exactly one Chromium, multiplexes session tabs onto it (max 8, LRU, 10-minute leases), and survives OpenCode restarts. If the daemon ever dies, the shim respawns it on the next call.

## Quickstart

```jsonc
// opencode.jsonc
{ "$schema": "https://opencode.ai/config.json", "plugins": ["opencode-browser"] }
```

```sh
opencode run "navigate to http://127.0.0.1:8787, snapshot, and tell me what you see"
```

## Configuration

All options are optional; defaults shown.

| Option | Values | Default | Notes |
|---|---|---|---|
| `driver` | `"rust"` \| `"js"` | `"rust"` | `"js"` is an in-process raw-CDP baseline (also the daemon fallback); needs no binary |
| `mode` | `"launch"` \| `"attach"` | `"launch"` | `attach` connects to an existing debug-enabled Chrome; opt-in, never closes your tabs |
| `attach_url` | URL | `http://127.0.0.1:9222` | only used in `attach` mode |
| `profile` | `"fresh"` \| `"persistent"` \| `"<path>"` | `"fresh"` | `persistent` reuses cookies across runs (still isolated from your real Chrome) |
| `max_tabs` | 1–32 | `8` | hard cap; LRU evicts unowned/idle tabs first, never an actively-owned tab |
| `idle_timeout_s` | seconds | `1800` | daemon exits after 30 min with zero tabs |

## Tools

20 tools, all `codemode: true`. (The `browse_` prefix comes from the plugin namespace — the host reserves `browser` for its built-in desktop tools, and a colliding tool id is silently dropped.)

| Tool | What it does | Returns |
|---|---|---|
| `browse_navigate` | go to a URL in your session tab | `{tab_id, url, title, status}` |
| `browse_snapshot` | compact accessibility snapshot with `[uid]` refs | text tree, `max_nodes` default 300 |
| `browse_click` | real mouse click at the element center (occlusion-checked, auto-waits) | `{ok}` |
| `browse_fill` | focus + real key events (works with React/Vue) | `{ok}` |
| `browse_hover` | move the mouse over a uid (menu/hover states) | `{ok, x, y}` |
| `browse_select` | pick a `<select>` option by value, label or index | `{value, label, index}` |
| `browse_upload` | attach local files to a file input (**permission-gated**) | `{files}` |
| `browse_dialog` | accept/dismiss a JS dialog (after `dialog_policy: manual`) | `{action, dialog}` |
| `browse_scroll` | scroll up/down/left/right/top/bottom | `{scrollX, scrollY, at_bottom}` |
| `browse_press_key` | key press, optionally into a uid | `{ok}` |
| `browse_eval` | run JS in the page (**permission-gated**, see below) | `{value}` |
| `browse_screenshot` | PNG capture | file attachment + `{path}` |
| `browse_console` | recent console messages (ring buffer, 500/tab) | `{messages, next_since}` |
| `browse_network` | recent requests (ring buffer, 500/tab) | `{requests, next_since}` |
| `browse_network_body` | one response body by `request_id` | `{body, bytes, truncated}` |
| `browse_route` | mock a URL pattern: fulfill with a fixture or abort it | `{pattern, action, routes}` |
| `browse_wait_for_uid` | wait for a `[uid]` to appear (bounded poll) | `{found, elapsed_ms}` or `NAV_TIMEOUT` |
| `browse_expect_text` | wait for a page-text substring (bounded poll, plain match) | `{matched, elapsed_ms}` or `NAV_TIMEOUT` |
| `browse_list_tabs` / `browse_close_tab` | inspect / close tabs (yours only) | `{tabs}` / `{closed}` |

### Reading logs without missing rows

`browse_console` / `browse_network` accept `since` (the previous response's `next_since`) and return only newer entries, so a polling loop cannot skip rows. `browse_network` includes redacted request/response headers only with `include_headers: true`. `browse_network_body` reads one body (default 16 KiB, cap 256 KiB) and reports `BODY_UNAVAILABLE` once Chrome has evicted it.

### Deterministic mocks

`browse_route` binds one literal URL pattern (`substring` default, `prefix`, or bare `host`) to `fulfill` or `abort` on your session tab, so agent tests don't depend on the network. Patterns are capped at 512 chars and matched literally — never a regex. A fulfilled mock answers with exactly one header (`content-type`); request headers and their secrets are never reflected. Mocks are session-scoped and die with the tab; unmatched requests pass through untouched.

### Bounded waits

`browse_wait_for_uid` polls (every 150 ms) until the element carrying the uid exists; `browse_expect_text` polls until the visible text contains the substring (plain case-sensitive match — never a regex). Both take `timeout_ms` (default 5 s, clamp 100 ms–30 s) and never hold the per-tab lock across sleeps, so a long wait cannot wedge the tab. Success reports elapsed time; a blown deadline is a typed `NAV_TIMEOUT` naming the condition and the budget.

### Identity rules

- **Stale uids fail safe.** Every uid encodes its navigation generation (`g7-3`). Using one after the page changed returns `UID_STALE` — and the shim retries once automatically (re-snapshot, re-resolve by role+name, retry exactly once) before surfacing the original error.
- **Tabs are yours alone.** Driving another session's tab returns `TAB_FORBIDDEN`.
- **Permissions are per page.** `browse_eval` calls `ctx.permission.assert({sessionID, action: "browser_eval", resources: [url]})`, so allow/deny follows the session's rules with a UI prompt — no bypass via hook input rewriting. `browse_upload` uses the same gate with the file paths as resources.
- **Dialogs default to safe.** `navigate` uses `dialog_policy: "auto"`, which dismisses `alert`/`confirm`/`prompt` and accepts `beforeunload` so a page can never wedge the tab. Pass `"manual"` and call `browse_dialog` to drive one explicitly.

## Security (summary)

- **Socket:** `$XDG_RUNTIME_DIR/opencode-browser/v1/` (mode `0700`), `daemon.sock` (mode `0600`), `SO_PEERCRED` uid check — another local user cannot connect, even on a shared host.
- **Navigation allowlist:** `http`, `https`, `about`; `file:` only with explicit opt-in; `javascript:` rejected, with re-check after redirects.
- **Eval:** permission-gated per session (see above); attach mode is opt-in and tags only daemon-owned targets.
- **Upload:** permission-gated with the file paths as resources; the daemon re-validates every path (absolute, regular file, no `..`, no symlinks, ≤8 files / 100 MiB) so a hostile client cannot bypass the shim.
- **Logs:** query strings/fragments are redacted from stored URLs; credential-bearing headers are redacted at capture; upload errors name basenames only.
- **Not protected:** a page you navigate to can still attack the browser itself (standard CDP caveat); the daemon does not sandbox web content.

Full notes: [`docs/security.md`](docs/security.md), [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md).

## Development

```sh
cargo test --manifest-path daemon/Cargo.toml   # Rust unit tests
cargo fmt --check --manifest-path daemon/Cargo.toml
cargo clippy --manifest-path daemon/Cargo.toml --all-targets -- -D warnings
cd plugin && ./node_modules/.bin/tsc --noEmit && bun test   # shim
node scripts/smoke.mjs                          # 61-check end-to-end vs real Chrome
```

CI runs all of the above plus a pack-size budget and the smoke suite as e2e. The merge bar is green trio + 61/61 smoke; performance claims require same-conditions before/after numbers, never estimates.

## Benchmarks

Baselines on the same machine/Chrome/fixture: **A** = raw-CDP JS driver in-process, **B** = Rust daemon. Workload: 1/4/8 sessions × 20 calls, 3 runs. Metrics: cold first call, warm p50/p95 per method, idle/marginal/total-tree RSS, collisions.

> **Pre-registered kill rule:** if Rust shows **<20% improvement** in marginal memory per session **and** **<20%** in warm-call p95 vs baseline A, the daemon does **not** become the default — the JS driver ships instead.

Run it: `node scripts/bench.mjs --mock` (no Chrome) or `node scripts/bench.mjs --driver js` (real Chrome); `--compare <other-results.json>` evaluates the rule. Decision memo: [`bench/results/report.md`](bench/results/report.md).

## Packaging

`node scripts/build-native.mjs` builds `browserd --release`, strips it, and stages `prebuilds/linux-x64/browserd` (mode `755`). The npm tarball ships `plugin/ + prebuilds/ + README.md` **inside** the package (no postinstall download for v1). **Size budget: ≤20 MB compressed**, enforced by CI (`pack-smoke` fails the build over budget).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `DAEMON_UNAVAILABLE` / empty reply | Is it running? `ss -x \| grep opencode-browser`. If dead, the shim respawns it on next call (≤2 s backoff) |
| `PROTOCOL_MISMATCH` | Shim/daemon version skew. The socket path embeds the protocol major (`.../v1/`), so kill the stale daemon (below) and retry |
| `CHROME_DEAD` | Chrome crashed; the daemon relaunches once automatically — just retry. Persistent? Run `google-chrome --headless=new about:blank` by hand |
| `UID_STALE` / `UID_NOT_FOUND` | Page changed since the snapshot. The shim already retried once; re-run `browse_snapshot` and use the new uids |
| `NAV_TIMEOUT` | Condition not met within budget. Retry with a larger `timeout_ms`, or snapshot what rendered |
| `TAB_FORBIDDEN` | That tab belongs to another session. Navigate in your own session instead |
| Need the socket path | `${XDG_RUNTIME_DIR:-/tmp/opencode-browser-$UID}/opencode-browser/v1/daemon.sock` (see `daemon/src/paths.rs`) |
| Kill the daemon | `pkill -x browserd`, or send `{"id":1,"method":"shutdown","params":{}}` on the socket. Tabs die with it; Chrome's profile dir is removed |

## Compatibility

- OS/CPU: `linux` / `x64` (v1). macOS/Windows are post-v1.
- Runtimes: Node ≥22 or Bun ≥1 (shim + bench scripts).
- OpenCode: V2 plugin API (`@opencode/plugin` 2.x).
- Protocol: major version in the socket path (`v1/`); mismatched shims refuse to talk to old daemons instead of misbehaving.
