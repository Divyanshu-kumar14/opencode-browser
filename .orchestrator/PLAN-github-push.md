# PLAN-github-push — public repo + phase-wise commits to main

Hypothesis (sequential-thinking #4): 5 phased commits (≤5 files each) + repo create + push.

## Phase 0 — done
- Gateway ping: `searxng_instance_info` reachable.
- `gh auth`: Divyanshu-kumar14, scopes repo/workflow.
- No remote; `Divyanshu-kumar14/opencode-browser` does not exist → create public.
- Secret scan: no gho/ghp/sk/AKIA/private keys in README/docs/scripts/plugin/daemon/.github.

## Task Packets
### Packet 1: Repo create [@orchestrator]
- Objective: Create public GitHub repo and attach remote.
- Target: `.` (no file edits)
- Context: name `opencode-browser`, public, `git config user.name/email` already set.
- Verification: `gh repo view` + `git remote -v`
- Exit: `origin → github.com:Divyanshu-kumar14/opencode-browser.git`, default branch main.

### Packet 2A: Daemon types/policy [@orchestrator]
- Files: `daemon/src/rpc.rs`, `daemon/src/policy.rs`, `daemon/src/error.rs`
- Verification: `cargo test --manifest-path daemon/Cargo.toml` (and fmt/clippy if fast)
- Exit: commit `feat(daemon): typed RPC params, upload policy, new error codes`

### Packet 2B: Daemon core [@orchestrator]
- Files: `daemon/src/dispatch.rs`, `daemon/src/tabs.rs`
- Verification: same cargo test
- Exit: commit `feat(daemon): hover/select/upload/dialog/scroll + network depth`

### Packet 2C: Plugin surface [@orchestrator]
- Files: `plugin/src/tools.ts`, `plugin/src/index.ts`, `plugin/src/errors.ts`, `plugin/src/driver/js.ts`
- Verification: `tsc --noEmit` + `bun test` in plugin/
- Exit: commit `feat(plugin): browse_* namespace + interaction tools`

### Packet 2D: Tests+fixtures [@orchestrator]
- Files: `plugin/test/tools.test.ts`, `plugin/test/rpc.test.ts`, `scripts/fixture.html`, `scripts/smoke.mjs`, `scripts/fixture-server.mjs` (new)
- Verification: `bun test` + `node --check scripts/smoke.mjs`
- Exit: commit `test: cover new tools, fixture server + smoke`

### Packet 2E: Docs [@orchestrator]
- Files: `README.md`, `docs/api-notes.md`, `docs/security.md` (new), `docs/PLAN-tool-surface-gaps.md` (new)
- Verification: secret grep exit≠0 + `git status --short`
- Exit: commit `docs: browse rename, tool table, security model`

### Packet 3: Push [@orchestrator]
- Objective: `git push -u origin main`, confirm remote log.
- Verification: `git ls-remote` / `gh repo view --web=false`
- Exit: 5 new SHAs on origin/main.

## Budgets
- Each commit ≤5 files (change-budget compliant).
- Binary `prebuilds/linux-x64/browserd` is gitignored — never force-add.
- `node_modules/`, `target/` stay ignored.
