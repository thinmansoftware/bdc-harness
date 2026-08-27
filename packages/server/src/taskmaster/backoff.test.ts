import { describe, expect, test } from 'bun:test';
import { fireBackoffDecision } from './backoff';
import type { TmJournalEntry } from '@archon/core/db/taskmaster';

const failed = (i: number): TmJournalEntry => ({
  id: `${i}`,
  created_at: new Date(i * 60_000).toISOString(),
  thread_ref: 'x',
  action_type: 'fire_cauldron',
  proposal_json: '{}',
  idempotency_key: `x${i}`,
  before_hash: null,
  proof_predicate: null,
  proof_deadline_at: null,
  outcome: 'failed',
  graded_at: null,
  grade: null,
});
describe('fire backoff', () => {
  test('backs off 4 ticks, doubles, caps at 96, then escalates', () => {
    expect(fireBackoffDecision([failed(0)], 'x', 1, 60_000, 3 * 60_000).kind).toBe('backoff');
    expect(fireBackoffDecision([failed(0)], 'x', 1, 60_000, 4 * 60_000).kind).toBe('ready');
    expect(
      fireBackoffDecision(
        Array.from({ length: 6 }, (_, i) => failed(i)),
        'x',
        10,
        60_000,
        100 * 60_000
      ).kind
    ).toBe('backoff');
    expect(
      fireBackoffDecision(
        Array.from({ length: 7 }, (_, i) => failed(i)),
        'x',
        10,
        60_000,
        100 * 60_000
      ).kind
    ).toBe('escalate');
  });
});
