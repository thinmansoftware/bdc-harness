# XO Terra/Sol staging advisory implementation plan

Goal: Prove the approved routine-Terra / important-Sol advice policy through the existing Board API in staging, without replacing the incumbent interactive XO or changing live lanes.

Spec: C:/Users/pcmed/Downloads/terra-xo-lane-approval-20261031/XO-ROUTING-PROPOSAL.json (John approved policy and implementation/staging on 2026-10-31).

Architecture: Add a dark advisory route under the existing private Board API. Authenticate the current XO with the existing principal resolver and live lease; no lease acquisition. A separate persistent single-owner SQLite pilot ledger atomically binds request ID, packet hash, lease identity and both model reservations before any paid important request. This is a callable delegate, not an automatic replacement for the interactive coordinator.

Tech stack: Existing Bun, TypeScript, OpenAPIHono/Zod and bun:sqlite. No business DB schema or network routing changes.

## Constraints and architecture review corrections

- Existing source base e1ece0ffd1d4524b325d8bba40f49fb38ff8bdd1; isolated registered worktree.
- Preserve existing operator middleware plus explicit Board principal authentication. Current seat must be xo and principal must match an unexpired live lease. Bind lease ID and fence and recheck before every paid call.
- Configured absolute ledger path, fixed $1 lifetime campaign, exclusive SQLite owner, atomic admission; no temporary fallback, resets or replay. Restart retains unknown/in-flight reservations and stops.
- Both important legs reserved before either starts. Unknown billing retains full reservation and stops the campaign. No retries, provider fallback or automatic third critique.
- Exact Terra6.1 and Sol6.1 OpenAI endpoints through OpenRouter. Refresh fixed-endpoint maximum rates, enforce request max_price, save exact identity, charge and generation provider receipt.
- Captured GitHub evidence is supplied by the authenticated caller, not independently verified live state. Require source IDs and reject invalid citations. No retrieval, filesystem paths or evaluation banks. No real held-out material is read even for testing.
- Sol gets the identical original packet in a fresh stateless request, without Terra output. Decisions remain advice and confer no authority.
- One staging instance/ledger only; production binding and adoption by incumbent coordinator remain subject to exact-head approval and operational acceptance.

## Tasks

1. Add service tests before implementation: routine one call, important two independent calls; citations, stale captures, source provenance and no-action boundaries.
2. Implement packet validation, immutable prompts, fixed-route request/receipt checks and conservative importance classification. No tool with external effects.
3. Implement durable admission/settlement and test concurrent duplicates, restart, two-leg reserve, cap denial, unknown-cost stop and failed storage. No product DB use.
4. Mount route after existing private authentication. Test disabled default, Board identity, exact lease/fence, expired or moved lease, malformed inputs and recheck before paid calls.
5. Add staged caller/runbook and run a single isolated staging listener using real Board authentication against an isolated lease store. Use synthetic non-held-out evidence and separate staging credentials; no production queue or lease writes.
6. Verify targeted tests, server typecheck/lint, staging HTTP and bounded real provider calls within approved $1 total pilot. Record sources, exact commit, receipts and rollback. Obtain fresh code review; return changes before live activation.

## Review focus

- Concurrent/restarted requests must never repeat a paid call or reset the cap.
- A valid operator token alone must not authorize spending; a stale lease must not survive a wait.
- Caller metadata must not be advertised as independently verified evidence.
- Invalid output/provider/cost must retain honest incomplete outcomes and existing reservations.
- Important requests must not succeed without an independent Sol opinion.

## Verification commands

- bun test packages/server/src/xo-advice/
- bun test packages/server/src/routes/xo-advice.routes.test.ts
- bun --filter @archon/server type-check
- bun x eslint packages/server/src/xo-advice packages/server/src/routes/xo-advice.routes.ts packages/server/src/routes/xo-advice.routes.test.ts
- Staging HTTP acceptance script: disabled/default refusal, bad principal refusal, routine one-model receipt, important two-model receipt, duplicate denial and ledger total <= $1.

Stop before production registration, coordinator adoption, live lane edits, readiness/merge/deployment or owner messages. Staging evidence is not automatic XO reassignment.
