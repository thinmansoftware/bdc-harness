Manifest-Version: 2
WO: WO-HARNESS-OVERSEER-REVIEW-SANDBOX-01
Builder: major-build
Repair base: f7c932ba99c9fa13cd1e17ac6c60a746c3d05bb3
Candidate: repair worktree based on the repair base above; this manifest is part of the candidate diff

Files modified:

- packages/server/src/dispatch/review-worker-clock.ts
- scripts/overseer-reviewer-broker.ts
- packages/overseer/src/pr-review-ingest.ts
- packages/overseer/src/pr-review-wiring.ts
- packages/overseer/src/merge-candidate-discovery.ts
- packages/overseer/src/merge-execution-bridge.ts
- packages/overseer/src/**tests**/pr-review-sandbox.test.ts
- packages/overseer/src/**tests**/merge-candidate-discovery.test.ts
- packages/overseer/src/**tests**/merge-execution-bridge.test.ts
- artifacts/manifests/wo-harness-overseer-review-sandbox-01.md

Repair evidence:

- The worker now persists the webhook base SHA and atomically fetches the exact GitHub PR head and base refs into the broker spool, verifies both SHAs, checks out the detached head, and re-verifies cached checkouts.
- The broker validates and executes the submitted pinned `bunx --offline @openai/codex@0.153.3` model argv. Substituted model argv fails closed.
- Merge discovery and merge execution both exclude work when the durable exact-head qualification dependency is absent or returns false.
- The sandbox suite uses the running production broker when its ready file exists, making container/final-image runs exercise UID 1002. Developer runs use an honestly identified protocol stand-in and directly exercise real broker failure logic.

Validation:

- `bun test --timeout 60000 packages/overseer/src/__tests__/merge-candidate-discovery.test.ts packages/overseer/src/__tests__/merge-execution-bridge.test.ts packages/overseer/src/__tests__/pr-review-sandbox.test.ts packages/server/src/dispatch/review-worker-clock.test.ts packages/server/src/dispatch/review-worker-sandbox.test.ts`
- Result: 157 pass / 157 total, 0 fail, 0 skip.
- `bun run type-check`
- Result: exit 0 for every workspace and scripts TypeScript project.
- `git diff --check`
- Result: exit 0.

Runtime verification: final-image broker-ready test path required by CI; local builder ran the non-container real-broker failure path as uid 1001.
Vercel deployment: N/A (internal harness)
PR: existing repair PR #1290; no deployment or new PR performed.

VALIDATION: PASS
