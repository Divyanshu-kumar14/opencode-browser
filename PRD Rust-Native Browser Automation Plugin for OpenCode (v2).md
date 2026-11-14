# PRD: Rust-Native Browser Automation Plugin for OpenCode (v2)

By Anshu - Draft v0.1 - Nov 2026

## 1. Problem Statement

OpenCode agents (coding/testing/research workflows) need to drive a real browser - navigate, click, fill forms, read the DOM, screenshot, inspect network/console - for end-to-end testing, scraping, and live research. OpenCode has no built-in browser tool; it must come from a plugin.

Stated constraint: the plugin should be fast and memory-light, built in Rust where possible, targeting OpenCode's v2 plugin API (domain-scoped hooks: ctx.tool.hook, ctx.tool registration - distinct from the deprecated v1 string-keyed hook API).

## 2. Critical Assumption Check (read before building)

Three assumptions are baked into the ask. Only one survives scrutiny untouched.

Assumption: "Rust will make this fast/light." - Partially false as stated. A real Chrome/Chromium process costs roughly 150-400MB+ RSS per instance regardless of what language drives it. The automation harness (the thing that would be Rust vs JS) is not the dominant cost. Rust buys a lighter driver process, not a lighter browser. If the goal is low total memory, the bigger lever is a persistent, shared browser process reused across tool calls - language-agnostic.

Assumption: "Rust vs Node is a big memory win for the harness itself." - Weakly supported. The one concrete number found (chaser-oxide, a Rust CDP fork) claims roughly 50-100MB for the automation layer vs roughly 500MB+ for "Node.js alternatives." That 500MB figure is almost certainly Puppeteer/Playwright (which bundle their own abstractions and often their own Chromium), not bare CDP-over-WebSocket Node code. At least one existing OpenCode plugin (different-ai/opencode-browser, CDP mode) already talks raw CDP from JS with no Puppeteer - its harness overhead is likely in the low tens of MB, not 500MB. Treat the Rust-vs-JS harness delta as tens of MB, not hundreds, until benchmarked. This is a blind spot in the original ask, not a fixable detail - it changes the value proposition.

Assumption: "This is a green field." - False. Competitive landscape as of Nov 2026:

| Project | Approach | Notes |
| --- | --- | --- |
| HaknErd/opencode-browser | Chrome Native Messaging + local broker (unix socket) + extension | Multi-session, per-tab ownership, no MCP, no WS port |
| different-ai/opencode-browser | Direct CDP (no extension) | browser\_snapshot/click/fill/eval/screenshot; also an experimental Playwright-based "Agent Browser" mode |
| michaljach/opencode-browser | Wraps an external Browser MCP server | Adds prompt-level speed guidance, not its own driver |
| crottolo/opencode-agent-browser | Wraps agent-browser npm CLI | Persistent sessions, video streaming, network mocking |

Three of four already do direct CDP or near-it. None currently claims a Rust core. The differentiator available is not "faster CDP driver" (marginal) - it's lower idle/overhead cost at scale (many parallel sessions, which the stated "multiple agents in parallel" workflow actually stresses) and startup latency, where a compiled, long-lived Rust daemon with a connection pool genuinely beats spinning up a fresh Node/Bun process or extension-messaging round trip per call.

