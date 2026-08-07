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
  grade: string | null;
}

/** In-memory tm_journal: idempotent on key, restart-safe like the real DAL. */
function makeJournal(seed: Array<{ key: string; outcome: string; thread_ref: string }> = []) {
  const rows = new Map<string, JournalRow>();
  let n = 0;
  for (const s of seed) {
    rows.set(s.key, {
      id: `seed-${++n}`,
      outcome: s.outcome,
      thread_ref: s.thread_ref,
      grade: null,
    });
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
      const row = {
        id,
        outcome: input.outcome ?? 'proposed',
        thread_ref: input.thread_ref,
        grade: null,
      };
      rows.set(input.idempotency_key, row);
      return { id, outcome: row.outcome };
    },
    updateActionOutcome: async (
      id: string,
      outcome: string,
      grade?: string | null
    ): Promise<void> => {
      for (const r of rows.values())
        if (r.id === id) {
          r.outcome = outcome;
          r.grade = grade ?? null;
        }
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
    // Default: external effect verified -> actions may be graded 'useful'.
    verifyDelivered: async () => true,
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

  test('grades useful ONLY when the external effect is independently verified (SC7)', async () => {
    // A delivered ruling whose SOR proof holds -> graded 'useful'.
    const okJournal = makeJournal();
    await tick(
      baseCtx({ journal: okJournal, threads: [ruling('ruling/ok')], eligibility: new Map() })
    );
    expect(okJournal.byThread('ruling/ok')[0]?.grade).toBe('useful');

    // Same send, but the SOR cannot confirm the row -> outcome 'sent', grade NULL.
    // A self-report must never satisfy the 48h activation proof.
    const unverifiedJournal = makeJournal();
    await tick(
      baseCtx({
        journal: unverifiedJournal,
        threads: [ruling('ruling/no-proof')],
        eligibility: new Map(),
        verifyDelivered: async () => false,
      })
    );
    const row = unverifiedJournal.byThread('ruling/no-proof')[0];
    expect(row?.outcome).toBe('sent');
    expect(row?.grade).toBeNull();
  });

  test('parked items during pause never defer a P0 escalation (ceiling counts sends only)', async () => {
    const journal = makeJournal();
    const sent: string[] = [];
    const eligibility = new Map();
    const pauseState = { pause_state: 'PAUSED' as const, epoch: 0 };

    // 12 stale P1s (> the 10-effect ceiling) all reach their confirming tick, plus
    // one unclaimed P0. Under pause every P1 parks; the P0 must still escalate.
    const threads: TaskmasterThread[] = [];
    for (let i = 0; i < 12; i++) {
      const ref = `wo/park-${i}`;
      threads.push(staleP1(ref));
      eligibility.set(ref, { count: 1, epoch: 0 });
    }
    const p0: TaskmasterThread = {
      ref: 'wo/p0-late',
      priority: 'P0',
      lastActivityAt: NOW - 40 * MIN,
      claimed: false,
      recipient: 'john',
      subject: 'wo/p0-late',
    };
    threads.push(p0);

    const res = await tick(baseCtx({ journal, threads, sent, eligibility, pause: pauseState }));

    expect(res.parked).toBe(12); // every P1 parked (sends blocked)
    expect(res.sent).toBe(1); // the P0 escalation still went out
    expect(journal.byThread('wo/p0-late')[0]?.outcome).toBe('sent');
    expect(sent.length).toBe(1);
  });

  test('daily digest sends exactly once per day (deduped), even while paused', async () => {
    const journal = makeJournal();
    const sent: string[] = [];
    const digest = { recipient: 'john', buildBody: async () => 'digest body' };
    const pauseState = { pause_state: 'PAUSED' as const, epoch: 0 };

    // Paused tick with no threads: the digest must still be delivered.
    const first = await tick(
      baseCtx({ journal, threads: [], sent, eligibility: new Map(), pause: pauseState, digest })
    );
    expect(first.digest).toBe(true);
    expect(journal.byThread('digest')[0]?.outcome).toBe('sent');
    expect(journal.byThread('digest')[0]?.grade).toBe('useful');
    expect(sent.filter(k => k.startsWith('tm:digest:')).length).toBe(1);

    // A later tick the SAME day re-proposes but the row-first dedupe blocks a
    // second send.
    const second = await tick(
      baseCtx({ journal, threads: [], sent, eligibility: new Map(), pause: pauseState, digest })
    );
    expect(second.digest).toBe(false);
    expect(journal.byThread('digest').length).toBe(1);
    expect(sent.filter(k => k.startsWith('tm:digest:')).length).toBe(1);
  });
});
