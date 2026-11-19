# Evidence-only repair completion implementation

> Execution: incumbent custodian, native inline work on the existing draft PR.

Goal: allow an unchanged-source repair to correct its evidence and succeed only through the ordinary manifest/publication path plus an authoritative consumed-input receipt.

Spec: bdc-xo#6327, General design receipt 6977625863 and bounded consumer receipt 6978683653. Part (a), historical holds and runtime authority are excluded.

## Design and file ownership

- `packages/workflows/src/reliability/evidence-repair-body.ts`: exact byte-position runner preamble comparison; reject masking, unsupported serialization and embedded/duplicate framing.
- `evidence-repair-invocation.ts`: original/new invocation identity, canonical repository/PR/head, producer, workflow, actual script checkout and merge-checkout parent binding.
- `evidence-repair-collector.ts`: read-only authoritative check/job/attempt/run/source/log collection; verify the whole published body and terminal step/check success; re-read current PR/head/body before returning.
- `evidence-repair-lane.ts` and `scripts/evidence-repair.ts`: capture the original failed-check snapshot, classify provisional implementation completion, preserve publication bytes/hash and pre-publication check identities, observe only a new invocation, and re-verify immediately before terminal success. No dispatch or rerun capability.
- Thirteen existing manifest-v2 lane YAML files: extend completion/assertion/classification, reuse ordinary PROCEED manifest/stops/publication gates, adopt the existing repair PR without source mutation, and make receipt/final gates load-bearing. Regenerate bundled defaults.
- Existing smart-cauldron gate-misfire classifier: a mechanical evidence-repair receipt/final failure hands off once instead of climbing. No merge-manager change.

## Constraints

- Engine-substituted persisted outputs carry the checkout snapshot, publication hash and receipt. Model-writable artifacts cannot replace those identities.
- Preserve the entire published string: UTF-8 bytes, CR/LF, whitespace, Unicode and trailing newline. Never substitute manifest summaries or equal lengths for identity.
- Only the inspected Linux runner/reusable manifest-validator serialization is supported. Unsupported caller/event/serialization, missing logs, drift, failed/skipped/neutral checks and ambiguous identities hand off.
- Existing caller `edited` support is required; never modify a caller or dispatch a CI rerun. Publication uses the existing PR-body edit path.
- The implementation's COMPLETE signal is provisional. It is neither REAL_BUILD nor ALREADY_SATISFIED success.
- No adjudicator setting, historical run conversion, PR1210 hold clearance, fire, runtime change, ready admission or merge.

## Construction and verification

- [x] Add body/invocation predicates and fail-first focused tests.
- [x] Add authoritative collector with adversarial record/log cases.
- [x] Add lane stages and executable acceptance across all manifest-v2 lanes.
- [x] Keep tests reachable through the existing CI-selected manifest evidence suite.
- [x] Add no-climb regressions for unknown receipt and final-proof handoff.
- [ ] Complete final local checks and commit/push through normal hooks.
- [ ] Wait for exact-head hosted CI; only then request XO ready admission.

Review focus: stale same-head input; a longer body forging runner framing; wrong producer/run/attempt or ambiguous PR association; mutable artifacts replacing machine identity; source/body drift after the first receipt; accidental no-op/NOT_GATED routing; caller without an authorized fresh event.

The read-only historical qualification uses the real recorded API/log data with an explicitly simulated historical local HEAD. It is not a live workflow, a canary, a hold clearance or a conversion of the historical run.
