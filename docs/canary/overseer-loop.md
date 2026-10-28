# Overseer loop canaries

Daily and post-rebuild observation of the Overseer merge stall and the fix-loop hand-back gap. This WO does not fix #3949, #3951, or #3942. The canaries only report them.

## Checks

- C1 run-branch-identity: workflow runs from the last 24 hours whose metadata lacks a non-empty `base_branch` or `head_branch`. WARN until `OVERSEER_CANARY_BRANCH_IDENTITY_LANDED=1`, then FAIL.
- C2 overseer-merge-health: FAIL when one `merge_denied` result repeats 3 or more times in 24 hours, or when `flag_merge_ready` is present and no run-derived `merged` action exists. Rows whose `run_id` starts with `pr-discovery:` are not run-derived merges. Two repeats stay PASS.
- C3 end-to-end merge: one docs-only PR. Budgets are 30 minutes to open, 30 minutes for Overseer approval at the exact head SHA, and 15 minutes for the merge manager. The first step past budget is the FAIL name. A stall closes the PR and deletes the branch.
- C4 spec base-branch gate: `validate-wo-spec.sh` and `fire.ps1` in dry-refusal mode against three fixtures (missing base, wrong base, `Base branch: dev`). Production fails closed with `c4_expected_text_unverified` while the expected refusal text is still the SPEC_GAP placeholder, and with `fire_ps1_host_missing` when `pwsh` is not already on PATH. This checkout does not run `fire.ps1`; an operator host with `pwsh` is required for that production path.
- C5 reviewer-has-spec: the latest 20 `overseer_verdicts` rows with `status='verdict'` must contain `Reviewed against WO-... @ <sha>` or `No WO spec found (<reason>)`. WARN until `OVERSEER_CANARY_REVIEW_SPEC_LANDED=1`, then FAIL. Zero reviews is WARN.
- C6 fix-loop health: ratio of automatic `overseer_remediation_candidate` dispatches to hand-fired runs for `CHANGES_REQUESTED` verdicts in 24 hours. Evidence looks like `automatic=<n> hand=<n>`. The verdict stays WARN for both values of `OVERSEER_CANARY_HANDBACK_LANDED`, including `1`. There is no FAIL threshold.
- C7 repeated-refusal tripwire: any `overseer_actions.result` seen 10 or more times in 7 days emits one `digest: <result> count=<n>` line and WARN. Nine occurrences do not. C7 never FAILs.

Only the exact value `1` enables a landed flag.

## Invocation

```bash
archon-canary overseer-loop --db-path /opt/bdc/archon-data/archon.db --output-root /opt/bdc/archon-data/canary
archon-canary overseer-loop --since-rebuild --db-path /opt/bdc/archon-data/archon.db --output-root /opt/bdc/archon-data/canary
```

`--since-rebuild` sets the report invocation to `since-rebuild`. It does not change windows or thresholds. Exit codes: 0 for PASS or WARN, 2 for FAIL, 3 for missing arguments or an unreadable database.

## Schedule

`.archon/scheduled/overseer-loop-canary-daily.yaml` is a source-only record. No scheduler consumes `.archon/scheduled` yet, and this WO does not enable the schedule or wire a rebuild hook. The daily cron in that file is `0 9 * * *`. After an archon-app-1 rebuild, the operator entry point is the `since_rebuild_command` (`--since-rebuild`).

## Alerts and digest

A FAIL posts `action: escalate_xo` to `https://n8n.bluedevilcollectibles.com/webhook/builder-status` and enqueues one Dispatch message at `POST /api/dispatch/messages` (base `ARCHON_API_BASE_URL`, header `x-archon-operator-token`) with recipient `operator`, priority `blocker`, and idempotency key `overseer-loop:<name>:<utcDay>`. PASS and WARN do not alert. The duty-officer digest is a separate Dispatch message, recipient `duty-officer`, and is one line with no newline:

```text
overseer-loop FAIL=<n> WARN=<n> PASS=<n> invocation=<daily|since-rebuild>
```

Artifacts are `summary.json` and `summary.md` under `overseer-loop-<uuid>/` in the output root.

## Locked C3 target

C3 may change only `docs/canary/overseer-loop-canary.txt` in `thinmansoftware/bdc-harness` on branch `canary/overseer-loop` against base `dev`. Any other repo or base is `target_refused` and makes no forge call. An already-open canary PR is updated. A closed PR is not reused. Event-store reads of `remote_agent_workflow_runs`, `overseer_actions`, `overseer_verdicts`, and `agent_dispatch_messages` use a readonly sqlite connection. Review bodies and result strings are data, never executed. Evidence strings are truncated to 500 characters.
