import { describe, expect, test } from 'bun:test';
import { recheckCeScopeBeforeMerge, type CeScopeGitHub } from '../ce-scope-premerge-recheck';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
function github(overrides: Partial<CeScopeGitHub> = {}): CeScopeGitHub {
  return {
    getPull: async () => ({ state: 'open', head: { sha: head, ref: 'feature' }, base: { ref: 'release/ce' } }),
    getBranchTip: async () => base,
    compare: async () => ({ files: [] }),
    listWorkflowRuns: async (_repo, _head, event) => ({ runs: event === 'pull_request_target' ? [{ id: 1, check_suite_id: 10, path: '.github/workflows/ce-change-scope-gate.yml', event, head_branch: 'feature', run_started_at: '2026-01-02T00:00:00Z', run_attempt: 1, conclusion: 'success' }] : [] }),
    listCheckRuns: async () => ({ checks: [{ name: 'CE Change Scope Gate', conclusion: 'success', check_suite: { id: 10 } }] }),
    ...overrides,
  };
}

describe('CE scope premerge recheck', () => {
  test('allows exactly one genuine current green gate', async () => {
    expect(await recheckCeScopeBeforeMerge({ repo: 'thinmansoftware/lspro-react', pr_number: 1, expected_head_sha: head }, { github: github(), newestRevocation: async () => null })).toEqual({ ok: true });
  });

  test('refuses a spoofed duplicate and a revocation newer than green', async () => {
    const duplicate = github({ listCheckRuns: async () => ({ checks: [{ name: 'CE Change Scope Gate', conclusion: 'success', check_suite: { id: 999 } }] }) });
    expect(await recheckCeScopeBeforeMerge({ repo: 'r', pr_number: 1 }, { github: duplicate, newestRevocation: async () => null })).toEqual({ ok: false, reason: 'duplicate_gate_check' });
    expect(await recheckCeScopeBeforeMerge({ repo: 'r', pr_number: 1 }, { github: github(), newestRevocation: async () => '2026-01-03T00:00:00Z' })).toEqual({ ok: false, reason: 'revoked_after_green' });
  });

  test('rechecks wide-scope approval and prevents merge on missing approval', async () => {
    const wide = github({ compare: async () => ({ files: Array.from({ length: 11 }, (_, i) => ({ filename: `src/components/ce/${i}.tsx`, status: 'modified' })) }) });
    let decisions = 0;
    const result = await recheckCeScopeBeforeMerge({ repo: 'r', pr_number: 1 }, {
      github: wide,
      decision: async () => { decisions++; return { decision: 'deny', reason: 'no_record' }; },
      newestRevocation: async () => null,
    });
    expect(decisions).toBe(1);
    expect(result).toEqual({ ok: false, reason: 'approval_missing' });
  });

  test('fails closed when compare reports a truncated file set', async () => {
    const truncated = github({ compare: async () => ({ files: [], truncated: true }) });
    expect(await recheckCeScopeBeforeMerge({ repo: 'r', pr_number: 1 }, { github: truncated }))
      .toEqual({ ok: false, reason: 'compare_truncated' });
  });

  test('rejects a mismatched target event and an earlier green rerun attempt', async () => {
    const run = (attempt: number, conclusion: string, event = 'pull_request_target') => ({
      id: 1, check_suite_id: 10, path: '.github/workflows/ce-change-scope-gate.yml', event,
      head_branch: 'feature', run_started_at: '2026-01-02T00:00:00Z', run_attempt: attempt, conclusion,
    });
    const mismatched = github({ listWorkflowRuns: async (_repo, _head, event) => ({
      runs: event === 'pull_request_target' ? [run(1, 'success', 'pull_request')] : [],
    }) });
    expect(await recheckCeScopeBeforeMerge({ repo: 'r', pr_number: 1 }, { github: mismatched }))
      .toEqual({ ok: false, reason: 'gate_not_green' });
    const rerun = github({ listWorkflowRuns: async (_repo, _head, event) => ({
      runs: event === 'pull_request_target' ? [run(1, 'success'), run(2, 'failure')] : [],
    }) });
    expect(await recheckCeScopeBeforeMerge({ repo: 'r', pr_number: 1 }, { github: rerun }))
      .toEqual({ ok: false, reason: 'gate_not_green' });
  });
});
