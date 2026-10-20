import { beforeEach, describe, expect, test } from 'bun:test';
import type { IndependentReviewFinding } from '../independent-review-evidence.ts';
import {
  createRealFetchExactHeadPullRequestEvidence,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';
import {
  inMemoryAttemptCounterStore,
  resetRequiredContextsAttemptCounters,
  resetRequiredContextsCache,
} from '../adapters/required-contexts.ts';
import { latestAttemptPerCheck } from '../pr-review-check-ingest.ts';
import {
  applyRequiredCheckGate,
  buildReviewPrompt,
  evaluatePullRequest,
  partitionChecksByRequired,
  type PrReviewCheck,
  type PrReviewDeps,
  type PrReviewInput,
} from '../pr-review-evaluator.ts';

// WO-HARNESS-OVERSEER-GRADE-REQUIRED-CHECKS-01: the Overseer verdict is gated
// ONLY by the base branch's required status-check contexts, judged on the latest
// attempt per check. Non-required failures are non-blocking notes. These tests
// drive evaluatePullRequest through injected PrReviewDeps -- no network, no
// GitHub, no database -- plus the two real adapters (required-contexts resolver
// and github-real-deps) for the attempt-field carry test.

beforeEach(() => {
  resetRequiredContextsAttemptCounters();
  resetRequiredContextsCache();
});

const HEAD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REQUIRED = ['docker-build', 'test (ubuntu-latest)'];

const input: PrReviewInput = {
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  pr_number: 1187,
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
      requiredContexts: REQUIRED,
    }),
    fetchAcceptanceCriteria: async () => 'implementation is safe',
    invokeModel: async () => ({ exitCode: 0, timedOut: false, stdout: output('APPROVE') }),
    ladder: ['review-model'],
    ...overrides,
  };
}

const TEST_1_CHECKS: PrReviewCheck[] = [
  { name: 'docker-build', status: 'completed', conclusion: 'success' },
  { name: 'test (ubuntu-latest)', status: 'completed', conclusion: 'success' },
  { name: 'test (windows-latest)', status: 'completed', conclusion: 'failure' },
];

