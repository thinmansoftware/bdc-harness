# PR Repair Owner -- Operations Runbook

WO-HARNESS-PR-REPAIR-OWNER-AND-DEDUPE-01

The PR repair owner is a Taskmaster tick step. It decides WHEN a lane-built pull
request that the Overseer rejected (CHANGES_REQUESTED) is repaired in place, it
collapses duplicate lane-built PRs for one Work Order to a single survivor, and
it surfaces exhausted or human-judgment cases as a single line in the Duty
Officer daily digest. It edits no lane YAML and opens no new PR for a repair --
the repair runs on the rejected PR's own branch.

## What it does, each tick

The owner runs once per Taskmaster tick, ONLY while `pause_state` is `RUNNING`.
Pausing the Taskmaster is the kill switch (see below). Each tick it performs
three bounded steps:

1. **Dedupe sweep.** Over at most 5 Work Orders that have two or more
   lane-created PRs inside `PR_REPAIR_DEDUPE_WINDOW_HOURS` (default 168 = 7
   days), it picks a survivor and closes the others:
   - Survivor = the newest OPEN lane-created PR whose `reviewDecision` is
     `APPROVED`; if none is approved, the newest OPEN lane-created PR.
   - Every OTHER OPEN lane-created PR that is NOT `APPROVED` is closed with the
     comment:

     `Superseded by #<S> (lane PR dedupe for <WO>). Closed automatically by the
     PR repair owner; branch kept. Runbook: docs/operations/pr-repair-owner.md`

   - The branch is NEVER deleted.
   - An `APPROVED` non-survivor is NEVER closed. It becomes a
     `dedupe_needs_human` digest line instead, because a human may want to merge
     it.

2. **Repair.** It reads queued `overseer_remediation_candidate` dispatch rows
   (findingClasses include `lane_repair`) addressed to `taskmaster`. For at most
   ONE per tick it:
   - re-proves the LANE PR RULE (else addresses the row `refused:not_lane_created`);
   - runs the dedupe for that WO first and refuses a non-survivor
     (`refused:superseded_by_#<S>`);
   - requires the PR OPEN with its live head SHA equal to the reviewed head
     (else `refused:stale_head`);
   - skips (leaves the row queued) while any run for the WO is `pending` or `running`;
   - otherwise acknowledges the row as `taskmaster`, fires EXACTLY ONE bounded
     repair cascade on the PR's branch (the cascade never climbs). Admission does
     not address or consume the row: the first run-authority transaction does.

   Freezing requires the candidate's owner/repository to match the resolved
   execution repository, not the separate spec repository. It rejects addressed,
   cancelled, rerouted, stale-acknowledged or future-acknowledged rows and requires
   the authenticated Overseer sender plus Taskmaster acknowledgment. The full
   candidate ID travels as `repairAttemptId` and selects the immutable authority's
   `dispatch_id=repair:<candidate id>` in both background and direct execution.

   First authority persistence atomically revalidates the candidate against the
   actual Git remote, compare-and-set addresses it, and inserts the authority.
   The existing unique dispatch index permits only one run per candidate. A
   failed insert rolls back addressing; an identical retry by the same run is
   idempotent. A second run or an addressed/refused candidate is rejected. No new
   table, migration, mailbox status, or alternate controller is introduced.

   The attempt cap is two repairs per PR, enforced upstream by the Overseer
   remediation candidate's attempt-slot key; a third CHANGES_REQUESTED verdict
   produces an `overseer_remediation_exhausted` row instead of a candidate.

3. **Exhausted.** Each queued `overseer_remediation_exhausted` row becomes one
   digest line `<owner>/<repo>#<N> <WO> <reason>` (reason is `attempt_cap` or
   `non_auto_finding`). Those rows are addressed ONLY AFTER the digest carrying
   them is sent, so a failed digest never loses the line.

## The LANE PR RULE

A PR is "lane-created for WO W" only if ALL hold (`lane-pr-registry.ts`):

- (a) an event-store row (`node_completed`/`tool_completed`, step
  `implement`/`open-pr-if-needed`) cites `github.com/<owner>/<repo>/pull/<N>`
  and belongs to a run whose `WO_ID` equals W exactly;
