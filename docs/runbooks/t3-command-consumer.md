# T3 command consumer (cauldron-fire) runbook

WO-HARNESS-T3-COMMAND-CONSUMER-01

The cauldron-fire command consumer decides typed commands (fire / cancel-own /
approve) sent by an authorized Dispatch principal to the harness recipient
`cauldron-fire`, server-side inside archon-app-1. It is a background clock
(`packages/server/src/dispatch/cauldron-fire-consumer.ts`) that drains the
`cauldron-fire` mailbox, decides each command exactly once, replies to the
submitting actor, then acknowledges the command row.

It ships DISABLED. Nothing reads or writes until an operator turns it on, mints
the t3-bridge principal, and sets the allowlists (all below, all John's go).

## Environment flags

| Variable | Default | Meaning |
|---|---|---|
| `T3_COMMAND_CONSUMER_ENABLED` | unset (off) | Set to `1` to start the clock. Off = no reads, no writes. |
| `T3_COMMAND_POLL_MS` | `15000` | Poll interval in ms (minimum 1000). |
| `T3_COMMAND_ACTORS` | unset | Comma list of principal ids allowed to send commands. Unset or empty = every actor refused 403 `actor_not_allowed`. |
| `T3_COMMAND_PROJECTS` | unset | Comma list of allowed project names, as the command sends them (the bare repo name, for example `bdc-xo`, the same naming as `fire.ps1 -Project` and fire-eligibility). Unset = every command refused 403 `project_not_allowed`. A project must also resolve to a registered codebase: an exact codebase name, or a bare repo name that matches exactly one `owner/repo` codebase (two or more matches = 400 `project_not_registered`, fail closed). |
| `T3_COMMAND_APPROVE_BASES` | unset | Comma list of allowed PR bases as `owner/repo:branch`. Unset = every approve refused 403 `base_not_allowed`. NEVER list a production base (M-09). |
| `T3_COMMAND_MAX_AGE_S` | `900` | A NEW command (no existing admission) older than this is refused 409 `expired` (Amendment 5 A5.6). |
| `T3_APPROVAL_HANDOFF_S` | `120` | An approval's `failed` hand-off counts as live/transitional only this long after `approval_received` (A5.9). |
| `T3_COMMAND_RESERVATION_STALE_S` | `300` | A `reserved` admission not updated for this many seconds, and not held by a handler in this process, is recovered at the start of the next tick (all verbs). |

## Command and reply contract

Command envelope (a Dispatch `agent_message`):

- `sender` = `t3-bridge` (must equal the authenticated `sender_principal_id`)
- `recipient` = `cauldron-fire`
- `correlation_id` = `idempotency_key` = `body.request_id`
- Body JSON:

```
{
  "schema": "t3-command/v1",
  "request_id": "<uuid>",
  "verb": "fire" | "cancel-own" | "approve",
  "wo_id": "<WO id>",            // fire
  "project": "<codebase name>",
  "lane": "<optional entry lane>",
  "run_id": "<run id>",          // cancel-own
  "pr": "owner/repo#N",          // approve
  "head_sha": "<40-hex>",        // approve
  "run_id_for_approve": "<run id>", // approve
  "thread_id": "<thread id>"
}
```

Reply (one Dispatch `agent_message`):

- system sender `cauldron-fire`
- recipient = the submitting actor credential's first `receive_as` entry
  (`t3-desktop` for `t3-bridge`)
- `correlation_id` = the submitted `request_id`
- `idempotency_key` = `reply:<source command message id>` (the
  `agent_dispatch_messages` id of the command row answered, so every distinct
  submission gets its own reply identity while re-processing the SAME command
  row after a crash cannot create a second reply)
- Body JSON:

```
{
  "schema": "t3-command-reply/v1",
  "request_id": "...",
  "verb": "...",
  "status": 200 | 400 | 403 | 409 | 422,
  "code": "ok" | "actor_not_allowed" | "project_not_allowed" | "invalid_body"
        | "request_id_mismatch" | "unknown_verb" | "request_conflict"
        | "live_run" | "forbidden_not_own_run" | "run_pr_mismatch"
        | "base_not_allowed" | "stale_head" | "admission_unknown" | ...,
  "run_id": "... | null",
  "cascade_id": "... | null",
  "thread_id": "... | null",
  "error_class": "<error class name>",   // 503 failed_before_effect only
  "message": "unknown, adjudication required" // 409 admission_unknown only
}
```

Status codes: 200 ok, 400 invalid, 403 forbidden, 409 conflict, 422
stale_head, 503 failed_before_effect. (202 `pending` was removed by Amendment 5:
Dispatch returns the ORIGINAL command row for a same-actor resend of a
request_id, whatever the body, so a same-actor retry row never exists. The only
outcome channel for a request is `reply:<original command id>`.)

Amendment 5 additions to the contract:

- Fire `wo_id` must be exactly one canonical WO id (`^WO-[A-Z][A-Z0-9-]*-\d+$`,
  at most 96 characters), else 400 `invalid_wo_id`; it must equal the
  eligibility evidence's WO id (409 `wo_id_mismatch`) and the request's project
  must equal the spec's own project (409 `wo_project_mismatch`). The pinned spec
  revision (`expectedSpec`) is passed to the cascade.
- Approve must carry `node_id`, the approval node the actor reviewed: a
  different paused gate is 409 `gate_mismatch`; an `interactive_loop` or
  `captureResponse` gate is 409 `gate_not_supported`. Approve is bound to the
  owning fire admission's project exactly like cancel-own.
- `request_id` and `thread_id` are at most 128 characters (400 `invalid_field`).

Approve success codes: `approved` (the approval was recorded AND the run's
resume was dispatched) or `approved_not_resumed` (recorded, but the resume was
not dispatched -- missing conversation, non-web parent or missing workflow).
`approved_not_resumed` is an OPERATOR FOLLOW-UP: the run sits in the approval
hand-off state until someone re-runs it from the dashboard.

## Decision rules (summary)

- Admission dedupe by `request_id` in `t3_command_admissions`: a retry with the
  same digest and actor replays the original outcome; a reuse with a different
  digest or actor is refused 409 `request_conflict`, leaving the original row
  and its reply unchanged.
- fire: refused 409 `live_run` when any `remote_agent_workflow_runs` row in
  status pending/running/waiting_provider/interrupted/orphaned/paused (or a bounded approval hand-off `failed`) names the exact WO id (token match), an active shared WO claim exists, or another
  fire admission for the WO is `reserved`. While a fire for the WO is `unknown`
  (awaiting adjudication) a new fire is refused 409 `admission_unknown`
  carrying the ORIGINAL admission's request_id in `run_id`, the key to
  adjudicate. Otherwise runs the cascade (runCascade)
  in-process (see "In-process execution" below): no HTTP self-call, no
  operator token header.
- cancel-own: allowed only when the actor fired that run through this consumer.
- cancel-own project binding (Amendment 4): the run's project is the one its
  owning fire admission recorded. A request naming another project is refused
  403 `project_mismatch`; a recorded project no longer in
  `T3_COMMAND_PROJECTS` is refused 403 `project_not_allowed`. No cancel call.
- Run custody (Amendment 3): a fire admission owns EVERY run its cascade
  creates, on every tier. Each discovered run is appended to
  `t3_command_run_custody` (admission_id, run_id, tier, discovered_at; unique
  run_id; append-only). Ownership for cancel-own and approve reads custody;
  only when no custody row exists for a run does it fall back to the actor's
  cascade records, logging `cauldron_fire_custody_fallback_used` and appending
  the missing row.
- approve: every binding is derived server-side (ownership, run repo = project
  repo = PR repo, same-repo head ref = run branch, base allowlisted, PR current
  head = stated `head_sha`). Production bases are never allowlisted.
- Approve contract (Amendment 2 A2.1): the consumer approves through exactly
  the pair the HTTP approve route uses -- `approvePausedWorkflowRun` followed by
  `tryAutoResumeRun(run, 'approve')` (hoisted to module level in
  packages/server/src/routes/api.ts; consumer wrapper `approveRunWithResume`).
  The run row passes through `failed` (the approval's hand-off) and the
  executor's resume continues it. The background cascade for a consumer fire is
  given `isApprovalHandOff` so that hand-off `failed` (latest decisive event
  `approval_received`, no later `*_failed` event) is not read as terminal.
- Outcome states (Amendment 2 A2.2), for fire, cancel-own and approve alike:
  `reserved -> admitted | refused | unknown`. `effect_started_at` is written in
  its own commit immediately BEFORE the side effect (fire: the cascade
  dispatch; cancel-own: the cancel call; approve: the approve call).
  - Exception with no effect marker -> `refused`, 503 `failed_before_effect`
    with `error_class`; the lock is released; resend with a NEW request_id.
  - Exception with the effect marker set -> `unknown`, 409 `admission_unknown`;
    the lock is HELD until adjudication: the WO fire lock for a fire, the RUN
    LOCK (`idx_t3_command_admissions_run_lock`, one unresolved cancel-own /
    approve per `target_run_id`) for cancel-own and approve. A new command
    against a held lock is refused 409 `admission_unknown` with the holding
    request_id in `run_id` (or 409 `command_in_flight` while the holder is
    still `reserved`).
  - The admission's own SOURCE command row is never answered by the tick
    (Amendment 4): re-read while `reserved` (for example after a restart) it
    stays queued with no reply and no ack; the in-flight handler or recovery
    owns its final reply under `reply:<source_message_id>`.
  - A command is NEVER acknowledged without a durable reply row: if the actor's
    mailbox cannot be resolved the row stays queued (Amendment 5 A5.5).
- Recovery (all verbs, start of every tick, so also at startup): a stale
  `reserved` row with no effect marker -> `refused` 503 `failed_before_effect`
  (`error_class` `RecoveredBeforeEffect`); with the marker and a provable
  outcome -> `admitted` (fire: run custody; cancel-own: run cancelled with this
  actor on its `run_cancelled` event; approve: `approval_received` after the
  marker, code `approved_not_resumed`); otherwise -> `unknown`. Recovery replies
  as `reply:<source_message_id>`, acknowledges, and never re-executes a verb.
- Unprovable fire (in-flight): if the cascade throws, returns no run id, or its
  admitted outcome fails to persist, the admission is reconciled to `unknown` and
  replied 409 `admission_unknown` -- never a 5xx, since the status set above is
  closed. It is never marked `refused` (that would release the WO and permit a
  duplicate fire once the run completes). Any cascade/run id actually observed is
  retained on the row, so a retry replays the same outcome AND the same run
  identity. Never refired automatically; an operator adjudicates.
- WO fire lock: an `unknown` fire holds the WO exactly like a `reserved` one
  (partial unique index `idx_t3_command_admissions_wo_fire_lock` on
  `(wo_id) WHERE verb='fire' AND state IN ('reserved','unknown')`, migration
  067, mirrored in the SQLite adapter and 000_combined.sql). Every new fire for
  that WO is refused 409 `live_run` until an operator adjudicates it.

## Shared WO claim (Amendment 5 A5.0, General's verdict)

Taskmaster and the T3 consumer share ONE database WO claim,
`cascade_wo_claims` (partial unique index on `wo_id` WHERE state='active'),
acquired through runCascade's WO-lock seam BEFORE any dispatch and released
only when the cascade record is terminal -- so it is held through every tier,
pause and discovery. Both callers pass `cascadeWoClaimDeps(...)`
(packages/server/src/cascade/wo-claim.ts). A cascade refused by the claim
returns `blocked` with zero attempts; the consumer replies 409 `live_run`
(admission `refused`). Taskmaster's `tm_fire_admissions` budget is untouched;
T3 fires are not charged to it.

Release is OUTCOME-CONDITIONAL (Overseer round 1 under Amendment 5; XO
decision 2026-11-03). runCascade calls releaseWoLock whenever it exits;
smart-cauldron's own file lock keeps that behavior for every other caller, but
this DB claim is released only when the cascade record is terminal AND every run
under it is terminal (no resumable run, no approval hand-off). Otherwise it is
RETAINED (`retained_reason` = the record status, `record_missing`, or
`run_not_terminal`; `run_ids_json` = the cascade's runs) and released later by:

- (a) the resumed cascade: `POST /api/cascades/{id}/approve-frontier` takes the
  claim over for the resume cascade id BEFORE dispatch (`takeOverWoClaimForResume`:
  transfer from the paused cascade, or a fresh claim when none is held; any other
  holder -> 409, approval rolled back, nothing fired), runs the resume with the
  shared claim deps, and the resumed cascade releases it at terminal;
- (b) an operator, through the operator-token API (CAS on the named holder):

```
curl -s -X POST http://localhost:3090/api/cascade-wo-claims/release -H "x-archon-operator-token: $TOKEN" -H 'content-type: application/json' --data '{"woId":"<WO id>","cascadeId":"<cascade id>"}'
```

- (c) reconcile (`reconcileRetainedWoClaims`, every consumer tick): releases a
  retained claim whose record is not paused/handed-off/delegated and whose
  recorded runs are all terminal in the event store.

There is no time-based expiry.

Known gap (scoped out): approving a frontier pause of a cascade the T3 consumer
fired (its `apiBaseUrl` is the in-process origin) returns 409
`t3_frontier_resume_unsupported` -- no dispatch, the approval rolls back, the WO
claim stays retained. The fix is WO-HARNESS-T3-FRONTIER-RESUME-TRANSPORT-01
(bdc-xo issue 4410). Until then an operator rejects the pause or releases the
claim (above).

Approve is ONE transaction on the reviewed gate (gate update + node_completed + approval_received; any failure rolls all three back): the consumer passes
`node_id` to `approvePausedWorkflowRun`, which flips paused -> failed with a
conditional update on (run id, paused, current gate node) BEFORE writing any
approval event; if the gate moved, the reply is 409 `gate_changed` and nothing
is written. The HTTP approve route is unchanged.

## Single consumer and poison rows (Amendment 5 A5.7, A5.12)

- The consumer ticks only while holding the `t3_consumer_lease` row (CAS
  acquire/renew each tick, TTL max(60 s, 3 x poll)). A second process (rebuild
  overlap, second server) does nothing until the lease expires.
- Every admission transition is CAS from `reserved`; a miss before an effect
  aborts the effect with no reply and no ack.
- The reply for a decided command is always the DURABLE decision: if a
  handler's terminal transition (admitted / refused / unknown) lost its CAS, the
  ledger's decision is replied instead, or 409 `stale_reservation` when no
  decision exists -- never the handler's success.
- The lease is renewed before EACH command (a lease lost mid-batch stops the
  batch). Lease TTL: `T3_COMMAND_LEASE_TTL_S`, default 900 s (15 min). Bound:
  the longest handler is a fire, which holds the tick until run discovery --
  preflight + seat read (~30 s) + prior-run teardown wait
  (`SMART_CAULDRON_TEARDOWN_WAIT_MS`, default 180 s) + run discovery (30 s),
  about 4 minutes -- so the default is over 3x the longest handler. Raise it if
  the teardown wait is raised.
- Recovery skips any reservation whose handler is still in flight in this
  process.
- OPERATING ASSUMPTION / known gap: today the harness runs ONE consumer process
  in ONE container (archon-app-1). Cross-process fencing of recovery against a
  live handler in ANOTHER process (a lease epoch / fencing token) is not built:
  WO-HARNESS-T3-CONSUMER-LEASE-EPOCH-FENCING-01 (bdc-xo issue 4421). Do not run
  a second consumer process (T3_COMMAND_CONSUMER_ENABLED=1 in two containers)
  until it lands.
- A command row that fails processing 3 times (`t3_command_attempts`) is
  acknowledged, addressed and dead-lettered: one Dispatch message from
  `cauldron-fire` to `operator` (`idempotency_key` `dead-letter:<message id>`).

## In-process execution (fire)

The consumer runs `runCascade` with `apiBaseUrl` = `http://archon.in-process`
and `fetchImpl` = `createInProcessApiFetch(app)`
(packages/server/src/routes/in-process-authority.ts), wired in
packages/server/src/index.ts. Every Archon API call the cascade makes
(codebase lookup, conversation dispatch, run discovery, poll, node timeouts,
cancel, seat read) is dispatched straight into this process's own router with
`app.fetch` -- no socket, no network self-call. Authority: the /api auth
middleware admits a Request only if it was created by that function in this
process (a WeakSet membership no network request can forge); principal headers
are stripped on that path and any other origin is refused. No operator token is
read or sent. Without the in-process dispatcher the consumer refuses to start
(`cauldron_fire_consumer_in_process_api_missing`).

## Adjudicating an unknown fire (operator)

An `unknown` fire is never refired and holds its WO lock until adjudicated.
First establish the truth on the event store: did request `<request_id>`
(its `cascade_id` / `run_id` columns, and `remote_agent_workflow_runs` rows
naming the WO) create a run? Then, inside archon-app-1:

```
docker exec -w /app archon-app-1 bun -e "const a = await import('@archon/core/db/t3-command-admissions'); console.log(JSON.stringify(await a.adjudicateUnknownFire('<request_id>', { resolution: 'no_run', adjudicated_by: '<who>', now: new Date().toISOString() })))"
```

- `resolution: 'no_run'` -> row becomes `refused`, code
  `adjudicated_no_run:<who>`; the WO lock is released and a NEW request_id may
  fire it.
- `resolution: 'run', run_id: '<run id>'` -> row becomes `admitted` 200 `ok`
  with that run; the original actor owns it for cancel-own / approve and the
  lock is released (later fires are gated by the live-run check).

Result `status`: `adjudicated`, `not_found`, or `not_unknown` (the row was not
`unknown`; nothing changed). Adjudication is a compare-and-set and never
deletes the row.

## Adjudicating an unknown cancel-own / approve (operator)

An `unknown` cancel-own or approve holds its run lock until adjudicated. Read
the run's events first (`run_cancelled` with this actor; `approval_received`
after the row's `effect_started_at`), then inside archon-app-1:

```
docker exec -w /app archon-app-1 bun -e "const a = await import('@archon/core/db/t3-command-admissions'); console.log(JSON.stringify(await a.adjudicateUnknownRunCommand('<request_id>', { resolution: 'no_effect', adjudicated_by: '<who>', now: new Date().toISOString() })))"
```

- `resolution: 'no_effect'` -> `refused`, code `adjudicated_no_effect:<who>`.
- `resolution: 'effect_applied'` -> `admitted` 200 (`ok` for cancel-own;
  `approved_not_resumed` for approve -- follow up on the run's resume).

Either releases the run lock. Same result statuses as the fire adjudication.

## Principal issuance (operator, John's go)

The credential is issued by the harness principal registry
`DISPATCH_PRINCIPALS_JSON` (the shopops tenant_secrets vault issues nothing to
the harness).

1. Generate a 32-byte random token on the operator machine:

   ```
   head -c 32 /dev/urandom | base64
   ```

2. Compute its sha256 (hex):

   ```
   printf '%s' '<RAW_TOKEN>' | sha256sum | cut -d' ' -f1
   ```

3. Add the record to `DISPATCH_PRINCIPALS_JSON` in the archon-app-1 env file and
   restart the container (a container config change -- John's go). The t3-bridge
   record gets `send` + `receive` only, never `admin`:

   ```
   {"credential_id":"t3-bridge-1","principal_id":"t3-bridge","token_sha256":"<sha256 hex of raw token>","status":"active","send_as":["t3-bridge"],"receive_as":["t3-desktop"],"roles":["send","receive"]}
   ```

   [UNVERIFIED] The env file path is expected to be `/opt/bdc/archon/.env`; the
   operator confirms the actual path read-only before editing. This WO does not
   edit the live env.

4. Deliver the RAW token over `ssh ops@t3-vps` into
   `/home/t3/.config/t3-bridge/dispatch-principal` as user t3 with `umask 077`.
   Never through chat, a ticket, or a log.

5. Turn the consumer on and set the allowlists (operator env, John's go):

   ```
   T3_COMMAND_CONSUMER_ENABLED=1
   T3_COMMAND_ACTORS=t3-bridge
   T3_COMMAND_PROJECTS=<comma list of codebase names>
   T3_COMMAND_APPROVE_BASES=<owner/repo:branch,...>   # never a production base
   ```

## DISPATCH_SENDER_AUTH_MODE

The principal transport (POST/GET `/api/dispatch/messages`, POST
`/api/dispatch/messages/{id}/ack`) authenticates the principal headers directly
via `authenticateDispatchPrincipal`; it does NOT require
`DISPATCH_SENDER_AUTH_MODE` to be set. Verified in the api.ts auth middleware
and by Test 9. Leave it unset (defaults to `off`) unless another consumer needs
it; if set, it must be one of `off` | `warn` | `enforce` (an invalid value fails
closed with HTTP 500). This WO does not change it.

## Revocation (one line + restart)

Remove the `t3-bridge` record from `DISPATCH_PRINCIPALS_JSON` (or set its
`status` to `disabled`) and restart archon-app-1. Optionally also clear
`T3_COMMAND_ACTORS` / `T3_COMMAND_PROJECTS` to refuse everything.

## Blast radius

Anything that can read the t3-bridge token can send commands within that grant
(send as t3-bridge; receive t3-desktop; fire/cancel-own/approve on allowlisted
projects and non-production approve bases only). It CANNOT reach any other
route: principal headers on any route other than the Dispatch transport get
HTTP 403 `dispatch_principal_forbidden`, and a list for a recipient outside
`receive_as` is also 403. Revocation is one env edit plus a restart.
