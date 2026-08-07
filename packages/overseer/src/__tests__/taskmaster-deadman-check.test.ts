import { describe, expect, test } from 'bun:test';
import { TaskmasterDeadmanChecker, type TaskmasterStatus } from '../taskmaster-deadman-check';
import { runTaskmasterDeadmanScheduler } from '../service';

/**
 * SC8 (binding condition 5, Q4): with the tick suspended for 3 intervals the
 * status endpoint reports tick_health='degraded'; the EXTERNAL checker emits
 * EXACTLY ONE escalation (a second poll while still degraded emits none), and
 * recovery re-arms it.
 */
describe('TaskmasterDeadmanChecker', () => {
  function makeChecker(healthSeq: Array<'healthy' | 'degraded'>) {
    const escalations: TaskmasterStatus[] = [];
    let clock = 0;
    let i = 0;
    const checker = new TaskmasterDeadmanChecker({
      now: () => clock,
      fetchStatus: async () => {
        const health = healthSeq[Math.min(i, healthSeq.length - 1)];
        i++;
        clock += 1000;
        return { tick_health: health, last_heartbeat_at: 0 };
      },
      emitEscalation: async status => {
        escalations.push(status);
      },
    });
    return { checker, escalations };
  }

  test('emits exactly one escalation while degraded (3 missed intervals)', async () => {
    const { checker, escalations } = makeChecker(['degraded', 'degraded', 'degraded']);
    await checker.poll(); // first degraded reading -> escalate
    await checker.poll(); // still degraded -> NO second escalation
    await checker.poll(); // still degraded -> NO escalation
    expect(escalations.length).toBe(1);
    expect(checker.isArmed).toBe(false);
  });

  test('recovery re-arms; a subsequent degradation escalates again', async () => {
    const { checker, escalations } = makeChecker(['degraded', 'healthy', 'degraded']);
    const first = await checker.poll(); // degraded -> escalate
    expect(first.escalated).toBe(true);
    const recovered = await checker.poll(); // healthy -> re-arm
    expect(recovered.escalated).toBe(false);
    expect(checker.isArmed).toBe(true);
    const second = await checker.poll(); // degraded again -> escalate
    expect(second.escalated).toBe(true);
    expect(escalations.length).toBe(2);
  });

  test('a healthy tick never escalates', async () => {
    const { checker, escalations } = makeChecker(['healthy', 'healthy']);
    await checker.poll();
    await checker.poll();
    expect(escalations.length).toBe(0);
  });

  test('a failed status poll does not escalate (degraded is a verdict, an error is not)', async () => {
    const escalations: TaskmasterStatus[] = [];
    const checker = new TaskmasterDeadmanChecker({
      fetchStatus: async () => {
        throw new Error('network down');
      },
      emitEscalation: async status => {
        escalations.push(status);
      },
    });
    const result = await checker.poll();
    expect(result.health).toBe('unknown');
    expect(result.escalated).toBe(false);
    expect(escalations.length).toBe(0);
  });
});

/**
 * Production wiring: the scheduler must actually INSTANTIATE + POLL the checker
 * and route escalation. Without this, the factory is dead code and no dead-man
 * polling occurs in production.
 */
describe('runTaskmasterDeadmanScheduler', () => {
  test('polls the injected checker and routes escalation on degraded (once mode)', async () => {
    const escalations: TaskmasterStatus[] = [];
    const checker = new TaskmasterDeadmanChecker({
      fetchStatus: async () => ({ tick_health: 'degraded', last_heartbeat_at: 0 }),
      emitEscalation: async status => {
        escalations.push(status);
      },
    });
    await runTaskmasterDeadmanScheduler({ once: true, checker });
    expect(escalations.length).toBe(1);
    expect(checker.isArmed).toBe(false);
  });

  test('unconfigured (no checker, no status URL) is a safe no-op', async () => {
    const priorUrl = process.env.TASKMASTER_STATUS_URL;
    delete process.env.TASKMASTER_STATUS_URL;
    try {
      await runTaskmasterDeadmanScheduler({ once: true });
    } finally {
      if (priorUrl !== undefined) process.env.TASKMASTER_STATUS_URL = priorUrl;
    }
    expect(true).toBe(true); // returned without throwing / hanging
  });
});
