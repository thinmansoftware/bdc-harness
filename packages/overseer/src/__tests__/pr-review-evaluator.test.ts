import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  submitReviewerBrokerJob,
  diagnosticForError,
  type ReviewerBrokerResult,
} from '../reviewer-broker-client.ts';
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  REQUIRED_CHECK_NAME,
  reportedChecksForHead,
  requiredCheckCases,
} from './fixtures/required-check-decisions';
import {
  createRealFetchExactHeadPullRequestEvidence,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';
import {
  inMemoryAttemptCounterStore,
  resetRequiredContextsAttemptCounters,
  resetRequiredContextsCache,
} from '../adapters/required-contexts.ts';
import {
  buildReviewModelTransport,
  buildReviewPrompt,
  checksAreTerminal,
  codexExecJsonlVerdictText,
  evaluatePullRequest,
  invokeConfiguredReviewModel,
  parseReviewVerdict,
  partitionChecksByRequired,
  runReviewModelProcess,
  DEFAULT_CURSOR_JUDGE_MODEL,
  type PrReviewDeps,
  type PrReviewInput,
  type ReviewModelSpawn,
} from '../pr-review-evaluator.ts';

// The required-contexts resolver counts CONSECUTIVE unknown attempts per
// owner/repo@base+head in module scope, and degrades to the reported-checks
// heuristic past the bound. These tests assert the FAIL-CLOSED first-attempt
// behaviour, so each must start from a clean count rather than inheriting one
// from an earlier test in this file and degrading by accident.
beforeEach(() => {
  resetRequiredContextsAttemptCounters();
  resetRequiredContextsCache();
});

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

test.each(requiredCheckCases)('Rule 4 review evaluator parity: $name', async checkCase => {
  const result = await evaluatePullRequest(
    input,
    deps({
      fetchEvidence: async () => ({
        diff: '+ safe implementation',
        checks: reportedChecksForHead(checkCase),
        requiredContexts: [REQUIRED_CHECK_NAME],
      }),
    })
  );
  const expected = { pass: 'APPROVE', fail: 'REQUEST_CHANGES', pending: 'CHECKS_PENDING' };
  expect(result.verdict).toBe(expected[checkCase.outcome]);
  if (checkCase.outcome === 'pass') {
    expect(result.findings).toEqual([
      expect.objectContaining({ scope: 'checks/optional preview', severity: 'note' }),
    ]);
  }
});

describe('#6357 -- composed prompt byte cap', () => {
  const cap = 1_048_576;
  const checks = [{ name: 'test', status: 'completed', conclusion: 'success' }];
  const criteria = 'implementation is safe';
  function composed(diff: string, acceptanceCriteria = criteria): string {
    return buildReviewPrompt({
      request: input,
      diff,
      checkPartition: partitionChecksByRequired(checks),
      acceptanceCriteria,
    });
  }
  function sizedDiff(bytes: number): string {
    return 'x'.repeat(bytes - Buffer.byteLength(composed(''), 'utf8'));
  }

  test('over cap is terminal before reading the ladder or invoking any model', async () => {
    let calls = 0;
    let ladderReads = 0;
    const d = deps({
      fetchEvidence: async () => ({ diff: sizedDiff(cap + 1), checks }),
      invokeModel: async () => {
        calls++;
        return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
      },
    });
    Object.defineProperty(d, 'ladder', {
      get: () => {
        ladderReads++;
        return ['codex', 'grok'];
      },
    });
    const result = await evaluatePullRequest(input, d);
    expect(result.verdict).toBe('INDETERMINATE');
    expect(result.error).toBe(`prompt_too_large:bytes=${cap + 1}:cap=${cap}`);
    expect(result.findings).toEqual([]);
    expect(result.reviewed_head_sha).toBe(HEAD_A);
    expect(result.retry_after).toBeUndefined();
    expect(result.retry_after_ms).toBeUndefined();
    expect(calls).toBe(0);
    expect(ladderReads).toBe(0);
  });

  for (const bytes of [cap - 1, cap]) {
    test(`at ${bytes} bytes the complete prompt reaches the ordinary model`, async () => {
      const diff = sizedDiff(bytes);
      let observed = '';
      const result = await evaluatePullRequest(
        input,
        deps({
          fetchEvidence: async () => ({ diff, checks }),
          invokeModel: async (_binary, prompt) => {
            observed = prompt;
            return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
          },
        })
      );
      expect(Buffer.byteLength(observed, 'utf8')).toBe(bytes);
      expect(observed).toBe(composed(diff));
      expect(result.verdict).toBe('APPROVE');
    });
  }

  test('counts UTF-8 bytes rather than string characters', async () => {
    const diff = sizedDiff(cap - 2) + String.fromCodePoint(0x1f600);
    expect(composed(diff).length).toBeLessThanOrEqual(cap);
    let calls = 0;
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({ diff, checks }),
        invokeModel: async () => {
          calls++;
          throw new Error('must not invoke');
        },
      })
    );
    expect(result.error).toBe(`prompt_too_large:bytes=${cap + 2}:cap=${cap}`);
    expect(calls).toBe(0);
  });

  test('acceptance criteria can put an otherwise in-cap diff over the limit', async () => {
    const diff = sizedDiff(cap);
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({ diff, checks }),
        fetchAcceptanceCriteria: async () => criteria + 'x',
      })
    );
    expect(result.verdict).toBe('INDETERMINATE');
    expect(result.error).toBe(`prompt_too_large:bytes=${cap + 1}:cap=${cap}`);
  });

  test('full-text fallback and real binary markers remain intact below cap', async () => {
    const diff =
      'diff --git a/text.ts b/text.ts\n@@ -1 +1 @@\n-old\n+new\n' +
      'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n' +
      '[binary or patch unavailable]';
    let observed = '';
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({ diff, checks }),
        invokeModel: async (_binary, prompt) => {
          observed = prompt;
          return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
        },
      })
    );
    expect(observed).toBe(composed(diff));
    expect(result.verdict).toBe('APPROVE');
  });
});

