# Offline Jev Dynamic Lane routing behavior v3

Proposed implementation contract. No live execution authority is created by this document.

## Interface and ownership

The proposed evaluator belongs in the existing bdc-harness workflow reliability package. It accepts one validated, versioned decision-time snapshot, constructs a Jev request from eligible candidates, consumes a supplied synthetic or recorded Jev response, and produces one deterministic receipt. A local replay CLI is its first caller. Jev is the per-step decision engine; MTA supplies optional model-profile/evaluation context. No live API call occurs in this offline slice.

Use existing DagNode, RunAuthorityRecord, ProviderAttemptRecord and ExecutionCapability types where they describe the input. Snapshot-only fields are NEW contract fields; they are not database columns. Derive runtime validation and TypeScript types from a single schema following repository conventions.

The snapshot must explicitly supply: fixed evaluation time; run/node/scope identifiers; AI role; authority; ready/dependency state; cancellation/pause state; evidence of custody and active writers; candidate allowlist; configured model-binding inputs; required capabilities; per-account capacity observations with measured and expiry times; finite nonnegative budget limit, spend, outstanding commitments and verification allowance; bounded router-call and next-step cost estimates; existing attempt history and attempt ceiling; contributing model families with identity evidence; current artifact hash and review-target hash; and optional MTA model-profile context. The Jev exchange is a separate record bound to the hash of these decision inputs, excluding the exchange and output to avoid a self-referential hash.

No production defaults may fill missing authority, custody, capacity, costs, review identities, timestamps, artifact hashes or policy limits. Fixtures may state these values explicitly. Required freshness and independence are supplied policy constraints, never inferred from a model name or endpoint.

### Required decision-time task and model context

The NEW versioned snapshot contract also requires these semantic inputs, all included in snapshotHash and the constructed request:

- taskBrief: {version, text, sourceRef, availableAt}, describing the task known at this boundary.
- roleObjective: {version, role, text, acceptanceCriteria, sourceRef, availableAt}. acceptanceCriteria is a nonempty list of explicit criteria for this step; role must match the snapshot's AI role.
- decisionEvidence: {version, availability, items, noPriorArtifactReason}. Each item contains evidenceId, sourceRef, contentHash, observedAt, availableAt and the relevant sanitized content. availability is supplied or no_prior_artifact. The latter is permitted only for initial intake with a stated reason; it does not waive taskBrief, roleObjective or acceptanceCriteria. Other AI steps require cited evidence items for their role. Missing evidence must not be mislabeled no_prior_artifact.
- candidateProfiles: a versioned record per eligible candidate, containing candidateId, profileVersion, applicableRoles, observations, sourceRefs, availableAt and limitations. Each observation records its task/evaluation scope and provenance. Missing, unsupported-version or role-inapplicable profiles exclude that candidate. No surviving profiles means abstention.

These are required evidence slots, distinct from the structural envelope. Omitted, null or empty semantic inputs normalize to missing evidence and produce an evaluated abstention (CLI exit 0) before a Jev request is constructed. Malformed structural envelope types still produce nonzero exit. Unsupported semantic packet versions produce an explicit unsupported-evidence-version reason. Do not fetch or invent replacements.

Only evidence availableAt <= evaluationTime may enter decision state. Separate later outcomes into a different outcome record outside the snapshot and Jev request; never feed the result of the step being predicted back into its inputs. Historical outcomes from other cases may inform profiles only if available before the current decision. Reject a supplied packet marked as this decision's later outcome rather than silently removing it and accepting the rest.

The matrix observations are provisional profiles, not certified role winners: the small two-task synthetic evaluation supports further GLM/Kimi builder, DeepSeek Pro planning and Flash intake/validation trials. It does not establish production calibration or qualify Fable. Do not hardcode those assignments, production success probabilities or confidence thresholds from these observations. Candidate profiles must carry these limitations and their source evidence.

The required envelope (version, evaluation time, run/node identity, candidate list and policy structure) must validate. Evidence slots explicitly allow null values: missing authority, capacity, cost or identity evidence is a valid snapshot that yields abstention, not a CLI parse error. An absent/invalid Jev exchange yields a recorded wait/abstention; do not choose a baseline model silently. Invalid numeric policy values or malformed required envelope fields cause CLI error; unknown evidence does not. Observations after evaluationTime are invalid evidence; evaluationTime >= expiresAt means expired.

