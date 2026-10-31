# XO advisory delegate - staging only

This service implements the approved Terra6.1 routine-advice / Sol6.1 important-opinion policy. It is not a replacement for the incumbent interactive XO. The Board alias, lease holder, named-pipe delivery, Dispatch, builder ladder and formal independent code-review gates are unchanged.

## Verified binding and invocation

Readback on 2026-10-31: `/api/board/recipient` resolved to `xo-claude-board-work`. Local designation named an interactive Claude session, not a generic Codex worker. This observation must be refreshed for any later action.

`POST /api/board/xo-advice` is mounted in `registerApiRoutes` behind the existing private operator middleware. It additionally authenticates `x-board-principal-token` with the existing Board registry. Only the principal holding the current unexpired XO lease may invoke it. Request `lease_id` and `fencing_token` must match; the lease is rechecked before each paid leg and before completion. This code never acquires, renews or releases the production lease.

The route defaults disabled. This phase only permits `XO_ADVICE_MODE=staging` with `NODE_ENV` other than `production`. Staging needs an explicit absolute `XO_ADVICE_LEDGER_PATH` and an existing `OPENROUTER_API_KEY`. Missing configuration fails closed. No key belongs in a request, script argument, config commit or transcript.

## Request and response contract

The strict schema lives in `packages/server/src/routes/schemas/xo-advice.schemas.ts`: UUID request ID, exact lease ID/fence, task, category (`status`, `duplicate_work`, `checkpoint`, `important`), capture timestamp and 1-8 GitHub evidence records with unique IDs. Each source is bounded to16000 characters; serialized packets are bounded to65000 bytes. Only captured GitHub URLs under the harness/XO repositories are accepted. File paths, unknown actor fields, evaluation-source URLs, duplicate source IDs and stale captures are refused. There is no file or corpus retrieval. Dummy held-out URLs test refusal; actual held-out files are never opened.

Capture metadata is caller supplied, not independent live verification. The authenticated XO must construct an evidence packet from verified reads. Do not send customer data or secrets. Common credential forms are rejected; this is not a general data-loss-prevention classifier.

Consequential content in the original packet or Terra's answer forces Sol even if the caller says routine or Terra reports important=false. Classification is deliberately conservative and may request Sol on otherwise routine summaries. Sol's request contains the same original evidence/prompt, never Terra's answer. There is no automatic third critique.

The only model function is `submit_brief`, which returns data. Completion requires bounded valid output, known source IDs, false live-change authority, exact served model, an OpenAI generation receipt and matching cost. `advisory_complete` means a complete advisory exchange, not source acceptance, truth certification, consensus or permission to execute. The owner must assess the two opinions and resolve disagreements. Syntactic citation validation does not prove every claim true.

## Durable pilot and failure behavior

The separate single-owner SQLite ledger has one fixed $1 lifetime campaign. Both potential legs are reserved atomically before Terra so importance upgrades cannot bypass the Sol budget. Routine work charges only Terra; a never-started Sol reservation is released. Rates are refreshed from the exact `openai` endpoints including peak overrides, then enforced with max_price and no fallback. Serialized request bytes plus margin conservatively bound input; output is capped at6000 tokens.

Request ID, immutable packet hash, original evidence and lease binding are durable. Duplicates are refused, including changed IDs for identical packets. Calls persist requested/served identity, reported charge, verified provider receipt and final/incomplete advice. Unverified billing/identity retains the full reservation and halts the campaign. In-flight work found after restart halts admission. No automatic reset, retry, paid fallback, campaign-creation endpoint or deletion path exists.

SQLite exclusive locking prevents two owners using the same file. This does not enforce a fleet cap across different files/volumes; only one reviewed instance and canonical persistent ledger may be activated. Production acceptance must prove this deployment binding or replace it with an approved shared-budget mechanism.

## Isolated HTTP acceptance

Run from the worktree root:

```powershell
$env:XO_ADVICE_STAGE_DIR='C:/Users/pcmed/Downloads/xo-advice-stage-offline-20261031'
bun run scripts/staging/xo-advice-http.ts
```

This creates only a separate local Board principal, real isolated lease DB and loopback listener, then shuts it down. Offline model responses are explicitly protocol controls, not model performance proof. Existing report files prevent implicit replay.

Paid acceptance requires the approved pilot allowance:

```powershell
$env:XO_ADVICE_STAGE_DIR='C:/Users/pcmed/Downloads/xo-advice-stage-paid-20261031'
bun run scripts/staging/xo-advice-http.ts --paid
```

All paid runs share the pinned campaign file `~/Downloads/terra-xo-lane-approval-20261031/XO-STAGING-PILOT.sqlite`, regardless of report directory. Never delete or replace it to retry. Paid mode uses `xo-advice-relay.py` through the existing SSH/container credential boundary; it executes a process in the live host/container and spends OpenRouter credits, but does not copy credentials or change the live app/config/database/registry/lease. The report distinguishes these effects explicitly.

The HTTP runner verifies operator/Board refusal, strict body validation, stale fence, Terra-only routine work, duplicate refusal, independent Terra+Sol important work and the shared cap. Paid source packets contain a small fresh GitHub capture, not evaluation cases. It records model IDs, input hashes, receipts, ledger, source hashes and source commit. Keep reports and ledger private locally; no API secret is included.

## Review and go-live boundary

Before live use: exact-head independent review and required CI, staged served-model receipts, a canonical persistent single-writer ledger binding, rollback evidence and an environment/commit-scoped production motion with required recorded approvals. The incumbent coordinator must explicitly adopt the delegate; merely installing the endpoint does not reroute interactive sessions.

Rollback is to keep the route disabled and stop its separate listener, preserving ledger and receipts. Disabling the delegate does not change or restart the incumbent XO and never repeats in-flight work. No production activation or adoption is authorized by this staging implementation.
