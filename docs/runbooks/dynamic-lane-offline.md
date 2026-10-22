# Dynamic Lane offline replay

This runbook covers the deterministic offline evaluator defined by
`docs/behavior-specs/dynamic-lane-offline.md`. It creates no workflow authority, performs no
provider or FuelGlass call, acquires no lease, and writes no state.

## Prerequisites and invocation

Use Bun from the repository root and a sanitized JSON fixture using schema
`dynamic-lane-snapshot/v3`:

```bash
bun run scripts/replay-dynamic-lane.ts --input packages/workflows/src/reliability/fixtures/dynamic-lane/eligible-synthetic.json
```

The CLI accepts exactly one `--input <path>` argument and reads the file once. Redirect stdout
explicitly if a saved receipt is wanted. Fixtures must contain explicit evaluation timestamps,
synthetic or recorded-and-sanitized exchanges only, and no credentials, authenticated exchanges,
or live capacity data.

## Output contract

For a structurally valid envelope, stdout contains exactly one canonical, single-line JSON receipt
and a newline. The receipt is `dynamic-lane-receipt/v3` and includes the policy, snapshot and request
hashes, sorted eligible candidates and rejections, decision, optional proposed binding, Jev origin
and disposition, evidence references, distribution, usage/latency, and an explicitly `unissued`
post-execution review. A valid wait or abstention exits 0 with empty stderr.

Unreadable JSON and malformed required envelopes emit one deterministic
`dynamic-lane-replay: ...` diagnostic to stderr, emit no stdout, and exit 2. Missing or invalid Jev
evidence and missing semantic evidence are evaluated abstentions, not malformed envelopes. The CLI
does not modify its input, create an output file, contact the network, call a provider, probe
capacity, execute a node, acquire a lease, or access a store/database.

Identical input bytes with the same explicit evaluation time produce byte-identical receipt bytes.
Capacity predicted reset times do not restore eligibility; a fresh healthy observation is required.

## Scenario-to-fixture mapping

`eligible-synthetic.json` is the sanitized base for scenarios 1-12. The evaluator test clones it and
applies named, in-memory variants for: all six AI roles; cancellation/pause/dependencies; authority
and capacity; budgets and account sharing; attempt ceiling; writer/cancellation acknowledgement;
independent review; operator binding/capabilities; all Jev dispositions; availability/reset;
future/expired evidence; and semantic/profile evidence. `malformed-envelope.json` covers structural
CLI failure. Exact expected receipts are asserted in the tests rather than embedded self-referential
Jev request hashes in fixtures.

## Targeted verification

```bash
bun test packages/workflows/src/reliability/dynamic-lane-admission.test.ts
bun test scripts/replay-dynamic-lane.test.ts
bun test packages/workflows/src/model-override.test.ts
bun test packages/workflows/src/node-failover.test.ts
bun run --filter @archon/workflows type-check
bun x tsc --noEmit -p scripts/tsconfig.json
bun run lint --max-warnings 0
git diff --check
```

Do not use root `bun test` for this work order because its suites share mock-module state.
