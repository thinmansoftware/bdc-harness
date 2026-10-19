# Minimal diagnostic failure: source correction plan

Status: source preparation only; no new authenticated operation approved.

## Observed failure and preserved state

The one diagnostic reviewed at bdc-xo PR3392 head
`e373cddb607572ce79286b5c302642ecc7bd2e72` ran once. Exact-head scanner run
39227342069 passed; actual independent App review5569213276 was read back before
invocation. Frozen harness source was929c3e0c60987d3e021727b8802f221b812bb0ac.

Diagnostic attempt1f9a4f10-7807-4fb9-96cc-119deacbab32 is terminal
quality/required_stage_failed. The run remains paused. A fresh read-only database
query verified all16fields of each original implementation row unchanged, exactly
five total rows, and no resume. Preserve all consumed claims, roots and evidence.

The worker passed six preflight checks, then made one query invocation. It emitted
zero normalized chunks and failed with sdk_iterator_exception/other. Iterator
closure, task reaping, copied-worker auth equality, workspace equality, zero OOM
delta and owned cleanup passed. Independent local worker/proxy parsers accepted
the retained failed receipt. Fresh Docker reads found no resources for its owner
teetime-auth-d9d7169c778f; the unrelated reviewer remained running.

The proxy recorded five closed connections and one request-line/destination
denial. Aggregate counters do not establish that denial caused the query failure.
The original PC-login equality receipt was not independently retained: the PC
envelope discarded failed operator output. Do not reconstruct it from worker
auth equality. PC process settlement was verified.

Retained local audit root:
`C:/Users/pcmed/projects/.audit/tee-time-proposal-20261016/minimal-diagnostic-source-929c3e0c6098`.
Authoritative records: minimal-remote-reconciliation.json,
minimal-terminal-state.json, minimal-pc-launch.claim.json and
minimal-pc-launch.result.json. Remote diagnostic-result.json SHA256:
`1b6a1f47dc3c02d465e90aa19018694a91052ea3d188b237757c4a197f1ef000`.

## Correction scope

1. Extract/reuse the bounded source-derived SDK classification already implemented
   in scripts/staging/teetime-reviewer-fixture.ts. Recognize only the pinned SDK's
   CLI-exit wrapper, numeric exit0..255, its existing signal allowlist, SDK JSONL
   parsing failure, abort and unknown. Reuse its bounded startup-stage/cause/errno
   classifier. Store closed data at the real iterator boundary through private
   provenance metadata before provider error enrichment. Copy metadata when
   replacing errors. Caller properties cannot forge provenance. Never retain raw
   stderr, arbitrary text, destinations, paths, credentials or arbitrary hashes
   of such data. Keep the existing origin-only contract intact for its consumers;
   explicitly version any new exported diagnostic packet/parser contract.
2. Split the existing proxy request-line diagnostic into closed method, HTTP
   version, expected/other authority and framing categories. Egress policy and
   accepted bytes remain unchanged. Never emit the actual other authority or
   arbitrary request bytes. Update the independent Python receipt validator and
   cross-language fixtures together; malformed counters fail closed.
3. Update the future PC envelope to independently validate and retain sanitized
   failed operator JSON while preserving passed:false and no-retry semantics.
   Malformed, unknown or unsettled output gets only a fixed failure record. Do not
   change the consumed launcher or infer historical PC equality from new code.

Before changing contracts, review the concrete closed schemas and migration of
all selected helper inventories. Historical v1 evidence stays immutable. A new
source revision is not authority to overwrite installed/frozen execution trees.

## Verification order

- Write focused failing tests first, using actual SDK wrapper forms and mocked
  iterator boundaries, not a fabricated success packet. Cover initialization,
  iterator acquisition/next/return and metadata propagation through enrichment.
- Prove hostile error getters/properties, raw sentinels, malformed wrapper numbers,
  signals and oversized stderr cannot escape the closed metadata schema.
- Run provenance and reviewer-fixture Bun suites plus minimal diagnostic/runner
  tests; run the relevant TypeScript check from existing offline qualification CI.
- Run independent Python diagnostic/worker/protocol/controller/operator tests.
  Exercise TS-produced success/failure data through the Python validators. Keep
  unknown counts unknown and verify negative schema/version/counter cases.
- Exercise proxy categories with synthetic request lines and run the existing
  credential-free native fixture. No real account is supplied. This proves only
  the measured synthetic traffic forms, never the historical failure's cause.
- Run ASCII and diff checks, independent source review, publish exact source and
  verify exact-head offline qualification. No full model prompt or new live query
  is a verification command in this source-only plan.

## Subsequent gate

Only after reviewed concrete corrections and credential-free evidence may a new
finite diagnostic execution plan be considered. It must explicitly reconcile the
four full implementation attempts plus this consumed diagnostic, define fresh
one-use authority/paths/limits and obtain actual independent exact-head approval.
Do not reuse this plan or the previous App approval as a live execution grant.

No model/account/binary change, fallback, wider egress, automatic retry, generic
resume, fifth implementation attempt, Claude/Fable, production deployment,
golf-provider traffic, booking, payment or purchase is included.

The final objective remains the simulated demo: accepted app source, functional
booking-rule tests, build/typecheck, deterministic browser walkthrough, isolated
preview and device verification. None is replaced by a passing diagnostic.
