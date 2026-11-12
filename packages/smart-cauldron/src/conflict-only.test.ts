// WO-HARNESS-CONFLICT-ONLY-GATE-NO-TIER-CLIMB-01 (bdc-xo#5658).
// A completed run whose only failing gate condition is a merge conflict never climbs. These cases
// cover the mergeability reading (Test 1), the judge's conflictOnly flag (Tests 3 and 4) and the
// handler that tries one branch update and otherwise comments once (Tests 5 to 7 at the handler
// level). The cascade-level cases are in __tests__/cascade.test.ts.
import { describe, expect, test } from 'bun:test';
import { judgeGate } from './judge.js';
import { prMergeabilityFromGh } from './poll.js';
import { conflictMarker, handleConflictOnly, type ConflictOnlyDeps } from './conflict-only.js';
import type { PollResult } from './types.js';

const gh = (mergeable: string, mergeStateStatus: string): string =>
  JSON.stringify({ mergeable, mergeStateStatus });

describe('Test 1: only a conflict is unmergeable', () => {
  test('reads mergeable and mergeStateStatus together', () => {
    expect(prMergeabilityFromGh(gh('MERGEABLE', 'CLEAN'))).toBe(true);
    // A PR waiting for a required review is BLOCKED, never "not mergeable".
    expect(prMergeabilityFromGh(gh('MERGEABLE', 'BLOCKED'))).toBe(true);
    expect(prMergeabilityFromGh(gh('MERGEABLE', 'BEHIND'))).toBe(true);
    expect(prMergeabilityFromGh(gh('MERGEABLE', 'UNSTABLE'))).toBe(true);
    expect(prMergeabilityFromGh(gh('UNKNOWN', 'UNKNOWN'))).toBeNull();
    expect(prMergeabilityFromGh(gh('CONFLICTING', 'DIRTY'))).toBe(false);
    expect(prMergeabilityFromGh(gh('UNKNOWN', 'DIRTY'))).toBe(false);
  });

  test('the old dead branch is gone: BLOCKED in either field is not a conflict', () => {
    expect(prMergeabilityFromGh(gh('BLOCKED', 'BLOCKED'))).toBeNull();
    expect(prMergeabilityFromGh(gh('MERGEABLE', 'BLOCKED'))).not.toBe(false);
  });

  test('unreadable output is unknown', () => {
    expect(prMergeabilityFromGh('')).toBeNull();
    expect(prMergeabilityFromGh('not json')).toBeNull();
    expect(prMergeabilityFromGh('{}')).toBeNull();
  });
});

function poll(overrides: Partial<PollResult> = {}): PollResult {
  return {
    runId: 'run-1',
    terminalStatus: 'completed',
    validatorVerdict: 'unknown',
    prUrl: 'https://github.com/org/repo/pull/106',
    prMergeable: false,
    servedModelId: null,
    rawMetadata: {},
    ...overrides,
  };
}

describe('judgeGate conflictOnly', () => {
  test('Test 3: a completed run with an opened PR and only a conflict is conflict-only', () => {
    const verdict = judgeGate(poll());
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe('PR is not mergeable');
    expect(verdict.conflictOnly).toBe(true);
  });

  test('Test 4: every other failure is not conflict-only and keeps its reasons', () => {
    const rejected = judgeGate(poll({ validatorVerdict: 'needs_revision' }));
    expect(rejected.conflictOnly).toBeUndefined();
    expect(rejected.reason).toBe('validator verdict: needs_revision; PR is not mergeable');

    const failed = judgeGate(poll({ terminalStatus: 'failed' }));
    expect(failed.conflictOnly).toBeUndefined();
    expect(failed.reason).toBe('terminal status: failed; PR is not mergeable');

    const noPr = judgeGate(poll({ prUrl: null }));
    expect(noPr.conflictOnly).toBeUndefined();
    expect(noPr.reason).toBe('no PR opened after completed run; PR is not mergeable');

    const passing = judgeGate(poll({ prMergeable: true }));
    expect(passing.pass).toBe(true);
    expect(passing.conflictOnly).toBeUndefined();

    const cancelled = judgeGate(poll({ terminalStatus: 'cancelled' }));
    expect(cancelled.conflictOnly).toBeUndefined();
  });
});

const HEAD = 'a'.repeat(40);
const FORK_POINT = 'b'.repeat(40);

interface Call {
  args: readonly string[];
}

