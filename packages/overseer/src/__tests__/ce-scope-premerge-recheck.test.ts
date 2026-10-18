import { describe, expect, test } from 'bun:test';
import { ceScopePremergeRecheck, type CeScopeRecheckDeps } from '../ce-scope-premerge-recheck';
import live from './fixtures/pull-request-target-run.live-2026-09-28.json';
const S = '1'.repeat(40),
  B = '2'.repeat(40),
  started = '2026-09-28T10:00:00Z';
function deps(overrides: Partial<CeScopeRecheckDeps> = {}): CeScopeRecheckDeps {
  const run = {
    id: 1,
    path: '.github/workflows/ce-change-scope-gate.yml',
    event: 'pull_request_target',
    head_sha: S,
    head_branch: 'feature',
    run_started_at: started,
    run_attempt: 1,
    conclusion: 'success',
    check_suite_id: 10,
  };
  return {
    getPullRequest: async () => ({
      state: 'open',
      number: 626,
      head: { sha: S, ref: 'feature' },
      base: { ref: 'release/ce' },
    }),
    getBranchTip: async () => B,
    compare: async () => ({
      complete: true,
      files: [{ filename: 'README.md', status: 'modified' }],
    }),
    listWorkflowRuns: async () => [run],
    listCheckRuns: async () => [
      { name: 'CE Change Scope Gate', conclusion: 'success', check_suite: { id: 10 } },
    ],
    getApproval: async () => ({
      decision: 'allow',
      approval: {
        repo: 'thinmansoftware/lspro-react',
        pr_number: 626,
        head_sha: S,
        base_sha: B,
        target_branch: 'release/ce',
      },
    }),
    getMetadata: async () => ({ hasOtherBase: false, newestRevokedAt: null }),
    ...overrides,
  };
}
const check = (d: CeScopeRecheckDeps) =>
  ceScopePremergeRecheck({ owner: 'thinmansoftware', repo: 'lspro-react', prNumber: 626, deps: d });
