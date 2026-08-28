import { describe, expect, test } from 'bun:test';
import { handleRecordJudgeFirst } from '../judge-first-pipeline';
import type { JudgeOutcome } from '../judge-first';
import type { OverseerWorkflowEvent, WatchedRunRecord } from '../types';

const event: OverseerWorkflowEvent = {
  id: 'event-1',
  workflow_run_id: 'run-1',
  event_type: 'completed',
  step_name: 'review',
  data: {},
  created_at: '2026-08-28T00:00:00Z',
};

function record(headSha = 'head-1', withPr = true): WatchedRunRecord {
  return {
    runId: `run-${headSha}`,
    woId: 'WO-TARGET-01',
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    status: 'completed',
    action: 'escalate',
    reason: 'review',
    prEvidence: {
      exists: withPr,
      state: withPr ? 'open' : 'missing',
      mergeable: false,
      checks: { total: 1, passed: 0, failed: 1, pending: 0 },
      headSha,
      pr: withPr ? { owner: 'thinmansoftware', repo: 'bdc-harness', number: 650 } : undefined,
    },
  };
}

function outcome(reason: string, verdict = 'needs_human'): JudgeOutcome {
  return {
    kind: 'verdict',
    verdict: verdict as never,
    confidence: 0.9,
    model: 'test',
    modelRung: 0,
    proposedAction: verdict === 'needs_human' ? 'escalate_with_evidence' : 'none',
    proposedTier: 0,
    reason,
  };
}

function harness(attempts: number, reason: string, verdict = 'needs_human') {
  const actions: { action: string; result: string }[] = [];
  const emitted: Record<string, unknown>[] = [];
  const escalations: string[] = [];
  const deps = {
    listRunsForWatch: async () => [],
    listRunEvents: async () => [event],
    insertOverseerAction: async (input: { action: string; result: string }) => {
      actions.push(input);
    },
    findPullRequest: async () => record().prEvidence,
    mergePullRequest: async () => {
      throw new Error('not used');
    },
  };
  const options = {
    dryRun: false,
    actor: 'test',
    verdictStore: {
      claimVerdict: async () => ({
        claimed: true,
        verdictId: `verdict-${Math.random()}`,
        retryCount: 0,
      }),
      finalizeVerdict: async (input: unknown) => input as never,
    },
    judge: async () => outcome(reason, verdict),
    escalate: async (_run: string, decision: { reason: string }) => {
      escalations.push(decision.reason);
      return { card_id: 'card-1' } as never;
    },
    remediation: {
      countAttempts: async () => attempts,
      emit: async (input: Record<string, unknown>) => {
        emitted.push(input);
      },
    },
  };
  return { actions, emitted, escalations, deps, options };
}

describe('judge-first remediation handoff', () => {
  test('emits one complete candidate for a fixable review', async () => {
    const h = harness(0, '[high] migration-ordering: update child rows before parent');
    await handleRecordJudgeFirst(record(), h.deps, h.options);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({ prNumber: 650, headSha: 'head-1', attempt: 1 });
    expect(h.actions.some(a => a.action === 'remediation_candidate_emitted')).toBe(true);
    expect(h.escalations).toHaveLength(0);
  });

  test('cap exhaustion and mixed non-auto findings stay on the operator rail', async () => {
    const capped = harness(2, '[high] test: fix regression');
    await handleRecordJudgeFirst(record(), capped.deps, capped.options);
    expect(capped.emitted).toHaveLength(0);
    expect(capped.actions.at(-1)?.result).toContain('remediation_attempts_exhausted');

    const mixed = harness(0, '[high] lint: fix style\n[high] design: choose a new API');
    await handleRecordJudgeFirst(record(), mixed.deps, mixed.options);
    expect(mixed.emitted).toHaveLength(0);
    expect(mixed.actions.at(-1)?.action).toBe('escalate_with_evidence');
  });

  test('a new reviewed head uses the next persisted attempt', async () => {
    const h = harness(1, '[high] test: fix regression');
    await handleRecordJudgeFirst(record('head-2'), h.deps, h.options);
    expect(h.emitted[0]).toMatchObject({ headSha: 'head-2', attempt: 2 });
  });

  test('approved and no-PR verdicts never emit remediation', async () => {
    const approved = harness(0, 'No blocking findings.', 'healthy');
    await handleRecordJudgeFirst(record(), approved.deps, approved.options);
    expect(approved.emitted).toHaveLength(0);

    const noPr = harness(0, '[high] test: fix regression');
    await handleRecordJudgeFirst(record('head-1', false), noPr.deps, noPr.options);
    expect(noPr.emitted).toHaveLength(0);
    expect(noPr.actions.at(-1)?.action).toBe('escalate_with_evidence');
  });
});
