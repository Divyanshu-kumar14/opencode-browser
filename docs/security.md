# Security model

This is a local automation tool, not a sandbox: it drives a real Chromium with a
real, persistent profile. The goal is that *another local user*, *a hostile
page*, or *a mistaken agent* cannot escalate beyond what the user could do by
hand.

There are two code bases in this repository:

- **Active plugin (`plugin/src`)**: the Playwright engine that OpenCode loads
  and the six `browse_*` tools. Everything in the next section applies to it.
- **Daemon and legacy shim (`daemon/`, `plugin/legacy/`)**: the earlier Rust
  CDP daemon and its TypeScript client. The plugin no longer registers them, so
  their controls do **not** protect the active plugin. They are documented in
  the last section for reference.

## Active plugin (`plugin/src`)

| Boundary | Enforced where | Mechanism |
|---|---|---|
| Agent → navigation | `core/url-policy.ts`, `core/browser-session.ts` | scheme allowlist on `browse_navigate goto` |
| Agent → page JS | `tools/evaluate.ts`, `index.ts` | `browser_eval` permission prompt, eval timeout |
| Page → agent | `injected/dom-annotator.ts`, `core/telemetry.ts` | sensitive-input and URL redaction; page text is data, never instructions |
| Local user → screenshots | `core/action-engine.ts` | owner-only directory and files |

### Navigation

- `browse_navigate goto` accepts only absolute `http:`, `https:`, and `about:`
  URLs. Any other scheme (`javascript:`, `data:`, `chrome:`, `file:`, …) fails
  with `INVALID_INPUT` before the page is touched.
- `file:` URLs are allowed only with `OPENCODE_BROWSER_ALLOW_FILE_URLS=1`.
- Only `goto` is checked. Links the page follows, redirects, and `back` /
  `forward` / `reload` are not re-checked (see "Not protected").

### `browse_eval`

Running arbitrary JS in the page is the most powerful tool here: it can read
cookies visible to JS, call same-origin APIs, and post data anywhere.

- Every call asserts the host permission `browser_eval` with the page URL as
  the resource, before the expression runs. The URL in the prompt has its query
  string, fragment, and userinfo removed. A denial ends the call; the
  expression never runs.
- With no permission rules the host resolves `browser_eval` to allow, so the
  plugin registers a permission hook that turns that default into **ask**: the
  user is prompted unless they opt out with `OPENCODE_BROWSER_EVAL_PROMPT=0`.
  With the opt-out, the host's own rules decide; `deny` and `ask` rules always
  apply.
- The approval is tied to the page: if the active page changed between the
  prompt and the run, the call fails with "page changed since browse_eval was
  approved" and must be retried.
- The tool is registered with `options.permission: "browser_eval"`.
- Each eval is bounded by `OPENCODE_BROWSER_EVAL_TIMEOUT_MS` (default 30000).
  A script that blocks the renderer (`while (true) {}`) is stopped with CDP
  `Runtime.terminateExecution`; a promise that never settles is abandoned, and
  the result says the page script may still be pending.
- Known limit: whether a user's "always allow" reply survives the ask upgrade
  has not been verified in an interactive TUI session yet.

### Sensitive inputs

- The element map never carries the value of a password field or of a field
  whose `autocomplete` tokens include `cc-number`, `cc-csc`, or
  `one-time-code`. A non-empty value is shown as `value="[redacted]"`, and the
  value is never used as the element's label.
- Redaction happens inside the page, so the plaintext never crosses the CDP
  connection as part of the element map.

### Console and network telemetry

- HTTP error responses, failed requests, console message sources, and page
  error stack frames are stored with the query string, fragment, and userinfo
  removed from every URL, so tokens such as `?access_token=…` do not reach the
  transcript. Stack frames keep their `:line:col`.
- The text of a console message is page-controlled and is not parsed; a URL
  inside the message text is not redacted.
- Request and response bodies and headers are never captured.

### Screenshots

- Annotated PNGs are written to `OPENCODE_BROWSER_SCREENSHOT_DIR`, default
  `$TMPDIR/opencode/browser-screenshots`. They hold full page content: treat
  them as sensitive.
- The directory is created with mode `0700`, and an existing directory owned by
  the current user is tightened to `0700`. A symlink in place of the directory
  is refused.
- Each file is created with mode `0600` and `O_CREAT|O_EXCL`, so it stays
  private even when another user owns the parent directory, and a planted file
  or symlink is never followed.

### Profile and sandbox

- A persistent Chromium profile under `.opencode/browser-profile` (or
  `OPENCODE_BROWSER_PROFILE_DIR`) is reused across runs. Anything you log into
  stays logged in until that directory is removed.