Revised value proposition: not "Rust makes browser automation light" (it doesn't, Chrome dominates), but "a single persistent Rust daemon amortizes browser/session startup cost and driver overhead across many parallel OpenCode agent sessions, with lower per-session marginal memory and faster cold-call latency than spawning a JS driver or extension bridge per session." This is a narrower, defensible, and honest claim.

## 3. Goals

- G1: Give OpenCode v2 agents a browser\_\* tool surface (navigate, snapshot, click, fill, eval, screenshot, console/network read) backed by a real Chrome/Chromium instance via CDP.
- G2: Minimize marginal memory/CPU cost per additional concurrent agent session, via a shared Rust daemon and connection pool, not per-session process spawn.
- G3: Minimize cold-start latency for the first tool call in a session.
- G4: Ship as a normal opencode.json plugin, matching ecosystem conventions.
- G5: Target OpenCode's v2 plugin API specifically (domain hooks, ctx.tool.hook, custom tool registration), not v1.

## 4. Non-Goals (v1 of the plugin)

- Not competing on "undetectable"/stealth automation (that is chaser-oxide's niche - different problem, different risk profile, likely policy-sensitive).
- Not building a browser extension bridge (HaknErd's niche - more install friction, but reuses the user's real logged-in Chrome profile, which raw CDP launch does not).
- Not reimplementing Playwright's full cross-browser matrix. Chrome/Chromium-only for v1.
- Not a general-purpose scraping framework; scope is OpenCode agent tool calls.

## 5. Users and Core Use Cases

- Primary user: solo dev running multiple OpenCode agent sessions in parallel for coding/testing/research.
- UC1: Agent writes a frontend change, then navigates to localhost, takes an accessibility snapshot, clicks through a flow, screenshots the result to verify.
- UC2: Agent researches a live site (pricing page, docs, competitor product) and extracts structured content.
- UC3: Multiple parallel agent sessions each need a browser tab without each spinning up a full new Chrome process.

## 6. Architecture

Hard constraint: OpenCode v2 plugins are JS/TS modules executed in-process by the Bun/Node host. There is no native-binary plugin-loading mechanism. "Built in Rust" therefore means:

OpenCode (Bun host) -> JS/TS plugin shim (registers browser\_\* tools via ctx.tool; on first call, spawns/attaches to the Rust daemon; talks to the daemon over a local Unix domain socket using length-prefixed JSON or MessagePack) -> Rust daemon (single long-lived process, one per machine/user, not per session; owns a connection pool to one or more Chrome instances via CDP, async; manages tab allocation per OpenCode session ID; exposes navigate, snapshot (ARIA tree), click/fill by snapshot ID, eval, screenshot, console/network tap; launches Chrome headless via remote-debugging-port or pipe transport, or attaches to an existing instance).

Why this split, not a pure-JS plugin:

- The JS shim is unavoidable (host requirement) - keep it minimal: socket I/O and tool schema only, no CDP logic in JS.
- The daemon being a separate OS process (not a Bun worker) is what lets it (a) survive across OpenCode restarts, (b) be reused by multiple concurrent OpenCode sessions without re-paying Chrome launch cost, (c) be written in Rust without fighting Bun's FFI/N-API story.
- Daemon-to-shim transport: Unix domain socket (Linux/macOS) - matches a Linux dev environment; Windows via named pipe if cross-platform is later required, deferred (see section 9).

Rust crate choice: chromiumoxide (async, actively maintained, full CDP type coverage via generated PDL bindings) as the baseline. Re-evaluate forks (chromey, chaser-oxide) only if a specific gap (concurrency ergonomics, stealth) becomes a real requirement - don't adopt a stealth-focused fork by default, since undetectability features carry their own policy/ToS risk and are out of scope (section 4).

## 7. Tool Surface (initial set)

Modeled on the existing ecosystem's converged API shape (so prompts/skills written for different-ai/opencode-browser largely transfer):

- browser\_navigate(url, tab\_id?)
- browser\_snapshot(tab\_id?) -> accessibility-tree snapshot with stable element UIDs
- browser\_click(uid)
- browser\_fill(uid, value)
- browser\_eval(js, tab\_id?)
- browser\_screenshot(tab\_id?) -> saved path
- browser\_console(tab\_id?) -> recent console messages
- browser\_network(tab\_id?) -> recent requests/responses (status, timing)
- browser\_list\_tabs() / browser\_close\_tab(tab\_id)

Session-to-tab ownership: one tab reserved per OpenCode session ID at first use, released on session end/idle timeout - prevents two parallel agents from fighting over the same tab (the failure mode HaknErd's broker explicitly exists to solve).

## 8. Performance and Memory Targets

State targets honestly, split by what Rust actually controls:

| Component | Target | Rationale |
| --- | --- | --- |
| Daemon idle RSS (no tabs open) | under 20MB | Rust async binary, no browser launched yet |
| Daemon RSS per additional pooled connection (daemon-side only, excludes Chrome) | under 5MB marginal | Connection/session bookkeeping only |
| Chrome/Chromium per headless tab | 60-150MB (not controllable by daemon language) | Set expectation correctly; do not market this as "low memory" - it is Chrome's cost |
| Cold first-call latency (daemon already running, Chrome already warm) | under 150ms | Socket round-trip plus CDP call, no process spawn |
| Cold daemon+Chrome launch (worst case, first call ever) | under 2s | One-time cost, amortized across all later sessions |

These must be benchmarked, not assumed - add a bench command in the daemon that reports RSS before/after N simulated sessions, and compare against different-ai/opencode-browser's plain-CDP JS implementation as the actual baseline (not Puppeteer, which is a straw man).

## 9. Distribution and Packaging

- Publish as an npm package containing the thin JS/TS shim plus a prebuilt Rust daemon binary per platform (pattern used by esbuild, ripgrep-wrapping tools: optionalDependencies keyed by platform/arch, or a postinstall download from GitHub Releases).
- v1 target platform: Linux x86\_64 (matches a CachyOS/Arch dev environment). macOS/Windows binaries deferred to v2 - don't let cross-compilation block shipping v1.
- opencode.json: declare the plugin package name - standard convention, no bespoke install flow unless a native-messaging bridge is added later.

## 10. Security and Permissions

- Daemon binds to a Unix socket in a user-owned directory (e.g. XDG\_RUNTIME\_DIR), not a TCP port - avoids the "no WebSocket port, no port conflicts" problem HaknErd explicitly solved, and avoids exposing CDP to anything other than the local plugin.
- browser\_eval is arbitrary JS execution in a real browser context - treat it as interceptable in the JS shim via OpenCode's tool.execute.before hook, so a user can gate/deny it the same way the ecosystem gates bash or .env reads (precedent: OpenCode's own env-protection plugin example).
- Launch headless Chrome with a fresh, isolated profile by default (no access to the user's real cookies/logins) unless the user explicitly opts into attaching to an existing debuggable Chrome instance - that opt-in path inherits all the risk of exposing a real logged-in session to agent-driven JS eval; document this loudly.

## 11. Milestones

1. M0 (spike): Rust daemon that launches headless Chrome via chromiumoxide, exposes navigate+screenshot over a Unix socket, driven by a hand-rolled test client (no OpenCode yet). Validates the core technical risk.
2. M1: JS/TS shim registering browser\_navigate/browser\_snapshot/browser\_screenshot as OpenCode v2 tools, talking to the M0 daemon. End-to-end through an actual OpenCode session.
3. M2: Full tool surface (section 7) plus tab ownership per session plus idle cleanup.
4. M3: Benchmark suite vs different-ai/opencode-browser baseline (section 8); publish numbers before making any "faster/lighter" claim publicly.
5. M4: Packaging/distribution (section 9), public release.

## 12. Risks

- Fatal (if unaddressed): the core value claim doesn't survive a benchmark. If M3 shows the Rust daemon isn't meaningfully lighter/faster than the existing plain-CDP JS plugin under realistic conditions, "built in Rust" is a technology choice without a user-facing benefit - ship it anyway only if the goal is the engineering exercise, not adoption.
- Fixable: Chrome itself dominates memory. Mitigate by defaulting to a single shared Chrome instance with multiple tabs (not one Chrome process per session) - this is a design choice, not a language choice, and is the actual lever for a parallel-agents workflow.
- Fixable: cross-platform binary distribution complexity. Scope v1 to Linux only (section 9); don't let this block shipping.
- Blind spot: profile/login reuse. Competitors (HaknErd, different-ai's extension mode) solve "use my real logged-in Chrome" via native messaging/extension, which a headless-launch-only Rust daemon does not give for free. If the actual use case needs the user's real sessions (e.g. testing behind auth), a CDP-attach-to-existing-Chrome mode is required from v1, not deferred.
- Blind spot: "opencode2" naming. No evidence of a product literally named "OpenCode2" distinct from sst/opencode; this PRD assumes the ask means OpenCode's v2 plugin API (confirmed to exist via OpenCode's own v1-to-v2 migration docs). Confirm this reading before investing further.

## 13. Success Metrics

- Benchmarked marginal memory per concurrent session at least 2x better than the plain-CDP JS baseline, under a realistic multi-session load matching actual parallel-agent usage.
- Cold daemon+Chrome launch under 2s; warm tool-call latency under 150ms (section 8).
- Zero cross-session tab collisions under concurrent use (functional correctness, not just a perf claim).

## 14. What Would Change This Recommendation

- If M3 benchmarks show the Rust daemon's memory/latency edge over a plain-CDP JS implementation is marginal (under 20 percent), the right call is to not ship a Rust rewrite and instead contribute pooling/shared-instance improvements to an existing JS plugin (e.g. different-ai/opencode-browser) - same user benefit, far less maintenance surface.
- If the real requirement turns out to be "reuse my logged-in Chrome profile" rather than "spin up headless instances," the native-messaging/extension architecture (HaknErd's approach) is a better fit than a pure CDP-launch daemon, regardless of implementation language.
