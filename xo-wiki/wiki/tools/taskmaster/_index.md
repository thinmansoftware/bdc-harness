# Taskmaster (Slice 1) -- Operator Runbook

WO: WO-HARNESS-TASKMASTER-SLICE1-01 | Authority: M-133 (CARRIED 3-0, John 2026-08-06)

The Taskmaster is an always-on deterministic loop inside the bdc-harness
server (archon-app-1, Hetzner 5.78.86.90). Every tick (default 60s) it:

1. Delivers undelivered ratified rulings (queued board-motion mailbox rows
   with no acknowledgement) to their seat.
2. Nudges idle threads past their clock: 30min P0/customer, 4h P1, 24h P2-P3.
3. Escalates unclaimed P0s to John (via the `operator` dispatch drain).
4. Sends one daily digest summarizing its journal.

All effects are dispatch messages through the existing dispatch DAL
(`agent_dispatch_messages`). It has NO spend, send-to-customer, deploy,
merge, assignment, or WO-authoring authority (Slice 1 exclusions, ratified).

## Fire source binding (PR746 source candidate, not activated)

This subsection documents `WO-HARNESS-TASKMASTER-FIRE-ALL-PRIORITIES-01`
source behavior. It does not certify deployment or authorize enabling fire.
The older Slice 1 and P0-only descriptions elsewhere on this page are
historical context, not evidence that this candidate is running.

Eligible, unclaimed P0-P3 work can produce a fire proposal. Priority determines
fire order, not permission. The fire cap is three per tick within the existing
ten-effect cap; overflow remains deferred. Assigned, claimed, blocked, or held
work cannot fire. Existing pause, backoff, and lane-budget checks still apply.
Hold labels exclude fire without changing ordinary nudge classification.

### Canonical source and trust boundary

Eligibility reuses `freezeWorkOrderSource`, resolving bdc-xo `main` to an
immutable commit before reading these exact paths in order:

1. `docs/work-orders/<WO_ID>.md`
2. `docs/superpowers/specs/<WO_ID>.md`

There is no date-glob or issue-title-search fallback for Taskmaster fires.
Issue-only specs fail closed: issue-authored `cauldron_compatible: true` and
`target_repo` fields are not an execution grant. This follows the permitted
safety alternative recorded on bdc-xo issue1843 and replaces the older WO
scenario expecting issue-only automatic eligibility. The current feature
lanes consume frozen authority artifacts, not their historical dead resolver.

Eligibility records `expectedSpec` with the full canonical source, commit
revision, and SHA-256 content hash. The legacy `specSource: repo-path` category
covers either exact committed path; `expectedSpec.specSource` distinguishes
them. Both the loop and direct proposal function require the identity to fire.
The cascade carries it through retries. Runtime resolves its own authority
policy and rejects a mismatch before worker creation or isolation.
Prior-attempt prose cannot supply or replace the binding.

Premium approval packets preserve the same constraint on resume. Original
Taskmaster packets identified by `tm:fire:` without a binding are refused.
Existing identity-less manual packets remain compatible; historical UUID
descendants do not establish Taskmaster provenance.

### Diagnose a blocked fire

- `spec_missing`: verify a spec exists at one of the two committed paths,
  rather than only in an issue body.
- `authority_conflict`: compare journal `fireEvidence.expectedSpec` with the
  canonical source and, when available, the run's authority manifest. A changed
  source, revision, or hash requires fresh eligibility and governed re-dispatch.
  Strict revision equality intentionally also refuses an unchanged spec after
  an unrelated bdc-xo main commit, including a delayed premium resume. Do not
  strip the binding to recover. This liveness tradeoff remains an activation
  decision; this source repair does not relax the same-revision/hash contract.
- A legacy Taskmaster approval packet missing its identity needs fresh
  eligibility and governed re-dispatch, not fabricated approval metadata.

Local verification from the bdc-harness checkout:

```powershell
bun test packages/server/src/taskmaster/
bun test packages/core/src/workflows/work-order-source.test.ts
bun test packages/smart-cauldron/src/__tests__/fire.test.ts
bun test packages/smart-cauldron/src/__tests__/cascade.test.ts
bun test packages/smart-cauldron/src/__tests__/frontier-approval-resume.test.ts
bun run validate
```

