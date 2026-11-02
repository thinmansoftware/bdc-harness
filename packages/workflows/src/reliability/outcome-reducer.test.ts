import { describe, expect, test } from 'bun:test';
import { EXECUTION_CAPABILITIES } from '@archon/workflows/reliability/types';
import { projectRunOutcome, reduceRunOutcome } from './outcome-reducer';
import type { RunOutcomeEvidence } from './types';

const baseEvidence: RunOutcomeEvidence = {
  executionState: 'completed',
  deliverable: {},
  validation: { required: true, state: 'passed' },
  recoveryState: 'not_needed',
  routeState: 'current',
  requirements: { deliverable: 'none' },
  evidenceRefs: ['event://fixture'],
};

function evidence(overrides: Partial<RunOutcomeEvidence>): RunOutcomeEvidence {
  return {
    ...baseEvidence,
    ...overrides,
    deliverable: { ...baseEvidence.deliverable, ...overrides.deliverable },
    validation: { ...baseEvidence.validation, ...overrides.validation },
    requirements: { ...baseEvidence.requirements, ...overrides.requirements },
  };
}

describe('reduceRunOutcome incident table', () => {
  test('publishes the execution capability vocabulary through the package contract', () => {
    expect(EXECUTION_CAPABILITIES).toEqual([
      'text_generation',
      'repo_read',
      'repo_write',
      'shell',
      'network',
      'browser',
    ]);
  });

  const cases: Array<{
    name: string;
    input: RunOutcomeEvidence;
    expected: {
      executionState: string;
      deliverableState: string;
      validationState: string;
      recoveryState: string;
      routeState: string;
      primaryReason: string;
      projection: string;
    };
  }> = [
    {
      name: 'CE false-fail preserves a ready PR and indeterminate wrong-scope gate',
      input: evidence({
        executionState: 'failed',
        deliverable: { pullRequest: { open: true, ready: true } },
        validation: {
          required: true,
          state: 'indeterminate',
          reasonCode: 'gate_scope_mismatch',
        },
        requirements: { deliverable: 'pr_ready' },
      }),
      expected: {
        executionState: 'failed',
        deliverableState: 'pr_ready',
        validationState: 'indeterminate',
        recoveryState: 'not_needed',
        routeState: 'current',
        primaryReason: 'gate_scope_mismatch',
        projection: 'failed',
      },
    },
    {
      name: 'recoverable zombie remains interrupted with preserved worktree changes',
      input: evidence({
        executionState: 'interrupted',
        deliverable: { worktreeChanges: true },
        validation: { required: false, state: 'not_run' },
        recoveryState: 'recoverable',
        reasonCodes: ['worker_lease_expired'],
      }),
      expected: {
        executionState: 'interrupted',
        deliverableState: 'worktree_changes',
        validationState: 'not_run',
        recoveryState: 'recoverable',
        routeState: 'current',
        primaryReason: 'worker_lease_expired',
        projection: 'interrupted',
      },
    },
    {
      name: 'provider exhaustion becomes a durable provider wait',
      input: evidence({
        executionState: 'waiting_provider',
        validation: { required: false, state: 'not_run' },
        routeState: 'exhausted',
        reasonCodes: ['provider_quota_wait'],
      }),
      expected: {
        executionState: 'waiting_provider',
        deliverableState: 'none',
        validationState: 'not_run',
        recoveryState: 'not_needed',
        routeState: 'exhausted',
        primaryReason: 'provider_quota_wait',
        projection: 'waiting_provider',
      },
    },
    {
      name: 'gate-rejected predecessor with a successor projects escalated',
      input: evidence({
        executionState: 'failed',
        validation: { required: true, state: 'failed' },
        routeState: 'escalated',
        reasonCodes: ['gate_rejection_with_successor'],
      }),
      expected: {
        executionState: 'failed',
        deliverableState: 'none',
        validationState: 'failed',
        recoveryState: 'not_needed',
        routeState: 'escalated',
        primaryReason: 'gate_rejection_with_successor',
        projection: 'escalated',
      },
    },
    {
      name: 'verified no-op completes without inventing a deliverable',
      input: evidence({
        validation: { required: false, state: 'passed' },
        verifiedNoop: true,
      }),
      expected: {
        executionState: 'completed',
        deliverableState: 'none',
        validationState: 'passed',
        recoveryState: 'not_needed',
        routeState: 'current',
        primaryReason: 'verified_noop',
        projection: 'completed',
      },
    },
    {
      name: 'bad build keeps completed execution separate from a failed gate',
      input: evidence({
        deliverable: { worktreeChanges: true },
        validation: { required: true, state: 'failed', reasonCode: 'gate_failed' },
        requirements: { deliverable: 'pr_ready' },
      }),
      expected: {
        executionState: 'completed',
        deliverableState: 'worktree_changes',
        validationState: 'failed',
        recoveryState: 'not_needed',
        routeState: 'current',
        primaryReason: 'gate_failed',
        projection: 'failed',
      },
    },
    {
      name: 'ready PR with passed validation completes',
      input: evidence({
        deliverable: { pullRequest: { open: true, ready: true } },
        requirements: { deliverable: 'pr_ready' },
      }),
      expected: {
        executionState: 'completed',
        deliverableState: 'pr_ready',
        validationState: 'passed',
        recoveryState: 'not_needed',
        routeState: 'current',
        primaryReason: 'pr_ready',
        projection: 'completed',
      },
    },
    {
      name: 'required multi-stage predecessor failure blocks the parent',
      input: evidence({
        executionState: 'running',
        validation: { required: true, state: 'not_run' },
        requirements: { deliverable: 'pr_ready' },
        requiredStages: [
          {
            stageId: 'stage-1',
            required: true,
            executionState: 'failed',
            validationState: 'failed',
            deliverableState: 'none',
          },
        ],
      }),
      expected: {
        executionState: 'failed',
        deliverableState: 'none',
        validationState: 'failed',
        recoveryState: 'not_needed',
        routeState: 'current',
        primaryReason: 'required_stage_failed',
        projection: 'failed',
      },
    },
  ];

  for (const item of cases) {
    test(item.name, () => {
      const outcome = reduceRunOutcome(item.input);
      expect(outcome).toMatchObject({
        executionState: item.expected.executionState,
        deliverableState: item.expected.deliverableState,
        validationState: item.expected.validationState,
        recoveryState: item.expected.recoveryState,
        routeState: item.expected.routeState,
        primaryReason: item.expected.primaryReason,
      });
      expect(projectRunOutcome(outcome, item.input)).toBe(item.expected.projection);
      expect(outcome.evidenceRefs).toEqual(['event://fixture']);
      expect(new Set(outcome.reasonCodes).size).toBe(outcome.reasonCodes.length);
    });
  }

  test('dry run projects planned and never a winning completion', () => {
    const input = evidence({ dryRun: true, validation: { required: false, state: 'not_run' } });
    const outcome = reduceRunOutcome(input);

    expect(outcome.primaryReason).toBe('dry_run_planned');
    expect(projectRunOutcome(outcome, input)).toBe('planned');
    expect(projectRunOutcome(outcome, input)).not.toBe('completed');
  });

  test('an indeterminate required gate gets a stable default reason', () => {
    const input = evidence({
      validation: { required: true, state: 'indeterminate' },
      requirements: { deliverable: 'pr_ready' },
    });

    const outcome = reduceRunOutcome(input);
    expect(outcome.primaryReason).toBe('gate_indeterminate');
    expect(projectRunOutcome(outcome, input)).toBe('failed');
  });

  test('an indeterminate required predecessor is blocked without being called failed', () => {
    const input = evidence({
      executionState: 'running',
      validation: { required: true, state: 'not_run' },
      requirements: { deliverable: 'pr_ready' },
      requiredStages: [
        {
          stageId: 'stage-1',
          required: true,
          executionState: 'completed',
          validationState: 'indeterminate',
          deliverableState: 'pr_open',
        },
      ],
    });

    const outcome = reduceRunOutcome(input);
    expect(outcome.executionState).toBe('failed');
    expect(outcome.validationState).toBe('indeterminate');
    expect(outcome.primaryReason).toBe('required_stage_indeterminate');
  });

  test('successful execution without a required deliverable projects completed', () => {
    const input = evidence({ validation: { required: false, state: 'passed' } });
    const outcome = reduceRunOutcome(input);

    expect(outcome.primaryReason).toBe('execution_completed');
    expect(outcome.deliverableState).toBe('none');
    expect(projectRunOutcome(outcome, input)).toBe('completed');
  });

  test('successful execution with a PR that is not ready does not project completed', () => {
    const input = evidence({
      deliverable: { pullRequest: { open: true, ready: false } },
      requirements: { deliverable: 'pr_ready' },
    });
    const outcome = reduceRunOutcome(input);

    expect(outcome.primaryReason).toBe('pr_not_ready');
    expect(outcome.deliverableState).toBe('pr_open');
    expect(projectRunOutcome(outcome, input)).toBe('failed');
  });
});
