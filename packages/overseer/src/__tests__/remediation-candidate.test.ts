import { describe, expect, test } from 'bun:test';
import {
  buildRemediationIdempotencyKey,
  emitRemediationCandidate,
  REMEDIATION_MESSAGE_KIND,
} from '../remediation-candidate';

describe('remediation candidate contract', () => {
  test('builds a stable per-PR/head/attempt key and carries the verdict', async () => {
    const calls: Record<string, unknown>[] = [];
    const inserted = new Map<string, Record<string, unknown>>();
    const createMessage = async (input: Record<string, unknown>) => {
      calls.push(input);
      const key = String(input.idempotency_key);
      const message = inserted.get(key) ?? { id: 'message-1', ...input };
      inserted.set(key, message);
      return message as never;
    };
    const input = {
      woId: 'WO-DEFECT-01',
      owner: 'ThinManSoftware',
      repo: 'bdc-harness',
      prNumber: 650,
      headSha: 'f868542e',
      attempt: 1,
      verdictId: 'verdict-1',
      verdictBody: '[high] migration-ordering: update the child first',
    };
    await emitRemediationCandidate(input, { createMessage: createMessage as never });
    await emitRemediationCandidate(input, { createMessage: createMessage as never });

    const expectedKey = 'overseer-remediation:thinmansoftware/bdc-harness#650:f868542e:1';
    expect(
      buildRemediationIdempotencyKey('ThinManSoftware', 'bdc-harness', 650, 'f868542e', 1)
    ).toBe(expectedKey);
    expect(calls).toHaveLength(2);
    expect(inserted.size).toBe(1);
    expect(calls[0]?.idempotency_key).toBe(expectedKey);
    expect(calls[0]?.recipient).toBe('taskmaster');
    expect(calls[0]?.task_type).toBe('agent_message');
    expect(calls[0]?.repeat_reason).toBeTruthy();
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      kind: REMEDIATION_MESSAGE_KIND,
      ...input,
    });
  });
});
