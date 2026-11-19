import { describe, expect, test } from 'bun:test';
import { approvalHandOffBoundS, isApprovalHandOff, parseUtcTimestamp } from './approval-handoff';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');

function ev(
  event_type: string,
  created_at?: string | null
): {
  event_type: string;
  created_at?: string | null;
} {
  return { event_type, created_at };
}

describe('isApprovalHandOff (unbounded)', () => {
  test('false when the run is not failed, even with approval_received', () => {
    for (const status of ['running', 'completed', 'cancelled', 'paused']) {
      expect(isApprovalHandOff({ run: { status }, events: [ev('approval_received')] })).toBe(false);
    }
  });

  test('false for a failed run with no events or no approval_received', () => {
    expect(isApprovalHandOff({ run: { status: 'failed' } })).toBe(false);
    expect(isApprovalHandOff({ run: { status: 'failed' }, events: [] })).toBe(false);
    expect(isApprovalHandOff({ run: { status: 'failed' }, events: [ev('node_failed')] })).toBe(
      false
    );
  });

  test('true when the latest decisive event is approval_received with no later *_failed', () => {
    expect(
      isApprovalHandOff({
        run: { status: 'failed' },
        events: [ev('node_started'), ev('approval_received'), ev('node_started')],
      })
    ).toBe(true);
  });

  test('false when any *_failed event follows the last approval_received', () => {
    expect(
      isApprovalHandOff({
        run: { status: 'failed' },
        events: [ev('approval_received'), ev('node_failed')],
      })
    ).toBe(false);
    expect(
      isApprovalHandOff({
        run: { status: 'failed' },
        events: [ev('approval_received'), ev('workflow_failed')],
      })
    ).toBe(false);
  });

  test('a *_failed BEFORE the last approval_received does not count', () => {
    expect(
      isApprovalHandOff({
        run: { status: 'failed' },
        events: [ev('node_failed'), ev('approval_received')],
      })
    ).toBe(true);
  });

  test('the LAST approval_received is the reference point', () => {
    expect(
      isApprovalHandOff({
        run: { status: 'failed' },
        events: [ev('approval_received'), ev('node_failed'), ev('approval_received')],
      })
    ).toBe(true);
  });

  test('event types merely containing failed (not ending in _failed) do not disqualify', () => {
    expect(
      isApprovalHandOff({
        run: { status: 'failed' },
        events: [ev('approval_received'), ev('failed_over')],
      })
    ).toBe(true);
  });
});

describe('isApprovalHandOff (bounded)', () => {
  const run = { status: 'failed' };

  test('true inside the window and exactly at the boundary', () => {
    const inside = [ev('approval_received', '2026-11-03T11:59:00.000Z')];
    expect(isApprovalHandOff({ run, events: inside }, { nowMs: NOW, maxAgeS: 120 })).toBe(true);
    const boundary = [ev('approval_received', '2026-11-03T11:58:00.000Z')];
    expect(isApprovalHandOff({ run, events: boundary }, { nowMs: NOW, maxAgeS: 120 })).toBe(true);
  });

  test('false one millisecond past the window', () => {
    const stale = [ev('approval_received', '2026-11-03T11:57:59.999Z')];
    expect(isApprovalHandOff({ run, events: stale }, { nowMs: NOW, maxAgeS: 120 })).toBe(false);
  });

  test('false when the approval timestamp is missing or unparseable', () => {
    expect(
      isApprovalHandOff({ run, events: [ev('approval_received')] }, { nowMs: NOW, maxAgeS: 120 })
    ).toBe(false);
    expect(
      isApprovalHandOff(
        { run, events: [ev('approval_received', 'garbage')] },
        { nowMs: NOW, maxAgeS: 120 }
      )
    ).toBe(false);
  });

  test('accepts sqlite datetime text (no zone) as UTC', () => {
    const events = [ev('approval_received', '2026-11-03 11:59:30')];
    expect(isApprovalHandOff({ run, events }, { nowMs: NOW, maxAgeS: 120 })).toBe(true);
    expect(isApprovalHandOff({ run, events }, { nowMs: NOW + 91_000, maxAgeS: 120 })).toBe(false);
  });

  test('a future approval timestamp counts as within the window', () => {
    const events = [ev('approval_received', '2026-11-03T12:05:00.000Z')];
    expect(isApprovalHandOff({ run, events }, { nowMs: NOW, maxAgeS: 120 })).toBe(true);
  });

  test('bound does not rescue a later *_failed or a non-failed run', () => {
    const recent = '2026-11-03T11:59:59.000Z';
    expect(
      isApprovalHandOff(
        { run, events: [ev('approval_received', recent), ev('node_failed', recent)] },
        { nowMs: NOW, maxAgeS: 120 }
      )
    ).toBe(false);
    expect(
      isApprovalHandOff(
        { run: { status: 'running' }, events: [ev('approval_received', recent)] },
        { nowMs: NOW, maxAgeS: 120 }
      )
    ).toBe(false);
  });
});

describe('parseUtcTimestamp', () => {
  test('handles Date, zoned ISO, sqlite text, and empty values', () => {
    expect(parseUtcTimestamp(new Date(NOW))).toBe(NOW);
    expect(parseUtcTimestamp('2026-11-03T12:00:00.000Z')).toBe(NOW);
    expect(parseUtcTimestamp('2026-11-03 12:00:00')).toBe(NOW);
    expect(parseUtcTimestamp('2026-11-03T08:00:00-04:00')).toBe(NOW);
    expect(Number.isNaN(parseUtcTimestamp(null))).toBe(true);
    expect(Number.isNaN(parseUtcTimestamp(undefined))).toBe(true);
    expect(Number.isNaN(parseUtcTimestamp(''))).toBe(true);
  });
});

describe('approvalHandOffBoundS', () => {
  test('defaults to 120 when unset, empty, non-numeric, zero, or negative', () => {
    expect(approvalHandOffBoundS({})).toBe(120);
    expect(approvalHandOffBoundS({ T3_APPROVAL_HANDOFF_S: '' })).toBe(120);
    expect(approvalHandOffBoundS({ T3_APPROVAL_HANDOFF_S: 'abc' })).toBe(120);
    expect(approvalHandOffBoundS({ T3_APPROVAL_HANDOFF_S: '0' })).toBe(120);
    expect(approvalHandOffBoundS({ T3_APPROVAL_HANDOFF_S: '-5' })).toBe(120);
  });

  test('uses a positive numeric override, including fractional', () => {
    expect(approvalHandOffBoundS({ T3_APPROVAL_HANDOFF_S: '30' })).toBe(30);
    expect(approvalHandOffBoundS({ T3_APPROVAL_HANDOFF_S: '0.5' })).toBe(0.5);
    expect(approvalHandOffBoundS({ T3_APPROVAL_HANDOFF_S: '3600' })).toBe(3600);
  });
});