describe('required-check verdict gate', () => {
  test('1 non_required_failure_approves_with_note', async () => {
    const windowsFinding: IndependentReviewFinding = {
      scope: 'checks/test (windows-latest)',
      severity: 'major',
      summary: 'failed',
    };
    // Case A: the model blocked on the non-required windows check.
    const caseA = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({
          diff: '+ change',
          checks: TEST_1_CHECKS,
          requiredContexts: REQUIRED,
        }),
        invokeModel: async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: output('REQUEST_CHANGES', [windowsFinding]),
        }),
      })
    );
    // Case B: the model approved and never mentioned the windows check.
    const caseB = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({
          diff: '+ change',
          checks: TEST_1_CHECKS,
          requiredContexts: REQUIRED,
        }),
        invokeModel: async () => ({ exitCode: 0, timedOut: false, stdout: output('APPROVE') }),
      })
    );

    for (const result of [caseA, caseB]) {
      expect(result.verdict).toBe('APPROVE');
      const windowsNotes = result.findings.filter(
        finding => finding.scope === 'checks/test (windows-latest)'
      );
      expect(windowsNotes.length).toBe(1);
      expect(windowsNotes[0]?.severity).toBe('note');
      expect(windowsNotes[0]?.summary).toContain('not a required check');
      expect(windowsNotes[0]?.summary).toContain('non-blocking');
      expect(
        result.findings.some(
          finding => finding.severity === 'blocker' || finding.severity === 'major'
        )
      ).toBe(false);
    }
  });

  test('2 required_failure_still_blocks', async () => {
    const checks: PrReviewCheck[] = [
      { name: 'test (ubuntu-latest)', status: 'completed', conclusion: 'failure' },
      { name: 'docker-build', status: 'completed', conclusion: 'success' },
      { name: 'test (windows-latest)', status: 'completed', conclusion: 'success' },
    ];
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({ diff: '+ change', checks, requiredContexts: REQUIRED }),
        invokeModel: async () => ({ exitCode: 0, timedOut: false, stdout: output('APPROVE') }),
      })
    );
    expect(result.verdict).toBe('REQUEST_CHANGES');
    const required = result.findings.find(
      finding => finding.scope === 'checks/test (ubuntu-latest)'
    );
    expect(required?.severity).toBe('major');
  });

  test('3 superseded_failed_attempt_then_success_counts_as_success', async () => {
    const checks: PrReviewCheck[] = [
      {
        name: 'test (ubuntu-latest)',
        status: 'completed',
        conclusion: 'failure',
        id: 1,
        completed_at: '2026-10-20T11:30:00Z',
      },
      {
        name: 'test (ubuntu-latest)',
        status: 'completed',
        conclusion: 'success',
        id: 2,
        completed_at: '2026-10-20T11:50:00Z',
      },
      {
        name: 'test (windows-latest)',
        status: 'completed',
        conclusion: 'failure',
        id: 3,
        completed_at: '2026-10-20T11:30:00Z',
      },
      {
        name: 'test (windows-latest)',
        status: 'completed',
        conclusion: 'success',
        id: 4,
        completed_at: '2026-10-20T11:50:00Z',
      },
      {
        name: 'docker-build',
        status: 'completed',
        conclusion: 'success',
        id: 5,
        completed_at: '2026-10-20T11:50:00Z',
      },
    ];
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({ diff: '+ change', checks, requiredContexts: REQUIRED }),
        invokeModel: async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: output('REQUEST_CHANGES', [
            { scope: 'checks/test (windows-latest)', severity: 'major', summary: 'failed' },
          ]),
        }),
      })
    );
    expect(result.verdict).toBe('APPROVE');
    expect(
      result.findings.some(
        finding =>
          finding.scope.includes('test (ubuntu-latest)') ||
          finding.scope.includes('test (windows-latest)')
      )
    ).toBe(false);

    const partition = partitionChecksByRequired(checks, REQUIRED);
    const all = [...partition.gating, ...partition.nonRequired];
    const perName = new Map<string, number>();
    for (const check of all) perName.set(check.name, (perName.get(check.name) ?? 0) + 1);
    expect(perName.get('docker-build')).toBe(1);
    expect(perName.get('test (ubuntu-latest)')).toBe(1);
    expect(perName.get('test (windows-latest)')).toBe(1);
    for (const check of all) expect(check.conclusion).toBe('success');
  });

  test('4 prompt_separates_required_from_non_required', () => {
    const partition = partitionChecksByRequired(TEST_1_CHECKS, REQUIRED);
    const prompt = buildReviewPrompt({
      request: input,
      diff: '+ code',
      partition,
      acceptanceCriteria: 'must pass',
    });
    const lines = prompt.split('\n');
    const requiredLine = lines.find(line =>
      line.startsWith('Required checks (these gate the verdict):')
    );
    const nonRequiredLine = lines.find(line => line.startsWith('Non-required checks'));
    expect(requiredLine).toBeDefined();
    expect(nonRequiredLine).toBeDefined();
    expect(requiredLine).toContain('docker-build');
    expect(requiredLine).toContain('test (ubuntu-latest)');
    expect(requiredLine).not.toContain('test (windows-latest)');
    expect(nonRequiredLine).toContain('test (windows-latest)');
    expect(nonRequiredLine).not.toContain('docker-build');
    expect(prompt).not.toContain('Never approve when checks fail');
  });

  test('5 code_finding_kept_and_gate_is_idempotent', async () => {
    const modelFindings: IndependentReviewFinding[] = [
      { scope: 'packages/overseer/src/x.ts', severity: 'major', summary: 'bug' },
      { scope: 'checks/test (windows-latest)', severity: 'major', summary: 'failed' },
    ];
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({
          diff: '+ change',
          checks: TEST_1_CHECKS,
          requiredContexts: REQUIRED,
        }),
        invokeModel: async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: output('REQUEST_CHANGES', modelFindings),
        }),
      })
    );
    expect(result.verdict).toBe('REQUEST_CHANGES');
    const code = result.findings.find(finding => finding.scope === 'packages/overseer/src/x.ts');
    expect(code?.severity).toBe('major');
    const windows = result.findings.find(
      finding => finding.scope === 'checks/test (windows-latest)'
    );
    expect(windows?.severity).toBe('note');

    // The gate is pure and idempotent: a single application already produced the
    // evaluator's output, and a second application is a deep-equal no-op.
    const partition = partitionChecksByRequired(TEST_1_CHECKS, REQUIRED);
    const once = applyRequiredCheckGate(
      { verdict: 'REQUEST_CHANGES', findings: modelFindings },
      partition
    );
    const twice = applyRequiredCheckGate(once, partition);
    expect(twice).toEqual(once);
    expect(once.verdict).toBe('REQUEST_CHANGES');
    expect(once.findings.filter(f => f.scope === 'checks/test (windows-latest)').length).toBe(1);
    expect(result.verdict).toBe(once.verdict);
    expect(result.findings).toEqual(once.findings);
  });

  test('6 no_required_set_keeps_todays_behavior', async () => {
    const checks: PrReviewCheck[] = [{ name: 'test', status: 'completed', conclusion: 'failure' }];
    // requiredContexts omitted (undefined): every check gates, exactly as today.
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({ diff: '+ change', checks }),
        invokeModel: async () => ({ exitCode: 0, timedOut: false, stdout: output('APPROVE') }),
      })
    );
    expect(result.verdict).toBe('REQUEST_CHANGES');
    const major = result.findings.find(finding => finding.scope === 'checks/test');
    expect(major?.severity).toBe('major');

    // requiredContexts null (UNKNOWN) still defers -- deferral is unchanged.
    const deferred = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({ diff: '+ change', checks, requiredContexts: null }),
        invokeModel: async () => ({ exitCode: 0, timedOut: false, stdout: output('APPROVE') }),
      })
    );
    expect(deferred.verdict).toBe('CHECKS_PENDING');
  });

  test('7 adapter_carries_attempt_fields', async () => {
    const octokit = {
      pulls: {
        get: async () => ({ data: { head: { sha: HEAD_A }, base: { sha: HEAD_B, ref: 'dev' } } }),
      },
      repos: {
        compareCommits: async () => ({
          data: { files: [{ filename: 'safe.ts', patch: '+ pinned' }] },
        }),
      },
      checks: {
        listForRef: async () => ({
          data: {
            check_runs: [
              {
                name: 'test (windows-latest)',
                status: 'completed',
                conclusion: 'failure',
                id: 1,
                started_at: '2026-10-20T11:00:00Z',
                completed_at: '2026-10-20T11:30:00Z',
                app: { slug: 'github-actions', name: 'GitHub Actions' },
              },
              {
                name: 'test (windows-latest)',
                status: 'completed',
                conclusion: 'success',
                id: 2,
                started_at: '2026-10-20T11:40:00Z',
                completed_at: '2026-10-20T11:50:00Z',
                app: { slug: 'github-actions', name: 'GitHub Actions' },
              },
            ],
          },
        }),
      },
    } as unknown as RealGitHubOctokitLike;

    const evidence = await createRealFetchExactHeadPullRequestEvidence(
      octokit,
      undefined,
      inMemoryAttemptCounterStore
    )({
      owner: input.owner,
      repo: input.repo,
      prNumber: input.pr_number,
      headSha: HEAD_A,
    });

    expect(evidence.checks.length).toBe(2);
    for (const check of evidence.checks) {
      expect(typeof check.id).toBe('number');
      expect(typeof check.completed_at).toBe('string');
      expect(check.app?.slug).toBe('github-actions');
    }

    const latest = latestAttemptPerCheck(evidence.checks);
    expect(latest.length).toBe(1);
    expect(latest[0]?.id).toBe(2);
  });
});
