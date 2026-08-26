import { describe, expect, test } from 'bun:test';
import {
  createRealFetchExactHeadPullRequestEvidence,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';
import {
  buildReviewPrompt,
  evaluatePullRequest,
  parseReviewVerdict,
  type PrReviewDeps,
  type PrReviewInput,
} from '../pr-review-evaluator.ts';

const HEAD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const input: PrReviewInput = {
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  pr_number: 42,
  head_sha: HEAD_A,
  wo_id: 'WO-TEST-01',
};

function output(
  verdict: 'APPROVE' | 'REQUEST_CHANGES',
  findings: unknown[] = [],
  head = HEAD_A
): string {
  return JSON.stringify({ verdict, findings, reviewed_head_sha: head });
}

function deps(overrides: Partial<PrReviewDeps> = {}): PrReviewDeps {
  return {
    reviewer: { provider: 'test-provider', model: 'review-model' },
    fetchEvidence: async () => ({
      diff: '+ safe implementation',
      checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    }),
    fetchAcceptanceCriteria: async () => 'implementation is safe',
    invokeModel: async () => ({ exitCode: 0, timedOut: false, stdout: output('APPROVE') }),
    ladder: ['review-model'],
    ...overrides,
  };
}

describe('governed PR-code reviewer', () => {
  test('1 clean diff yields APPROVE with exact head and reviewer identity', async () => {
    const result = await evaluatePullRequest(input, deps());
    expect(result.verdict).toBe('APPROVE');
    expect(result.reviewed_head_sha).toBe(HEAD_A);
    expect(result.reviewer).toEqual({ provider: 'test-provider', model: 'review-model' });
  });

  test('2 blocking acceptance-criteria finding yields REQUEST_CHANGES', async () => {
    const finding = { scope: 'auth.ts', severity: 'blocker', summary: 'Bypasses authorization' };
    const result = await evaluatePullRequest(
      input,
      deps({
        invokeModel: async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: output('REQUEST_CHANGES', [finding]),
        }),
      })
    );
    expect(result.verdict).toBe('REQUEST_CHANGES');
    expect(result.findings).toEqual([finding]);
  });

  test('3 unparseable model output is INDETERMINATE, never approval', async () => {
    const result = await evaluatePullRequest(
      input,
      deps({ invokeModel: async () => ({ exitCode: 0, timedOut: false, stdout: 'yes' }) })
    );
    expect(result.verdict).toBe('INDETERMINATE');
    expect(parseReviewVerdict('{"verdict":"APPROVE"}')).toBeNull();
  });

  test('4 invocation error is recorded as INDETERMINATE', async () => {
    const result = await evaluatePullRequest(
      input,
      deps({
        invokeModel: async () => {
          throw new Error('provider unavailable');
        },
      })
    );
    expect(result.verdict).toBe('INDETERMINATE');
    expect(result.error).toContain('provider unavailable');
  });

  test('5 every ref-addressable GitHub evidence read is pinned to the exact head', async () => {
    const calls: Record<string, unknown>[] = [];
    const octokit = {
      pulls: {
        get: async (request: Record<string, unknown>) => {
          calls.push(request);
          return { data: { head: { sha: HEAD_A }, base: { sha: HEAD_B } } };
        },
      },
      repos: {
        compareCommits: async (request: Record<string, unknown>) => {
          calls.push(request);
          return { data: { files: [{ filename: 'safe.ts', patch: '+ pinned' }] } };
        },
      },
      checks: {
        listForRef: async (request: Record<string, unknown>) => {
          calls.push(request);
          return { data: { check_runs: [] } };
        },
      },
    } as unknown as RealGitHubOctokitLike;
    await createRealFetchExactHeadPullRequestEvidence(octokit)({
      owner: input.owner,
      repo: input.repo,
      prNumber: input.pr_number,
      headSha: input.head_sha,
    });
    expect(calls[0]?.head_sha).toBe(HEAD_A);
    expect(calls[1]?.head).toBe(HEAD_A);
    expect(calls[2]?.ref).toBe(HEAD_A);
  });

  test('5b evidence collection rejects when the live PR head has moved', async () => {
    const octokit = {
      pulls: {
        get: async () => ({ data: { head: { sha: HEAD_B }, base: { sha: HEAD_A } } }),
      },
      repos: {
        compareCommits: async () => {
          throw new Error('comparison must not run for a stale head');
        },
      },
      checks: {
        listForRef: async () => {
          throw new Error('checks must not run for a stale head');
        },
      },
    } as unknown as RealGitHubOctokitLike;

    await expect(
      createRealFetchExactHeadPullRequestEvidence(octokit)({
        owner: input.owner,
        repo: input.repo,
        prNumber: input.pr_number,
        headSha: HEAD_A,
      })
    ).rejects.toThrow('pr_review_head_moved');
  });

  test('6 returned head mismatch is INDETERMINATE', async () => {
    const result = await evaluatePullRequest(
      input,
      deps({
        invokeModel: async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: output('APPROVE', [], HEAD_B),
        }),
      })
    );
    expect(result.verdict).toBe('INDETERMINATE');
    expect(result.error).toBe('reviewed_head_mismatch');
  });

  test('7 missing acceptance criteria degrades without failing review', async () => {
    const result = await evaluatePullRequest(
      input,
      deps({ fetchAcceptanceCriteria: async () => null })
    );
    expect(result.verdict).toBe('APPROVE');
    expect(result.acceptance_criteria_available).toBe(false);
  });

  test('8 failing checks are visible to the model and its findings', async () => {
    let prompt = '';
    const finding = { scope: 'checks/test', severity: 'major', summary: 'Tests failed' } as const;
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({
          diff: '+ change',
          checks: [{ name: 'unit', status: 'completed', conclusion: 'failure' }],
        }),
        invokeModel: async (_binary, value) => {
          prompt = value;
          return {
            exitCode: 0,
            timedOut: false,
            stdout: output('REQUEST_CHANGES', [finding]),
          };
        },
      })
    );
    expect(prompt).toContain('"conclusion":"failure"');
    expect(result.findings).toEqual([finding]);
  });

  test('9 every completed result records non-empty reviewer identity', async () => {
    const result = await evaluatePullRequest(input, deps());
    expect(result.reviewer.provider.length).toBeGreaterThan(0);
    expect(result.reviewer.model.length).toBeGreaterThan(0);
  });

  test('10 prompt asks for code review evidence and strict structured output', () => {
    const prompt = buildReviewPrompt({
      request: input,
      diff: '+ code',
      checks: [],
      acceptanceCriteria: 'must pass',
    });
    expect(prompt).toContain('code diff');
    expect(prompt).toContain('acceptance criteria');
    expect(prompt).toContain('REQUEST_CHANGES');
  });
});
