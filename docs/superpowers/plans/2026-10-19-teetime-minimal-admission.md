# One-use minimal diagnostic admission - source design proposal

Status: corrected design approved for source implementation/offline tests only.
Final source review remains required. No execution authority.

Approval constraints: repeat the remaining-budget check after persisted claim
and immediately before child launch; preserve legacy claim/selector bytes; test
complete-set mutations, stale observations, partial writes and failed terminal
persistence; never mutate paused run or historical implementation attempts.

The controller source at ed7da7baccd532e9d7472798053a21a7c71c9f9a has a
minimal-diagnostic branch, but no operator route or Cauldron diagnostic claim.
This proposal supplies that missing governed path. It is not implementation
attempt5. The sole prompt remains Reply with exactly OK.; no artifact or app
acceptance, fallback, production, purchase or golf-provider operation.

## Live facts read before this proposal

Read-only SQLite inspection on the isolated laptop confirmed tables
remote_agent_workflow_runs and remote_agent_provider_attempts. The latter has
TEXT node_id, UNIQUE(run_id,node_id,attempt_number), run_id FK and closed outcome
classes; no node_id FK or schema addition is needed for a separate diagnostic
record. This database fact does not by itself grant policy/phase admission.
Run6e1379d3959a5e5b373130cb11742018 is paused. Exactly4 implement attempts are
terminal quality/required_stage_failed with resume_at null. No diagnostic row
was present. These observations are not reusable execution-time reconciliation.

One existing owner teetime-review-20261017 retains an internal network and the
Ollama reviewer service. It is not an implementation/auth resource. Preserve it.
Future reconciliation checks the four exact historical auth owners/resource IDs,
not absence of every teetime.owner-labelled resource on the laptop.

## Immutable execution identity

Define a separate version1 diagnostic execution packet, not DemoExecution.
Exact keys: version, kind, repository, workflow, woId, runId, nodeId, attempt,
preparedBindingHash, authorityHash, runPolicyHash, providerPolicyHash, provider, model, source, baseSource,
image, operatorInputHash, selectedHashes, predecessors, limits. kind is
teetime-minimal-execution; repository/workflow/woId equal the existing supervised
case; nodeId diagnose-transport; attempt1; provider/model equal current immutable
restricted policy. runId32hex; source/baseSource40hex; image sha256:64hex;
preparedBindingHash/authorityHash/runPolicyHash/providerPolicyHash sha256:64hex;
operatorInputHash64hex. runPolicyHash is policyDigest of the exact persisted
run.metadata.execution_policy object; it must equal the unchanged prepared run
policy. providerPolicyHash is the measured restricted-policy.ts file byte digest
and must equal sha256:selectedHashes for that path. Neither is the new diagnostic
admissionHash; separately reviewed admission authorizes this sidecar while the
original run policy/RunAuthority stay unchanged.
selectedHashes has the exact diagnostic protocol ALL_PATHS keys and64hex values.
predecessors is exactly4 distinct chronological existing predecessor_identity
records (attemptId/completedAt/rowHash/executionHash/resultHash/claimHash/owner/
manifestHash/lockHash). This reuses the closed9-key historical identity syntax
without accepting a product execution or transmitting any product prompt.
limits is exact: querySeconds90, taskSeconds100, workerCaptureSeconds180,
watchdogSeconds300, containerSeconds330, proxyCaptureMaximumSeconds295,
readyRemainingSeconds265, authRemainingSeconds225, protocolLineBytes32768,
protocolTotalBytes65536, taskResultBytes4096, workerResultBytes8192,
pcOuterSeconds450, sshTransportSeconds420, observationDeliverySeconds15,
reapSeconds10. These are fixed admission limits, not caller overrides.
Canonical sorted compact ASCII JSON, duplicate/unknown fields rejected,
maximum32768bytes. No arbitrary prompt/destination/path or app artifact fields.

Avoid a circular manifest: the complete installed source inventory includes the
execution packet, so its own hash cannot be embedded in that packet. Keep the
full installed inventory external as in the existing supervised path. Compute
admissionHash from the exact canonical sorted compact ASCII object
{version:1,kind:teetime-minimal-admission,executionHash,installedManifestHash,
operatorInputHash,source}; names/kind are JSON strings, numeric version1,
all hashes raw64hex and source40hex. Domain/version tags prevent ambiguity.
Hash the ASCII bytes with SHA256. Exact sorted serialization template:
`{"executionHash":"<64hex>","installedManifestHash":"<64hex>","kind":"teetime-minimal-admission","operatorInputHash":"<64hex>","source":"<40hex>","version":1}`.
The exact-head review
pins both frozen hashes and this admissionHash. Bind the new control lock/claim
to sha256:admissionHash, not a self-referential execution hash. The inventory
itself stays outside the measured source tree and is verified by its pinned
external hash. Freeze packet and complete inventory before execution-plan review.

The live GitHub observer reads fixed new carrier path
docs/tee-time/minimal-diagnostic-admission.json on thinmansoftware/bdc-xo at the
actual reviewed PR3392 head. Require canonical ASCII <=8192bytes and exact keys
version, kind, executionHash, installedManifestHash, operatorInputHash, source,
admissionHash; kind teetime-minimal-admission-review/version1. Compare the actual
reviewed blob with local packet bytes/full-inventory bytes and recomputed
admissionHash. Verify current PR head, independent actionable approval and fresh
chronology. Caller-supplied hashes or a matching packet alone cannot authorize.

