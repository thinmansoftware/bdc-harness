# Smart Cauldron Reliability Canary Packet

Date: 2026-07-09

Status: REVIEW PACKET ONLY

This packet is not permission to deploy, drain, rebuild, restart, fire a workflow,
create a branch, push, or open a pull request. Each state-changing step requires a
separate explicit operator approval after this packet and the implementation diff
have been reviewed.

## 1. Canary identity

- WO: `WO-HARNESS-SMART-CAULDRON-CANARY-01`
- Canonical repository: `bluedevilcollectibles/bdc-harness`
- Canonical checkout: the registered bdc-harness checkout only
- Base branch: `dev`
- Expected branch: the exact branch frozen in run authority after isolation;
  it must match `archon/thread-<8 lowercase hex>` and every later evidence source.
- Expected file: `docs/canary/smart-cauldron-canary.md`
- Expected change: create exactly one ASCII Markdown file containing the WO ID,
  the word `CANARY`, and no executable code.
- Expected verification: file exists, contains the WO ID, is ASCII-only, and the
  diff contains exactly that one path.
- Expected PR: one draft or open PR to `dev`, never auto-merged.
- Forbidden changes: source, workflow, config, dependency, lock, secret, database,
  deployment, branch protection, and production files.

The WO spec must be created and approved through the normal WO lifecycle before a
real canary. The spec must freeze the exact text bytes, base SHA, path, branch, and
verification commands. This packet does not create that WO or authorize it.

## 2. Preconditions and separate approvals

All boxes must have direct evidence. Missing evidence is an abort, not an assumption.

- [ ] Implementation commits reviewed; no uncommitted changes in the canary runtime.
- [ ] Root typecheck, focused reliability tests, lint, formatting, generated bundle,
      diff check, and ASCII check are green at the reviewed commit.
- [ ] Canonical bdc-harness remote and `origin/dev` SHA recorded.
- [ ] Canary WO immutable spec bytes and hash recorded.
- [ ] No other active bdc-harness mutation lane conflicts with the canary path.
- [ ] Operator separately approves drain, if drain is needed.
- [ ] Operator separately approves rebuild, if rebuild is needed.
- [ ] Operator separately approves restart, if restart is needed.
- [ ] Operator separately approves enabling the conductor feature flag.
- [ ] Operator separately approves the single canary fire.
- [ ] Operator separately approves any push and PR creation performed by the WO.

Do not combine these approvals. Approval to review this packet is approval for none
of the state-changing steps above.

## 3. Route expectations

The canary WO class is `CODE` with tag `mechanical`. The deterministic ruleset is
expected to select tier `zero` and workflow `bdc-feature-development-zero-open`.

Before a real fire, inject and observe these routes in tests:

1. Zero tier healthy: one provider attempt, no climb.
2. Selected provider unavailable: one sideways failover only to a capable provider.
3. Selected provider quota-exhausted: durable `waiting_provider`, no busy loop.
4. All capable providers exhausted: durable scheduled wait survives process restart.
5. Chat-only fallback: rejected before provider dispatch.

Real provider availability is observational input, not a reason to weaken the
capability gate. If the planned route is unavailable, the run must wait or take its
declared eligible failover; it must not silently substitute a chat-only provider.

## 4. Dry-run proof before any live fire

With the server still non-production and only after explicit approval to enable the
flag in that environment, submit the existing run endpoint with:

```json
{
  "conversationId": "smart-cauldron-canary-plan",
  "message": "WO-HARNESS-SMART-CAULDRON-CANARY-01",
  "conductor": {
    "enabled": true,
    "woId": "WO-HARNESS-SMART-CAULDRON-CANARY-01",
    "project": "bdc-harness",
    "woClass": "CODE",
    "tags": ["mechanical"],
    "idempotencyKey": "smart-cauldron-canary-2026-07-09-v1",
    "dryRun": true
  }
}
```

Expected response facts:

- `accepted: true`
- `status: planned`
- `dispatchMode: conductor`
- a stable `cascadeId`
- `entryTier: zero`
- no workflow run, provider call, branch, worktree, push, or PR
- one durable planned cascade record bound to the complete request identity

Repeating the identical request must return the same durable record. Reusing the
idempotency key with a different WO, project, class, tags, entry override, or dry-run
mode must fail with a dispatch identity conflict.

## 5. Observation commands

Use read-only queries against the explicitly approved non-production database. Do
not print tokens, environment values, prompts containing secrets, or raw credentials.

```sql
SELECT id, workflow_name, status, created_at, updated_at
FROM remote_agent_workflow_runs
WHERE id = '<RUN_ID>';

SELECT run_id, owner_id, acquired_at, last_heartbeat_at, expires_at, released_at
FROM remote_agent_run_leases
WHERE run_id = '<RUN_ID>';

SELECT attempt_id, node_id, attempt_number, provider, model,
       served_model_id, outcome_class, reason_code, resume_at
FROM remote_agent_provider_attempts
WHERE run_id = '<RUN_ID>'
ORDER BY node_id, attempt_number;

SELECT wait_id, attempt_id, provider, reason_code, resume_at, state,
       claimed_at, cancelled_at, completed_at
FROM remote_agent_scheduled_waits
WHERE run_id = '<RUN_ID>';

SELECT execution_state, deliverable_state, validation_state,
       recovery_state, route_state, primary_reason
FROM remote_agent_run_outcomes
WHERE run_id = '<RUN_ID>';

SELECT event_type, step_name, data, created_at
FROM remote_agent_workflow_events
WHERE workflow_run_id = '<RUN_ID>'
ORDER BY created_at;
```

