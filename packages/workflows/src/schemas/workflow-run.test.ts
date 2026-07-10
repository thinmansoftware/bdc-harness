import { describe, it, expect } from 'bun:test';
import {
  isApprovalContext,
  workflowRunStatusSchema,
  runOutcomeSchema,
  outcomeReasonCodeSchema,
  TERMINAL_WORKFLOW_STATUSES,
  RESUMABLE_WORKFLOW_STATUSES,
  type ApprovalContext,
} from './workflow-run';

describe('ApprovalContext graded fields', () => {
  it('accepts the new optional fields and still passes the guard', () => {
    const ctx: ApprovalContext = {
      nodeId: 'pause-gate',
      message: 'm',
      decisionVerb: 'approve_with_fix',
      authorizedFixIds: ['locg-migration'],
    };
    expect(isApprovalContext(ctx)).toBe(true);
  });

  it('still passes the guard with no new fields (legacy)', () => {
    expect(isApprovalContext({ nodeId: 'g', message: 'm' })).toBe(true);
  });
});

describe('reliability outcome schemas', () => {
  it('accepts waiting and interrupted compatibility statuses without making them terminal', () => {
    expect(workflowRunStatusSchema.parse('waiting_provider')).toBe('waiting_provider');
    expect(workflowRunStatusSchema.parse('interrupted')).toBe('interrupted');
    expect(TERMINAL_WORKFLOW_STATUSES).not.toContain('waiting_provider');
    expect(TERMINAL_WORKFLOW_STATUSES).not.toContain('interrupted');
    expect(RESUMABLE_WORKFLOW_STATUSES).toContain('interrupted');
  });

  it('parses all five dimensions without collapsing the CE false-fail facts', () => {
    expect(
      runOutcomeSchema.parse({
        executionState: 'failed',
        deliverableState: 'pr_ready',
        validationState: 'indeterminate',
        recoveryState: 'not_needed',
        routeState: 'current',
        primaryReason: 'gate_scope_mismatch',
        reasonCodes: ['gate_scope_mismatch'],
        evidenceRefs: ['github://pull/429'],
      })
    ).toMatchObject({
      executionState: 'failed',
      deliverableState: 'pr_ready',
      validationState: 'indeterminate',
    });
  });

  it('accepts stable provider classifier reasons without storing raw errors', () => {
    expect(outcomeReasonCodeSchema.parse('provider_quota_exhausted')).toBe(
      'provider_quota_exhausted'
    );
    expect(outcomeReasonCodeSchema.parse('sdk_contradiction')).toBe('sdk_contradiction');
  });
});
