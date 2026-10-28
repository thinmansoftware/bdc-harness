Manifest-Version: 2
WO: WO-HARNESS-OVERSEER-LOOP-CANARIES-01
Builder: Any
Files modified: packages/canary-suite/src/cli.ts
Files created: packages/canary-suite/src/overseer-loop-canary.ts, packages/canary-suite/src/overseer-loop-canary.test.ts, docs/canary/overseer-loop.md, .archon/scheduled/overseer-loop-canary-daily.yaml, packages/canary-suite/fixtures/overseer-loop/c1-missing-branch.sql, packages/canary-suite/fixtures/overseer-loop/c2-repeated-denial.sql, packages/canary-suite/fixtures/overseer-loop/c2-unmerged-ready.sql, packages/canary-suite/fixtures/overseer-loop/c2-clean.sql, packages/canary-suite/fixtures/overseer-loop/c7-tripwire.sql, packages/canary-suite/fixtures/overseer-loop/c4-missing-base.md, packages/canary-suite/fixtures/overseer-loop/c4-wrong-base.md, packages/canary-suite/fixtures/overseer-loop/c4-correct-base.md, packages/canary-suite/fixtures/overseer-loop/c4-missing-base.expected.txt, packages/canary-suite/fixtures/overseer-loop/c4-wrong-base.expected.txt, artifacts/manifests/wo-harness-overseer-loop-canaries-01.md
Tests: 10/10 (bun test packages/canary-suite/src/overseer-loop-canary.test.ts)
Suite: 75 pass / 0 fail (bun test packages/canary-suite)
PRs: https://github.com/thinmansoftware/bdc-harness/pull/1365
Merge ancestors:

- thinmansoftware/bdc-harness dev HEAD: 40b6522994149452cb73abdd5fd8dbfc4f2e0071 | manifest commit: 8740d6de084c6e1c8eedf5a8b059cbe6fdededb7 | behind_by: 0
  Grep assertions:
- thinmansoftware/bdc-harness: grep -c 'overseer-loop' packages/canary-suite/src/cli.ts -> 5 (at least 1)
- grep -c 'C[1-7]' packages/canary-suite/src/overseer-loop-canary.ts -> 50 (at least 7)
- ASCII scan of overseer-loop-canary.ts, overseer-loop-canary.test.ts, and docs/canary/overseer-loop.md -> no matches
  Runtime verification: N/A (CODE class, no runtime surface)
  Vercel deployment: N/A
  PS deliverable not authored; C4 production fire.ps1 path needs an operator host with pwsh.
  VALIDATION: PASS
