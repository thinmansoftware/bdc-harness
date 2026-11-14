/**
 * escalation-dedupe unit tests (WO-HARNESS-TASKMASTER-ESCALATE-P0-FLOOD-01):
 * Test 4 (reason guard), Test 5 (settable windows and fallback) and Test 12
 * (reason from thread_ref, heartbeat rows excluded), and the failed backoff
 * from the latest attempt (Overseer review of PR 1598). Eleven named cases.
 */
import { describe, expect, test } from 'bun:test';
import {
  decideEscalation,
  FAILED_BACKOFF_ENV,
  MARKER_WINDOW_ENV,
  resolveEscalationCooldowns,
  SENT_WINDOW_ENV,
  type EscalationJournalRow,
} from './escalation-dedupe';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const DEFAULTS = resolveEscalationCooldowns({}, () => {
  throw new Error('unset settings must not warn');
});

function row(
  threadRef: string,
  outcome: string,
  hoursAgo: number,
  proposal: Record<string, unknown> = {}
): EscalationJournalRow {
  return {
    thread_ref: threadRef,
    action_type: 'escalate_p0',
    proposal_json: JSON.stringify(proposal),
    outcome,
    created_at: new Date(NOW - hoursAgo * HOUR).toISOString(),
  };
}

function collectWarnings(): {
  warn: (variable: string, raw: string, fallback: number) => void;
  seen: Array<{ variable: string; raw: string; fallback: number }>;
} {
  const seen: Array<{ variable: string; raw: string; fallback: number }> = [];
  return { warn: (variable, raw, fallback) => seen.push({ variable, raw, fallback }), seen };
}

describe('escalation-dedupe: Test 4, a new reason for an escalated thread is not swallowed', () => {
  const T = 'gh:thinmansoftware/bdc-xo#4932';
  const rows = [row(T, 'sent', 2, { reason: 'unclaimed_p0' })];

  test('escalation-dedupe: Test 4 (a) a new reason on the same ref is sent', () => {
    expect(
      decideEscalation({
        threadRef: T,
        reason: 'unroutable_remediation',
        nowMs: NOW,
        rows,
        settings: DEFAULTS,
      })
    ).toEqual({ action: 'send' });
  });

  test('escalation-dedupe: Test 4 (b) a repeat of the same reason inside the window is skipped', () => {
    expect(
      decideEscalation({
        threadRef: T,
        reason: 'unclaimed_p0',
        nowMs: NOW,
        rows,
        settings: DEFAULTS,
      })
    ).toEqual({ action: 'skip', basis: 'sent_window', windowStartIso: rows[0]!.created_at });
  });
});

describe('escalation-dedupe: Test 5, the windows are settable and fall back', () => {
  test('escalation-dedupe: Test 5 (a) valid values are used, and 24 and 168 are accepted', () => {
    const { warn, seen } = collectWarnings();
    const set = resolveEscalationCooldowns(
      { [SENT_WINDOW_ENV]: '48', [FAILED_BACKOFF_ENV]: '2', [MARKER_WINDOW_ENV]: '3' },
      warn
    );
    expect(set).toEqual({
      sentWindowMs: 48 * HOUR,
      failedBackoffMs: 2 * HOUR,
      markerWindowMs: 3 * HOUR,
    });
    expect(resolveEscalationCooldowns({ [SENT_WINDOW_ENV]: '24' }, warn).sentWindowMs).toBe(
      24 * HOUR
    );
    expect(resolveEscalationCooldowns({ [SENT_WINDOW_ENV]: '168' }, warn).sentWindowMs).toBe(
      168 * HOUR
    );
    expect(seen).toEqual([]);
    expect(DEFAULTS).toEqual({
      sentWindowMs: 24 * HOUR,
      failedBackoffMs: 6 * HOUR,
      markerWindowMs: 72 * HOUR,
    });
  });

  test('escalation-dedupe: Test 5 (b) an invalid sent window gives 24 with one warning', () => {
    for (const raw of ['1', '6', '23', '169', 'abc', '0']) {
      const { warn, seen } = collectWarnings();
      expect(resolveEscalationCooldowns({ [SENT_WINDOW_ENV]: raw }, warn).sentWindowMs).toBe(
        24 * HOUR
      );
      expect(seen).toEqual([{ variable: SENT_WINDOW_ENV, raw, fallback: 24 }]);
    }
  });

  test('escalation-dedupe: Test 5 (c) an invalid failed backoff gives 6 with one warning', () => {
    for (const raw of ['abc', '0', '500']) {
      const { warn, seen } = collectWarnings();
      expect(resolveEscalationCooldowns({ [FAILED_BACKOFF_ENV]: raw }, warn).failedBackoffMs).toBe(
        6 * HOUR
      );
      expect(seen).toEqual([{ variable: FAILED_BACKOFF_ENV, raw, fallback: 6 }]);
    }
  });

  test('escalation-dedupe: Test 5 (d) an invalid marker window gives 72 with one warning', () => {
    for (const raw of ['abc', '0', '500']) {
      const { warn, seen } = collectWarnings();
      expect(resolveEscalationCooldowns({ [MARKER_WINDOW_ENV]: raw }, warn).markerWindowMs).toBe(
        72 * HOUR
      );
      expect(seen).toEqual([{ variable: MARKER_WINDOW_ENV, raw, fallback: 72 }]);
    }
  });
});

