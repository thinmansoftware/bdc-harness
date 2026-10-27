Manifest-Version: 2
WO: WO-HARNESS-OVERSEER-REVIEW-SANDBOX-01
Builder: Codex
Repair target: PR #1290, feat/wo-harness-overseer-review-sandbox-01-repair
Functional candidate SHA: c0dcb58be46dc8751f0ee7768abc27882c5d4a3a
Fetched origin/dev: 7a4b6438fc16696707b736cd160cc1861d7ffacb
Merge base: 7a4b6438fc16696707b736cd160cc1861d7ffacb
Persisted runScopeSha: 7a4b6438fc16696707b736cd160cc1861d7ffacb
Authority proof: git merge-base --is-ancestor runScopeSha merge-base exited 0
Custody: local HEAD, remote repair branch, and live PR #1290 head matched a8fd831bed348b21f8de34848fa5a09141e66929 before this repair iteration; exactly one open PR used the branch and its base was dev.

Files modified:

- .github/workflows/test.yml
- packages/overseer/src/**tests**/merge-candidate-discovery.test.ts
- packages/overseer/src/**tests**/merge-execution-bridge.test.ts
- packages/overseer/src/**tests**/pr-review-sandbox-merge-qualification.test.ts
- packages/overseer/src/**tests**/pr-review-sandbox.test.ts
- packages/overseer/src/merge-candidate-discovery.ts
- packages/overseer/src/merge-execution-bridge.ts
- packages/overseer/src/pr-review-ingest.ts
- packages/overseer/src/pr-review-wiring.ts
- packages/server/src/dispatch/review-worker-clock.ts
- packages/server/src/dispatch/review-worker-sandbox.test.ts
- scripts/overseer-review-sandbox-smoke.ts
- scripts/overseer-reviewer-broker.ts
- artifacts/manifests/wo-harness-overseer-review-sandbox-01.md

Validation:

- Stop 1: review_incomplete count 4.
- Stop 2: 22 pass / 22 total, zero failures and zero skips.
- Stop 3: ASCII checks produced no output.
- Stop 4: not run outside the final image; the required broker is intentionally unavailable here.
- Stop 5: 14 pass / 14 total, zero failures.
- Stop 6: type-check exited 0.
- Stop 7 native smoke: final-image CI printed `uid=1002 codex=0.153.3 policy=use_legacy_landlock`; the final CapAdd literal assertion was corrected to use the required plain Docker template rendering.
- Stop 8: focused review_incomplete tests passed.
- Stop 10: no errexit-exempt negative probes found.
- Stop 11: negative_probe_success_fails_closed collected and passed.
- Stop 12: all three named regressions collected and passed.
- Stop 13: all three named regressions collected and passed; g+rwX count 0.
- Stop 14 source assertions: workflow contains false []; this manifest names the functional candidate.
- Extended merge/worker/sandbox regression command passed with zero failures.
- Full Ubuntu CI exposed a legacy-body compatibility regression; the functional candidate preserves an absent optional baseSha and its focused regression passes.
- Merge-bridge retry fixtures now supply the mandatory qualification dependency; 7/7 retry tests and the missing-dependency fail-closed regression pass.
- Final-image diagnostics proved loopback denial; the smoke accepts curl's `Could not connect to server` spelling as the required refused-or-blocked result.

Native binding required in final-image CI: UID 1002, Codex 0.153.3, use_legacy_landlock, no added privileges, and the real broker smoke. No native result is fabricated by this manifest.
Runtime verification: post-activation Stop 9 not run; activation was not authorized.
Vercel deployment: N/A (internal harness)
PR: https://github.com/thinmansoftware/bdc-harness/pull/1290
VALIDATION: PENDING FINAL-IMAGE CI
