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
hashes, the nullable offline-only `JevChoiceRequest`, sorted eligible candidates and rejections,
decision, optional proposed binding, Jev origin and disposition, evidence references,
distribution, usage/latency, and an explicitly `unissued` post-execution review. The request is the
exact normalized value hashed by `requestHash`; it contains only eligible bindings plus abstain,
sanitized effective account identifiers, sourced profiles, and code-computed capacity, cost, and
budget facts. This local representation does not claim conformance with the live OpenRouter Jev
wire schema. A valid wait or abstention exits 0 with empty stderr.

Unreadable JSON and malformed required envelopes emit one deterministic
`dynamic-lane-replay: ...` diagnostic to stderr, emit no stdout, and exit 2. Missing or invalid Jev
evidence and missing semantic evidence are evaluated abstentions, not malformed envelopes. The CLI
does not modify its input, create an output file, contact the network, call a provider, probe
capacity, execute a node, acquire a lease, or access a store/database.

Identical input bytes with the same explicit evaluation time produce byte-identical receipt bytes.
The candidate allowlist is a required structural field. Only listed candidates can be eligible; an
empty allowlist is valid but yields an evaluated abstention, while omission or duplicate entries are
malformed. Task-brief and role-objective packet versions are explicit gates. Node identity must
match the embedded node before resolver or capability evaluation. Duplicate account IDs and profile
candidate IDs are rejected before lookup-map construction.

Capacity predicted reset times do not restore eligibility; `resetAt` is informational and a fresh
healthy observation is required. Verification allowance remains part of both run and applicable
account budget calculations. Unknown contributor identity uses the existing `family: null` state;
no new identity field is introduced.

## Scenario-to-fixture mapping

`eligible-synthetic.json` is the sanitized base for scenarios 1-12. The evaluator test clones it and
applies named, in-memory variants for: all six AI roles; allowlisting; duplicate identities; node
identity; semantic-packet versions; cancellation/pause/dependencies; authority and capacity;
separate router/worker budgets and verification allowance; attempt ceiling; writer/cancellation
acknowledgement; independent review; operator binding/capabilities; all Jev dispositions;
FuelGlass healthy/exhausted/stale/reset behavior; future/expired evidence; and profile completeness.
`malformed-envelope.json` covers structural CLI failure. Exact request shapes, request hashes, and
receipts are asserted in tests rather than embedded self-referential hashes in fixtures.

## Targeted verification

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

Do not use root `bun test` for this work order because its suites share mock-module state.
