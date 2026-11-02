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
| `T3_COMMAND_PROJECTS` | unset | Comma list of allowed project (codebase) names. Unset = every command refused 403 `project_not_allowed`. A project must also be a registered codebase. |
| `T3_COMMAND_APPROVE_BASES` | unset | Comma list of allowed PR bases as `owner/repo:branch`. Unset = every approve refused 403 `base_not_allowed`. NEVER list a production base (M-09). |

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
  "thread_id": "... | null"
}
```

Status codes: 200 ok, 400 invalid, 403 forbidden, 409 conflict, 422 stale_head.

## Decision rules (summary)

- Admission dedupe by `request_id` in `t3_command_admissions`: a retry with the
  same digest and actor replays the original outcome; a reuse with a different
  digest or actor is refused 409 `request_conflict`, leaving the original row
  and its reply unchanged.
- fire: refused 409 `live_run` when any `remote_agent_workflow_runs` row in
  status pending/running/paused names the exact WO id (token match), or another
  fire admission for the WO is reserved. Otherwise runs the same in-process
  cascade Taskmaster uses (no HTTP self-call, no operator token header).
- cancel-own: allowed only when the actor fired that run through this consumer.
- approve: every binding is derived server-side (ownership, run repo = project
  repo = PR repo, same-repo head ref = run branch, base allowlisted, PR current
  head = stated `head_sha`). Production bases are never allowlisted.
- Crash safety: a fire left `reserved` at startup is marked `unknown`, replied
  409 `admission_unknown`, and is NEVER refired automatically.

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
