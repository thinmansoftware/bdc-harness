Manifest-Version: 2
WO: WO-HARNESS-OVERSEER-REVIEW-SANDBOX-01
Builder: Any
Repair target: PR #1290 (feat/wo-harness-overseer-review-sandbox-01-repair). No new PR. Not merged.
Pre-repair head: 1f547dd5cd191f91979c5df9655dde82b9071b3e
Candidate SHA: RECORDED_AFTER_COMMIT
origin/dev: 9f918e79dddca71b060e691d4a96be66576633a8
behind_by: 2 (d8bb42a4, 9f918e79). Not rebased and not merged.

Files modified:

- packages/overseer/src/pr-review-wiring.ts
- packages/overseer/src/**tests**/pr-review-sandbox.test.ts
- scripts/overseer-review-sandbox-smoke.ts

Files created:

- artifacts/manifests/wo-harness-overseer-review-sandbox-01.md

Files intentionally unchanged:

- packages/overseer/src/judge-transport.ts (no documented Codex 0.153.3 mode qualifies)
- buildJudgeTransport argv unchanged

Capability blocker (nonmergeable, VALIDATION is not PASS):
Codex CLI 0.153.3 help does not document an enforcing mode, used with --enable use_legacy_landlock, that denies unrelated filesystem reads, unrelated writes, and network without a new user namespace, extra capabilities, root, or host/container policy changes.
codex exec --help sandbox values: read-only, workspace-write, danger-full-access. None of that text says unrelated reads fail. danger-full-access was not selected.
codex sandbox --help documents --sandbox-state-readable-root (add a readable root to supplied state) and --sandbox-state-disable-network (requires supplied sandbox state). It does not document a self-contained profile that denies unrelated reads.
codex features list: use_legacy_landlock deprecated false; use_linux_sandbox_bwrap removed false.
judge-transport.ts was not changed. The negative smoke probe was not removed, skipped, or weakened.

Native smoke:
Command: bun run scripts/overseer-review-sandbox-smoke.ts
uid: 1001 (appuser)
Codex: 0.153.3
Policy argv: codex --enable use_legacy_landlock -C <checkout> sandbox --
Result: exit 1
Error: sandbox_forbidden_read_succeeded at scripts/overseer-review-sandbox-smoke.ts:152
Outside read, outside write, and loopback controls ran as uid 1001 before the sandbox attempts. The permitted in-sandbox git inspection and test -r allowed.txt succeeded. The unrelated read then exited 0. Unrelated reads are not confined.
docker is not installed in this builder, so docker exec --user appuser archon-smoke could not run. The command above is the direct uid-1001 run of the same script. This is not a final-image PASS.

Stop 1:
Command: grep -c 'review_incomplete' packages/overseer/src/pr-review-submit.ts
Result: 4 (at least 1)

Stop 2:
Command: bun test --timeout 60000 packages/overseer/src/**tests**/pr-review-sandbox.test.ts packages/overseer/src/**tests**/pr-review-sandbox-merge-qualification.test.ts packages/server/src/dispatch/review-worker-sandbox.test.ts
Result: 12 pass / 12 total, 0 fail, 0 skip

- pr-review-sandbox.test.ts: 8 pass (2 existing hand-built approval tests plus 6 caller tests)
- pr-review-sandbox-merge-qualification.test.ts: 2 pass
- review-worker-sandbox.test.ts: 2 pass

Caller proof behavior:

- A tracked post-commit edit, an untracked file, and a gitignored untracked file each prevent codex sandbox argv spawn, return review_incomplete, and post zero APPROVE reviews.
- A declared check that appends to a tracked file and exits 0 produces no execution proof and does not qualify the head. The spawn wrapper is test simulation, not native enforcement.
- A non-mutating check can reach the model, and an evaluate override that then appends to a tracked file and returns APPROVE does not qualify the head. Proof is discarded.
- Synthetic canaries BDC_REVIEW_CANARY, GH_TOKEN, GITHUB_TOKEN, OPENAI_API_KEY, GITHUB_APP_PRIVATE_KEY, and OVERSEER_REVIEW_WEBHOOK_SECRET are absent from recorded git environments and from captured Codex spawn environments. The parent environment is unchanged afterward.
  Untrusted git, inspection, and check subprocesses receive only PATH copied from the parent plus HOME, CODEX_HOME, and TMPDIR set to a private mkdtemp scratch. Model authentication is unchanged.

Stop 3:
Command: LC_ALL=C grep -n '[^ -~]' on judge-transport.ts, pr-review-evaluator.ts, pr-review-wiring.ts, pr-review-submit.ts, github-real-deps.ts, review-worker-clock.ts, pr-review-sandbox.test.ts, and scripts/overseer-review-sandbox-smoke.ts
Result: no output, exit 1

Stop 5:
Command: bun test --timeout 60000 packages/overseer/src/**tests**/judge-transport.test.ts
Result: 14 pass / 14 total, 0 fail. Non-PR buildJudgeTransport behavior preserved.

Stop 6:
Command: bun run type-check
Result: exit 0

VALIDATION: FAIL
Native uid-1001 smoke did not exit 0. Unrelated reads are not confined. Do not merge.
Runtime verification: author ran the local uid-1001 smoke; final-image CI remains required; later activation is separate.
Vercel deployment: N/A (internal harness)
PRs: https://github.com/thinmansoftware/bdc-harness/pull/1290
