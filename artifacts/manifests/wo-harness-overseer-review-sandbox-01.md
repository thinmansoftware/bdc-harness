Manifest-Version: 2
WO: WO-HARNESS-OVERSEER-REVIEW-SANDBOX-01
Builder: Major Build (Claude Opus 5.5, XO-directed session, outside Cauldron per John 2026-11-01)
Repair target: PR #1290, feat/wo-harness-overseer-review-sandbox-01-repair
Functional candidate SHA: e63c92a710513cedde2abb88fc2678471f5b4a44
Prior reviewed head: 6e69be855c80cacd19164b2d98d3dded217aa9c8
Fetched origin/dev: ff56241c10fd50ecca092837721f050427e6dd49
Merge commit: 9d60e6f86 (parents 6e69be855c80cacd19164b2d98d3dded217aa9c8, ff56241c10fd50ecca092837721f050427e6dd49), ordinary merge, no rebase, no force push
Merge base after merge: ff56241c10fd50ecca092837721f050427e6dd49 (behind_by 0)
Custody: worktree created from origin/feat/wo-harness-overseer-review-sandbox-01-repair at 6e69be85 (= live PR head); only fast-forward pushes followed.

Round-6 findings (Overseer CHANGES_REQUESTED at 6e69be85):

- R6-1 / S2 seal strips executable bits: fixed. sealReviewCheckout takes Git's 100755 list (git ls-files --stage); tracked executables 0750, other files 0640, dirs 0750, symlinks never followed. Fresh and cached checkouts re-verified with `git -c core.filemode=true diff --quiet HEAD` and empty porcelain status.
- R6-2 / S1 base compared to moving tip: fixed. prepareReviewCheckout fetches H and B by object id; the base branch tip is never read; a missing or non-commit object is review_checkout_identity_failure.
- Worker preparation failure previously left the claim stuck (catch-and-log); it is now a review_incomplete COMMENT carrying the reason. Queued work without baseSha (check-completion, ladder recovery) captures the PR base from GitHub in the trusted parent.
- S4: broker capture bounded in bytes across both streams with process-group SIGKILL on overflow and after exit; configurable deadline/limit; model jobs carry the parent's model wall clock (4 MiB event limit). Deadline/overflow reasons reach the `Review incomplete:` comment.
- Merged dev #1400 regressions: execution qualification moved after both head gates (still before custody and any publication).
- Windows: readTrustedCheckPlan containment by lstat (8.3 short-name realpath mismatch).

Files modified (this repair): packages/overseer/package.json, packages/overseer/src/**tests**/pr-review-sandbox.test.ts, packages/overseer/src/pr-review-evaluator.ts, packages/overseer/src/pr-review-submit.ts, packages/overseer/src/pr-review-wiring.ts, packages/overseer/src/reviewer-broker-client.ts, packages/server/src/dispatch/review-worker-clock.ts, packages/server/src/dispatch/review-worker-sandbox.test.ts, scripts/overseer-reviewer-broker.ts, artifacts/manifests/wo-harness-overseer-review-sandbox-01.md
Merge resolution: Dockerfile, packages/overseer/src/merge-execution-bridge.ts, packages/overseer/src/pr-review-evaluator.ts, packages/overseer/src/service.ts

Validation at e63c92a7:

- Stop 1: review_incomplete count 4.
- Stop 2: Linux CI (test ubuntu-latest, run 41368055199) ran all three suites through the package test scripts, 0 fail, no sandbox test skipped. Local Windows: overseer suites 12 pass / 8 Linux-gated skip; server suite 8 pass / 3 Linux-gated skip.
- Stop 3: ASCII byte scan of all 26 changed files: 0 non-ASCII bytes.
- Stop 4/7: docker-build (run 41368055199) passed; final-image smoke printed `overseer-review-sandbox-smoke: ok uid=1002 codex=0.153.3 policy=use_legacy_landlock`; reviewer secret/workspace/auth/proc-environ probes denied; inspect `false []`.
- Stop 5: judge-transport 18 pass / 0 fail.
- Stop 6: bun run type-check exit 0.
- Stop 8, 11, 12, 13: named tests pass on ubuntu CI; g+rwX count 0.
- Stop 10: no errexit-exempt negated probes (grep exit 1).
- Stop 14: workflow contains `false []`; this file names the functional candidate; commits after it touch only artifacts/manifests/.
- Stop 15: tracked_executable_survives_checkout_seal, captured_base_survives_branch_advance, captured_base_unavailable_fails_closed pass on ubuntu CI (executable test is Linux-only).
- Stop 16: all ten names present and passing on ubuntu CI, including untrusted_check_deadline_kills_tree and untrusted_check_output_bounded (worker -> wiring -> submit -> real processJob).
- Full ubuntu test job: pass. Full overseer package suite on Windows: 1571 pass, 0 fail, 9 skip.
- test (windows-latest): fails only on companion-mcp `wiki-sync is idempotent` (Executable not found: wiki-sync.sh), identical on dev ff56241c1 (run 41360578622); not touched by this PR.

Accepted limit: Design A residual risk item 8 (reviewer can read its own model login), mitigated by blocked command network, disabled model web search, and the parent review-body credential-leak guard.
Runtime verification: post-activation Stop 9 not run; activation not authorized. Deploy is the post-merge M-181 rebuild.
Vercel deployment: N/A (internal harness)
PR: https://github.com/thinmansoftware/bdc-harness/pull/1290
VALIDATION: PASS