- (b) the PR's GitHub `created_at` is within the run window (-60s .. +60s);
- (c) the PR head is in the same repository (not a fork) and the head ref
  matches `feat|fix|wip/...` or `archon/task-web-worker-<n>-<id>` (refs starting
  `wo/` are author-wo.sh spec branches and are NEVER lane-created);
- (d) the PR title, body, or head ref claims W (`textClaimsWoId`).

Author login is NOT a signal: lane PRs and human PRs share the
`bluedevilcollectibles` login. Only the event store proves which run opened a
PR. A PR the rule does not prove lane-created is never closed, never commented,
never repaired.

## Conductor open-PR guard (related)

Separately, the conductor's cascade now refuses to climb the ladder while an
open PR for the same WO exists (`open-pr-guard.ts`,
`cascade.ts` `climbOrStop`). That guard runs whether or not `-AllowSatisfied`
(`SMART_CAULDRON_ALLOW_CLAIMED=1`) is set, so the ladder cannot climb over an
open PR even under the admission override. A repair cascade excludes its own
target PR from that guard.

## Environment knobs

- `PR_REPAIR_DEDUPE_WINDOW_HOURS` -- dedupe lookback window in hours (default
  168). WOs whose newest lane run started before this cutoff are not swept.
- `ARCHON_OPERATOR_TOKEN` -- forwarded to the repair cascade.
- `GITHUB_TOKEN` / `GH_TOKEN` -- used by `gh` for PR read and PR close.

## Kill switch

Pause the Taskmaster. While `pause_state` is not `RUNNING`, the owner does not
run at all -- no dedupe closes, no repair fires.

```
# status / pause / resume runbook:
xo-wiki/wiki/tools/taskmaster/_index.md
```

## Read-only operator queries

Run these against the host event store (`/opt/bdc/archon-data/archon.db`) with
`sqlite3`. They are all read-only.

Repair candidates the Overseer handed back for a WO:

```
sqlite3 /opt/bdc/archon-data/archon.db \
  "SELECT id, status, acknowledged_by, addressed_by, substr(body,1,120)
   FROM agent_dispatch_messages
   WHERE recipient = 'taskmaster'
     AND body LIKE '%overseer_remediation_candidate%'
     AND body LIKE '%lane_repair%'
   ORDER BY created_at DESC LIMIT 20;"
```

Exhausted / judgment hand-offs (one per PR ever):

```
sqlite3 /opt/bdc/archon-data/archon.db \
  "SELECT id, status, addressed_by, substr(body,1,160)
   FROM agent_dispatch_messages
   WHERE recipient = 'taskmaster'
     AND body LIKE '%overseer_remediation_exhausted%'
   ORDER BY created_at DESC LIMIT 20;"
```

Repair runs that were fired (the fire message carries a `repair_attempt=` line):

```
sqlite3 /opt/bdc/archon-data/archon.db \
  "SELECT id, workflow_name, status, started_at
   FROM remote_agent_workflow_runs
   WHERE user_message LIKE '%repair_attempt=%'
   ORDER BY started_at DESC LIMIT 20;"
```

PRs closed by the dedupe sweep are visible on GitHub with the superseded
comment; the branch is always kept.

## Runtime dependency

Live repair runs succeed only after WO-HARNESS-REPAIR-TARGET-LANE-01
(bdc-xo #3069) is merged and deployed. That WO repairs the in-place repair
MECHANICS inside the 13 lane YAMLs (authorization through commit-and-push).
Until it ships, every repair cascade this owner fires fails at commit-and-push
with `repair_target_unauthorized`. The two WOs touch disjoint files; this one is
safe to deploy first, but the Section 8 canary is only meaningful afterward.

## Candidate admission identity

The Taskmaster mailbox read filters both `sender=overseer` and
`sender_principal_id=system:overseer` before its bounded SQL page. It retains
actual sender, routing, lifecycle, and acknowledgment fields. The owner checks
these fields before acknowledging a candidate, generating exhaustion notices,
or spending a repair admission slot. Missing metadata fails closed.

An already acknowledged candidate requires Taskmaster ownership and a timestamp
no more than one hour old, with future timestamps rejected. Invalid existing
acknowledgments are not refreshed into new authorization. The first persisted
run authority remains the atomic consumer of the candidate.

Authenticated stale-ack rows cannot spend admission, but can still occupy the
bounded SQL page. A queue dominated by such rows requires further pagination
or lifecycle handling; this change does not claim to resolve that backlog.
