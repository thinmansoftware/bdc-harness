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
});