function fakeGh(options: {
  comments?: string[];
  updateFails?: string;
  commentFails?: boolean;
  covered?: boolean;
}): { deps: ConflictOnlyDeps; calls: Call[]; posted: string[] } {
  const calls: Call[] = [];
  const posted: string[] = [];
  const deps: ConflictOnlyDeps = {
    isCoveredProductionBase: () => options.covered === true,
    gh: async args => {
      calls.push({ args });
      const text = args.join(' ');
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          stdout: JSON.stringify({
            headRefOid: HEAD,
            baseRefName: 'main',
            comments: (options.comments ?? []).map(body => ({ body })),
          }),
        };
      }
      if (text.includes('update-branch')) {
        if (options.updateFails) {
          throw Object.assign(new Error('gh failed'), { stderr: options.updateFails });
        }
        return { stdout: '{"message":"Updating pull request branch."}' };
      }
      if (text.includes(`compare/main...${HEAD}`)) return { stdout: `${FORK_POINT}\n` };
      if (text.includes(`compare/${FORK_POINT}...main`)) {
        return { stdout: 'staging/package.json\nstaging/src/server/m67-store.ts\nREADME.md\n' };
      }
      if (text.includes('/pulls/106/files')) {
        return { stdout: 'staging/package.json\nstaging/app/signup/page.tsx\nREADME.md\n' };
      }
      if (text.includes('/issues/106/comments')) {
        if (options.commentFails) throw new Error('comment refused');
        const bodyArg = args.find(arg => arg.startsWith('body=')) ?? '';
        posted.push(bodyArg.slice('body='.length));
        return { stdout: '{}' };
      }
      throw new Error(`unexpected gh call: ${text}`);
    },
  };
  return { deps, calls, posted };
}

const URL = 'https://github.com/org/repo/pull/106';

describe('handleConflictOnly', () => {
  test('Test 5: a clean update (202) means no comment and one update call', async () => {
    const h = fakeGh({});
    const result = await handleConflictOnly(URL, h.deps);
    expect(result.outcome).toBe('updated');
    expect(result.updateStatus).toBe(202);
    expect(h.posted).toEqual([]);
    expect(h.calls.filter(call => call.args.join(' ').includes('update-branch'))).toHaveLength(1);
    const update = h.calls.find(call => call.args.join(' ').includes('update-branch'));
    expect(update?.args).toContain('PUT');
    expect(update?.args).toContain(`expected_head_sha=${HEAD}`);
  });

  test('Test 6: a conflict (422) posts one comment with the marker and the files changed on both sides', async () => {
    const h = fakeGh({ updateFails: 'gh: Merge conflict (HTTP 422)' });
    const result = await handleConflictOnly(URL, h.deps);
    expect(result.outcome).toBe('conflict_only');
    expect(result.updateStatus).toBe(422);
    expect(result.commented).toBe(true);
    expect(result.files).toEqual(['README.md', 'staging/package.json']);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toContain(conflictMarker(HEAD));
    expect(h.posted[0]).toContain('- staging/package.json');
    expect(h.posted[0]).toContain('no higher rung was started');
    expect(h.posted[0]).toContain('(HTTP 422)');

    // The same head again: the marker is already there, so no update call and no second comment.
    const again = fakeGh({ comments: [h.posted[0] ?? ''] });
    const second = await handleConflictOnly(URL, again.deps);
    expect(second.alreadyRecorded).toBe(true);
    expect(second.commented).toBe(false);
    expect(again.posted).toEqual([]);
    expect(again.calls.some(call => call.args.join(' ').includes('update-branch'))).toBe(false);
  });

  test('Test 7: a refused update (403) or a covered production base never claims a conflict', async () => {
    const refused = fakeGh({ updateFails: 'gh: Resource not accessible (HTTP 403)' });
    const a = await handleConflictOnly(URL, refused.deps);
    expect(a.outcome).toBe('conflict_only');
    expect(a.updateStatus).toBe(403);
    expect(refused.posted[0]).toContain('HTTP 403');
    expect(refused.posted[0]).toContain('No conflict was observed by this call');

    const covered = fakeGh({ covered: true });
    const b = await handleConflictOnly(URL, covered.deps);
    expect(b.outcome).toBe('conflict_only');
    expect(b.updateStatus).toBeNull();
    expect(covered.calls.some(call => call.args.join(' ').includes('update-branch'))).toBe(false);
    expect(covered.posted[0]).toContain('covered production base');
  });

  test('an unreadable PR or a failed comment degrades quietly', async () => {
    const unreadable = await handleConflictOnly(URL, {
      isCoveredProductionBase: () => false,
      gh: async () => {
        throw new Error('not found');
      },
    });
    expect(unreadable.outcome).toBe('conflict_only');
    expect(unreadable.commented).toBe(false);
    expect(unreadable.note).toContain('nothing was attempted');

    const bad = await handleConflictOnly('not a url', fakeGh({}).deps);
    expect(bad.note).toContain('could not be parsed');

    const noComment = await handleConflictOnly(
      URL,
      fakeGh({ updateFails: 'HTTP 422', commentFails: true }).deps
    );
    expect(noComment.commented).toBe(false);
    expect(noComment.note).toContain('could not be posted');
  });
});