describe('governed PR-code reviewer', () => {
  test('preserves recognized per-finding remediation signals', async () => {
    for (const remediation of ['mechanical', 'judgment'] as const) {
      const finding = {
        scope: 'src/x.ts',
        severity: 'major',
        summary: 'Build fails.',
        remediation,
      };
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
      expect(result.findings).toEqual([finding]);
    }
  });

  test('absent or invalid remediation signals are omitted without losing the finding', () => {
    const finding = { scope: 'src/x.ts', severity: 'major', summary: 'Build fails.' };
    for (const remediation of [
      undefined,
      null,
      'auto',
      'Mechanical',
      'mechanical ',
      true,
      {},
      [],
    ]) {
      const parsed = parseReviewVerdict(output('REQUEST_CHANGES', [{ ...finding, remediation }]));
      expect(parsed?.findings).toEqual([finding]);
      expect(parsed?.findings[0]).not.toHaveProperty('remediation');
    }
  });

  test('prompt requires a structured signal and reserves security judgments for humans', () => {
    const prompt = buildReviewPrompt({
      request: input,
      diff: '',
      checkPartition: { gating: [], nonRequired: [] },
      acceptanceCriteria: null,
    });
    expect(prompt).toContain('"remediation":"mechanical|judgment"');
    expect(prompt).toContain('security judgment is never mechanical');
  });

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
    await createRealFetchExactHeadPullRequestEvidence(
      octokit,
      undefined,
      inMemoryAttemptCounterStore
    )({
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
      createRealFetchExactHeadPullRequestEvidence(
        octokit,
        undefined,
        inMemoryAttemptCounterStore
      )({
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
          checks: [{ name: 'test', status: 'completed', conclusion: 'failure' }],
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
      checkPartition: partitionChecksByRequired([], []),
      acceptanceCriteria: 'must pass',
    });
    expect(prompt).toContain('code diff');
    expect(prompt).toContain('acceptance criteria');
    expect(prompt).toContain('REQUEST_CHANGES');
  });

  // WO-HARNESS-OVERSEER-REVIEW-WAITS-FOR-CHECKS-01, stop condition 1: a PR whose
  // checks are still non-terminal must never produce a REQUEST_CHANGES on
  // checks-pending grounds. Instead it defers (CHECKS_PENDING) WITHOUT invoking
  // the model.
  test('11 a non-terminal check defers to CHECKS_PENDING and never invokes the model', async () => {
    let modelInvoked = false;
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({
          diff: '+ change',
          checks: [{ name: 'test', status: 'queued', conclusion: null }],
        }),
        invokeModel: async () => {
          modelInvoked = true;
          return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
        },
      })
    );
    expect(result.verdict).toBe('CHECKS_PENDING');
    expect(result.reviewed_head_sha).toBe(HEAD_A);
    expect(result.error).toBe('checks_pending');
    expect(modelInvoked).toBe(false);
  });

  test('12 an empty checks array (no CI reported yet) also defers to CHECKS_PENDING', async () => {
    let modelInvoked = false;
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({ diff: '+ change', checks: [] }),
        invokeModel: async () => {
          modelInvoked = true;
          return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
        },
      })
    );
    expect(result.verdict).toBe('CHECKS_PENDING');
    expect(modelInvoked).toBe(false);
  });

  test('13 all-completed checks still flow to the model (regression)', async () => {
    let modelInvoked = false;
    const result = await evaluatePullRequest(
      input,
      deps({
        invokeModel: async () => {
          modelInvoked = true;
          return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
        },
      })
    );
    expect(modelInvoked).toBe(true);
    expect(result.verdict).toBe('APPROVE');
  });

  test('14 checksAreTerminal is true only when every reported check is completed', () => {
    expect(checksAreTerminal([])).toBe(false);
    expect(checksAreTerminal([{ name: 'a', status: 'completed', conclusion: 'success' }])).toBe(
      true
    );
    expect(
      checksAreTerminal([
        { name: 'a', status: 'completed', conclusion: 'success' },
        { name: 'b', status: 'in_progress', conclusion: null },
      ])
    ).toBe(false);
  });

  // WO-HARNESS-OVERSEER-REVIEW-WAITS-FOR-CHECKS-01, review finding 2026-09-01:
  // GitHub only lists check runs that have already been created, so "every
  // reported check completed" can be true before the rest of the required suite
  // even registers. When required contexts are known they are the authoritative
  // signal: a completed reported check with a required context still ABSENT is
  // NOT terminal.
  test('15 checksAreTerminal defers when a required context has not reported yet', () => {
    // One fast check completed, but 'build' (required) has not registered a run.
    expect(
      checksAreTerminal(
        [{ name: 'test', status: 'completed', conclusion: 'success' }],
        ['test', 'build']
      )
    ).toBe(false);
    // A required context present but still running is likewise non-terminal.
    expect(
      checksAreTerminal(
        [
          { name: 'test', status: 'completed', conclusion: 'success' },
          { name: 'build', status: 'in_progress', conclusion: null },
        ],
        ['test', 'build']
      )
    ).toBe(false);
    // Every required context reported AND completed -> terminal.
    expect(
      checksAreTerminal(
        [
          { name: 'test', status: 'completed', conclusion: 'success' },
          { name: 'build', status: 'completed', conclusion: 'success' },
        ],
        ['test', 'build']
      )
    ).toBe(true);
    // Authoritative empty set (branch enforces nothing) -> heuristic fallback.
    expect(
      checksAreTerminal([{ name: 'test', status: 'completed', conclusion: 'success' }], [])
    ).toBe(true);
    // Source does not model required contexts at all -> heuristic fallback.
    expect(checksAreTerminal([{ name: 'test', status: 'completed', conclusion: 'success' }])).toBe(
      true
    );
    // UNKNOWN required set -> fail closed, never terminal, even when every
    // reported check has completed successfully.
    expect(
      checksAreTerminal([{ name: 'test', status: 'completed', conclusion: 'success' }], null)
    ).toBe(false);
    expect(checksAreTerminal([], null)).toBe(false);
  });

  test('crossAppRequiredContext pending app before completed app is non-terminal', () => {
    expect(
      checksAreTerminal(
        [
          {
            name: 'test',
            status: 'in_progress',
            conclusion: null,
            app: { slug: 'app-a' },
          },
          {
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            app: { slug: 'app-b' },
          },
        ],
        ['test']
      )
    ).toBe(false);
  });

  test('crossAppRequiredContext completed app before pending app is non-terminal', () => {
    expect(
      checksAreTerminal(
        [
          {
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            app: { slug: 'app-b' },
          },
          {
            name: 'test',
            status: 'in_progress',
            conclusion: null,
            app: { slug: 'app-a' },
          },
        ],
        ['test']
      )
    ).toBe(false);
  });

  test('crossAppRequiredContext is terminal when every apps latest run completed', () => {
    expect(
      checksAreTerminal(
        [
          {
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            app: { slug: 'app-a' },
          },
          {
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            app: { slug: 'app-b' },
          },
        ],
        ['test']
      )
    ).toBe(true);
  });

  test('16 a completed reported check with a required context still absent defers to CHECKS_PENDING', async () => {
    let modelInvoked = false;
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({
          diff: '+ change',
          checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
          requiredContexts: ['test', 'build'],
        }),
        invokeModel: async () => {
          modelInvoked = true;
          return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
        },
      })
    );
    expect(result.verdict).toBe('CHECKS_PENDING');
    expect(result.error).toBe('checks_pending');
    expect(modelInvoked).toBe(false);
  });

  test('17 all required contexts reported and completed flow to the model', async () => {
    let modelInvoked = false;
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({
          diff: '+ change',
          checks: [
            { name: 'test', status: 'completed', conclusion: 'success' },
            { name: 'build', status: 'completed', conclusion: 'success' },
          ],
          requiredContexts: ['test', 'build'],
        }),
        invokeModel: async () => {
          modelInvoked = true;
          return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
        },
      })
    );
    expect(modelInvoked).toBe(true);
    expect(result.verdict).toBe('APPROVE');
  });

  test('18 real evidence fetch surfaces base-branch required contexts', async () => {
    const octokit = {
      pulls: {
        get: async () => ({ data: { head: { sha: HEAD_A }, base: { sha: HEAD_B, ref: 'main' } } }),
      },
      repos: {
        compareCommits: async () => ({
          data: { files: [{ filename: 'safe.ts', patch: '+ ok' }] },
        }),
        getAllStatusCheckContexts: async (request: Record<string, unknown>) => {
          expect(request.branch).toBe('main');
          return { data: ['test', 'build'] };
        },
      },
      checks: {
        listForRef: async () => ({
          data: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] },
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
    expect(evidence.requiredContexts).toEqual(['test', 'build']);
    // Reviewer would defer: 'build' is required but no run reported it yet.
    expect(checksAreTerminal(evidence.checks, evidence.requiredContexts)).toBe(false);
  });

  test('19 unreadable branch protection is UNKNOWN (null), never an empty required set', async () => {
    // GitHub returns 404 both for an unprotected branch and for a token that
    // cannot see protection, so a failure must never be read as "nothing is
    // required" -- that is the fail-open path this test locks shut.
    for (const failure of [
      Object.assign(new Error('Branch not protected'), { status: 404 }),
      Object.assign(new Error('Resource not accessible by integration'), { status: 403 }),
      Object.assign(new Error('Bad gateway'), { status: 502 }),
    ]) {
      // Each shape asserts fail-closed on a FIRST attempt; without this the
      // three iterations would share one consecutive-unknown count.
      resetRequiredContextsAttemptCounters();
      const octokit = {
        pulls: {
          get: async () => ({
            data: { head: { sha: HEAD_A }, base: { sha: HEAD_B, ref: 'main' } },
          }),
        },
        repos: {
          compareCommits: async () => ({
            data: { files: [{ filename: 'safe.ts', patch: '+ ok' }] },
          }),
          getAllStatusCheckContexts: async () => {
            throw failure;
          },
        },
        checks: {
          listForRef: async () => ({
            data: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] },
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
      expect(evidence.requiredContexts).toBeNull();
      // Fails closed: a completed reported check does NOT make the suite terminal.
      expect(checksAreTerminal(evidence.checks, evidence.requiredContexts)).toBe(false);
    }
  });

  test('20 an unavailable protection API is UNKNOWN, not an empty required set', async () => {
    const octokit = {
      pulls: {
        get: async () => ({ data: { head: { sha: HEAD_A }, base: { sha: HEAD_B, ref: 'main' } } }),
      },
      repos: {
        compareCommits: async () => ({
          data: { files: [{ filename: 'safe.ts', patch: '+ ok' }] },
        }),
        // getAllStatusCheckContexts intentionally absent.
      },
      checks: {
        listForRef: async () => ({
          data: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] },
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
    expect(evidence.requiredContexts).toBeNull();
    expect(checksAreTerminal(evidence.checks, evidence.requiredContexts)).toBe(false);
  });

  test('21 an authoritative empty required set still allows review to proceed', async () => {
    const octokit = {
      pulls: {
        get: async () => ({ data: { head: { sha: HEAD_A }, base: { sha: HEAD_B, ref: 'main' } } }),
      },
      repos: {
        compareCommits: async () => ({
          data: { files: [{ filename: 'safe.ts', patch: '+ ok' }] },
        }),
        getAllStatusCheckContexts: async () => ({ data: [] }),
      },
      checks: {
        listForRef: async () => ({
          data: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] },
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
    expect(evidence.requiredContexts).toEqual([]);
    expect(checksAreTerminal(evidence.checks, evidence.requiredContexts)).toBe(true);
  });

  test('22 evaluator defers to CHECKS_PENDING when the required set is UNKNOWN', async () => {
    let modelInvoked = false;
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({
          diff: '+ change',
          checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
          requiredContexts: null,
        }),
        invokeModel: async () => {
          modelInvoked = true;
          return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
        },
      })
    );
    expect(result.verdict).toBe('CHECKS_PENDING');
    expect(result.error).toBe('checks_pending');
    expect(modelInvoked).toBe(false);
  });

  test('required checks use normalized latest names and optional pending checks do not block', async () => {
    let prompt = '';
    let modelInvocations = 0;
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({
          diff: '+ change',
          requiredContexts: ['docker-build', 'test (ubuntu-latest)'],
          checks: [
            { name: 'Docker-Build', status: 'completed', conclusion: 'success' },
            { name: ' test (ubuntu-latest) ', status: 'completed', conclusion: 'success' },
            { name: 'test (windows-latest)', status: 'in_progress', conclusion: null },
          ],
        }),
        invokeModel: async (_binary, value) => {
          modelInvocations += 1;
          prompt = value;
          return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
        },
      })
    );
    expect(result.verdict).toBe('APPROVE');
    expect(modelInvocations).toBe(1);
    expect(prompt).toContain('test (windows-latest)');
  });

  test('CHECKS_PENDING identifies running required checks but not absent ones', async () => {
    const result = await evaluatePullRequest(
      input,
      deps({
        fetchEvidence: async () => ({
          diff: '+ change',
          requiredContexts: ['docker-build', 'test (ubuntu-latest)'],
          checks: [
            { name: 'docker-build', status: 'completed', conclusion: 'success' },
            { name: 'test (ubuntu-latest)', status: 'in_progress', conclusion: null },
          ],
        }),
      })
    );
    expect(result.verdict).toBe('CHECKS_PENDING');
    expect(result.pendingChecks).toEqual(['test (ubuntu-latest)']);
    expect(
      checksAreTerminal(
        [{ name: 'docker-build', status: 'completed', conclusion: 'success' }],
        null
      )
    ).toBe(false);
  });
});