These commands do not deploy, unpause Taskmaster, enable firing, or satisfy
the WO's runtime stop condition. Source review and runtime acceptance are
separate gates. A supplied `healthy` classification does not suppress an
undelivered ruling; normal classification already marks that ruling ready.
This preserves the existing governance-delivery behavior.

## Environment

| Variable                       | Meaning                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `TASKMASTER_INTERVAL_MS`       | Tick interval. `60000` in production compose. `0` = KILLED (loop off, zero effects) -- this is the rollback switch. |
| `TASKMASTER_GH_REPOS`          | Comma-separated GitHub repos read as the work SOR (default `bluedevilcollectibles/bdc-xo`).                         |
| `TASKMASTER_USAGE_ARTIFACT`    | Optional path to a local usage-anchor JSON (`{"tokensRemaining": N, "observedAt": ISO}`).                           |
| `TASKMASTER_CLI_ANCHOR_CMD`    | Optional shell probe printing tokens-remaining; failure reads as UNKNOWN, never 0.                                  |
| `TASKMASTER_FIRE_VERB_ENABLED` | Enables mechanically-qualified unclaimed-P0 Cauldron fires. Default `false`; leave off through deploy.              |
| `TASKMASTER_FIRE_MAX_PER_DAY`  | Maximum successful automatic fires per UTC day. Default `2`.                                                        |

### Enable the fire verb

After the updated container and migration are verified, John can set
`TASKMASTER_FIRE_VERB_ENABLED=true` and optionally tune
`TASKMASTER_FIRE_MAX_PER_DAY`, then force-recreate the container so its env file
is re-read. Observe the first fires in `tm_journal`; every `fire_cauldron` sent
row must contain a `cascadeId`/`runId` in `proposal_json`. Set the enable flag
back to `false` and force-recreate to stop new fire proposals. The normal
Taskmaster pause with `pause_scope='effects'` also parks every fire effect.

## Status

```bash
curl -s -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  http://localhost:3090/api/taskmaster/status
```

Returns `pause_state` (RUNNING | PAUSED | HARD_PAUSE), `epoch`,
`tick_health` (healthy | degraded | not_running), `interval_ms`,
`last_tick_at`, `headroom_state` (OK | LOW | UNKNOWN), `effects_last_24h`.

`last_tick_at` is the last successfully completed tick, not merely the last
attempt. A failed startup or failed tick therefore cannot report a false-green
heartbeat. `tick_health` flips to `degraded` after 3 missed intervals; the EXTERNAL
dead-man checker in the Overseer package
(`packages/overseer/src/taskmaster-deadman-check.ts`) escalates exactly once
per degradation episode and re-arms on recovery.

GitHub work discovery accepts the `wo`, `project`, or `arc` label. Priorities
may be written as `P0` through `P3`, `prio:P0` through `prio:P3`, or
`priority:P0` through `priority:P3` (case-insensitive). `blocked` and
`status:blocked` are blocked states; `status:building` and `status:review` are
active states and prevent an item from being treated as an unclaimed P0.

When a nudge causes progress, record that evidence on the source GitHub issue
with an exact first-line marker of `[PROGRESS]` or `[BLOCKED]`. Taskmaster ignores
its own outbound dispatch row as proof of progress.

## Pause (John or operator)

```bash
curl -s -X POST -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"why","actor":"john"}' \
  http://localhost:3090/api/taskmaster/pause
```

Paused mode stops ordinary sends but NEVER stops watching: monitoring, P0
escalation, and the digest stay alive. Parked proposals are journaled with
`outcome='parked'`. An automatic circuit (forbidden/duplicate/unlogged
effect) HARD-PAUSES effects on its own; it can only tighten into pause,
never convert into KILL.

## Resume (John-authorized)

```bash
curl -s -X POST -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"actor":"john"}' \
  http://localhost:3090/api/taskmaster/resume
```

Resume increments the pause epoch only when leaving PAUSED or HARD_PAUSE.
Every successful invocation EXPIRES stale parked/pending proposals rather
than replaying them and writes its own audit (response includes
`expired_proposals` and `audit_id`). An already-RUNNING reset preserves the
epoch-start timestamp, so accumulated useful/noise grades remain in scope.

