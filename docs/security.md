# Security model

Scope: the `browser` plugin (`plugin/`) and its daemon (`daemon/`). This is a
local automation tool, not a sandbox: it drives a real Chrome with a real
profile. The goal here is that *another local user*, *a hostile page*, or *a
mistaken agent* cannot escalate beyond what the user could do by hand.

## Trust boundaries

| Boundary | Enforced where | Mechanism |
|---|---|---|
| Local user → daemon socket | `daemon/src/paths.rs`, `main.rs` | runtime dir `0700`, socket `0600`, `SO_PEERCRED` uid check |
| Client → daemon params | `daemon/src/dispatch.rs` | every method parses typed params; unknown/malformed → `INTERNAL`, never a panic |
| Client → navigation | `daemon/src/policy.rs` | scheme allowlist, redirect re-check after load |
| Agent → risky actions | `plugin/src/tools.ts` | permission asserts for `browser_eval` and `browser_upload` |
| Page → agent | tool output | page text is data, never instructions |

The TypeScript shim is a convenience client, **not** a trust boundary. Anything
the shim validates (upload path shape, log limits) is validated again in the
daemon, because a hostile client can speak the socket protocol directly.

## Navigation

- Allowed without opt-in: `http`, `https`, `about`.
- `file:` only with `allow_file: true` (fixtures, local HTML).
- Rejected: `javascript:`, `data:`, `vbscript:`, `chrome:`, `ftp:`, …
- After the load settles the daemon re-reads the final URL and rejects a
  redirect that landed on a disallowed scheme.
- URLs in logs, tab listings and error payloads are stripped of query string
  and fragment (`redact_url`), so tokens in `?access_token=…` do not leak into
  transcripts.

## `browser_eval`

Running arbitrary JS in the page is the most powerful tool here: it can read
cookies visible to JS, call same-origin APIs, and post data anywhere.

- Gated by `ctx.permission.assert({action: "browser_eval", resources: [url]})`.
  The prompt names the page URL, so an approval is scoped to a page.
- Input capped at 1 MiB; output truncated at 100 KiB.
- Default `timeout_ms` 30 s, cap 120 s. The deadline bounds the *caller's*
  wait; the page script may keep running, which the error hint states.

## `browser_upload`

Attaching local files to a file input is a file-exfiltration primitive: a
malicious page plus one approved upload can read anything the user can read.

- Gated by `ctx.permission.assert({action: "browser_upload", resources: paths})`.
  The prompt names the files, because reading them is the risky half.
- Daemon re-validation (`policy::check_upload_paths` + filesystem checks):
  - 1–8 paths, each absolute;
  - no `..` component;
  - regular file, **not** a symlink (a symlink could be swapped after approval);
  - ≤ 100 MiB total.
- Error messages and logs carry the basename only, never the directory.

## Dialogs

`alert`/`confirm`/`prompt`/`beforeunload` can block a renderer indefinitely.

- `Page.enable` + `Page.javascriptDialogOpening` are wired at tab setup.
- Default policy (`dialog_policy: "auto"`) dismisses `alert`/`confirm`/`prompt`
  and accepts `beforeunload` — a hostile page cannot wedge the tab.
- `dialog_policy: "manual"` leaves the dialog open for `browse_dialog`; while
  it is open, calls that need the renderer will wait.
- Dialog text is page-controlled: it is returned as data and must not be
  treated as instructions.

## Console / network capture

- Per-tab ring buffers, 500 entries each; console text capped at 2 000 chars.
- URLs redacted (no query/fragment); request bodies are never captured.
- Network entries expose method, URL, status, timing, resource type
  (`kind`), cache state (`from_cache`), wire bytes (`encoded_bytes`) and the
  CDP `request_id`. Headers are captured redacted at the source —
  `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`
  become `[redacted]` — and are only serialized when the caller passes
  `include_headers: true`.
- `browse_network_body` reads one response body by `request_id` (default
  16 KiB, cap 256 KiB, UTF-8 safe). Bodies may contain session tokens or PII:
  treat them as untrusted data, never log them, and prefer a small `max_bytes`.
  Chrome evicts bodies after navigation or cache pressure; that surfaces as
  `BODY_UNAVAILABLE`, never as a generic error.
- `next_since` is a monotonic per-tab cursor, not a timestamp: it leaks nothing
  about other sessions.

## Route mocks (`browse_route`)

Deterministic fixtures for agent tests: one literal URL pattern bound to
`fulfill` (serve a fixture body) or `abort` (fail the request) on the
session tab.

- Matching is substring (default), `prefix`, or bare-`host` comparison —
  literal string operations only. `*` and `?` match themselves; no regex
  crate ever sees untrusted input, so there is no backtracking bomb.
- Patterns cap at 512 chars; `status` must be 100–599, `body` 256 KiB,
  `content-type` printable ASCII ≤ 128 chars. Oversized or malformed input
  is rejected before any tab or CDP call, and `abort` rejects fulfill-only
  fields instead of silently dropping them.
- A fulfilled mock sends exactly one response header (`content-type`).
  Request headers — `authorization`, `cookie`, `set-cookie`, `x-api-key` —
  are never reflected into a mock, so fulfilled fixtures cannot leak
  session secrets.
- Session-scoped: installing a route resolves the caller's owned tab
  (`TAB_FORBIDDEN` otherwise), and `mark_dead` clears the table, so
  `close_tab`, `remove_all`, `sweep`, and eviction all drop every mock.
  Requests with no matching route pass through untouched.
- Arming: Chrome launches with `request_intercept`, so chromey's manager
  enables Fetch at target creation and steps aside; the daemon pump (armed
  from tab birth) answers each pause with exactly one continue/fulfill/fail,
  so a mock can never wedge the page. Auth challenges are answered
  `Default` (browser default handling).

## Session and tab isolation

- One tab per OpenCode session; `TAB_FORBIDDEN` when a client addresses
  another session's tab.
- Max 8 tabs; eviction only of unowned tabs or tabs idle past the 10-minute
  lease, never the caller's own tab.
- uids encode the navigation generation (`g7-3`); a uid from a previous
  document returns `UID_STALE` instead of acting on a different node.
- Click/hover verify the top element at the target point and refuse with
  `ELEMENT_OCCLUDED` rather than clicking through a covering element.

## Not protected

- A page can still attack the browser itself (standard CDP caveat). The daemon
  does not sandbox web content.
- Chrome runs with the user's profile; cookies and saved logins are reachable
  by JS in the page, exactly as in normal browsing.
- Screenshots are written to `$XDG_CACHE_HOME/opencode-browser/screenshots`
  with owner-only permissions; they are full-page content and should be
  treated as sensitive.
