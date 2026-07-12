# Codex Auth Freshness And Sync Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop valid ChatGPT-managed Codex JWTs from being rejected as stale and make the Windows-to-Hetzner credential sync safe, repeatable, and installable.

**Architecture:** The provider freshness reader uses the access-token JWT `exp` claim as the primary expiry source and retains `last_refresh` only as a legacy fallback. The dispatch gate fails closed only when the token is actually expired, missing, or unreadable; it no longer treats an ineffective source-mode `--version` probe as recovery. The operator sync compares JWT issue times, performs all protected remote-file operations through the existing container boundary, and installs a stable local copy of the script before registering the scheduled task.

**Tech Stack:** TypeScript, Bun test, PowerShell 5.1, SSH, Docker CLI, Windows Task Scheduler.

## Global Constraints

- Never print, log, commit, or include credential contents in test fixtures.
- All source and documentation files must be ASCII only.
- No production deployment or container restart is part of this PR.
- Remote auth replacement must preserve a dated backup and restore it if verification fails.
- Scheduled-task installation must not depend on a transient Git branch or worktree path.

---

### Task 1: JWT Expiry Is The Primary Freshness Truth

**Files:**
- Modify: `packages/providers/src/auth-refresh/preflight.ts`
- Modify: `packages/providers/src/auth-refresh/__tests__/preflight.test.ts`
- Modify: `packages/providers/src/auth-refresh/__tests__/dispatch-gate.test.ts`

**Interfaces:**
- Consumes: `CodexCreds.tokens.access_token`, `CodexCreds.tokens.refresh_token`, and legacy `last_refresh`.
- Produces: unchanged `readCodexFreshness(filePath): FreshnessRead` contract.

- [ ] **Step 1: Write failing tests for a ten-day JWT**

Add a fixture helper that creates a placeholder JWT from a JSON payload and assert that an access token with `exp = now + 10 days` is fresh even when `last_refresh` is older than 11 hours. Add the inverse assertion for `exp = now - 1 minute`. The payload must contain no real token bytes.

- [ ] **Step 2: Run the focused tests and verify the valid ten-day JWT test fails**

Run:

```powershell
bun test packages/providers/src/auth-refresh/__tests__/preflight.test.ts packages/providers/src/auth-refresh/__tests__/dispatch-gate.test.ts
```

Expected before implementation: the valid ten-day JWT is classified stale because the existing code uses only `last_refresh`.

- [ ] **Step 3: Decode only the JWT payload and apply the existing 60-second buffer**

Implement a private parser that splits the access token into three segments, base64url-decodes the payload, reads a finite numeric `exp`, and returns milliseconds. Do not verify or trust any other claim. Use `exp` when available; use the existing `last_refresh` calculation only for opaque legacy tokens.

- [ ] **Step 4: Run the focused tests and verify green**

Run the command from Step 2. Expected: all focused tests pass.

### Task 2: Dispatch Gate Stops Using An Ineffective Source-Mode Probe

**Files:**
- Modify: `packages/providers/src/auth-refresh/dispatch-gate.ts`
- Modify: `packages/providers/src/auth-refresh/__tests__/dispatch-gate.test.ts`

**Interfaces:**
- Consumes: `readCodexFreshness()`.
- Produces: unchanged `checkCodexDispatchGate(): Promise<DispatchGateResult>` contract.

- [ ] **Step 1: Write failing tests for deterministic gate behavior**

Assert that a valid JWT passes without calling `softRefreshCodex`, while an expired JWT returns `{ fresh: false, reason: 'stale' }` without pretending that a `--version` spawn recovered auth.

- [ ] **Step 2: Run the dispatch-gate test and verify red**

```powershell
bun test packages/providers/src/auth-refresh/__tests__/dispatch-gate.test.ts
```

Expected before implementation: the stale branch calls the mocked soft-refresh function.

- [ ] **Step 3: Remove dispatch-time dependence on `softRefreshCodex`**

Return the deterministic result from the credential file. Keep source-mode refresh code available to the provider preflight path, but do not use it as a dispatch authorization signal.

- [ ] **Step 4: Run the dispatch-gate test and verify green**

Run the Step 2 command. Expected: all dispatch-gate tests pass.

### Task 3: Sync Through The Container Boundary