- Chromium sandboxing stays on unless `OPENCODE_BROWSER_NO_SANDBOX=1` or the
  process runs as root, where the sandbox cannot work.

### Not protected

- **Dialogs:** there is no dialog policy. An `alert`/`confirm`/`prompt` can
  block the page until it is handled.
- **Uploads:** there is no upload tool, and so no upload path checks.
- **Redirects:** there is no re-check after load. A page or redirect can still
  land on a scheme that `goto` would reject.
- **Tabs:** there is no per-session tab ownership. Every OpenCode session in
  the process shares one browser, one profile, and the same tabs.
- **Inspect:** `browse_inspect` prints an element's HTML attributes, including
  the `value` attribute of a password input.
- **Page content** can still attack the browser itself (standard CDP caveat),
  and JS in the page can read the profile's cookies exactly as in normal
  browsing.

## Daemon and legacy shim only (not used by the active plugin)

Scope: the Rust daemon (`daemon/`) and the quarantined TypeScript shim
(`plugin/legacy/`). None of the controls below run for the `browse_*` tools.

### Trust boundaries

| Boundary | Enforced where | Mechanism |
|---|---|---|
| Local user → daemon socket | `daemon/src/paths.rs`, `main.rs` | runtime dir `0700`, socket `0600`, `SO_PEERCRED` uid check |
| Client → daemon params | `daemon/src/dispatch.rs` | every method parses typed params; unknown/malformed → `INTERNAL`, never a panic |
| Client → navigation | `daemon/src/policy.rs` | scheme allowlist, redirect re-check after load |
| Agent → risky actions | `plugin/legacy/src/tools.ts` | permission asserts for `browser_eval` and `browser_upload` |
| Page → agent | tool output | page text is data, never instructions |

The TypeScript shim is a convenience client, **not** a trust boundary. Anything
the shim validates (upload path shape, log limits) is validated again in the
daemon, because a hostile client can speak the socket protocol directly.

### Navigation

- Allowed without opt-in: `http`, `https`, `about`.
- `file:` only with `allow_file: true` (fixtures, local HTML).
- Rejected: `javascript:`, `data:`, `vbscript:`, `chrome:`, `ftp:`, …
- After the load settles the daemon re-reads the final URL and rejects a
  redirect that landed on a disallowed scheme.
- URLs in logs, tab listings and error payloads are stripped of query string
  and fragment (`redact_url`), so tokens in `?access_token=…` do not leak into
  transcripts.

### `browser_eval`

Running arbitrary JS in the page is the most powerful tool here: it can read
cookies visible to JS, call same-origin APIs, and post data anywhere.

- Gated by `ctx.permission.assert({action: "browser_eval", resources: [url]})`.
  The prompt names the page URL, so an approval is scoped to a page.
- Input capped at 1 MiB; output truncated at 100 KiB.
- Default `timeout_ms` 30 s, cap 120 s. The deadline bounds the *caller's*
  wait; the page script may keep running, which the error hint states.

### `browser_upload`

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

### Dialogs

`alert`/`confirm`/`prompt`/`beforeunload` can block a renderer indefinitely.

- `Page.enable` + `Page.javascriptDialogOpening` are wired at tab setup.
- Default policy (`dialog_policy: "auto"`) dismisses `alert`/`confirm`/`prompt`
  and accepts `beforeunload` — a hostile page cannot wedge the tab.
- `dialog_policy: "manual"` leaves the dialog open for `browse_dialog`; while
  it is open, calls that need the renderer will wait.
- Dialog text is page-controlled: it is returned as data and must not be
  treated as instructions.

### Console / network capture

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

### Route mocks (`browse_route`)

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

### Session and tab isolation

- One tab per OpenCode session; `TAB_FORBIDDEN` when a client addresses
  another session's tab.
- Max 8 tabs; eviction only of unowned tabs or tabs idle past the 10-minute
  lease, never the caller's own tab.
- uids encode the navigation generation (`g7-3`); a uid from a previous
  document returns `UID_STALE` instead of acting on a different node.
- Click/hover verify the top element at the target point and refuse with
  `ELEMENT_OCCLUDED` rather than clicking through a covering element.

### Not protected (daemon)

- A page can still attack the browser itself (standard CDP caveat). The daemon
  does not sandbox web content.
- Chrome runs with the user's profile; cookies and saved logins are reachable
  by JS in the page, exactly as in normal browsing.
- Screenshots are written to `$XDG_CACHE_HOME/opencode-browser/screenshots`
  with owner-only permissions; they are full-page content and should be
  treated as sensitive.
