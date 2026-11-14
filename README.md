# opencode-browser

Browser automation for OpenCode: a TypeScript shim plus a Rust CDP daemon that
keeps **one shared Chromium** warm across sessions. Linux x86_64 only for v1.

> **Status: pre-release.** The daemon core (M0) and the full `browser_*` tool
> surface (M2) are under construction. No "faster/lighter" performance claim
> in this file is backed by measurement yet — see
> [`bench/results/report.md`](bench/results/report.md) (M3) before quoting any
> number. The raw-WS JS baseline driver
> (`plugin/src/driver/js.ts`, selectable via `driver: "js"`) already runs the
> full bench workload against real Chrome.

## Quickstart

```jsonc
// opencode.jsonc
{ "$schema": "https://opencode.ai/config.json", "plugins": ["opencode-browser"] }
```

```sh
opencode run "navigate to http://127.0.0.1:8787, snapshot, and tell me what you see"
```

How it works: the shim (`plugin/`, runs inside the OpenCode server) talks
NDJSON over a Unix socket to `browserd` (the Rust daemon), which drives one
Chromium via CDP. The daemon survives server restarts; tabs are owned per
OpenCode session with a 10-minute lease (max 8 tabs, LRU).

## Config

Plugin options (all optional; defaults shown):

| Option | Values | Default | Notes |
|---|---|---|---|
| `driver` | `"rust"` \| `"js"` | `"rust"` | `"js"` = in-process raw-CDP baseline (also the daemon fallback); no binary needed |
| `mode` | `"launch"` \| `"attach"` | `"launch"` | `attach` connects to an existing debug-enabled Chrome; opt-in, never closes your tabs |
| `attach_url` | URL | `http://127.0.0.1:9222` | only used in `attach` mode |
| `profile` | `"fresh"` \| `"persistent"` \| `"<path>"` | `"fresh"` | `persistent` reuses cookies across runs (still isolated from your real Chrome) |
| `max_tabs` | 1–32 | `8` | hard cap; LRU evicts unowned/idle tabs first, never an actively-owned tab |
| `idle_timeout_s` | seconds | `1800` | daemon exits after 30 min with zero tabs |

## Tools

Planned surface (M2; `codemode: true` on all):

| Tool | What it does | Returns |
|---|---|---|
| `browser_navigate` | go to a URL in your session tab | `{tab_id, url, title, status}` |
| `browser_snapshot` | compact accessibility snapshot with `[uid]` refs | text tree, `max_nodes` default 300 |
| `browser_click` | real mouse click at the element center (occlusion-checked) | `{ok}` |
| `browser_fill` | focus + real key events (works with React/Vue) | `{ok}` |
| `browser_press_key` | key press, optionally into a uid | `{ok}` |
| `browser_eval` | run JS in the page (**permission-gated**, see below) | `{value}` |
| `browser_screenshot` | PNG capture | file attachment + `{path}` |
| `browser_console` | recent console messages (ring buffer, 500/tab) | `{messages}` |
| `browser_network` | recent requests (ring buffer, 500/tab) | `{requests}` |
| `browser_list_tabs` / `browser_close_tab` | inspect / close tabs (yours only) | `{tabs}` / `{closed}` |

Stale-uid rule: every uid encodes its navigation generation (`g7-3`). Using
one after the page changed returns `UID_STALE` ("re-run `browser_snapshot`")
instead of clicking the wrong node. Driving another session's tab returns
`TAB_FORBIDDEN`.

`browser_eval` is gated by the native permission domain: the executor calls
`ctx.permission.assert({sessionID, action: "browser_eval", resources: [url]})`,
so allow/deny follows the session's permission rules with a UI prompt — there
is no bypass via hook input rewriting.

## Security (summary)

- **Socket:** `$XDG_RUNTIME_DIR/opencode-browser/v1/` (mode `0700`),
  `daemon.sock` (mode `0600`), `SO_PEERCRED` uid check — another user cannot
  connect, even on a shared host.
- **Navigation allowlist:** `http`, `https`, `about`; `file:` only with
  explicit opt-in; `javascript:` rejected.
- **Eval:** permission-gated per session (see above); attach mode is opt-in
  and tags only daemon-owned targets.
- **Logs:** query strings/fragments are redacted from logged URLs.
- **Not protected:** a page you navigate to can still attack the browser
  itself (standard CDP caveat); the daemon does not sandbox web content.

Full notes: `docs/security.md` (M2.5), `docs/IMPLEMENTATION-PLAN.md`.

## Benchmark & kill gate (M3)

Baselines on the same machine/Chrome/fixture: **A** = raw-CDP JS driver
in-process, **B** = Rust daemon. Workload: 1/4/8 sessions × 20 calls,
3 runs (first discarded). Metrics: cold first call, warm p50/p95 per method,
idle/marginal/total-tree RSS, collisions, 30-min drift.

> **Pre-registered kill rule:** if Rust shows **<20% improvement** in
> marginal memory per session **and** **<20%** in warm-call p95 vs baseline A,
> the daemon does **not** become the default — the JS driver ships instead.

Run it: `node scripts/bench.mjs --mock` (no Chrome) or
`node scripts/bench.mjs --driver js` (real Chrome);
`--compare <other-results.json>` evaluates the rule.
Decision memo: [`bench/results/report.md`](bench/results/report.md).

## Packaging

`node scripts/build-native.mjs` builds `browserd --release`, strips it, and
stages `prebuilds/linux-x64/browserd` (mode `755`). The npm tarball ships
`plugin/ + prebuilds/ + README.md` **inside** the package (no postinstall
download for v1). **Size budget: ≤20 MB compressed**, enforced by CI
(`pack-smoke` fails the build over budget).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `DAEMON_UNAVAILABLE` / empty reply | Is it running? `ss -x \| grep opencode-browser` or send `{"id":1,"method":"status","params":{}}` via `socat`. If dead, the shim respawns it on next call (≤2 s backoff). |
| `PROTOCOL_MISMATCH` | Shim/daemon version skew. Socket path embeds the protocol major (`.../v1/`), so this means a stale daemon: kill it (below) and retry. |
| `CHROME_DEAD` | Chrome crashed; the daemon relaunches once automatically — just retry. Persistent? Run the binary by hand: `google-chrome --headless=new about:blank`. |
| `UID_STALE` / `UID_NOT_FOUND` | Page changed since the snapshot. Re-run `browser_snapshot`, use the new uids. |
| `TAB_FORBIDDEN` | That tab belongs to another session. Navigate in your own session instead. |
| Need the socket path | `${XDG_RUNTIME_DIR:-/tmp/opencode-browser-$UID}/opencode-browser/v1/daemon.sock` (see `daemon/src/paths.rs`). |
| Kill the daemon | `pkill -x browserd`, or send `{"id":1,"method":"shutdown","params":{}}` on the socket. Tabs die with it; Chrome's profile dir is removed. |

## Compatibility

- OS/CPU: `linux` / `x64` (v1). macOS/Windows are post-v1.
- Runtimes: Node ≥22 or Bun ≥1 (shim + bench scripts).
- OpenCode: V2 plugin API (`@opencode/plugin` 2.x); verified against server 2.2.7.
- Protocol: major version in the socket path (`v1/`); mismatched shims refuse
  to talk to old daemons instead of misbehaving.