## Decision order

1. Reject malformed input with an explicit diagnostic and no eligible proposal. Version mismatches and nonfinite/negative numeric values are invalid.
2. Cancellation and human pause prevent a proposal, even with a favorable Jev response.
3. Missing/mismatched run authority, custody, dependency evidence, or non-ready step prevents a proposal. No unfinished conflicting writer or unacknowledged cancellation may be treated as absent.
4. Resolve baseline binding through resolveModelForNode. Preserve explicit operator bindings by restricting the eligible set accordingly. Jev cannot change their provider/model or relax required capabilities.
5. Filter candidates by allowlist, existing provider registration/capability facts, fresh known capacity, and known budget. Require a routerAccountId and workerAccountId per candidate, plus a run-wide budget and per-account budgets. For the run, spend + outstanding commitments + router-call allowance + next-step cost + remaining verification allowance must not exceed the run limit. For each charged account, apply that same check using only spend, commitments, verification allowance and new charges assigned to that account. If router and worker share an account, combine both new charges exactly once in its check; if distinct, check both accounts separately. Reject a candidate when either account or the run lacks headroom. Unknown cost is insufficient evidence, not zero. Explicit router-call limits are additional to the existing worker provider-attempt ceiling; count neither as the other. Include a fixture with exhausted Jev account and healthy worker account.
6. Apply the existing total-provider-attempt counting semantics read from beginProviderAttempt. No replay may reset or subtract consumed attempts. Do not create a second execution counter.
7. For an independent-review proposal, require currentArtifactHash == reviewTargetHash, known historical served-family evidence for all contributors, and explicit candidate-to-family mapping evidence distinct from every contributing family under the supplied independence policy. Unknown contributor identity or candidate mapping remains insufficient evidence. This only qualifies a proposed reviewer: the future served identity and substantive review verdict are not yet known. The receipt must explicitly leave post-execution independent review unissued; it cannot mark a review satisfied or approved.
8. Construct a pinned Jev Choice question with only eligible candidate IDs plus an explicit abstain option. Include the step's task, evidence, eligible model profiles and code-computed capacity/cost facts. No candidates means no request is needed. All AI roles use this same boundary contract. The first slice uses Choice; Score/Noul extensions need their own rubric tests.
9. Validate the supplied Jev exchange against the exact snapshot/request hash, requested model, returned model/version, rubric version, candidate options, probability distribution and policy thresholds. Thresholds are explicit fixture policy, not claimed calibrated production values. Tied, low-confidence, malformed, stale, mismatched or abstaining decisions yield wait/abstention. Transport/auth/rate-limit failures produce evidence, not hidden retries or worker-model fallback. A chosen candidate must still pass hard filters against the decision snapshot.
10. Return a proposed binding or an explained wait/abstention, including every rejection reason and evidence reference. Required receipt fields: schemaVersion, policyVersion, snapshotHash, requestHash or null, eligibleCandidateIds, decision, proposedBinding or null, decisionOrigin (none, synthetic_jev or recorded_jev), jevDisposition, candidateRejections, evidenceReferences, requestedJevModel, returnedJevModel or null, questionVersion, recorded distribution or null, usage/latency or explicitly unknown, and postExecutionReview (unissued). Prefilter rejection or a missing exchange uses decisionOrigin none and null returned-model/distribution fields; test both cases. These are NEW local receipt fields, not database columns. Decision labels are not persisted workflow states. Identical inputs and explicit time produce byte-identical normalized receipts.

Vendor confidence and the probability assigned to the winning option are distinct fields. Do not substitute one for the other when applying explicit fixture thresholds.

## Jev transport contract for later live integration

Target: POST https://openrouter.ai/api/alpha/decisions, model typesafe/jev-1.13, text state and typed questions. Use the official request/response schema at https://openrouter.ai/blog/tutorials/how-to-use-jev/ and https://openrouter.ai/typesafe/jev-1.13/api. Do not assume normal chat-completions or typesafe/jev-router are equivalent. Keep raw API wire fields separate from the local normalized receipt schema above. Freeze sanitized example fixtures against the actual documented schema. Synthetic fixtures must not be described as authenticated responses.

Live adapter calls, account access, worker dispatch, atomic budget reservation and custody recheck are later work. No new key is needed for this offline implementation.

## Side effects and failure interpretation