describe('escalation-dedupe: the failed backoff starts at the latest attempt', () => {
  const H = 3_600_000;
  const T = Date.parse('2026-11-14T00:00:00.000Z');
  const settings = { sentWindowMs: 24 * H, failedBackoffMs: 6 * H, markerWindowMs: 72 * H };
  const failedRow = (lastAttemptAt?: string): EscalationJournalRow => ({
    thread_ref: 'gh:o/r#1',
    action_type: 'escalate_p0',
    proposal_json: JSON.stringify({
      reason: 'unclaimed_p0',
      ...(lastAttemptAt ? { last_attempt_at: lastAttemptAt } : {}),
    }),
    outcome: 'failed',
    created_at: new Date(T).toISOString(),
  });
  const decide = (row: EscalationJournalRow, nowMs: number) =>
    decideEscalation({
      threadRef: 'gh:o/r#1',
      reason: 'unclaimed_p0',
      nowMs,
      rows: [row],
      settings,
    });

  test('escalation-dedupe: a failed retry at +7 h holds the backoff from +7 h, not from created_at', () => {
    const retriedAt = new Date(T + 7 * H).toISOString();
    expect(decide(failedRow(retriedAt), T + 8 * H)).toEqual({
      action: 'skip',
      basis: 'failed_backoff',
      windowStartIso: retriedAt,
    });
    expect(decide(failedRow(retriedAt), T + 13 * H - 1)).toMatchObject({ action: 'skip' });
    expect(decide(failedRow(retriedAt), T + 13 * H)).toEqual({ action: 'send' });
  });

  test('escalation-dedupe: a row without last_attempt_at, or with an older or invalid one, uses created_at', () => {
    expect(decide(failedRow(), T + 7 * H)).toEqual({ action: 'send' });
    expect(decide(failedRow(new Date(T - H).toISOString()), T + 7 * H)).toEqual({ action: 'send' });
    expect(decide(failedRow('not-a-date'), T + 7 * H)).toEqual({ action: 'send' });
    expect(decide(failedRow(), T + 5 * H)).toMatchObject({
      action: 'skip',
      basis: 'failed_backoff',
    });
  });
});

describe('escalation-dedupe: Test 12, a row with no reason gets one from thread_ref', () => {
  test('escalation-dedupe: reason from thread_ref: (a) remediation prefix', () => {
    const ref = 'remediation:thinmansoftware/bdc-harness#1';
    expect(
      decideEscalation({
        threadRef: ref,
        reason: 'unroutable_remediation',
        nowMs: NOW,
        rows: [row(ref, 'sent', 2)],
        settings: DEFAULTS,
      }).action
    ).toBe('skip');
  });

  test('escalation-dedupe: reason from thread_ref: (b) dispatch-worker prefix is excluded', () => {
    const heartbeat = row('dispatch-worker:dispatch-worker-HOST', 'sent', 2);
    // The heartbeat page is read as no reason at all: it neither blocks another
    // thread's P0 nor starts a window on its own ref.
    expect(
      decideEscalation({
        threadRef: 'gh:thinmansoftware/bdc-xo#2',
        reason: 'unclaimed_p0',
        nowMs: NOW,
        rows: [heartbeat],
        settings: DEFAULTS,
      })
    ).toEqual({ action: 'send' });
    expect(
      decideEscalation({
        threadRef: 'dispatch-worker:dispatch-worker-HOST',
        reason: 'unclaimed_p0',
        nowMs: NOW,
        rows: [heartbeat],
        settings: DEFAULTS,
      })
    ).toEqual({ action: 'send' });
  });

  test('escalation-dedupe: reason from thread_ref: (c) other ref', () => {
    const ref = 'gh:thinmansoftware/bdc-xo#1';
    // A pre-build row carries no reason; a parked row's proposal_json carries
    // reason "paused" (loop.ts pause path), which is not a valid reason either.
    for (const proposal of [{}, { reason: 'paused' }]) {
      expect(
        decideEscalation({
          threadRef: ref,
          reason: 'unclaimed_p0',
          nowMs: NOW,
          rows: [row(ref, 'sent', 2, proposal)],
          settings: DEFAULTS,
        }).action
      ).toBe('skip');
    }
  });
});
