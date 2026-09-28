import { describe, expect, test } from 'bun:test';
import {
  createRealGitHubClientDeps,
  deriveReviewDecision,
  fetchAllPullRequestReviews,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps';
import { buildEvidenceEnvelope } from '../judge-first';
import { isPullRequestDiscoveredCandidate } from '../merge-candidate-discovery';
import type { OverseerWorkflowEvent, WatchedRunRecord } from '../types.ts';

const head = 'head-sha';
const gate = 'review-gate';
const review = (
  state: string,
  login = gate,
  commitId = head,
  submittedAt = '2026-09-28T00:00:00Z'
) => ({ login, state, commitId, submittedAt });

describe('WO-HARNESS-BLOCKING-REVIEW-01 contract', () => {
  test('Test 1: a later rejection and later comments preserve the standing objection', () => {
    expect(
      deriveReviewDecision(
        [
          review('APPROVED', gate, head, '2026-09-28T00:00:00Z'),
          review('CHANGES_REQUESTED', gate, head, '2026-09-28T00:01:00Z'),
          review('COMMENTED', gate, head, '2026-09-28T00:02:00Z'),
        ],
        {
          headSha: head,
          reviewGateLogin: gate,
        }
      )
    ).toBe('CHANGES_REQUESTED');
  });

  test('Test 2: same-reviewer approval supersedes rejection while dismissal removes approval', () => {
    expect(
      deriveReviewDecision(
        [
          review('APPROVED', gate, head, '2026-09-28T00:01:00Z'),
          review('CHANGES_REQUESTED', gate, head, '2026-09-28T00:00:00Z'),
        ],
        { headSha: head, reviewGateLogin: gate }
      )
    ).toBe('APPROVED');
    expect(
      deriveReviewDecision(
        [
          review('DISMISSED', gate, head, '2026-09-28T00:01:00Z'),
          review('APPROVED', gate, head, '2026-09-28T00:00:00Z'),
        ],
        { headSha: head, reviewGateLogin: gate }
      )
    ).toBeNull();
  });

  test('Test 2a: the production GitHub dependency preserves chronology for downstream gates', async () => {
    process.env.GH_TOKEN = 'test-token';
    const octokit = {
      pulls: {
        listReviews: async () => ({
          data: [
            {
              user: { login: gate },
              state: 'CHANGES_REQUESTED',
              commit_id: head,
              submitted_at: '2026-09-28T00:00:00Z',
            },
            {
              user: { login: gate },
              state: 'APPROVED',
              commit_id: head,
              submitted_at: '2026-09-28T00:01:00Z',
            },
          ],
        }),
      },
    } as unknown as RealGitHubOctokitLike;
    const deps = createRealGitHubClientDeps(octokit);
    const reviews = await deps.listPullRequestReviews?.({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      number: 1,
    });

    expect(reviews?.map(item => item.submittedAt)).toEqual([
      '2026-09-28T00:00:00Z',
      '2026-09-28T00:01:00Z',
    ]);
    expect(deriveReviewDecision(reviews ?? [], { headSha: head, reviewGateLogin: gate })).toBe(
      'APPROVED'
    );
  });

  test('Test 3: complete pagination includes a page-two rejection', async () => {
    const first = Array.from({ length: 100 }, () => ({
      user: { login: gate },
      state: 'APPROVED',
      commit_id: head,
      submitted_at: '2026-09-28T00:00:00Z',
    }));
    const octokit = {
      pulls: {
        listReviews: async ({ page }: { page?: number }) => ({
          data:
            page === 1
              ? first
              : [
                  {
                    user: { login: gate },
                    state: 'CHANGES_REQUESTED',
                    commit_id: head,
                    submitted_at: '2026-09-28T00:01:00Z',
                  },
                ],
        }),
      },
    } as unknown as RealGitHubOctokitLike;
    const result = await fetchAllPullRequestReviews(octokit, {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 1,
    });
    expect(result.complete).toBeTrue();
    expect(deriveReviewDecision(result.reviews, { headSha: head, reviewGateLogin: gate })).toBe(
      'CHANGES_REQUESTED'
    );
  });

  test('Test 4: incomplete or missing review evidence never establishes approval', () => {
    expect(
      deriveReviewDecision([review('APPROVED')], {
        headSha: head,
        reviewGateLogin: gate,
        reviewsIncomplete: true,
      })
    ).toBeNull();
    expect(deriveReviewDecision([], { headSha: head, reviewGateLogin: gate })).toBeNull();
  });

  test('Test 5: judge evidence defaults to unavailable and non-executable', () => {
    const envelope = buildEvidenceEnvelope(record(), []);
    expect(envelope.reviewEvidence.status).toBe('unavailable');
    expect(envelope.recordedExecutionEvidence.present).toBeFalse();
  });

  test('Test 6: full-event execution evidence survives beyond the bounded prompt tail', () => {
    const events = Array.from({ length: 25 }, (_, index) => event(index));
    const envelope = buildEvidenceEnvelope(record(), events, {
      hasRecordedExecutionEvidence: true,
    });
    expect(envelope.eventTail).toHaveLength(20);
    expect(envelope.recordedExecutionEvidence.present).toBeTrue();
  });

  test('Test 7: discovery exemption requires both synthetic identity and metadata', () => {
    expect(
      isPullRequestDiscoveredCandidate({
        runId: 'pr-discovery:thinmansoftware/bdc-harness#1',
        metadata: { discovery_source: 'pr_first_sweep' },
      })
    ).toBeTrue();
    expect(
      isPullRequestDiscoveredCandidate({
        runId: 'run-real',
        metadata: { discovery_source: 'pr_first_sweep' },
      })
    ).toBeFalse();
  });

  test('Test 8: an approval for an old head cannot authorize the current head', () => {
    expect(
      deriveReviewDecision([review('APPROVED', gate, 'old-head')], {
        headSha: head,
        reviewGateLogin: gate,
      })
    ).toBeNull();
  });

  test('Test 9: exact-head approval by the configured independent identity remains eligible', () => {
    expect(
      deriveReviewDecision([review('APPROVED')], { headSha: head, reviewGateLogin: gate })
    ).toBe('APPROVED');
  });

  test('Test 10: another identity cannot authorize a previously stored merge proposal', () => {
    expect(
      deriveReviewDecision([review('APPROVED', 'merge-writer')], {
        headSha: head,
        reviewGateLogin: gate,
      })
    ).toBeNull();
  });

  test('Test 11: reversed API order uses submission chronology', () => {
    expect(
      deriveReviewDecision(
        [
          review('APPROVED', gate, head, '2026-09-28T00:00:00Z'),
          review('CHANGES_REQUESTED', gate, head, '2026-09-28T00:01:00Z'),
        ].reverse(),
        { headSha: head, reviewGateLogin: gate }
      )
    ).toBe('CHANGES_REQUESTED');
  });

  test('Test 12: ambiguous chronology cannot let approval supersede rejection', () => {
    expect(
      deriveReviewDecision(
        [
          { login: gate, state: 'CHANGES_REQUESTED', commitId: head },
          { login: gate, state: 'APPROVED', commitId: head },
        ],
        { headSha: head, reviewGateLogin: gate }
      )
    ).toBe('CHANGES_REQUESTED');
  });
});

function event(index: number): OverseerWorkflowEvent {
  return {
    id: `event-${index}`,
    workflow_run_id: 'run-1',
    event_type: index === 0 ? 'node_completed' : 'log',
    step_name: 'step',
    data: {},
    created_at: `2026-09-28T00:00:${String(index).padStart(2, '0')}Z`,
  };
}

function record(): WatchedRunRecord {
  return {
    runId: 'run-1',
    woId: 'WO-TEST',
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    status: 'completed',
    action: 'ignore',
    reason: 'fixture',
    prEvidence: {
      exists: false,
      state: 'missing',
      checks: { total: 0, passed: 0, failed: 0, pending: 0 },
      mergeable: null,
    },
  };
}
