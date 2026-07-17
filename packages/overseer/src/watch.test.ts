import { describe, expect, test } from 'bun:test';
import { selectFailureEvent, watchOnce } from './watch.ts';
import type {
  GitHubClientDeps,
  OverseerRunRecord,
  OverseerRunStoreDeps,
  OverseerWorkflowEvent,
  PullRequestEvidence,
} from './types.ts';

const failedPrEvidence: PullRequestEvidence = {
  exists: false,
  state: 'missing',
  checks: { total: 0, passed: 0, failed: 0, pending: 0 },
  mergeable: null,
};

const mergedPrEvidence: PullRequestEvidence = {
  exists: true,
  state: 'merged',
  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  mergeable: false,
  pr: { owner: 'bluedevilcollectibles', repo: 'bdc-harness', number: 505 },
};

const mergeReadyPrEvidence: PullRequestEvidence = {
  exists: true,
  state: 'open',
  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  mergeable: true,
  pr: { owner: 'bluedevilcollectibles', repo: 'bdc-harness', number: 506 },
};

const failedRun: OverseerRunRecord = {
  id: 'run-417c3299',
  woId: 'WO-HARNESS-PRECOMMIT-LINTSTAGED-YAML-DEP-FIX-01',
  owner: 'bluedevilcollectibles',
  repo: 'bdc-harness',
  status: 'failed',
  headBranch: 'wo/precommit-lintstaged-yaml-dep-fix-01',
};

function event(
  id: string,
  eventType: string,
  stepName: string | null,
  createdAt: string | undefined,
  data: Record<string, unknown>
): OverseerWorkflowEvent {
  return {
    id,
    workflow_run_id: failedRun.id,
    event_type: eventType,
    step_name: stepName,
    created_at: createdAt,
    data,
  };
}

function deps(
  events: OverseerWorkflowEvent[],
  evidence: PullRequestEvidence = failedPrEvidence,
  runs: OverseerRunRecord[] = [failedRun]
): OverseerRunStoreDeps & GitHubClientDeps {
  return {
    listRunsForWatch: async () => runs,
    listRunEvents: async () => events,
    findPullRequest: async () => evidence,
    mergePullRequest: async () => ({ merged: true }),
  };
}