const wideFiles = Array.from({ length: 11 }, (_, i) => ({
  filename: `src/components/ce/${i}.ts`,
  status: 'modified',
}));
describe('CE scope premerge recheck', () => {
  test('premerge_recheck_allows_single_genuine_green_gate', async () =>
    expect(await check(deps())).toEqual({ ok: true }));
  test('premerge_recheck_refuses_spoofed_or_duplicate_check', async () => {
    const result = await check(
      deps({
        listCheckRuns: async () => [
          { name: 'CE Change Scope Gate', conclusion: 'success', check_suite: { id: 10 } },
          { name: 'CE Change Scope Gate', conclusion: 'success', check_suite: { id: 99 } },
        ],
      })
    );
    expect(result).toEqual({ ok: false, reason: 'duplicate_gate_check' });
  });
  test('legacy pull_request run authenticates its same-name check suite', async () => {
    const base = deps();
    const target = await base.listWorkflowRuns('', '', '');
    const result = await check(
      deps({
        listWorkflowRuns: async () => [
          ...target,
          {
            ...target[0]!,
            id: 2,
            event: 'pull_request',
            check_suite_id: 11,
          },
        ],
        listCheckRuns: async () => [
          { name: 'CE Change Scope Gate', conclusion: 'success', check_suite: { id: 10 } },
          { name: 'CE Change Scope Gate', conclusion: 'success', check_suite: { id: 11 } },
        ],
      })
    );
    expect(result).toEqual({ ok: true });
  });
  test('premerge_recheck_refuses_green_older_than_revoke', async () =>
    expect(
      await check(
        deps({
          getMetadata: async () => ({
            hasOtherBase: false,
            newestRevokedAt: '2026-09-28T11:00:00Z',
          }),
        })
      )
    ).toEqual({ ok: false, reason: 'revoked_after_green' }));
  test('revoked_after_green_compares_epochs_not_strings', async () => {
    // PostgreSQL text form of a revoke AFTER the green run (started 10:00Z): blocks.
    expect(
      await check(
        deps({
          getMetadata: async () => ({
            hasOtherBase: false,
            newestRevokedAt: new Date('2026-09-28T11:00:00Z').toString(),
          }),
        })
      )
    ).toEqual({ ok: false, reason: 'revoked_after_green' });
    // A revoke BEFORE the green run does not block.
    expect(
      await check(
        deps({
          getMetadata: async () => ({
            hasOtherBase: false,
            newestRevokedAt: '2026-09-28 09:00:00+00',
          }),
        })
      )
    ).toEqual({ ok: true });
    // An unparseable revoke timestamp fails closed.
    expect(
      await check(
        deps({ getMetadata: async () => ({ hasOtherBase: false, newestRevokedAt: 'garbage' }) })
      )
    ).toEqual({ ok: false, reason: 'revoked_after_green' });
  });
  test('premerge_recheck_reverifies_record_not_just_check', async () =>
    expect(
      await check(
        deps({
          compare: async () => ({ complete: true, files: wideFiles }),
          getApproval: async () => ({ decision: 'deny', reason: 'no_record' }),
        })
      )
    ).toEqual({ ok: false, reason: 'approval_missing' }));
  test('premerge_recheck_check_cardinality', async () =>
    expect(
      await check(
        deps({
          listCheckRuns: async () => [
            { name: 'CE Change Scope Gate', conclusion: 'skipped', check_suite: { id: 10 } },
          ],
        })
      )
    ).toEqual({ ok: false, reason: 'gate_not_green' }));
  test('compare completeness fails closed at 300 files', async () =>
    expect(
      await check(
        deps({
          compare: async () => ({
            complete: true,
            files: Array.from({ length: 300 }, (_, i) => ({
              filename: `${i}`,
              status: 'modified',
            })),
          }),
        })
      )
    ).toEqual({ ok: false, reason: 'compare_truncated' }));
  test('force_push_back_requires_unchanged_base premerge', async () =>
    expect(
      await check(
        deps({
          compare: async () => ({ complete: true, files: wideFiles }),
          getApproval: async () => ({ decision: 'deny', reason: 'no_record' }),
          getMetadata: async () => ({ hasOtherBase: true, newestRevokedAt: null }),
        })
      )
    ).toEqual({ ok: false, reason: 'base_moved' }));
  test('reapproval_after_base_advance premerge allows', async () =>
    expect(
      await check(deps({ compare: async () => ({ complete: true, files: wideFiles }) }))
    ).toEqual({ ok: true }));
  test('live_api_pull_request_target_run_carries_pr_head_sha', () => {
    // Verbatim live GitHub API data (see fixture _source). A pull_request_target
    // run's head_sha is the PR HEAD, not the base; its check run sits on that head
    // with the same check suite; pull_requests[] is empty, so association uses
    // head_sha + head_branch.
    expect(live.workflow_run.event).toBe('pull_request_target');
    expect(live.workflow_run.head_sha).toBe(live.pull_request.head.sha);
    expect(live.workflow_run.head_sha).not.toBe(live.pull_request.base.sha);
    expect(live.workflow_run.head_branch).toBe(live.pull_request.head.ref);
    expect(live.workflow_run.pull_requests).toEqual([]);
    expect(live.check_runs_on_pr_head[0].head_sha).toBe(live.pull_request.head.sha);
    expect(live.check_runs_on_pr_head[0].check_suite.id).toBe(live.workflow_run.check_suite_id);
  });
  test('live_api_shaped_gate_run_is_found_by_pr_head_lookup', async () => {
    // Same field semantics as the live run; only the workflow path, name and
    // conclusion are those of the scope gate.
    const headSha = live.pull_request.head.sha;
    const run = {
      id: live.workflow_run.id,
      path: '.github/workflows/ce-change-scope-gate.yml',
      event: live.workflow_run.event,
      head_sha: live.workflow_run.head_sha,
      head_branch: live.workflow_run.head_branch,
      run_started_at: live.workflow_run.run_started_at,
      run_attempt: live.workflow_run.run_attempt,
      conclusion: 'success',
      check_suite_id: live.workflow_run.check_suite_id,
    };
    let queriedHead = '';
    const result = await ceScopePremergeRecheck({
      owner: 'thinmansoftware',
      repo: 'lspro-react',
      prNumber: live.pull_request.number,
      deps: deps({
        getPullRequest: async () => ({
          state: live.pull_request.state,
          number: live.pull_request.number,
          head: live.pull_request.head,
          base: { ref: live.pull_request.base.ref },
        }),
        getBranchTip: async () => live.pull_request.base.sha,
        listWorkflowRuns: async (_o, _r, head) => {
          queriedHead = head;
          return head === run.head_sha ? [run] : [];
        },
        listCheckRuns: async (_o, _r, head) =>
          head === headSha
            ? [
                {
                  name: 'CE Change Scope Gate',
                  conclusion: 'success',
                  check_suite: { id: live.check_runs_on_pr_head[0].check_suite.id },
                },
              ]
            : [],
      }),
    });
    expect(queriedHead).toBe(headSha);
    expect(result).toEqual({ ok: true });
  });
  test('rename_out_of_protected_directory_counts_as_removal', async () => {
    const denied = deps({
      compare: async () => ({
        complete: true,
        files: [
          {
            filename: 'src/components/other/Grader.tsx',
            previous_filename: 'src/components/ce/Grader.tsx',
            status: 'renamed',
          },
        ],
      }),
      getApproval: async () => ({ decision: 'deny', reason: 'no_record' }),
    });
    expect(await check(denied)).toEqual({ ok: false, reason: 'approval_missing' });
    const regressionMove = deps({
      compare: async () => ({
        complete: true,
        files: [
          {
            filename: 'tests/archive/slab.spec.ts',
            previous_filename: 'tests/ce-regression/slab.spec.ts',
            status: 'renamed',
          },
        ],
      }),
      getApproval: async () => ({ decision: 'deny', reason: 'no_record' }),
    });
    expect(await check(regressionMove)).toEqual({ ok: false, reason: 'approval_missing' });
    // A rename that stays inside a protected directory is not a removal.
    const within = deps({
      compare: async () => ({
        complete: true,
        files: [
          {
            filename: 'src/components/ce/grading/Grader.tsx',
            previous_filename: 'src/components/ce/Grader.tsx',
            status: 'renamed',
          },
        ],
      }),
      getApproval: async () => ({ decision: 'deny', reason: 'no_record' }),
    });
    expect(await check(within)).toEqual({ ok: true });
  });
  test('revocation_during_final_check_run_request_is_seen', async () => {
    // Narrow change: the revoke lands while GitHub check runs are being fetched.
    let revokedAt: string | null = null;
    const narrow = deps({
      getMetadata: async () => ({ hasOtherBase: false, newestRevokedAt: revokedAt }),
      listCheckRuns: async () => {
        revokedAt = '2026-09-28T12:00:00Z';
        return [{ name: 'CE Change Scope Gate', conclusion: 'success', check_suite: { id: 10 } }];
      },
    });
    expect(await check(narrow)).toEqual({ ok: false, reason: 'revoked_after_green' });
    // Wide change: the approval is revoked during the same request.
    let revoked = false;
    const wide = deps({
      compare: async () => ({ complete: true, files: wideFiles }),
      getApproval: async () =>
        revoked
          ? { decision: 'deny', reason: 'revoked' }
          : {
              decision: 'allow',
              approval: {
                repo: 'thinmansoftware/lspro-react',
                pr_number: 626,
                head_sha: S,
                base_sha: B,
                target_branch: 'release/ce',
              },
            },
      listCheckRuns: async () => {
        revoked = true;
        return [{ name: 'CE Change Scope Gate', conclusion: 'success', check_suite: { id: 10 } }];
      },
    });
    expect(await check(wide)).toEqual({ ok: false, reason: 'revoked' });
  });
  test('base_moving_during_inspection_is_refused', async () => {
    let tip = B;
    expect(
      await check(
        deps({
          getBranchTip: async () => tip,
          listCheckRuns: async () => {
            tip = '9'.repeat(40);
            return [
              { name: 'CE Change Scope Gate', conclusion: 'success', check_suite: { id: 10 } },
            ];
          },
        })
      )
    ).toEqual({ ok: false, reason: 'base_moved' });
  });
  test('revocation_during_final_base_lookup_is_seen', async () => {
    // Nothing is awaited after the authoritative read: a revoke committed while the
    // final release/ce tip is fetched (base unchanged) must still deny.
    let tipCalls = 0;
    let revokedAt: string | null = null;
    expect(
      await check(
        deps({
          getBranchTip: async () => {
            tipCalls += 1;
            if (tipCalls === 2) revokedAt = '2026-09-28T12:00:00Z';
            return B;
          },
          getMetadata: async () => ({ hasOtherBase: false, newestRevokedAt: revokedAt }),
        })
      )
    ).toEqual({ ok: false, reason: 'revoked_after_green' });
    expect(tipCalls).toBe(2);
    let revoked = false;
    let wideTipCalls = 0;
    expect(
      await check(
        deps({
          compare: async () => ({ complete: true, files: wideFiles }),
          getBranchTip: async () => {
            wideTipCalls += 1;
            if (wideTipCalls === 2) revoked = true;
            return B;
          },
          getApproval: async () =>
            revoked
              ? { decision: 'deny', reason: 'revoked' }
              : {
                  decision: 'allow',
                  approval: {
                    repo: 'thinmansoftware/lspro-react',
                    pr_number: 626,
                    head_sha: S,
                    base_sha: B,
                    target_branch: 'release/ce',
                  },
                },
        })
      )
    ).toEqual({ ok: false, reason: 'revoked' });
  });
  test('rename_between_protected_directories_counts_as_removal', async () => {
    for (const [from, to] of [
      ['src/components/ce/Grader.tsx', 'tests/ce-regression/Grader.tsx'],
      ['tests/ce-regression/slab.spec.ts', 'src/components/ce/slab.spec.ts'],
    ]) {
      expect(
        await check(
          deps({
            compare: async () => ({
              complete: true,
              files: [{ filename: to, previous_filename: from, status: 'renamed' }],
            }),
            getApproval: async () => ({ decision: 'deny', reason: 'no_record' }),
          })
        )
      ).toEqual({ ok: false, reason: 'approval_missing' });
    }
  });
});
