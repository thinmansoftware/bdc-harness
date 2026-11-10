import { describe, expect, test } from 'bun:test';
import {
  decideEscalateP0,
  DEFAULT_ESCALATE_P0_COOLDOWN_MS,
  escalationReason,
} from './escalation-dedupe';

const THREAD = 'dispatch-worker:A';

describe('escalate_p0 cooldown dedupe', () => {
  test('Test 1: a duplicate inside the cooldown is suppressed with the cooldown marker', () => {
    const nowMs = Date.parse('2026-11-05T12:00:00.000Z');
    const first = decideEscalateP0({
      threadRef: THREAD,
      reason: 'worker_down',
      nowMs,
      priorSentAtMs: null,
    });
    expect(first).toEqual({ send: true, suppressed: null });

    const duplicate = decideEscalateP0({
      threadRef: THREAD,
      reason: 'worker_down',
      nowMs: nowMs + 60_000,
      priorSentAtMs: nowMs,
      cooldownMs: 60 * 60 * 1000,
    });
    expect(duplicate).toEqual({ send: false, suppressed: 'cooldown' });
  });

  test('Test 2: a prior send exactly one default cooldown old still sends', () => {
    const priorSentAtMs = Date.parse('2026-11-04T12:00:00.000Z');
    expect(DEFAULT_ESCALATE_P0_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);

    const atBoundary = decideEscalateP0({
      threadRef: THREAD,
      reason: 'worker_down',
      nowMs: priorSentAtMs + DEFAULT_ESCALATE_P0_COOLDOWN_MS,
      priorSentAtMs,
    });
    expect(atBoundary).toEqual({ send: true, suppressed: null });

    const stillInside = decideEscalateP0({
      threadRef: THREAD,
      reason: 'worker_down',
      nowMs: priorSentAtMs + DEFAULT_ESCALATE_P0_COOLDOWN_MS - 1,
      priorSentAtMs,
    });
    expect(stillInside).toEqual({ send: false, suppressed: 'cooldown' });
  });

  test('Test 3: a quiet day stays under 10 sends and the injected probe still sends', () => {
    const startMs = Date.parse('2026-11-05T00:00:00.000Z');
    const stepMs = 30 * 60 * 1000;
    const lastSent = new Map<string, number>();
    let sends = 0;
    let probeSent = false;

    for (let i = 0; i < 48; i += 1) {
      const nowMs = startMs + i * stepMs;
      const reason = 'worker_down';
      const decision = decideEscalateP0({
        threadRef: THREAD,
        reason,
        nowMs,
        priorSentAtMs: lastSent.get(reason) ?? null,
      });
      if (decision.send) {
        sends += 1;
        lastSent.set(reason, nowMs);
      }

      if (i === 24) {
        const probeReason = escalationReason(
          { kind: 'worker_down', token: 'P0-INJECTED-PROBE' },
          THREAD
        );
        const probe = decideEscalateP0({
          threadRef: THREAD,
          reason: probeReason,
          nowMs,
          priorSentAtMs: lastSent.get(probeReason) ?? null,
        });
        if (probe.send) {
          sends += 1;
          probeSent = true;
          lastSent.set(probeReason, nowMs);
        }
      }
    }

    expect(sends).toBeLessThan(10);
    expect(probeSent).toBe(true);
    expect(lastSent.get('worker_down')).toBe(startMs);
  });

  test('Test 4: a distinct worker_death sends inside a worker_down cooldown', () => {
    const nowMs = Date.parse('2026-11-05T12:00:00.000Z');
    const downReason = escalationReason({ kind: 'worker_down', worker_id: 'A' }, THREAD);
    expect(downReason).toBe('worker_down');
    const down = decideEscalateP0({
      threadRef: THREAD,
      reason: downReason,
      nowMs,
      priorSentAtMs: nowMs - 60_000,
    });
    expect(down).toEqual({ send: false, suppressed: 'cooldown' });

    const deathA = escalationReason(
      {
        kind: 'worker_death',
        previous_pid: 4242,
        previous_started_at: '2026-11-05T11:00:00.000Z',
      },
      THREAD
    );
    const deathB = escalationReason(
      {
        kind: 'worker_death',
        previous_pid: 4343,
        previous_started_at: '2026-11-05T11:00:00.000Z',
      },
      THREAD
    );
    expect(deathA).toBe('worker_death:4242:2026-11-05T11:00:00.000Z');
    expect(deathB).toBe('worker_death:4343:2026-11-05T11:00:00.000Z');
    expect(deathA).not.toBe(deathB);

    const deathSend = decideEscalateP0({
      threadRef: THREAD,
      reason: deathA,
      nowMs,
      priorSentAtMs: null,
    });
    expect(deathSend).toEqual({ send: true, suppressed: null });

    expect(escalationReason({ kind: 'worker_down', note: 'P0-INJECTED-PROBE' }, THREAD)).toBe(
      'P0-INJECTED-PROBE'
    );

    const circular: { self?: unknown; kind?: string } = { kind: 'worker_down' };
    circular.self = circular;
    expect(escalationReason(circular, THREAD)).toBe('worker_down');

    const bare: { self?: unknown } = {};
    bare.self = bare;
    expect(escalationReason(bare, 'remediation:item-1')).toBe('unroutable_remediation');
    expect(escalationReason(undefined, 'plain-thread')).toBe('unclaimed_p0');
  });
});