describe('watch selectFailureEvent', () => {
  test('prefers_node_failed_over_later_node_completed', () => {
    const nodeFailed = event(
      'event-1',
      'node_failed',
      'commit-and-push',
      '2026-07-17T19:20:50.000Z',
      {
        error: 'commit-and-push failed',
      }
    );
    const nodeCompleted = event(
      'event-2',
      'node_completed',
      'patch-pr-body',
      '2026-07-17T19:20:52.000Z',
      { output: 'patch-pr-body skipped' }
    );

    expect(selectFailureEvent([nodeFailed, nodeCompleted])).toBe(nodeFailed);
  });

  test('real_regression_case_classifies_correctly_through_assessRun', async () => {
    const blockedMessage =
      "commit-and-push reached with status='BLOCKED' and no satisfied approve-with-fix or opus-rereview authorization";
    const events = [
      event('event-1', 'node_failed', 'commit-and-push', '2026-07-17T19:20:50.000Z', {
        error: blockedMessage,
      }),
      event('event-2', 'workflow_failed', null, '2026-07-17T19:20:51.000Z', {
        error: `DAG workflow 'WO-HARNESS-PRECOMMIT-LINTSTAGED-YAML-DEP-FIX-01' completed with failures: 'commit-and-push': ${blockedMessage}`,
        failed_nodes: ['commit-and-push'],
      }),
      event('event-3', 'node_completed', 'patch-pr-body', '2026-07-17T19:20:51.500Z', {
        output: 'patch-pr-body skipped because no PR body patch was required',
      }),
    ];

    const [record] = await watchOnce(deps(events));

    expect(record.errorClass).toBe('commit_blocked_no_authorization');
    expect(record.lastEvent?.step_name).toBe('commit-and-push');
  });

  test('workflow_failed_selected_when_no_node_failed_exists', () => {
    const workflowFailed = event('event-1', 'workflow_failed', null, '2026-07-17T19:20:51.000Z', {
      error: 'DAG workflow failed',
    });
    const nodeCompleted = event(
      'event-2',
      'node_completed',
      'patch-pr-body',
      '2026-07-17T19:20:52.000Z',
      { output: 'cleanup skipped' }
    );

    expect(selectFailureEvent([workflowFailed, nodeCompleted])).toBe(workflowFailed);
  });

  test('multiple_node_failed_disambiguated_by_failed_nodes', () => {
    const firstFailed = event(
      'event-1',
      'node_failed',
      'earlier-branch',
      '2026-07-17T19:20:50.000Z',
      {
        error: 'earlier branch failed',
      }
    );
    const secondFailed = event(
      'event-2',
      'node_failed',
      'terminal-branch',
      '2026-07-17T19:20:49.000Z',
      {
        error: 'terminal branch failed',
      }
    );
    const workflowFailed = event('event-3', 'workflow_failed', null, '2026-07-17T19:20:51.000Z', {
      error: 'DAG workflow failed',
      failed_nodes: ['terminal-branch', 'earlier-branch'],
    });

    expect(selectFailureEvent([firstFailed, secondFailed, workflowFailed])).toBe(secondFailed);
  });

  test('multiple_node_failed_without_authoritative_failed_nodes_uses_latest_node_failed', () => {
    const olderFailed = event(
      'event-1',
      'node_failed',
      'older-branch',
      '2026-07-17T19:20:50.000Z',
      {
        error: 'older branch failed',
      }
    );
    const newerFailed = event(
      'event-2',
      'node_failed',
      'newer-branch',
      '2026-07-17T19:20:52.000Z',
      {
        error: 'newer branch failed',
      }
    );
    const unrelatedCompleted = event(
      'event-3',
      'node_completed',
      'cleanup',
      '2026-07-17T19:20:53.000Z',
      { output: 'cleanup complete' }
    );
    const workflowFailedWithoutNodes = event(
      'event-4',
      'workflow_failed',
      null,
      '2026-07-17T19:20:54.000Z',
      {
        error: 'DAG workflow failed',
        failed_nodes: [],
      }
    );

    expect(selectFailureEvent([olderFailed, newerFailed, unrelatedCompleted])).toBe(newerFailed);
    expect(selectFailureEvent([olderFailed, newerFailed, workflowFailedWithoutNodes])).toBe(
      newerFailed
    );
  });

  test('node_failed_already_newest_no_regression', () => {
    const nodeCompleted = event(
      'event-1',
      'node_completed',
      'patch-pr-body',
      '2026-07-17T19:20:50.000Z',
      {
        output: 'patch body complete',
      }
    );
    const nodeFailed = event(
      'event-2',
      'node_failed',
      'commit-and-push',
      '2026-07-17T19:20:51.000Z',
      {
        error: 'commit-and-push failed',
      }
    );

    expect(selectFailureEvent([nodeCompleted, nodeFailed])).toBe(nodeFailed);
  });

  test('fallback_and_edge_determinism', () => {
    const older = event('event-1', 'node_started', 'build', '2026-07-17T19:20:50.000Z', {
      message: 'started',
    });
    const newer = event('event-2', 'node_completed', 'build', '2026-07-17T19:20:51.000Z', {
      output: 'completed',
    });
    const missingCreatedAtA = event('event-3', 'node_started', 'lint', undefined, {
      message: 'lint started',
    });
    const missingCreatedAtB = event('event-4', 'node_completed', 'lint', undefined, {
      output: 'lint complete',
    });
    const equalCreatedAtA = event('event-5', 'node_started', 'test', '2026-07-17T19:20:52.000Z', {
      message: 'test started',
    });
    const equalCreatedAtB = event('event-6', 'node_completed', 'test', '2026-07-17T19:20:52.000Z', {
      output: 'test complete',
    });

    expect(selectFailureEvent([older, newer])).toBe(newer);
    expect(selectFailureEvent([])).toBeUndefined();
    expect(selectFailureEvent([missingCreatedAtA, missingCreatedAtB])).toBe(missingCreatedAtB);
    expect(selectFailureEvent([equalCreatedAtA, equalCreatedAtB])).toBe(equalCreatedAtB);
  });

  test('early_return_path_never_reaches_selector', async () => {
    const throwingDeps: OverseerRunStoreDeps & GitHubClientDeps = {
      ...deps([]),
      listRunEvents: async () => {
        throw new Error('listRunEvents should not be called for merged PR evidence');
      },
      findPullRequest: async () => mergedPrEvidence,
    };

    const [record] = await watchOnce(throwingDeps);

    expect(record.action).toBe('success');
    expect(record.errorClass).toBeUndefined();

    const mergeReadyThrowingDeps: OverseerRunStoreDeps & GitHubClientDeps = {
      ...deps([]),
      listRunEvents: async () => {
        throw new Error('listRunEvents should not be called for merge-ready PR evidence');
      },
      findPullRequest: async () => mergeReadyPrEvidence,
    };

    const [mergeReadyRecord] = await watchOnce(mergeReadyThrowingDeps);

    expect(mergeReadyRecord.action).toBe('merge_ready');
    expect(mergeReadyRecord.errorClass).toBe('tail_node_false_fail');
  });
});