Read-only repository observations:

```bash
git remote get-url origin
git rev-parse --verify origin/dev^{commit}
git worktree list --porcelain
git -C <CANARY_WORKTREE> branch --show-current
git -C <CANARY_WORKTREE> merge-base --is-ancestor <FROZEN_BASE_SHA> HEAD
git -C <CANARY_WORKTREE> diff --name-status <FROZEN_BASE_SHA>...HEAD
gh pr view <PR_URL> --repo bluedevilcollectibles/bdc-harness \
  --json url,number,state,isDraft,baseRefName,headRefName,headRefOid,files,statusCheckRollup
```

Expected evidence chain:

`dispatch -> authority -> lease -> attempt -> optional wait -> mechanical evidence -> outcome -> manifest`

Every identifier in the chain must refer to the same run, WO, repository, frozen
base, worktree, branch, and PR. A missing or contradictory row is an abort.

## 6. Abort criteria

Abort before fire if any of these is true:

- Conductor flag is already enabled unexpectedly.
- Drain state, active run count, or active lease count is unknown.
- Canonical remote, base branch, base SHA, spec hash, workflow revision, bundle
  revision, or engine revision cannot be frozen.
- Expected worktree path exists but ownership or branch identity does not match.
- Planned provider lacks repository-read, repository-write, shell, or required
  network capability.
- Dry run creates a workflow run or provider attempt.
- Idempotent dry-run replay creates a second record.

Abort during the canary if any of these is true:

- More than one provider call exists for the same attempt number.
- Lease heartbeat stops and the run does not become recoverably interrupted.
- A quota wait exists only in memory or disappears after restart.
- Cancellation loses to a due-wait claim and the provider is called afterward.
- Diff contains a path other than `docs/canary/smart-cauldron-canary.md`.
- HEAD is not a descendant of the frozen base SHA.
- PR base, head, head SHA, repository, number, or exact file list disagrees with
  mechanical evidence.
- A legacy unrelated ASCII byte fails the run, or a changed non-ASCII byte passes.
- A blocked or indeterminate gate projects completed or REVIEW.
- Any deploy, merge, production write, or branch-protection mutation is attempted.

On abort: stop new dispatch, preserve the worktree and artifacts, record the reason,
and require operator review. Do not delete or reset evidence.

## 7. Recovery without destructive cleanup

1. Leave the stage/run worktree in place.
2. Record run ID, lease, attempt, wait, authority, worktree, branch, and last event.
3. If a worker died, let lease expiry move the run to recoverable interruption.
4. Reconcile the same run identity; do not create a replacement branch or PR.
5. If a provider wait is scheduled, preserve it and use the durable claim path.
6. If cancellation was requested, cancel scheduled waits before any resume claim.
7. If terminal persistence failed, keep the run interrupted with
   `status_persist_failed`; never publish terminal success from memory.
8. If authority conflicts, stop. Do not reset, rebase, adopt another checkout, or
   rewrite the frozen base.
9. If the PR is valid but a legacy unrelated gate failed, preserve the PR-ready
   deliverable and classify validation separately.

No recovery step in this packet authorizes `git reset --hard`, recursive deletion,
worktree removal, branch deletion, force push, merge, deploy, or production mutation.

## 8. Drain, rebuild, and restart gates

Drain, rebuild, and restart are three different operations.

- Drain: reject new dispatch while allowing active leased work to finish. Approval
  must name the environment and observation window.
- Rebuild: produce reviewed artifacts from the approved commit. Approval must name
  the commit and build target.
- Restart: stop/start the approved non-production process after drain evidence says
  it is safe. Approval must name the process and rollback owner.

None is implied by approval of another. If restart recovery is the test, first prove
the same behavior with controlled fixtures, then approve a non-production restart
separately.

## 9. Rollback controls

Primary kill switch:

```text
ARCHON_SMART_CAULDRON_DISPATCH_ENABLED=false
```

The code treats only the exact string `true` as enabled. Unset or `false` preserves
the explicit direct-lane path. Rollback must not delete durable records or worktrees.

Additional containment:

- Set Cauldron control mode to `draining` through the authenticated admin endpoint
  only with separate approval.
- Do not shorten `ARCHON_RESOURCE_EXHAUSTED_MAX_WAIT_MS` to force progress.
- Do not change `ARCHON_PROVIDER_WAIT_POLL_INTERVAL_MS` as an incident workaround.
- Cancel the specific run through the authenticated cancellation endpoint; do not
  kill unrelated workers.

Rollback success means: no new conductor dispatches, existing evidence remains
readable, active work is either safely completed or recoverably interrupted, and
the direct-lane behavior remains unchanged.

## 10. Canary completion bar

The canary is successful only if all of the following are mechanically observed:

- one dispatch identity and one run
- one authoritative worktree and branch
- no duplicate attempt or provider call
- exact one-file ASCII diff
- frozen base ancestry holds
- PR identity and file list match the authoritative evidence
- required checks and gates pass
- outcome is execution `completed`, deliverable `pr_ready`, validation `passed`
- lease is released and no provider wait remains claimable
- no production action occurred

Even after this bar passes, merge and production enablement remain separate operator
decisions. This packet never grants them.