// PR #848 -- the CURSOR rail as a judge rung. Both configured rungs
// (codex, grok) are dead (usage limit / defunded credits), so every review
// since 2026-09-14 returned INDETERMINATE model_exit_nonzero. A third rung on
// the Cursor subscription must be able to return a determinate verdict.
describe('cursor judge rung', () => {
  const prevModel = process.env.OVERSEER_CURSOR_JUDGE_MODEL;
  const prevLadder = process.env.OVERSEER_JUDGE_LADDER;

  function restoreEnv(): void {
    if (prevModel === undefined) delete process.env.OVERSEER_CURSOR_JUDGE_MODEL;
    else process.env.OVERSEER_CURSOR_JUDGE_MODEL = prevModel;
    if (prevLadder === undefined) delete process.env.OVERSEER_JUDGE_LADDER;
    else process.env.OVERSEER_JUDGE_LADDER = prevLadder;
  }

  test('23 transport spawns cursor-agent in read-only ask mode with the default model', async () => {
    delete process.env.OVERSEER_CURSOR_JUDGE_MODEL;
    try {
      const prompt = `review this ${'x'.repeat(150_000)}`;
      const transport = await buildReviewModelTransport('cursor', prompt);
      expect(DEFAULT_CURSOR_JUDGE_MODEL).toBe('grok-4.7-high');
      expect(transport.argv).toEqual([
        'cursor-agent',
        '--print',
        '--mode',
        'ask',
        '--trust',
        '--model',
        DEFAULT_CURSOR_JUDGE_MODEL,
      ]);
      // The prompt travels on stdin; no argv element may carry any of it.
      expect(transport.stdinPrompt).toBe(prompt);
      expect(transport.promptFile).toBeUndefined();
      expect(transport.promptDir).toBeUndefined();
      for (const arg of transport.argv) {
        expect(arg.length).toBeLessThan(200);
        expect(arg).not.toContain('review this');
        expect(arg).not.toContain('x'.repeat(100));
      }
    } finally {
      restoreEnv();
    }
  });

  test('24 transport honours OVERSEER_CURSOR_JUDGE_MODEL and ignores a blank value', async () => {
    try {
      process.env.OVERSEER_CURSOR_JUDGE_MODEL = 'gpt-5.6-sol-high';
      const configured = await buildReviewModelTransport('cursor', 'p');
      expect(configured.argv.slice(-2)).toEqual(['--model', 'gpt-5.6-sol-high']);

      process.env.OVERSEER_CURSOR_JUDGE_MODEL = '   ';
      const blank = await buildReviewModelTransport('cursor', 'p');
      expect(blank.argv.slice(-2)).toEqual(['--model', DEFAULT_CURSOR_JUDGE_MODEL]);
    } finally {
      restoreEnv();
    }
  });

  test('25 ladder codex,grok,cursor: two dead rungs then a cursor verdict is determinate', async () => {
    try {
      process.env.OVERSEER_JUDGE_LADDER = 'codex,grok,cursor';
      const invoked: string[] = [];
      const result = await evaluatePullRequest(
        input,
        deps({
          // undefined -> evaluator falls back to OVERSEER_JUDGE_LADDER.
          ladder: undefined,
          invokeModel: async binary => {
            invoked.push(binary);
            if (binary === 'cursor') {
              return { exitCode: 0, timedOut: false, stdout: output('APPROVE') };
            }
            // What the dead rungs print today: model_exit_nonzero.
            return { exitCode: 1, timedOut: false, stdout: '' };
          },
        })
      );
      expect(invoked).toEqual(['codex', 'grok', 'cursor']);
      expect(result.verdict).toBe('APPROVE');
      expect(result.reviewer).toEqual({ provider: 'test-provider', model: 'cursor' });
      expect(result.error).toBeUndefined();
    } finally {
      restoreEnv();
    }
  });

  test('26 a fenced JSON answer from cursor-agent still satisfies parseReviewVerdict', async () => {
    const fenced = '```json\n' + output('APPROVE') + '\n```\n';
    const spawn: ReviewModelSpawn = () => ({
      stdin: null,
      stdout: new Response(fenced).body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
      kill: (): void => undefined,
    });
    const result = await runReviewModelProcess(
      { argv: ['cursor-agent', '--print'], stdinPrompt: 'p' },
      'cursor',
      5_000,
      spawn
    );
    expect(result.exitCode).toBe(0);
    expect(parseReviewVerdict(result.stdout)?.verdict).toBe('APPROVE');
    // Unfenced output is passed through unchanged.
    expect(
      parseReviewVerdict(
        output('REQUEST_CHANGES', [{ scope: 'a.ts', severity: 'major', summary: 'x' }])
      )?.verdict
    ).toBe('REQUEST_CHANGES');
  });
});

