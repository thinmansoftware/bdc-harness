# Offline Dynamic Lane behavior v4

Proposed October 15, 2026 amendment for #2475 and #3264. Haiku is the default decision engine. No live authority is created.

## Scope and versions

Extend #1024's pure evaluator/replay CLI. Supplied snapshots and synthetic/recorded exchanges produce deterministic receipts. No network/model calls, database writes, reservations, leases, dispatch, workflow registration or cancellation. Reuse existing DagNode, RunAuthorityRecord, ProviderAttemptRecord and ExecutionCapability types where applicable; new fields are local contract fields, not DB columns. Derive validation/types from one schema.

Versions: `dynamic-lane-snapshot/v4`, `dynamic-lane-request/v1`, `dynamic-lane-response/v1`, `dynamic-lane-receipt/v4`, policy `offline-admission/v4`. Explicit v3 Jev inputs retain legacy parsing/receipt provenance with reviewed tie/limit/semantic fixes. Never silently migrate their hashes or invent Haiku probabilities. Offline inputs cannot claim live provenance.

## Snapshot and evidence

Structural envelope requires supported version, fixed evaluationTime, runId, nodeId, actual DagNode, role, candidates and policy. Require nodeId == node.id. Invalid types/timestamps, duplicate candidate/account/profile/route IDs and nonfinite/negative amounts/counters fail parsing. Unsupported envelope versions fail.

Omitted/null/empty taskBrief, roleObjective, decisionEvidence and candidateProfiles normalize to unknown semantic evidence and evaluated abstention, exit 0. Well-shaped unsupported semantic packet versions yield insufficiency; malformed envelope types still fail. Missing authority/capacity/cost/identity is unknown, never a process default.

Required proposal evidence:

- Matching authority/scope, ready dependencies, no cancellation/pause, valid custody, active-writer evidence and acknowledged cancellation where applicable.
- Explicit candidate allowlist/configured binding, required capabilities/context compatibility.
- Known account-specific capacity: account/seat/window, observedAt/expiresAt, sourceRef and state. Require observedAt <= evaluationTime < expiresAt. ResetAt alone never proves recovery.
- Run/account spend, limits, commitments, verification allowance, bounded router and next-step estimates. Unknown cost is insufficient. Decision routes/workers identify account and transport.
- Monthly policy tagged `uncapped` or `limited`, effectiveFrom/effectiveUntil and authorizationRef. October 2026 uncapped follows #3264; missing/null/expired is unknown. Other configured limits remain binding.
- Existing worker attempts/providerAttemptCeiling, plus independent routerCallsConsumed/routerCallCeiling. routerCallsConsumed means run-wide calls consumed BEFORE this decision's first attempt and excludes the supplied current-decision history. Derive resulting consumption by adding unique actual calls in that history; never reset on fallback/replay. Check capacity BEFORE each call; a final successful call that brings resulting consumption exactly to the ceiling remains valid. Skipping an unavailable route makes no call and consumes zero calls.
- For review: matching artifact/target hashes, all contributor served families with identity provenance, candidate-family mapping and explicit strong-reviewer qualification/version. Haiku is excluded.

Preserve v3 task/acceptance/evidence/profile packets and availableAt <= evaluationTime. Reject this decision's later outcome as input. Initial intake may cite explicit no-prior-artifact evidence. Profiles need applicable observations, sources and limitations. Small synthetic tests do not certify role winners or probabilities.

## Normalized request and response

Request fields: schemaVersion, decisionId, policyVersion, promptVersion, snapshotHash, runId, nodeId, role, taskBrief, roleObjective, decisionEvidence, eligibleCandidates, allowedChoices and routingResourcePlan. Candidates include exact candidateId, sanitized resolved provider/model/account/transport, applicable profile and code-computed capacity/budget facts. allowedChoices is exactly eligible IDs plus `abstain`. No eligible candidate means no request.

Canonical JSON sorts object keys, preserves defined array order and appends one newline for CLI output. snapshotHash covers normalized decision inputs excluding exchanges, output and prior-decision ledger (avoiding self-reference); record that ledger's separate canonical hash as priorLedgerHash in the receipt. requestHash covers the actual canonical request. A decisionId binds to one snapshotHash. Supply a trusted prior-decision ledger/reference with availableAt/sourceRef and known prior decisionId/snapshotHash/receipt references (explicit empty ledger is allowed). Detect conflicting ID/hash reuse only against that supplied evidence. Missing ledger is insufficient evidence. An identical supplied completed-decision receipt is validated and replayed, not charged again. The pure CLI cannot detect reuse across unrelated files or retain counters; cross-invocation uniqueness/durability belongs to the later runtime store. Stable input/time/exchanges produce byte-identical receipts.

Response fields: schemaVersion, decisionId, requestHash, snapshotHash, choice (`select` or `abstain`), candidateId (eligible ID for select, null for abstain), rationale and evidenceReferences. Reject extra/unknown fields, illegal choice/ID combinations and references absent from request evidence. Bound rationale to 2,000 characters; it is explanation, not authority.

Exchange provenance is separate: decisionId, snapshotHash, requestHash, engineId, adapterId, transport (`subscription` or `api`), sanitized accountId, origin (`synthetic` or `recorded`), requestedModel, servedModel or explicit unknown, attemptId, startedAt/completedAt, usage/latency/cash cost or explicit unknowns, outcome class, normalized response or null. Every actual exchange, including availability/quota failures with response null, requires its own decisionId/snapshotHash/requestHash bound to the current decision and normalized request before fallback can advance. Missing correlation is malformed exchange evidence; mismatched correlation waits without selecting a worker, preserving supplied actual-call accounting. A successful response repeats and independently validates the same identifiers. Validate identity/route/account/time/hash consistency. Synthetic served identity is only a fixture assertion. Unknown served identity in recorded qualification produces wait; request/auth-cache presence is not proof.

