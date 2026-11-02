Manifest-Version: 2
WO: WO-GRIMOIRE-PROJECT-RECORD-01
Builder: Codex (GPT-6), assigned Archon worktree
Spec revision: d18f07a4855f1af096a21a39a5127a1a62a91fd5
Spec hash: sha256:be5750b32cab594ed7a99789d54da0638ec4afc167a62aec6881f6c4ed19e861
Starting reference: 8c8438b37a59877cedd19ab1aaded77b61331cc5
Migration: 066_grimoire_project_record.sql (066 was free)

Files modified:

- bun.lock
- migrations/000_combined.sql
- packages/cli/package.json
- packages/cli/src/cli.ts
- packages/core/package.json
- packages/core/src/db/adapters/sqlite.ts
- packages/core/src/db/codebases.ts
- packages/core/src/db/codebases.test.ts
- packages/core/src/types/index.ts
- packages/overseer/package.json
- packages/server/src/routes/api.ts
- packages/server/src/routes/schemas/codebase.schemas.ts

Files created:

- migrations/066_grimoire_project_record.sql
- packages/core/src/grimoire/project-record.ts
- packages/core/src/grimoire/project-record.test.ts
- packages/cli/src/commands/project.ts
- packages/cli/src/commands/project.test.ts
- docs/grimoire/project-record.md
- artifacts/manifests/wo-grimoire-project-record-01.md

Implementation: nullable JSON text storage, strict versioned schema, PATCH object/null persistence, parsed API responses with corrupt-record warning, read-only project show/verify, thinman alias, credential redaction, five verification surfaces, JSON and exit precedence. SQLite inspection uses a read-only connection through the core database module to avoid initializing or migrating the inspected database. Core and Overseer expose narrowly scoped public subpaths. POST registration logic is unchanged; its new response field is serialized consistently with GET/PATCH.

Tests:

- 43/43 passed: bun test packages/core/src/grimoire/project-record.test.ts packages/cli/src/commands/project.test.ts packages/core/src/db/codebases.test.ts
- 32/32 passed: bun test packages/server/src/routes/api.codebases.test.ts
- bun run --cwd packages/cli test: exit 0
- bun run type-check: exit 0 (workspace and scripts)
- Changed production TypeScript lint: exit 0; commit hooks also passed lint and formatting.
- git diff --check: clean
- Required ASCII scan: no output (grep exit 1, clean)
- bun run test: exit 1, blocked by the existing Overseer sandbox test described below. All other package suites completed without a reported failure.

Validation blocker: packages/overseer/src/**tests**/pr-review-sandbox.test.ts, "a zero-exit check that edits a tracked file cannot qualify the head". Expected allowed.txt to contain "x"; received "allowed\n". Reproduced both with this implementation and on the untouched starting commit in this same assigned worktree. Baseline proof: stashed all feature changes, verified clean status and HEAD 8c8438b37a59877cedd19ab1aaded77b61331cc5, ran bun test --timeout 60000 packages/overseer/src/**tests**/pr-review-sandbox.test.ts packages/overseer/src/**tests**/pr-review-sandbox-merge-qualification.test.ts: 21 passed, 1 failed, exit 1. Restored the stash and reran the required feature tests successfully. No sandbox behavior or tests were changed. Stop 5 remains unsatisfied; this manifest does not claim PASS.

PRs: https://github.com/thinmansoftware/bdc-harness/pull/1423 (DRAFT, base dev)
Merge ancestors:

- thinmansoftware/bdc-harness dev HEAD: 8c8438b37a59877cedd19ab1aaded77b61331cc5 | manifest commit: 3ee49bf3b32e01eb5630c0c9160f9fcb0644f1bd | behind_by: 0

The manifest commit above is the validated implementation commit; this manifest is recorded in a subsequent documentation commit. Fetched dev and ran git rebase origin/dev before opening the draft PR; no rebase changes were needed.

Grep assertions:

- thinmansoftware/bdc-harness: grep -c 'thinman' packages/cli/package.json -> 1
- thinmansoftware/bdc-harness: grep -c 'production_branches' packages/core/src/grimoire/project-record.ts -> 4
- thinmansoftware/bdc-harness: grep -c 'resolveMergeRepoPolicy' packages/cli/src/commands/project.ts -> 2
- thinmansoftware/bdc-harness: grep -c 'verify' docs/grimoire/project-record.md -> 2

Runtime verification: N/A at REVIEW (CODE class); live outcome recorded after the rebuild per "Live outcome check"
Invocation documented at: docs/grimoire/project-record.md
Vercel deployment: N/A (harness, no Vercel)
VALIDATION: BLOCKED (required full-suite baseline failure; feature tests and types pass)

Fire (recorded only; not executed):

```text
powershell -File scripts/cauldron/fire.ps1 -Wo WO-GRIMOIRE-PROJECT-RECORD-01 -Project bdc-harness -Class CODE -Tags feature
```

No deployment, live record writes, projection writes, or production changes were performed.
