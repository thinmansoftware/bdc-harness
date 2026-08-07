import { describe, expect, test } from 'bun:test';
import { tick, type TickContext } from './loop';
import { validate as guardValidate } from './guard';
import type { TaskmasterThread } from './rules';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

interface JournalRow {
  id: string;
  outcome: string;
  thread_ref: string;
}

/** In-memory tm_journal: idempotent on key, restart-safe like the real DAL. */
function makeJournal(seed: Array<{ key: string; outcome: string; thread_ref: string }> = []) {
  const rows = new Map<string, JournalRow>();
  let n = 0;
  for (const s of seed) {
    rows.set(s.key, { id: `seed-${++n}`, outcome: s.outcome, thread_ref: s.thread_ref });
  }
  return {
    rows,
    recordAction: async (input: {
      thread_ref: string;
      idempotency_key: string;
      outcome?: string;
    }): Promise<{ id: string; outcome: string }> => {
      const existing = rows.get(input.idempotency_key);
      if (existing) return { id: existing.id, outcome: existing.outcome };
      const id = `row-${++n}`;
      const row = { id, outcome: input.outcome ?? 'proposed', thread_ref: input.thread_ref };
      rows.set(input.idempotency_key, row);
      return { id, outcome: row.outcome };
    },
    updateActionOutcome: async (id: string, outcome: string): Promise<void> => {
      for (const r of rows.values()) if (r.id === id) r.outcome = outcome;
    },
    countInterventionsSince: async (threadRef: string): Promise<number> => {
      let count = 0;
      for (const r of rows.values())
        if (r.thread_ref === threadRef && r.outcome === 'sent') count++;
      return count;
    },
    outcomes: (): string[] => [...rows.values()].map(r => r.outcome),
    byThread: (ref: string): JournalRow[] => [...rows.values()].filter(r => r.thread_ref === ref),
  };
}

function baseCtx(
  overrides: Partial<TickContext> & {
    journal: ReturnType<typeof makeJournal>;
    threads: TaskmasterThread[];
    pause?: { pause_state: 'RUNNING' | 'PAUSED' | 'HARD_PAUSE'; epoch: number };
    sent?: string[];
  }
): TickContext {
  const { journal, threads, pause, sent = [], ...rest } = overrides;
  const pauseState = pause ?? { pause_state: 'RUNNING' as const, epoch: 0 };
  return {
    now: NOW,
    readPause: async () => pauseState,
    readThreads: async () => threads,
    currentHeadroom: async () => ({ state: 'OK', value: 5 }),
    recordAction: journal.recordAction,
    updateActionOutcome: journal.updateActionOutcome,
    countInterventionsSince: journal.countInterventionsSince,
    sendMessage: async proposal => {
      sent.push(proposal.idempotencyKey);
      return { id: `msg-${sent.length}` };
    },
    validate: guardValidate,
    recordHeartbeat: () => {},
    eligibility: new Map(),
    ...rest,
  };
}

function ruling(ref: string): TaskmasterThread {
  return {
    ref,
    priority: 'P1',
    lastActivityAt: NOW,
    claimed: false,
    undeliveredRuling: true,
    recipient: 'major-build',
    subject: ref,
  };
}

function staleP1(ref: string): TaskmasterThread {
  return {
    ref,
    priority: 'P1',
    lastActivityAt: NOW - 5 * HOUR,
    claimed: true,
    recipient: 'major-build',
    subject: ref,
  };
}