## Grading (useful / noise / unheard)

`gradeSentActions` (`packages/server/src/taskmaster/loop.ts`) grades each sent
action against action-specific external SOR evidence recorded after the send:

| Grade     | Meaning                                                                                                     | Counts toward useful-rate floor? |
| --------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `useful`  | External SOR shows downstream movement caused by the send (ruling addressed, issue closed/assigned/marked). | Yes (numerator)                  |
| `noise`   | Heard channel, proof deadline passed, no downstream movement.                                               | Yes (denominator)                |
| `unheard` | The dispatch row was never acknowledged by a non-draining principal -- nobody could have read it.           | No (excluded from denominator)   |

**M-155 Amendment 03 (John's ruling 2026-09-21).** An action is `unheard`
unless its dispatch row carries an `acknowledged_at` from a recipient whose
`delivery_mode` is NOT `drain_on_start`. A `drain_on_start` mailbox (e.g.
`operator`, and `xo`) auto-addresses within seconds and is never human-read, so
a message sent there was never actually heard. Grading such a message `noise`
conflated **channel deafness** (the M-129 Phase 2 gap) with **supervisor
uselessness** (the M-155 measurement), which triggered a false useful-rate
floor breach and self-pause on 2026-09-17.

`unheard` is excluded from the floor denominator by construction: only
`useful` and `noise` grades feed `usefulRateFloorBreached(usefulCount,
noiseCount)` (`packages/server/src/taskmaster/rules.ts`). The heard gate is
applied FIRST, before any useful/noise evaluation: a send that was never heard
is graded `unheard` immediately, even if downstream SOR movement exists,
because that movement cannot be attributed to a send nobody received
(`packages/server/src/taskmaster/loop.ts`, `gradeSentActions`). Only heard
actions fall through to the useful/noise test. `fire_cauldron` is exempt from
the heard gate -- it is a direct cascade trigger with no human-mailbox hop, so
channel deafness cannot apply, and it is graded useful/noise like before. The
40% floor value, `USEFUL_RATE_MIN_GRADED`, the auto-pause mechanism, and
"resume is an operator decision" are all unchanged.

Grade-split query:

```bash
sqlite3 /opt/bdc/archon-data/archon.db \
  "SELECT grade, count(*) FROM tm_journal WHERE outcome='sent' GROUP BY grade"
```

## Journal queries (on archon-app-1)

Activation-proof query (SC7 kill test -- binding condition 4):

```bash
sqlite3 /opt/bdc/archon-data/archon.db \
  "SELECT count(*) FROM tm_journal WHERE outcome='sent' AND grade='useful' AND action_type <> 'digest'"
```

This count is necessary but not sufficient for SC7. Each qualifying row must
also be correlated to action-specific evidence in the source SOR after the send:
a delivered ruling was addressed by its recipient, a nudge produced a source
issue close or marker, or a P0 escalation produced a close, assignee, active
status, or marker. A `fire_cauldron` row qualifies when its admitted run
completes/opens a PR or the source issue gains `status:building` before the
deadline. Digests never qualify as useful SC7 actions.

Recent automatic fires:

```bash
sqlite3 /opt/bdc/archon-data/archon.db \
  "SELECT id, created_at, outcome, grade, proposal_json FROM tm_journal WHERE action_type='fire_cauldron' ORDER BY created_at DESC LIMIT 5"
```

Recent actions:

```bash
sqlite3 /opt/bdc/archon-data/archon.db \
  "SELECT created_at, action_type, thread_ref, outcome, grade FROM tm_journal ORDER BY created_at DESC LIMIT 20"
```

Pause state:

```bash
sqlite3 /opt/bdc/archon-data/archon.db "SELECT * FROM tm_control WHERE id=1"
```

## Registering an expectation

Use the authenticated front door instead of writing `tm_expectations` directly.
From the bdc-harness checkout, register a 24-hour PR expectation with:

```powershell
scripts/taskmaster/expect.ps1 -Ref bdc-xo#2006 -Recipient fable-cursor `
  -Evidence pr_opened:thinmansoftware/fuelglass -DueIn 24h -OnAbsence escalate
```

The script calls `POST /api/taskmaster/expectations` with the operator token.
Reuse the same registration key when retrying: the first request returns a new
expectation and later requests return that stored expectation without consuming
daily-cap headroom. See
`docs/doctrine/taskmaster-expectation-registration.md` for the API contract and
evidence forms.

## Known issues

WO-HARNESS-TM-HEALTH-UPSERT-CONFLICT-FIX-01 repairs legacy on-disk `tm_health`
tables whose composite `PRIMARY KEY (provider, sampled_at)` made every
provider health upsert fail. On connection, `migrateColumns()` preserves
the table and its schema objects, retains the latest sample per provider,
and adds a provider-only unique index using an unoccupied schema name.
An existing compatible unique index makes the repair a no-op. This allows
`/api/taskmaster/status` headroom to reflect recorded spawn evidence after
the separately governed runtime rollout.

## Kill / rollback

Set `TASKMASTER_INTERVAL_MS=0` in compose and restart the container. The
loop never starts, zero effects occur, monitoring endpoints still answer
(`tick_health=not_running`). All Slice 1 migrations are additive; no
existing table was altered.

## Budgets (ratified Q1)

- Max 10 effects per tick; overflow journaled `deferred`, not dropped.
- Max 1 effect per item per tick.
- Max 3 automated interventions per item per 24h.
- Ordinary nudges require eligibility on two consecutive ticks; undelivered
  rulings and unclaimed P0s act on the confirming tick.
- Each logical effect has one journal row. A failed or deferred attempt reuses
  that row on the next eligible tick; retries are bounded by the original
  deadline, and expired rows are terminal.

## Mailbox expectation evidence (WO-HARNESS-TASKMASTER-MAILBOX-EVIDENCE-01)

Authority: bdc-xo#2028 (owner:claude, John 2026-09-22). Related: bdc-xo#2007,
#2170, #2171.

### The problem it fixes

Every Taskmaster send registers a `dispatch_reply_exists` expectation demanding
a `status='done'` reply for its correlation. That is correct for a **worker_poll**
recipient (codex, claude, cursor, duty-officer, overseer-reviewer) -- those seats
poll, work, and post a result. It is structurally impossible for a **mailbox**
recipient (`drain_on_start` / `notify_only`: operator, xo, fable, overseer,
cauldron, ...), which is READ, never replied to. So a send to a mailbox could
never be "met": it exhausted its retries, escalated a blocker to the xo mailbox,
and -- before M-155 Amendment 03 -- counted the send as 'noise', dragging the
useful-rate floor down until Taskmaster paused itself. Live on 2026-09-22: 66
unread `Taskmaster expectation EXHAUSTED` blockers in the xo mailbox, and
`tm_control` PAUSED since 2026-09-17 by `taskmaster:useful-rate-floor`.

### The evidence rule (resolved at check time, by recipient delivery_mode)

The expectation is registered with the SAME `dispatch_reply_exists` spec as
before; resolution now diverges at CHECK time by resolving the recipient's
`delivery_mode` through the same `assessDispatchRecipient` the grader already
uses (M-155 Amendment 03). No new evidence kind, no registration-site change.

| recipient delivery_mode                                                      | what satisfies the expectation                                                                                                                                    | on absence at due_at                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| worker_poll (codex, claude, cursor, duty-officer, overseer-reviewer)         | a done/succeeded reply row for correlation `tm-<id>` (unchanged)                                                                                                  | unchanged: redispatch up to max_retries, then escalate                                                                                                                                                     |
| drain_on_start (operator, xo, fable, xo-fable)                               | the dispatched row is **addressed** (`addressed_at` set); pointer `dispatch:<id>:addressed`                                                                       | escalate once to xo ONLY IF the row is also un-acknowledged; an acknowledged-but-unaddressed row is "read, in progress" -- neither met nor failed until due_at + one further PROOF_DEADLINE, then escalate |
| notify_only (overseer, cauldron, overseer-review-route, john, merge-manager) | same as drain_on_start                                                                                                                                            | same as drain_on_start                                                                                                                                                                                     |
| alias_resolved (board)                                                       | resolves to the dispatched row's `resolved_recipient` and applies THAT principal's mode (mailbox -> addressed-row proof; worker_poll/unknown -> done-reply query) | follows the resolved recipient's mode                                                                                                                                                                      |
| unknown principal (not in dispatch_principals)                               | unchanged (done-reply query)                                                                                                                                      | unchanged                                                                                                                                                                                                  |

A read is the proof. An acknowledged-but-unaddressed mailbox row is granted
exactly **one** further `PROOF_DEADLINE_MS` (24h) extension of `due_at`
(`due_extended` one-shot flag) before it may escalate.

### Escalation dedupe (terminal status, not a per-tick tuple)

An escalation for expectation E is sent at most once. A confirmed escalation
moves the row to terminal `escalated`, and `listDueExpectations` only selects
`pending`/`failed`/`escalating` -- so an escalated row is never reselected and
no later tick can re-file the blocker. The terminal status IS the dedupe (an
unconfirmed send stays `escalating` and is replayed under its deterministic
escalation `idempotency_key`, which the dispatch DAL dedupes to exactly one
operator task). An earlier `last_escalation_state` evidence-tuple suppression
mechanism was removed as dead code: it could only ever be read from a reselected
row, which the terminal status guarantees never happens.

### Grading (M-155 Amendment 03 kept, plus one mailbox refinement)

Amendment 03 stands: a `drain_on_start` send never acknowledged by a
non-draining principal is graded `unheard` and excluded from the useful-rate
floor denominator. Added refinement, scoped to heard mailbox (`notify_only`)
nudges/escalations: a row that is **addressed** before its deadline is graded
`useful` (mailbox work can raise the numerator, not only avoid the denominator),
and a row only **acknowledged** (read, still open) is left ungraded (in progress)
rather than counted noise.

### Regrade script -- `regrade-unmeetable-expectations`

Historical rows graded before Amendment 03 still count in the epoch-bounded
lookback on resume. This one-shot script repairs them so the floor is computed
honestly. It is **dry-run by default** and NEVER run by the loop.

```
# Dry run -- prints the count of matching rows, mutates nothing:
bun scripts/taskmaster/regrade-unmeetable-expectations.ts

# Confirm -- give up the matched expectations and regrade their journal actions:
bun scripts/taskmaster/regrade-unmeetable-expectations.ts --confirm
```

It selects `tm_expectations` rows in status `escalated`/`failed` whose recipient
resolves (via `dispatch_principals`) to a mailbox principal and whose evidence
kind is `dispatch_reply_exists`; on `--confirm` it sets those rows `given_up`
with reason `unmeetable_mailbox_reply_spec`, clears the linked `tm_journal`
action's `grade` to NULL, and writes exactly one `tm_journal` note citing
bdc-xo#2028. It is idempotent: a second `--confirm` run matches 0 rows and does
not duplicate the note. Test: `bun run test:taskmaster-regrade`.

### Resume procedure (operator, after the rebuild)

Taskmaster stays PAUSED through the deploy; resuming is John's action.

1. Deploy: the change lands on `archon-app-1` on the next `rebuild-archon.sh`.
   Migration 056 (`due_extended`) is additive; apply it
   to `/opt/bdc/archon-data/archon.db` with a `.backup` first (rebuild runbook).
2. Regrade the history: run `regrade-unmeetable-expectations.ts --confirm` once
   against the live db (after the backup).
3. Verify the floor is honest over the 2026-09-15..21 window
   (`usefulRateFloorBreached` returns false, or graded < `USEFUL_RATE_MIN_GRADED`).
4. John resumes Taskmaster (`POST /api/taskmaster/resume`, or the reset DAL).
5. Verify within 24h of RUNNING:
   - no new mailbox `dispatch_reply_exists` expectation is `escalated`
     (Stop 7 sqlite count returns 0);
   - at least one mailbox expectation is `met` with an `evidence_pointer` ending
     `:addressed`.

Acceptance: Taskmaster does not pause itself again within 24h, and the xo mailbox
receives at most one blocker per genuinely unmet expectation.