describe('WO-HARNESS-OVERSEER-REVIEW-JSONL-VERDICT-01 -- broker JSONL verdict text', () => {
  const HEAD_H = 'H';

  function event(value: unknown): string {
    return JSON.stringify(value);
  }

  test('1 a JSONL stream whose last agent message is APPROVE parses that verdict', () => {
    const stream = [
      event({ type: 'thread.started', thread_id: 't' }),
      event({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          aggregated_output: 'bun test\n0 fail',
        },
      }),
      event({
        type: 'item.completed',
        item: { type: 'agent_message', text: output('APPROVE', [], HEAD_H) },
      }),
      event({ type: 'turn.completed' }),
    ].join('\n');
    const parsed = parseReviewVerdict(codexExecJsonlVerdictText(stream));
    expect(parsed?.verdict).toBe('APPROVE');
    expect(parsed?.reviewed_head_sha).toBe(HEAD_H);
  });

  test('2 the last completed agent message wins over an earlier REQUEST_CHANGES', () => {
    const stream = [
      event({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: output('REQUEST_CHANGES', [
            { scope: 'a.ts', severity: 'major', summary: 'earlier' },
          ]),
        },
      }),
      event({ type: 'turn.completed' }),
      event({
        type: 'item.completed',
        item: { type: 'agent_message', text: output('APPROVE', [], HEAD_H) },
      }),
    ].join('\n');
    expect(parseReviewVerdict(codexExecJsonlVerdictText(stream))?.verdict).toBe('APPROVE');
  });

  test('3 streams with no completed agent message fail closed', () => {
    const eventsOnly = [event({ type: 'thread.started' }), event({ type: 'turn.completed' })].join(
      '\n'
    );
    const verdictOnlyInToolOutput = event({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        aggregated_output: output('APPROVE', [], HEAD_H),
      },
    });
    expect(parseReviewVerdict(codexExecJsonlVerdictText(eventsOnly))).toBeNull();
    expect(parseReviewVerdict(codexExecJsonlVerdictText('not json at all'))).toBeNull();
    expect(parseReviewVerdict(codexExecJsonlVerdictText(verdictOnlyInToolOutput))).toBeNull();
  });
});