**Files:**
- Modify: `scripts/codex-auth-sync/sync-codex-auth.ps1`
- Create: `scripts/codex-auth-sync/codex-auth-sync.test.ts`

**Interfaces:**
- Consumes: local `%USERPROFILE%\.codex\auth.json`, SSH alias, and container name.
- Produces: newest-valid credential at `/root/.codex/auth.json` inside the running container, plus a dated backup and redacted log line.

- [ ] **Step 1: Write a failing static contract test**

Assert that the script does not use host-side `cat`, `sha256sum`, `cp`, `mv`, or named `chown appuser:appuser` against the protected bind-mounted path; assert that it uses `docker exec` for metadata, backup, replacement, and verification; assert that log output contains only hash prefixes, sizes, timestamps, and status labels.

- [ ] **Step 2: Run the contract test and verify red**

```powershell
bun test scripts/codex-auth-sync/codex-auth-sync.test.ts
```

Expected before implementation: failures identify the host-side permission assumptions in the shipped script.

- [ ] **Step 3: Implement privilege-correct newest-wins sync**

Compare JWT `iat` values first and use mtime only when either token is opaque. Read remote metadata through `docker exec`. Before replacement, create the dated backup inside the container. Stream the local file to a container temp file over standard input, set mode `600`, atomically replace the target, and run the existing boolean-only provider probe. Restore the backup on verification failure.

- [ ] **Step 4: Run the contract test and verify green**

Run the Step 2 command. Expected: all sync contract assertions pass.

### Task 4: Install A Stable Scheduled Task

**Files:**
- Modify: `scripts/codex-auth-sync/install-sync-task.ps1`
- Modify: `scripts/codex-auth-sync/codex-auth-sync.test.ts`
- Modify: `scripts/codex-auth-sync/README.md`

**Interfaces:**
- Consumes: repository copy of `sync-codex-auth.ps1`.
- Produces: protected operator copy under `%LOCALAPPDATA%\BlueDevil\codex-auth-sync\` and scheduled task `BDC Codex Auth Sync` pointing to that stable copy.

- [ ] **Step 1: Extend the contract test and verify red**

Assert that installation copies the sync script to the stable operator directory before registration and that the task action references the installed copy rather than `$PSScriptRoot` in a worktree.

- [ ] **Step 2: Implement stable installation**

Create the destination directory if missing, copy the script, register the 30-minute task, and print only task name, interval, and installed path.

- [ ] **Step 3: Update operator documentation**

Document dry verification, installation, task status inspection, redacted-log checks, and the explicit rule that installation occurs only after the PR is merged and available in the canonical checkout.

- [ ] **Step 4: Run focused verification**

```powershell
bun test packages/providers/src/auth-refresh/__tests__/preflight.test.ts packages/providers/src/auth-refresh/__tests__/dispatch-gate.test.ts packages/providers/src/codex/soft-refresh.test.ts scripts/codex-auth-sync/codex-auth-sync.test.ts
bun run type-check
bun run lint --max-warnings 0
bun run format:check
rg -n -P "[^\x00-\x7F]" packages/providers/src/auth-refresh scripts/codex-auth-sync docs/superpowers/plans/2026-07-12-codex-auth-freshness-sync-repair.md
```

Expected: focused tests, typecheck, lint, and format pass; the ASCII scan returns no matches.

### Task 5: Review And Publish

**Files:**
- Review all files changed by Tasks 1-4.

**Interfaces:**
- Consumes: verified branch diff.
- Produces: review-approved commit and pull request targeting `dev`.

- [ ] **Step 1: Re-read the accepted repair requirements and inspect the diff**

Confirm JWT `exp` fixes the observed July 22 tokens, no secret values are present, no production mutation is included, and sync operations no longer depend on host access to the mode-600 file.

- [ ] **Step 2: Request independent code review**

Provide the reviewer with the base SHA, head SHA, this plan, and the original PR #408 defects. Resolve all Critical and Important findings.

- [ ] **Step 3: Re-run verification after review fixes**

Run every command from Task 4 Step 4 and record exact output.

- [ ] **Step 4: Commit, push, and open the authorized PR**

Target `dev`. Include the observed false-positive evidence, redacted security boundaries, test results, and an explicit `Deployment: not performed` statement.