describe('taskmaster tick', () => {
  test('delivers an undelivered ruling exactly once (scenario 1: two ticks, then dedupe)', async () => {
    const journal = makeJournal();
    const sent: string[] = [];
    const eligibility = new Map();
    const threads = [ruling('ruling/M-133')];

    // Ruling acts on the confirming tick -> sends on the FIRST tick.
    const r1 = await tick(baseCtx({ journal, threads, sent, eligibility }));
    expect(r1.sent).toBe(1);
    // Second tick: journal returns the already-sent row -> no re-send.
    const r2 = await tick(baseCtx({ journal, threads, sent, eligibility }));
    expect(r2.sent).toBe(0);
    // Third tick: still no additional row / send (dedupe proven).
    await tick(baseCtx({ journal, threads, sent, eligibility }));

    const rows = journal.byThread('ruling/M-133');
    expect(rows.length).toBe(1);
    expect(rows[0]?.outcome).toBe('sent');
    expect(sent.length).toBe(1);
  });

  test('pause blocks P1 sends but P0 still escalates; resume expires the P1 (scenario 3)', async () => {
    const journal = makeJournal();
    const sent: string[] = [];
    const eligibility = new Map();
    const pauseState = { pause_state: 'PAUSED' as const, epoch: 0 };

    const p1 = staleP1('wo/p1');
    const p0: TaskmasterThread = {
      ref: 'wo/p0',
      priority: 'P0',
      lastActivityAt: NOW - 40 * MIN,
      claimed: false,
      recipient: 'john',
      subject: 'wo/p0',
    };

    // Pre-seed the P1 to its confirming tick so one paused tick attempts it.
    eligibility.set('wo/p1', { count: 1, epoch: 0 });

    const ctx = baseCtx({ journal, threads: [p1, p0], sent, eligibility, pause: pauseState });
    const res = await tick(ctx);

    // P1 parked (no send); P0 escalation sent through the pause.
    expect(res.parked).toBe(1);
    expect(res.sent).toBe(1);
    expect(journal.byThread('wo/p1')[0]?.outcome).toBe('parked');
    expect(journal.byThread('wo/p0')[0]?.outcome).toBe('sent');
    expect(sent.length).toBe(1); // only the P0

    // Resume: epoch increments. The parked P1 proposal must EXPIRE, not replay.
    // Isolate the P1 to prove it is not replayed (the P0, still unclaimed+stale,
    // would legitimately re-escalate under the new epoch -- not what this asserts).
    pauseState.pause_state = 'RUNNING';
    pauseState.epoch = 1;
    const afterResume = await tick(
      baseCtx({ journal, threads: [p1], sent, eligibility, pause: pauseState })
    );
    // The P1 was reset by the epoch bump -> needs a fresh confirming tick, so it
    // does NOT send on the first post-resume tick.
    expect(afterResume.sent).toBe(0);
    const p1Sent = journal.byThread('wo/p1').some(r => r.outcome === 'sent');
    expect(p1Sent).toBe(false);
  });

  test('restart does not double-send on same idempotency key (scenario 4)', async () => {
    // A prior run already SENT this ruling (journal row seeded 'sent').
    const key = 'tm:deliver_ruling:ruling/M-99:0';
    const journal = makeJournal([{ key, outcome: 'sent', thread_ref: 'ruling/M-99' }]);
    const sent: string[] = [];
    const res = await tick(
      baseCtx({ journal, threads: [ruling('ruling/M-99')], sent, eligibility: new Map() })
    );
    // Reconciliation via the journal: no second send with the same key.
    expect(res.sent).toBe(0);
    expect(sent.length).toBe(0);
    expect(journal.byThread('ruling/M-99').length).toBe(1);
  });

  test('budget ceiling caps at 10 effects per tick; remainder deferred not dropped (scenario 5)', async () => {
    const journal = makeJournal();
    const sent: string[] = [];
    const eligibility = new Map();
    const threads: TaskmasterThread[] = [];
    for (let i = 0; i < 25; i++) {
      const ref = `wo/stale-${i}`;
      threads.push(staleP1(ref));
      // Pre-seed each to its confirming tick so all 25 are eligible in ONE tick.
      eligibility.set(ref, { count: 1, epoch: 0 });
    }

    const res = await tick(baseCtx({ journal, threads, sent, eligibility }));

    expect(res.sent).toBe(10); // ceiling holds
    expect(sent.length).toBe(10);
    expect(res.deferred).toBe(15); // remainder journalled, not dropped
    // No item received two effects in the tick.
    const perThreadRows = threads.map(t => journal.byThread(t.ref).length);
    expect(Math.max(...perThreadRows)).toBe(1);
    // Nothing silently vanished: every thread is accounted for.
    expect(res.sent + res.deferred).toBe(25);
  });
});