/** Phase A fixtures never start a model, broker, socket or use a real profile. */
async function diagnosticFixture(
  fields: Partial<ReviewerBrokerResult>,
  action?: (id: string) => Partial<ReviewerBrokerResult>
) {
  const root = await mkdtemp(join(tmpdir(), 'review-diagnostic-'));
  await writeFile(join(root, 'ready'), 'synthetic');
  const canary = 'PRIVATE_DIAGNOSTIC_CANARY';
  let requestId = '';
  try {
    const result = await invokeConfiguredReviewModel(
      'codex',
      canary,
      {
        kind: 'pr-review',
        cwd: '/synthetic',
        expectedHeadSha: HEAD_A,
        nativePolicy: 'codex_bubblewrap',
      },
      1000,
      async (job, options) => {
        requestId = options?.id ?? '';
        await writeFile(
          join(root, `${requestId}.result.json`),
          JSON.stringify({
            id: requestId,
            ok: false,
            exitCode: 1,
            stdout: canary,
            stderr: canary,
            uid: 1002,
            ...fields,
            ...action?.(requestId),
          })
        );
        return submitReviewerBrokerJob(job, { ...options, env: { OVERSEER_REVIEW_SPOOL: root } });
      }
    );
    expect(await readdir(root)).toEqual(['ready']);
    return { result, requestId };
  } finally {
    expect(await readdir(root)).toEqual(['ready']);
    await rm(root, { recursive: true, force: true });
  }
}