Distribution/confidence is optional adapter evidence. Haiku/Luna invent neither. If supplied, probabilities must be finite and normalized over the exact choice set. Derive the unique maximum; reject hidden ties, nonmaximal selection and an abstain maximum. A tied flag cannot override facts. Self-reported confidence never bypasses gates.

## Evaluation order

1. Validate structural envelope; normalize semantic unknowns. Malformed input is diagnostic/nonzero exit.
2. Enforce cancellation/pause, authority, custody, writer and dependency gates before request.
3. Reuse resolveModelForNode precedence, explicit pins and existing capability derivation. Do not build an alternate resolver.
4. Filter allowlist, registered capability facts, fresh account capacity, semantic/profile applicability and resources. For limited ledgers, spend + commitments + router allowance + next step + verification allowance must fit each run/account limit. Separate accounts are checked separately; shared charges combine once. Uncapped monthly policy waives only its monthly ceiling. Missing router capacity rejects even with a healthy worker.
5. Independently enforce worker and router-call ceilings before request; no second worker execution counter.
6. Filter REVIEWER candidates by strong qualification, exact artifact/target and complete independent family provenance. Missing/weak qualification rejects. Selection leaves actual served identity/review unissued.
7. Build sanitized normalized request with eligible IDs plus abstain. No credentials/private customer content.
8. Validate supplied ordered route history and response against exact hashes, identity, evidence and choices. Recheck selected candidate's snapshot gates.
9. Emit proposed binding or explained wait/abstention. Live dispatch requires fresh gate/reservation checks beyond this offline slice.

## Decision fallback policy

Haiku `claude-haiku-5-5` subscription -> `gpt-6-luna` subscription -> Haiku `claude-haiku-5-5` API -> wait. Require explicit qualified adapter/account/billing transport. API needs recorded authorized binding and current balance/expiry or documented billing-status evidence; replay reads no credential. No new keys/purchases. Actual qualification must prove subscription mode cannot silently bill API.

Advance only on deterministic route unavailability or classified availability/quota failure. At most one actual call per route and three total per decision, additionally bounded by the remaining routerCallCeiling computed above. Failed calls consume the ceiling; skipped routes do not. Selection completes the decision. Substantive abstention, malformed/refused/incomplete output, wrong/unknown served identity, cancelled/paused/lost custody or insufficient evidence stop. No repair retry or direct API shortcut.

Every route supplies its own accountId, transport, call-cost estimate and reservation/usage evidence in a routingResourcePlan included in the normalized request. Preserve failed-call charges/commitments once and evaluate each next route against remaining run/account resources plus worker and verification allowances. Unknown actual charge retains its bounded reservation; it is never erased or changed to zero. Shared accounts combine charges once; distinct fallback accounts are independently checked. Initial worker eligibility uses the supplied resource plan. If later charges/headroom cannot support the original eligible choices, wait; do not alter candidates or request hash midway.

Histories require ordered attempt IDs, matching decisions/times and legal transitions with no new attempt after terminal outcome. Normalize byte-identical repeated attempt deliveries to one attempt/charge; conflicting duplicates fail. Reject fabricated/out-of-order chains. New snapshot requires new decisionId and supplied inherited run-wide consumption. Empty candidate set waits before calls. This ladder selects the engine, not a worker or reviewer.

## Receipt and CLI

Receipt fields: schemaVersion, policyVersion, promptVersion, decisionId, snapshotHash, requestHash/normalizedRequest or null, eligibleCandidateIds, candidateRejections, decision (`propose`, `wait`, `abstain`), proposedBinding or null, decisionOrigin (`none`, `synthetic`, `recorded`), engine/adapter/transport/account or null, requested/served model or null, disposition/reasons, attempts and consumed/remaining counters, evidenceReferences, usage/cash cost/latency or unknowns, optional distribution and postExecutionReview (`unissued`). Missing exchange uses origin none and null served/distribution. Positive receipt qualifies only supplied offline facts, not execution/review.

Keep sanitized vendor wire payload/provenance outside normalized schema. Invocation: `bun run scripts/replay-dynamic-lane.ts --input <fixture.json>`. Read one UTF-8 JSON input; canonical receipt stdout, diagnostics stderr. Exit 0 for evaluated wait/abstention/proposal, nonzero for structural/I/O failure. Preserve input bytes; no network/provider/store/credential activity. Document v3/v4 compatibility.

## Acceptance and boundaries

Tests cover all AI roles; Haiku default; strong review; every fallback/no-fallback transition; ceilings/exhaustion including successful last allowed call; skipped route versus failed call; distinct fallback accounts and retained charges; identical repeated attempts without double charging and conflicting duplicates; prior-ledger hash conflicts; omitted/empty/unsupported semantic evidence; allowlist/pins/capabilities; duplicate identity; shared and uncapped-policy budgets/expiry; stale/future/reset-only capacity; custody/writer/cancellation; profile/outcome leakage; review family/identity/artifact/qualification; malformed/wrong-model/refused/abstaining output; derived distribution ties/nonmaximum/abstain winner; legacy fixtures; canonical CLI and zero effects. Legacy v3 without new router/resource/ledger or strong-reviewer evidence retains v3 provenance but produces explicit insufficient-evidence abstention; never synthesize those facts to preserve an old positive fixture.

No executor hook, DB schema, provider plugin, workflow YAML, generated-default, live adapter or production default is included. Later runtime work requires reviewed source integration/plan and the shadow/staging gates in `docs/superpowers/specs/2026-10-15-dynamic-lane-haiku-design.md`.
