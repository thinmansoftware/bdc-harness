# Dynamic Lane offline replay

The default new contract is model-neutral v4 with Haiku (`claude-haiku-5-5`) as the first decision engine. This pure replay evaluates supplied facts and exchanges. It calls no provider, reads no credential, acquires no lease, reserves no budget and dispatches no worker. The source of truth is `docs/behavior-specs/dynamic-lane-offline.md` v4, approved through bdc-xo#3266 for WO-HARNESS-DYNAMIC-LANE-OFFLINE-01 / project#3264.

## Invocation

From the repository root:

```bash
bun run scripts/replay-dynamic-lane.ts --input packages/workflows/src/reliability/fixtures/dynamic-lane/eligible-haiku-synthetic.json
```

The supplied fixture has no exchange and therefore returns a wait receipt containing the normalized request/hash; it never invokes Haiku. To replay a decision, supply a synthetic or sanitized recorded `decisionExchanges` history bound to that request and snapshot. The evaluator tests construct complete selection, fallback and refusal examples without self-referential fixture hashes. Synthetic model identities are fixture assertions, not authenticated observations.

Explicit legacy v3 replay remains available:

```bash
bun run scripts/replay-dynamic-lane.ts --input packages/workflows/src/reliability/fixtures/dynamic-lane/eligible-synthetic.json
```

Version3 retains its Jev request/receipt/provenance. New safety evidence (router counts/ceiling, monthly policy, prior ledger, routing resource evidence and strong-reviewer qualification when applicable) must be supplied; it is never invented to keep an old fixture positive. Version4 uses no mandatory Jev probability or confidence. The legacy single-router field is absent from v4 worker facts; router accounts/estimates belong to `routingResourcePlan`.

## Receipts and failures

A valid snapshot produces one canonical JSON line plus newline on stdout and exit0, including wait/abstention. Missing/empty semantic evidence yields no request and an explained wait. Malformed envelope/JSON, unsupported snapshot version or I/O error yields stderr diagnostic, no stdout and exit2. The input remains unchanged; redirect stdout explicitly to save a receipt.

Version4 receipts include policy/prompt/schema versions, decision/run correlation through the hashed request, eligible worker IDs, rejections, snapshot/request/prior-ledger hashes, engine/adapter/account/transport, requested/served identity, attempt history, per-account charges, usage/cost/latency or explicit unknowns, and postExecutionReview unissued. A proposal qualifies the supplied offline snapshot only. It creates no authority or real review verdict.

## Decision order and resources

The only modeled engine order is Haiku subscription -> GPT-6 Luna subscription -> Haiku API -> wait. Advancing requires known route unavailability or a classified availability/quota failure. Substantive abstention, malformed/refused/incomplete output, missing identity, lost custody or insufficient task evidence stop. Every route requires explicit account/transport/binding evidence; API additionally requires authorized current billing evidence. Replay reads no actual credentials or balance.

Every actual v4 exchange must carry decisionId, snapshotHash and requestHash, including failed calls whose response is null. Bind these to the current decision and normalized request before accepting failure as a fallback reason. Failure histories copied from another decision or request are rejected. Responses on successful calls independently repeat the same correlation; an identifier on a later success cannot qualify an earlier unbound failure. Structurally valid supplied calls retain consumption and known charges even when correlation is refused.

routerCallsConsumed is consumption BEFORE this decision. Each unique actual call adds one; a skipped unavailable route adds zero. Gate before each call; a successful final permitted call is accepted. One call per route, maximum3, within the supplied run-wide ceiling. Identical duplicate deliveries count/charge once; conflicting duplicates fail. Failed calls retain actual cost or the bounded reservation where actual cost is unknown. Every fallback checks its own account and remaining run/account headroom while preserving the original eligible choices and request hash.

The October uncapped monthly policy is explicit, dated and referenced. It waives only that monthly cap. Other run/account limits, capacity, commitments, verification allowance and attempt limits apply. Unknown cost is not zero. Strong independent reviewer qualification, family provenance and exact target artifact remain hard gates. Haiku is never a reviewer candidate.

Prior decision IDs/hashes and completed receipts are checked against the supplied ledger. A stored receipt is recomputed from its supplied exchanges and all current snapshot gates before reuse. The pure CLI cannot detect reuse across unrelated files or persist counters; later runtime integration must supply durable ownership/idempotency/reservation evidence.

## Verification

Run these suites separately to preserve mock isolation:

```bash
bun test packages/workflows/src/reliability/dynamic-lane-admission.test.ts
bun test ./scripts/replay-dynamic-lane.test.ts
bun test packages/workflows/src/model-override.test.ts
bun test packages/workflows/src/node-failover.test.ts
bun run --filter @archon/workflows type-check
bun x tsc --noEmit -p scripts/tsconfig.json
bun run lint --max-warnings 0
bun run format:check
git diff --check
```

The tests cover all six roles, Haiku/Luna/API histories, every fallback stop, last-call and skip boundaries, budgets/accounts/expiry, prior-receipt recomputation, duplicate attempts, allowlist/binding/capability/custody/writers, semantic/provenance failures, reviewer qualification/independence, distribution-derived ties and CLI exit/input/side-effect behavior.

## Later gates

This slice does not wire a runtime adapter. Next requires independently reviewed integration through existing executor/provider/custody/reservation paths, authenticated transport/model qualification, at least20 unique real shadow steps with quality/usage/cost reporting, then one bounded staging WO. Production remains a separate M-09 decision. Shared harness/model/runtime readiness stays with project#3258. Offline replay passing is not a working live lane.