The evaluator performs no network calls, model calls, store writes, reservations, lease claims, workflow registration, cancellation or execution. A positive receipt means only that the supplied snapshot satisfies this offline policy. It does not prove that capacity is still available or custody is valid at dispatch time.

Availability errors, unknown infrastructure errors, and coding defects remain distinct. Provider reset time does not itself prove recovered capacity; a new observation is required. Offline failure handling produces evidence, not an automatic retry or tier climb.

## Replay CLI

Proposed NEW invocation: bun run scripts/replay-dynamic-lane.ts --input <fixture.json>.

Read one UTF-8 JSON snapshot from the named file, print one normalized JSON receipt to stdout, and use stderr for diagnostics. Exit 0 for valid evaluated snapshots, including wait/abstention; exit nonzero for invalid input or I/O failure. Do not overwrite the input. Document redirection if a saved receipt is wanted. Do not inspect credentials or mutate any workflow state.

## Invariants and acceptance

Preserve existing fixed-lane behavior, resolver precedence, capability requirements, attempt semantics and Taskmaster/Overseer ownership. No DAG executor hook, DB schema, provider plugin, workflow YAML or generated-default change is in scope. Live integration requires a later reviewed contract with atomic shared-account reservations, custody revalidation, prompt/loop/failover coverage and independent evidence that Jev routing is useful. MTA daily observations support calibration.

Acceptance requires success at each AI role, cancellation, pause, dependencies, missing authority, future/expired capacity, shared budget including router cost, invalid numeric values, exhausted worker and router limits, conflicting writer, incomplete cancellation, same-family review, unknown identity, wrong artifact hash, capability mismatch, and absent/invalid/stale/tied/abstaining Jev responses. CLI tests must verify stdout, exit status, unchanged input and zero external effects. Repeat deterministic replay and run existing resolver/failover regressions.

## FuelGlass eligibility clarification

John's design clarification, September 27, 2026. Proposed behavior; not evidence of implemented routing. Extends the offline replay acceptance contract; live integration remains later work.

Claude remains a registered candidate with its supported roles and model profile. Temporary exhaustion does not remove Claude from the roster or make the Dynamic Lane permanently Codex-only.

At every AI decision boundary:

1. Resolve the candidate's actual execution account and effective provider/model binding.
2. Read the supplied FuelGlass observation for that account. Code applies freshness, capacity windows, policy thresholds and outstanding reservations before constructing Jev options.
3. Exclude Claude when capacity is exhausted, below the required policy headroom, unknown, stale or unavailable. Apply this rule consistently to all candidates. Missing evidence does not mean available capacity.
4. Give Jev only eligible candidate IDs plus abstain. Keep excluded candidates and reasons in the audit receipt, outside selectable options.
5. Reject a response selecting an excluded candidate. No trial call, hidden retry or fallback may bypass the exclusion.
6. For later live integration, recheck current capacity and reserve required headroom before dispatch. A change since selection invalidates the proposal and requires a fresh decision or wait.
7. Re-admit Claude on a fresh observation proving sufficient capacity, subject to all other gates. A predicted reset time alone is insufficient.

Offline replay uses explicit synthetic or recorded FuelGlass snapshots; it makes no provider or FuelGlass calls. Exact runtime fields and adapter mapping remain to be verified.

### Required FuelGlass acceptance cases

- Claude is registered and healthy: it can appear in Jev options if all other gates pass; selection is not guaranteed.
- Claude is registered but exhausted: absent from constructed Jev request options, capacity rejection in receipt, no proposed Claude binding, and the supplied provider-attempt count remains unchanged by replay. Zero actual Claude calls while excluded is a later live integration criterion.
- Claude capacity is unknown, stale or future-dated: excluded.
- Reset time passes without a fresh reading: still excluded.
- A fresh healthy reading arrives: Claude may return to the eligible set.
- A supplied Jev response selects excluded Claude: invalid decision, no dispatch.
- In later live integration, capacity is lost after selection: no Claude dispatch under the stale proposal.
- No eligible candidates: explained wait/abstention.
- Every effective AI binding, including planning, loops, repairs, review and delivery, must be covered before claiming the live lane avoids exhausted providers.

The separate Codex-only supervised repair concerns the current builder bootstrap. It does not redefine the intended Dynamic Lane roster or establish that the current dispatcher already implements these gates.