describe('Phase A sanitized termination production seams', () => {
  test('A1 classified native result preserves only safe fields and actual broker id', async () => {
    const { result, requestId } = await diagnosticFixture({
      stderr: 'PRIVATE_DIAGNOSTIC_CANARY authentication required',
    });
    expect(result.diagnostic).toEqual({
      terminationClass: 'auth_expired',
      exitCode: 1,
      correlationId: requestId,
    });
    expect(Object.keys(result.diagnostic!).sort()).toEqual([
      'correlationId',
      'exitCode',
      'terminationClass',
    ]);
    // Native stderr still does NOT become business classifier input.
    expect(result.stderr).toBeUndefined();
  });
  test('A2 unknown native exit is not guessed and remains nonapproving', async () => {
    const { result } = await diagnosticFixture({});
    const evaluated = await evaluatePullRequest(input, deps({ invokeModel: async () => result }));
    expect(evaluated.verdict).toBe('INDETERMINATE');
    expect(evaluated.diagnostics?.[0].terminationClass).toBe('unknown_nonzero');
    expect(evaluated.diagnostics?.[0].exitCode).toBe(1);
  });
  test('A2 broker catch125 is unavailable, observed125 stays observed, and provenance refuses', async () => {
    const cases: [Partial<ReviewerBrokerResult>, string, number | null][] = [
      [
        { exitCode: 125, stdout: '', stderr: '', reason: 'reviewer_auth_missing' },
        'broker_unavailable',
        null,
      ],
      [
        { exitCode: 125, stdout: '', stderr: '', timedOut: false, outputTruncated: false },
        'unknown_nonzero',
        125,
      ],
      [
        {
          exitCode: 125,
          stdout: '',
          stderr: '',
          timedOut: true,
          outputTruncated: false,
          reason: 'execution_timeout',
        },
        'timeout',
        null,
      ],
      [
        {
          exitCode: 125,
          stdout: '',
          stderr: '',
          timedOut: false,
          outputTruncated: true,
          reason: 'output_limit_exceeded',
        },
        'unknown_nonzero',
        125,
      ],
      [{ exitCode: 125, stdout: '', stderr: '' }, 'invalid_broker_result', null],
      [
        {
          exitCode: 125,
          stdout: '',
          stderr: '',
          timedOut: false,
          outputTruncated: false,
          reason: 'reviewer_auth_missing',
        },
        'invalid_broker_result',
        null,
      ],
      [
        { exitCode: 125, stdout: '', stderr: '', uid: 999, reason: 'reviewer_auth_missing' },
        'invalid_broker_result',
        null,
      ],
    ];
    for (const [fields, kind, exit] of cases) {
      const { result, requestId } = await diagnosticFixture(fields);
      expect(result.diagnostic).toEqual({
        terminationClass: kind,
        exitCode: exit,
        correlationId: requestId,
      });
      expect(JSON.stringify(result.diagnostic)).not.toContain('reviewer_auth_missing');
      expect(JSON.stringify(result.diagnostic)).not.toContain('PRIVATE_');
    }
  });
  test('A3 caller nonUUID override refuses before consuming a private result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'diagnostic-id-'));
    const id = 'synthetic-non-uuid';
    try {
      await writeFile(join(root, 'ready'), 'synthetic');
      await writeFile(
        join(root, `${id}.result.json`),
        JSON.stringify({ id, ok: false, exitCode: 1, stdout: '', stderr: '', uid: 1002 })
      );
      await expect(
        submitReviewerBrokerJob(
          { checkout: '/synthetic', expectedHead: HEAD_A, argv: ['synthetic'] },
          { id, env: { OVERSEER_REVIEW_SPOOL: root } }
        )
      ).rejects.toThrow('reviewer_broker_unavailable');
      expect((await readdir(root)).sort()).toEqual(['ready', `${id}.result.json`].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('A7 head mismatch preserves earlier safe attempts without changing verdict', async () => {
    const { result } = await diagnosticFixture({
      exitCode: 125,
      stdout: '',
      stderr: '',
      timedOut: false,
      outputTruncated: false,
    });
    const evaluated = await evaluatePullRequest(
      input,
      deps({
        ladder: ['first', 'second'],
        invokeModel: async binary =>
          binary === 'first'
            ? result
            : { exitCode: 0, timedOut: false, stdout: output('APPROVE', [], HEAD_B) },
      })
    );
    expect(evaluated.verdict).toBe('INDETERMINATE');
    expect(evaluated.error).toBe('reviewed_head_mismatch');
    expect(evaluated.diagnostics).toEqual([result.diagnostic!]);
  });
  test('A3 wrong result identity and malformed types refuse and clean private spool', async () => {
    for (const bad of [
      { id: 'FOREIGN_DIAGNOSTIC_CANARY' },
      { id: '11111111-1111-4111-8111-111111111111' },
      { stdout: 42 },
      { uid: 'wrong' },
    ]) {
      try {
        await diagnosticFixture({}, () => bad as Partial<ReviewerBrokerResult>);
        throw new Error('fixture must refuse');
      } catch (error) {
        expect(diagnosticForError(error)?.terminationClass).toBe('invalid_broker_result');
        expect(JSON.stringify(diagnosticForError(error))).not.toContain(
          'FOREIGN_DIAGNOSTIC_CANARY'
        );
      }
    }
  });
  test('A4 timeout and thrown error preserve null exit without changing transport outcome', async () => {
    const { result } = await diagnosticFixture({ timedOut: true, exitCode: 124 });
    expect(result.diagnostic?.exitCode).toBeNull();
    expect(result.diagnostic?.terminationClass).toBe('timeout');
    const timed = await evaluatePullRequest(input, deps({ invokeModel: async () => result }));
    expect(timed.verdict).toBe('TRANSPORT_ERROR');
    const thrown = await evaluatePullRequest(
      input,
      deps({
        invokeModel: async () => {
          throw new Error('PRIVATE_EXCEPTION_CANARY');
        },
      })
    );
    expect(thrown.verdict).toBe('INDETERMINATE');
    expect(thrown.diagnostics?.[0].terminationClass).toBe('unknown_error');
    expect(thrown.diagnostics?.[0].exitCode).toBeNull();
    expect(JSON.stringify(thrown.diagnostics)).not.toContain('PRIVATE_EXCEPTION_CANARY');
    const absent = await mkdtemp(join(tmpdir(), 'diagnostic-unavailable-'));
    try {
      await submitReviewerBrokerJob(
        { checkout: '/synthetic', expectedHead: HEAD_A, argv: ['synthetic'] },
        { env: { OVERSEER_REVIEW_SPOOL: absent } }
      ).then(
        () => {
          throw new Error('must refuse');
        },
        error => {
          expect(diagnosticForError(error)?.terminationClass).toBe('broker_unavailable');
          expect(diagnosticForError(error)?.exitCode).toBeNull();
        }
      );
      expect(await readdir(absent)).toEqual([]);
    } finally {
      await rm(absent, { recursive: true, force: true });
    }
  });
  test('A5 primary and fallback ordered identities survive without replacing primary', async () => {
    const { result, requestId } = await diagnosticFixture({});
    const evaluated = await evaluatePullRequest(
      input,
      deps({
        ladder: ['codex', 'cursor'],
        invokeModel: async binary => {
          if (binary === 'codex') return result;
          throw new Error('pr_review_native_sandbox_unsupported_binary');
        },
      })
    );
    expect(evaluated.diagnostics?.map(entry => entry.terminationClass)).toEqual([
      'unknown_nonzero',
      'unsupported_binary',
    ]);
    expect(evaluated.diagnostics?.[0].correlationId).toBe(requestId);
    expect(evaluated.diagnostics?.[1].correlationId).not.toBe(requestId);
  });
  test('A6 diagnostic metadata drops all private canaries across native result classes', async () => {
    for (const stderr of [
      'PRIVATE_PROMPT_CANARY',
      'PRIVATE_ARGV_CANARY',
      'PRIVATE_CREDENTIAL_CANARY authentication required',
    ]) {
      const { result } = await diagnosticFixture({ stdout: 'PRIVATE_STDOUT_CANARY', stderr });
      const safe = JSON.stringify(result.diagnostic);
      for (const canary of [
        'PRIVATE_PROMPT_CANARY',
        'PRIVATE_ARGV_CANARY',
        'PRIVATE_CREDENTIAL_CANARY',
        'PRIVATE_STDOUT_CANARY',
      ])
        expect(safe).not.toContain(canary);
    }
  });
  test('A7 success and old doubles keep existing outcomes and no failure entries', async () => {
    const success = await evaluatePullRequest(input, deps());
    expect(success.verdict).toBe('APPROVE');
    expect(success.diagnostics).toBeUndefined();
    const old = await evaluatePullRequest(
      input,
      deps({ invokeModel: async () => ({ exitCode: 1, stdout: '', timedOut: false }) })
    );
    expect(old.verdict).toBe('INDETERMINATE');
    expect(old.diagnostics?.[0].terminationClass).toBe('unknown_nonzero');
    const first = await diagnosticFixture({});
    const second = await diagnosticFixture({});
    expect(first.requestId).not.toBe(second.requestId);
  });
});