Use the original prepared source and readSupervisedBinding to verify the same
operator-paused run, repository/worktree/base, policy and runtime identities.
New current source must preserve the prepared executor/defaults/policy files.
Separately inventory all installed files, not just selected import hashes.
Reconcile all4 row/file/resource identities before and immediately before claim.
Any new/incomplete row, changed historical evidence or missing ownership proof
rejects before account delivery; no stale lock recovery or automatic retry.

## Distinct durable claim and provider record

Extend the proven exclusive flushed control primitive with a separate diagnostic
claim function. Preserve claimSupervisedPhase's original model/publish allowlist
and exact legacy receipt bytes. Share its private validation/write primitive;
do not make the generic existing phase selector accept diagnostic strings.
New diagnostic function emits diagnostic.claim.json in a deterministic fresh
control-minimal-diagnostic-1 root. Its exact binding is the frozen admissionHash
and actual independent current-head approval. Persist and read back a separate
nonce-bound public observation before launching. A partial write consumes the
claim; never remove/reuse it to recover from failure.

Create one existing IWorkflowStore provider-attempt record with fixed
nodeId=diagnose-transport, attemptNumber1, no supersedes/resume, existing restricted
provider/model/text_generation and servedModelId null. Require zero rows for that
node at both admission checks. Query the complete run attempt set, not just
implement or diagnostic rows: exactly the4 approved historical rows before
claim; exactly those unchanged4 plus the exact diagnostic row after insertion
and completion. Unexpected node rows reject. This is a separately approved supervised sidecar,
not a generic workflow node or resumed executor. Do not modify the4 implement
rows, run authority/policy or paused status. Database uniqueness is only the last
fence; filesystem custody and fresh approval remain required. Persistence failure
consumes the claim and cannot launch a provider. Read back the exact inserted row
and unchanged4 implementation rows before credential transit.

Reuse actual current independent plan-review chronology, author separation and
exact-head/hash checks from supervised-model-phase. If extraction is necessary,
share a pure review validator with unchanged legacy tests rather than duplicating
or weakening that gate. A source approval or old consumed review is insufficient.

## Existing entry integration and transport

Add one closed --claim-minimal-diagnostic source branch to the existing supervised
controller. Reuse its common preparation/environment/full-source checks, SQLite
WAL/FULL setup, API construction and ownership primitives. Branch before the
product-package/model implementation path. Use a deterministic separate frozen
minimal-diagnostic-execution-harness/source manifest/control root, no new clone.
Keep original selectors, control roots and model-claim behavior unchanged.

The new phase freezes all input objects before its first await, verifies the
separate frozen packet and fresh independent review,
consumes its claim and diagnostic row, then forwards only the reviewed remote
controller minimal selector. Extend invoke-teetime-auth-canary.py with a matching
operator branch which can reach it only through the supervised controller. Do
not add a direct laptop credential route bypassing that claim. Preserve verified
READY before the operator reads auth, actual original-auth unchanged checks,
bounded single frame, reader/reaping deadlines and strict raw READY/RESULT parsing.
Use fixed diagnostic protocol32768-byte lines/65536 total. PC starts one450second
outer budget before SSH spawn and enforces the420second SSH transport limit,
allowing at most10seconds for kill/reap plus bounded reader shutdown inside the
remaining outer budget. Observation delivery is bounded15seconds and part of
that same transport budget. The supervised entry creates its own420second
monotonic deadline before common checks/first await; the diagnostic forwarding
wrapper uses remaining time, never resets after READY, and reserves10seconds for
settlement. Require >315seconds remaining immediately before claim and child
launch so the unchanged remote300second watchdog fits. Insufficient budget fails
before credentials and is not silently converted to a shorter admitted query.
Extend the existing forwarding transport with a closed diagnostic profile and
separate typed wrapper; keep legacy model/artifact summary and bounds unchanged.

Complete the diagnostic row with existing enums: a validated passing outer
report is success/execution_completed; validated failing report is
quality/required_stage_failed; missing/malformed/uncertain transport report is
quality/required_stage_indeterminate. Always servedModelId=null/resumeAt=null.
Failure to persist completion retains the consumed claim and reports unresolved
persistence; do not claim a terminal row was saved. Retain sanitized nested
evidence, closed counters and owned-resource receipt identities; no raw provider
errors, auth bytes/hashes or response text. Read back unchanged run/implementation
history and the exact completed diagnostic row. A failed or interrupted operation
keeps its consumed lock/claim. Generic executor remains paused in every outcome.

## Tests and operational gates

Tests first: duplicate/concurrent claims, partial writes, copied/stale custody,
wrong source/image/binding/review, changed history/files, active resources,
preexisting diagnostic row, failed persistence, zero launches before committed
claim, nonce mismatch, malformed/failed/successful receipts, uncertain cleanup,
actual exit disagreement and terminal persistence failure. Prove unchanged legacy
phase rejection/claim bytes, four historical rows and paused run. Use fake stores
and synthetic protocol processes only; no model/account in source tests.

Design approval must settle exact packet fields and source scope before coding.
Then independent final source review, exact-source CI, measured staging image,
complete frozen installation/operator inventories, fresh live reconciliation and
separate exact-head execution-plan approval precede any authenticated diagnostic.
No worker/claim/source verdict automatically permits installation or execution.
Only after a real diagnostic and a reviewed corrective plan can another full
demo-generation attempt be considered. Tiny OK is never app completion.
