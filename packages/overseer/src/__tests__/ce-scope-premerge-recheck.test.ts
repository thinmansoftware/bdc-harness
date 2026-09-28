import { describe, expect, test } from 'bun:test';
import { ceScopePremergeRecheck, type CeScopeRecheckDeps } from '../ce-scope-premerge-recheck';
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
});
