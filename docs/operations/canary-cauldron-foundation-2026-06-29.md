# Smart Cauldron Foundation Canary Proof -- 2026-06-29

Work Order: WO-HARNESS-CAULDRON-FOUNDATION-CANARY-01
Class: INFRA (cauldron_compatible: false, no source changes to engine code)
Lane under test: bdc-feature-development (default lane)
Anchor audit: docs/superpowers/specs/2026-06-29-smart-cauldron-foundation-audit-dependency-map.md

---

## 1. Tail-fix deploy cutpoint

The four tail-node fix commits are deployed in the running archon-app-1 container:

| Commit   | Date (local)               | Title                                                                                       |
| -------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| a933bd6f | 2026-06-26 09:11:58 -0400  | hotfix(patch-pr-body): pipefail-safe extract() (second grep trap) (#237)                    |
| 1fd253c3 | 2026-06-26 11:20:16 -0400  | fix(workflows): capture patch-pr-body outputs safely (#239)                                 |
| 5c310f87 | 2026-06-29 10:39:00 -0400  | fix(cauldron): tail-node defects 1-3 + 12 unit tests (WO-HARNESS-CAULDRON-DEFECT-CLEANUP-01) (#244) |

Cutpoint used for pre/post comparison: 2026-06-29 14:39:00 UTC (PR #244 merged + restarted).

Defect-to-node mapping (verbatim from
.archon/workflows/defaults/__tests__/bdc-feature-development.test.sh header):

- Tests 1-3   -> Defect 1: commit-and-push push_target regex tolerance
- Tests 4-7   -> Defect 2: open-pr-if-needed check-first design
- Test 8      -> Defect 3: DAG-executor capability check (recorded; live during build)
- Tests 9-10  -> Defect 3 integration smoke fires (manual via Cauldron)
- Tests 11-12 -> Defect 4: fire-wo-local.sh token resolution

---

## 2. Canary identification

Inaugural post-fix bdc-feature-development run, started 16 minutes after the PR #244
restart, served as the canary payload:

| Field          | Value                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| RUN_ID         | daf43c4fb9cd845ae936cae0b760f8d7                                       |
| Canary WO      | WO-SHOPOPS-OWNER-ALERT-SMS-CHANNEL-01 (real, non-money: SMS alerts)    |
| started_at     | 2026-06-29 14:54:56 UTC                                                |
| completed_at   | 2026-06-29 15:22:45 UTC                                                |
| working_path   | /.archon/workspaces/bluedevilcollectibles/shopops/worktrees/archon/thread-48ac6bd4 |
| status         | completed                                                              |

---

## 3. Tail-node event timeline (canary run daf43c4fb9cd)

From GET /api/workflows/runs/daf43c4fb9cd845ae936cae0b760f8d7 .events[],
filtered to step_name in {commit-and-push, open-pr-if-needed, patch-pr-body,
flip-notion-on-failure}:

| step_name           | node_started (UTC)    | node_completed (UTC)  | node_failed |
| ------------------- | --------------------- | --------------------- | ----------- |
| commit-and-push     | 2026-06-29 15:20:05   | 2026-06-29 15:20:07   | (none)      |
| open-pr-if-needed   | 2026-06-29 15:20:07   | 2026-06-29 15:20:09   | (none)      |
| patch-pr-body       | 2026-06-29 15:21:21   | 2026-06-29 15:21:24   | (none)      |
| flip-notion-on-failure | (not run -- success path) | -                | (none)      |

Captured PR_URL from open-pr-if-needed node_output:
  https://github.com/bluedevilcollectibles/shopops/pull/383

Captured patch-pr-body node_output:
  PR_URL=https://github.com/bluedevilcollectibles/shopops/pull/383
  patch-pr-body: PR body updated with v2 manifest.

---

## 4. PR verification (gh pr view canary)

PR #383 (bluedevilcollectibles/shopops):

```
{
  "number": 383,
  "state": "OPEN",
  "mergeable": "MERGEABLE",
  "baseRefName": "master",
  "headRefName": "feat/wo-shopops-owner-alert-sms-channel-01-thread-48ac6bd4",
  "title": "BDC feature Work Order implementation",
  "url": "https://github.com/bluedevilcollectibles/shopops/pull/383"
}
```

Note: PR base is master rather than staging; that is a separate Rule 20
correctness concern tracked outside this WO (Scope OUT in Section 5). The
canary objective -- tail-node completion + clean mergeable PR open -- is met.

---

## 5. Test scenario verdicts

| Test | Description                                                              | Verdict |
| ---- | ------------------------------------------------------------------------ | ------- |
| T1   | Canary run reaches AND completes patch-pr-body (node_completed event)    | PASS    |
| T2   | open-pr-if-needed produces a real PR URL; PR exists + mergeable          | PASS    |
| T3   | Run's tail did NOT false-fail on patch-pr-body (no node_failed event)    | PASS    |

---

## 6. Success-rate context (Scope D)

Pulled GET /api/workflows/runs?limit=200 and bucketed by started_at vs the
14:39:00 UTC cutpoint:

```
ALL bdc-feature-development        total=147 completed=87 failed=46 cancelled=7 running=7   success_of_terminal=62.1%
PRE-fix-deploy  (started < 14:39)  total=126 completed=76 failed=44 cancelled=6 running=0   success_of_terminal=60.3%
POST-fix-deploy (started >= 14:39) total= 21 completed=11 failed= 2 cancelled=1 running=7   success_of_terminal=78.6%
```

Per-run tail-event sweep across all 11 POST-fix completed runs (each fetched
individually and tail events checked):

```
daf43c4fb9cd  completed  commit-and-push=OK  open-pr-if-needed=OK  patch-pr-body=OK  pr=shopops/pull/383
bfe64e1d9dec  completed  commit-and-push=OK  open-pr-if-needed=OK  patch-pr-body=OK  pr=shopops/pull/384
37bdad157d63  completed  commit-and-push=OK  open-pr-if-needed=OK  patch-pr-body=OK  pr=shopops/pull/378
93bc96a6d8b5  completed  commit-and-push=OK  open-pr-if-needed=OK  patch-pr-body=OK  pr=lspro-react/pull/368
8b76730cdb5b  completed  commit-and-push=OK  open-pr-if-needed=OK  patch-pr-body=OK  pr=bdc-harness/pull/246
78538eb87026  completed  commit-and-push=OK  open-pr-if-needed=OK  patch-pr-body=OK  pr=bdc-harness/pull/245
92db4731d472  completed  commit-and-push=OK  open-pr-if-needed=OK  patch-pr-body=OK  pr=shopops-comic-theme/pull/36
d8c91a06da3e  completed  commit-and-push=OK  open-pr-if-needed=OK  patch-pr-body=OK  pr=shopops-comic-theme/pull/37
e4ea6b9e6f5c  completed  commit-and-push=OK  open-pr-if-needed=OK  patch-pr-body=OK  pr=bdc-harness/pull/247
4a2e94c1d291  completed  commit-and-push=OK  open-pr-if-needed=OK  patch-pr-body=OK  pr=bdc-harness/pull/248
9b2af6ad26a0  completed  commit-and-push=OK  open-pr-if-needed=OK  patch-pr-body=OK  pr=bdc-harness/pull/251
```

The 2 POST-fix failures were inspected:

```
99c5baf3ac9c  failed  commit-and-push=OK  open-pr-if-needed=OK  patch-pr-body=OK  pr=bdc-harness/pull/252
                      (PR did open; failure was outside the tail cluster)
c1be2d7a81d4  failed  commit-and-push=skip open-pr-if-needed=skip patch-pr-body=OK  pr=(none)
                      (pre-tail failure; patch-pr-body ran via trigger_rule all_done with no PR
                       to patch and did NOT false-fail)
```

Patch-pr-body tail-failure cluster (the audit's 14/25 baseline pattern):
**GONE.** Across 13 terminal post-fix runs (11 completed + 2 failed), zero
node_failed events were emitted for patch-pr-body. The 2 failures came from
upstream or non-tail nodes, not from the patched tail.

---

## 7. Conclusion

- Code-presence verified: tolerant push_target regex (Defect 1), check-first
  open-pr-if-needed (Defect 2), and flip-notion-on-failure / all_done trigger
  (Defect 3 + flip) present in /app/.archon/workflows/defaults/bdc-feature-development.yaml
  on the running container.
- Behavioral proof captured: inaugural post-fix canary run completed its full
  tail (commit-and-push -> open-pr-if-needed -> patch-pr-body) in ~80 seconds
  and produced a clean mergeable PR.
- Success-rate movement: 60.3% (pre) -> 78.6% (post) terminal completion rate
  on bdc-feature-development, with the patch-pr-body failure cluster fully
  eliminated across the post-fix sample.

INFRA VALIDATION: PASS
