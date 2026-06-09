import { describe, it, expect } from 'bun:test';
import { isApprovalContext, type ApprovalContext } from './workflow-run';

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
