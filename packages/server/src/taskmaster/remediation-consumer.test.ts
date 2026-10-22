/**
 * Taskmaster remediation-candidate consumer
 * (WO-HARNESS-TASKMASTER-REMEDIATION-CONSUMER-01).
 *
 * The 8 Section 7 scenarios. Everything is dependency-injected (fake clock,
 * fake DAL, fake dispatch, fake candidate store); no mock.module, so this file
 * cannot pollute the process-wide module cache for other files in the package.
 *
 * NOTE on recipient fixtures: Section 7's prose names 'codex' as the owner
 * thread's recipient. The real guard allowlist (TM_ALLOWED_RECIPIENTS) does not
 * include 'codex', and tick() runs the real (unfaked) validateProposal, so a
 * proposal addressed to 'codex' would be rejected and would never send. Per the
 * approved plan (resolved design decision #2), the fixtures use an
 * already-allowlisted seat ('major-build') in place of the illustrative
 * 'codex'; the scenario's intent (the nudge routes to the matched thread's
 * resolved recipient) is preserved. TM_ALLOWED_RECIPIENTS is intentionally NOT
 * widened by this WO.
 */
import { describe, expect, test } from 'bun:test';
import { rootLogger } from '@archon/paths';
import {
  createTaskmasterState,
  defaultListRemediationCandidates,
  tick,
  type ListedThread,
  type RemediationCandidate,
  type TaskmasterDeps,
} from './loop';
import {
  MAX_REMEDIATION_ATTEMPTS,
  REMEDIATION_CANDIDATE_KIND,
  type RemediationCandidateBody,
} from '@archon/overseer/remediation-candidate';
import type { DispatchDeliveryMode, DispatchMessage } from '@archon/core/db/dispatch';
import { MAX_INTERVENTIONS_PER_ITEM_24H } from './rules';
import type {
  TmActionOutcome,
  TmActionType,
  TmAdoptionRow,
  TmControlState,
  TmGrade,
  TmJournalEntry,
} from '@archon/core/db/taskmaster';
import type { HeadroomReading } from './ledger';

const T0 = Date.parse('2026-10-06T12:00:00.000Z');
const OWNER_THREAD_REF = 'gh:thinmansoftware/bdc-xo#777';
/** See the file header: 'major-build' stands in for the prose's 'codex'. */
const OWNER_RECIPIENT = 'major-build';

interface CandidateStoreEntry extends RemediationCandidate {
  consumed: boolean;
}

interface FakeWorld {
  journal: TmJournalEntry[];
  control: TmControlState;
  sentMessages: Array<{ idempotency_key: string; recipient: string; body: string }>;
  nowMs: number;
  adoptionRows: TmAdoptionRow[];
  adoptionMeta: {
    committed_snapshot_id: string | null;
    rebuilt_at: string | null;
    row_count: number | null;
    source_commit: string | null;
    complete: number;
  };
  /** Remediation candidate dispatch rows, with a local consumed flag. */
  candidates: CandidateStoreEntry[];
  consumeCalls: string[];
}

function makeWorld(): FakeWorld {
  return {
    journal: [],
    control: {
      pause_state: 'RUNNING',
      pause_scope: null,
      pause_reason: null,
      pause_actor: null,
      epoch: 0,
      updated_at: new Date(T0).toISOString(),
    },
    sentMessages: [],
    nowMs: T0,
    adoptionRows: [],
    adoptionMeta: {
      committed_snapshot_id: null,
      rebuilt_at: null,
      row_count: null,
      source_commit: null,
      complete: 0,
    },
    candidates: [],
    consumeCalls: [],
  };
}

function candidateBody(
  overrides: Partial<RemediationCandidateBody> = {}
): RemediationCandidateBody {
  return {
    kind: REMEDIATION_CANDIDATE_KIND,
    owner: 'owner',
    repo: 'repo',
    prNumber: 5,
    headSha: 'aaaaaaa1111',
    attempt: 1,
    maxAttempts: MAX_REMEDIATION_ATTEMPTS,
    findingClasses: ['migration_ordering'],
    verdictBody: 'Independent review at head aaaaaaa1111. Migration ordering violates the FK.',
    woId: 'WO-X-01',
    owningLane: null,
    ...overrides,
  };
}

function ownerThread(overrides: Partial<ListedThread> = {}): ListedThread {
  return {
    ref: OWNER_THREAD_REF,
    priority: 'P1',
    // Recent activity -> classified healthy, so the owner thread itself produces
    // no ordinary nudge/escalation that could pollute the assertions.
    lastActivityAt: new Date(T0 - 1_000).toISOString(),
    recipient: OWNER_RECIPIENT,
    title: 'WO-X-01 remediation target',
    ownerLogin: 'major-build',
    labels: ['wo', 'prio:P1'],
    isUnclaimed: false,
    isBlocked: false,
    isHeld: false,
    ...overrides,
  };
}

/** Seed a graded 'sent' intervention for a thread (feeds the 24h cap count). */
function seedIntervention(world: FakeWorld, threadRef: string, index: number): void {
  world.journal.push({
    id: `seed-intervention-${index}`,
    created_at: new Date(world.nowMs - 1_000).toISOString(),
    thread_ref: threadRef,
    action_type: 'nudge',
    proposal_json: '{}',
    idempotency_key: `seed:intervention:${threadRef}:${index}`,
    before_hash: null,
    proof_predicate: null,
    proof_deadline_at: null,
    outcome: 'sent',
    graded_at: new Date(world.nowMs - 500).toISOString(),
    grade: 'useful',
  });
}

function makeDeps(world: FakeWorld, overrides: Partial<TaskmasterDeps> = {}): TaskmasterDeps {
  let journalSeq = world.journal.length;
  const dal = {
    recordAction: async (data: {
      thread_ref: string;
      action_type: TmActionType;
      proposal_json: string;
      idempotency_key?: string | null;
      before_hash?: string | null;
      proof_predicate?: string | null;
      proof_deadline_at?: string | null;
      outcome: TmActionOutcome;
    }): Promise<TmJournalEntry> => {
      if (data.idempotency_key) {
        const existing = world.journal.find(j => j.idempotency_key === data.idempotency_key);
        if (existing) return existing;
      }
      journalSeq += 1;
      const row: TmJournalEntry = {
        id: `journal-${journalSeq}`,
        created_at: new Date(world.nowMs).toISOString(),
        thread_ref: data.thread_ref,
        action_type: data.action_type,
        proposal_json: data.proposal_json,
        idempotency_key: data.idempotency_key ?? null,
        before_hash: data.before_hash ?? null,
        proof_predicate: data.proof_predicate ?? null,
        proof_deadline_at: data.proof_deadline_at ?? null,
        outcome: data.outcome,
        graded_at: null,
        grade: null,
      };
      world.journal.push(row);
      return row;
    },
    updateActionOutcome: async (id: string, outcome: TmActionOutcome, proposalJson?: string) => {
      const row = world.journal.find(j => j.id === id) ?? null;
      if (row) {
        row.outcome = outcome;
        if (proposalJson !== undefined) row.proposal_json = proposalJson;
      }
      return row;
    },
    gradeAction: async (id: string, grade: TmGrade) => {
      const row = world.journal.find(j => j.id === id) ?? null;
      if (row) {
        row.grade = grade;
        row.graded_at = new Date(world.nowMs).toISOString();
      }
      return row;
    },
    getActionsSince: async (sinceIso: string) =>
      world.journal.filter(j => j.created_at >= sinceIso),
    getActionByIdempotencyKey: async (key: string) =>
      world.journal.find(j => j.idempotency_key === key) ?? null,
    getPauseState: async () => world.control,
    setPauseState: async (data: {
      pause_state: TmControlState['pause_state'];
      pause_scope?: string | null;
      pause_reason?: string | null;
      pause_actor: string;
      incrementEpoch?: boolean;
    }) => {
      world.control = {
        pause_state: data.pause_state,
        pause_scope: data.pause_scope ?? null,
        pause_reason: data.pause_reason ?? null,
        pause_actor: data.pause_actor,
        epoch: world.control.epoch + (data.incrementEpoch ? 1 : 0),
        updated_at: new Date(world.nowMs).toISOString(),
      };
      return world.control;
    },
    expireParkedActions: async () => 0,
    beginAdoptionSnapshot: async () => `snap-${world.nowMs}-${world.adoptionRows.length}`,
    upsertAdoptionRow: async (snapshotId: string, row: Omit<TmAdoptionRow, 'snapshot_id'>) => {
      const full: TmAdoptionRow = { ...row, snapshot_id: snapshotId };
      const idx = world.adoptionRows.findIndex(
        r => r.snapshot_id === snapshotId && r.thread_ref === row.thread_ref
      );
      if (idx >= 0) world.adoptionRows[idx] = full;
      else world.adoptionRows.push(full);
    },
    commitAdoptionSnapshot: async (snapshotId: string, sourceCommit?: string | null) => {
      world.adoptionRows = world.adoptionRows.filter(r => r.snapshot_id === snapshotId);
      world.adoptionMeta = {
        committed_snapshot_id: snapshotId,
        rebuilt_at: new Date(world.nowMs).toISOString(),
        row_count: world.adoptionRows.length,
        source_commit: sourceCommit ?? null,
        complete: 1,
      };
    },
    abandonAdoptionSnapshot: async (snapshotId: string) => {
      world.adoptionRows = world.adoptionRows.filter(r => r.snapshot_id !== snapshotId);
    },
    getAdoption: async () => {
      const id = world.adoptionMeta.committed_snapshot_id;
      if (!id) return [];
      return world.adoptionRows.filter(r => r.snapshot_id === id);
    },
    getAdoptionMeta: async () => ({
      id: 1,
      committed_snapshot_id: world.adoptionMeta.committed_snapshot_id,
      rebuilt_at: world.adoptionMeta.rebuilt_at,
      row_count: world.adoptionMeta.row_count,
      source_commit: world.adoptionMeta.source_commit,
      complete: world.adoptionMeta.complete,
    }),
  };

  const okHeadroom: HeadroomReading = {
    state: 'OK',
    tokensRemaining: 500_000,
    isUnknown: false,
    source: 'local_artifacts',
    observedAt: new Date(T0).toISOString(),
  };

  return {
    now: () => new Date(world.nowMs),
    db: dal,
    getDispatchReceiptCutoverAt: async () => new Date(T0 - 86_400_000).toISOString(),
    headroom: async () => okHeadroom,
    createTask: (async (
      _context: unknown,
      data: { idempotency_key: string; recipient: string; body: string }
    ) => {
      world.sentMessages.push({
        idempotency_key: data.idempotency_key,
        recipient: data.recipient,
        body: data.body,
      });
      return { id: `msg-${world.sentMessages.length}`, status: 'queued' } as never;
    }) as unknown as TaskmasterDeps['createTask'],
    findEffectByIdempotencyKey: async () => null,
    getDispatchMessageById: (async () =>
      null) as unknown as TaskmasterDeps['getDispatchMessageById'],
    assessDispatchRecipient: (async (recipient: string) => {
      const nonDrain: Record<string, DispatchDeliveryMode> = {
        'major-build': 'worker_poll',
        'captain-ci': 'worker_poll',
      };
      const canonical = recipient.trim().toLowerCase();
      return {
        ok: true,
        canonical_principal: canonical,
        delivery_mode: nonDrain[canonical] ?? 'drain_on_start',
        reason: null,
      };
    }) as unknown as TaskmasterDeps['assessDispatchRecipient'],
    listUndeliveredRulings: async () => [],
    listThreads: async () => [],
    getGithubIssueEvidence: async () => null,
    // Default remediation wiring, backed by the world's candidate store.
    listRemediationCandidates: async () =>
      world.candidates.filter(c => !c.consumed).map(c => ({ id: c.id, body: c.body })),
    consumeRemediationCandidate: async (id: string) => {
      world.consumeCalls.push(id);
      const entry = world.candidates.find(c => c.id === id);
      if (entry) entry.consumed = true;
    },
    ...overrides,
  };
}

/** Remediation nudge sends (the owner nudge), isolated from digest/escalation. */
function nudgeSends(world: FakeWorld): FakeWorld['sentMessages'] {
  return world.sentMessages.filter(
    m => m.idempotency_key.startsWith('tm:remediation_nudge:') && m.recipient === OWNER_RECIPIENT
  );
}

describe('Test 1: a candidate becomes one nudge to the owner', () => {
  test('exactly one remediation_nudge to the owner with PR ref, head, attempt, verdict, key', async () => {
    const world = makeWorld();
    world.candidates.push({ id: 'cand-1', consumed: false, body: candidateBody() });
    const deps = makeDeps(world, { listThreads: async () => [ownerThread()] });

    await tick(createTaskmasterState(60_000), deps);

    const sends = nudgeSends(world);
    expect(sends.length).toBe(1);
    const sent = sends[0]!;
    expect(sent.recipient).toBe(OWNER_RECIPIENT);
    expect(sent.idempotency_key).toBe('tm:remediation_nudge:owner/repo#5:1:aaaaaaa');
    expect(sent.body).toContain('owner/repo#5');
    expect(sent.body).toContain('aaaaaaa1111');
    expect(sent.body).toContain('attempt 1');
    expect(sent.body).toContain('Migration ordering violates the FK');
    // The candidate was consumed exactly once on the successful send.
    expect(world.consumeCalls).toEqual(['cand-1']);
  });
});

describe('Test 2: the same candidate never nudges twice', () => {
  test('three further ticks add no send and the candidate row is consumed', async () => {
    const world = makeWorld();
    world.candidates.push({ id: 'cand-1', consumed: false, body: candidateBody() });
    const deps = makeDeps(world, { listThreads: async () => [ownerThread()] });
    const state = createTaskmasterState(60_000);

    await tick(state, deps);
    expect(nudgeSends(world).length).toBe(1);

    for (let i = 0; i < 3; i += 1) {
      world.nowMs += 60_000;
      await tick(state, deps);
    }

    expect(nudgeSends(world).length).toBe(1);
    expect(world.consumeCalls).toEqual(['cand-1']);
    expect(world.candidates[0]!.consumed).toBe(true);
  });
});

describe('Test 3: paused Taskmaster refuses and records it', () => {
  test('paused: nothing sent, refusal recorded, candidate unconsumed; resume sends one', async () => {
    const world = makeWorld();
    world.control.pause_state = 'PAUSED';
    world.control.pause_scope = 'effects';
    world.candidates.push({ id: 'cand-1', consumed: false, body: candidateBody() });
    const deps = makeDeps(world, { listThreads: async () => [ownerThread()] });
    const state = createTaskmasterState(60_000);

    await tick(state, deps);

    // Nothing sent while paused; the refusal is recorded; the candidate is left
    // unconsumed so a later tick can still deliver it.
    expect(nudgeSends(world).length).toBe(0);
    const refusal = world.journal.find(
      j => j.thread_ref === OWNER_THREAD_REF && j.action_type === 'remediation_nudge'
    );
    expect(refusal).toBeTruthy();
    expect(refusal!.outcome).not.toBe('sent');
    expect(refusal!.proposal_json).toContain('"reason":"paused"');
    expect(world.consumeCalls).toEqual([]);
    expect(world.candidates[0]!.consumed).toBe(false);

    // Resume: the very next tick delivers exactly one nudge.
    world.control = { ...world.control, pause_state: 'RUNNING', pause_scope: null };
    world.nowMs += 60_000;
    await tick(state, deps);

    expect(nudgeSends(world).length).toBe(1);
    expect(world.consumeCalls).toEqual(['cand-1']);
  });
});

describe('Test 4: the per-item intervention cap refuses', () => {
  test('owner thread at the 24h cap: nothing sent and the refusal is recorded', async () => {
    const world = makeWorld();
    for (let i = 0; i < MAX_INTERVENTIONS_PER_ITEM_24H; i += 1) {
      seedIntervention(world, OWNER_THREAD_REF, i);
    }
    world.candidates.push({ id: 'cand-1', consumed: false, body: candidateBody() });
    const deps = makeDeps(world, { listThreads: async () => [ownerThread()] });

    await tick(createTaskmasterState(60_000), deps);

    expect(nudgeSends(world).length).toBe(0);
    const refusal = world.journal.find(
      j =>
        j.thread_ref === OWNER_THREAD_REF &&
        j.action_type === 'remediation_nudge' &&
        j.outcome === 'deferred'
    );
    expect(refusal).toBeTruthy();
    expect(world.consumeCalls).toEqual([]);
  });
});

describe('Test 5: no matching work thread escalates', () => {
  test('a null-woId candidate and an unmatched-woId candidate each escalate to the operator', async () => {
    const world = makeWorld();
    world.candidates.push({
      id: 'cand-no-wo',
      consumed: false,
      body: candidateBody({ prNumber: 11, headSha: 'ccccccc3333', woId: null }),
    });
    world.candidates.push({
      id: 'cand-unmatched',
      consumed: false,
      body: candidateBody({ prNumber: 12, headSha: 'ddddddd4444', woId: 'WO-OTHER-99' }),
    });
    // The only open thread matches neither candidate (title names WO-X-01).
    const deps = makeDeps(world, { listThreads: async () => [ownerThread()] });

    await tick(createTaskmasterState(60_000), deps);

    // No owner nudge (neither candidate matched a thread).
    expect(nudgeSends(world).length).toBe(0);

    const escalations = world.sentMessages.filter(m =>
      m.idempotency_key.startsWith('tm:remediation_nudge:')
    );
    expect(escalations.length).toBe(2);
    for (const escalation of escalations) {
      expect(escalation.recipient).toBe('operator');
    }
    expect(escalations.map(e => e.idempotency_key).sort()).toEqual(
      [
        'tm:remediation_nudge:owner/repo#11:1:ccccccc',
        'tm:remediation_nudge:owner/repo#12:1:ddddddd',
      ].sort()
    );
    // Neither candidate was dropped: both were consumed via the escalation send.
    expect(world.consumeCalls.sort()).toEqual(['cand-no-wo', 'cand-unmatched'].sort());
  });
});

describe('Test 6: other queued rows are not consumed', () => {
  test('non-candidate taskmaster rows and foreign rows produce no remediation_nudge', async () => {
    const world = makeWorld();
    // The reader (defaultListRemediationCandidates) is exercised against a fake
    // listMessages returning: an ordinary run_review row for another recipient,
    // a board_motion row, and a taskmaster run_review row of another kind. Only
    // overseer_remediation_candidate rows addressed to 'taskmaster' are picked up.
    const rows: DispatchMessage[] = [
      fakeDispatchRow({
        id: 'other-recipient',
        recipient: 'captain-ci',
        task_type: 'run_review',
        body: JSON.stringify(candidateBody()),
      }),
      fakeDispatchRow({
        id: 'board-motion',
        recipient: 'taskmaster',
        task_type: 'board_motion',
        body: JSON.stringify(candidateBody()),
      }),
      fakeDispatchRow({
        id: 'other-kind',
        recipient: 'taskmaster',
        task_type: 'run_review',
        body: JSON.stringify({ kind: 'something_else', foo: 'bar' }),
      }),
    ];
    const fakeListMessages = (async (filters: { recipient?: string }) =>
      rows.filter(r => !filters.recipient || r.recipient === filters.recipient)) as never;
    const deps = makeDeps(world, {
      listThreads: async () => [ownerThread()],
      listRemediationCandidates: () => defaultListRemediationCandidates(fakeListMessages),
    });

    await tick(createTaskmasterState(60_000), deps);

    expect(
      world.sentMessages.some(m => m.idempotency_key.startsWith('tm:remediation_nudge:'))
    ).toBe(false);
    expect(world.consumeCalls).toEqual([]);
  });
});

describe('Test 7: a malformed body never breaks the tick', () => {
  test('non-JSON and field-missing rows are ignored by id; sibling candidate still runs', async () => {
    const world = makeWorld();
    const rows: DispatchMessage[] = [
      fakeDispatchRow({
        id: 'not-json',
        recipient: 'taskmaster',
        task_type: 'run_review',
        body: 'this is not json',
      }),
      fakeDispatchRow({
        id: 'missing-fields',
        recipient: 'taskmaster',
        task_type: 'run_review',
        body: JSON.stringify({ kind: REMEDIATION_CANDIDATE_KIND, owner: 'owner' }),
      }),
      fakeDispatchRow({
        id: 'good',
        recipient: 'taskmaster',
        task_type: 'run_review',
        body: JSON.stringify(candidateBody()),
      }),
    ];
    const fakeListMessages = (async (filters: { recipient?: string }) =>
      rows.filter(r => !filters.recipient || r.recipient === filters.recipient)) as never;
    const deps = makeDeps(world, {
      listThreads: async () => [ownerThread()],
      listRemediationCandidates: () => defaultListRemediationCandidates(fakeListMessages),
    });

    const logChunks = captureLogChunks();
    try {
      await tick(createTaskmasterState(60_000), deps);
    } finally {
      logChunks.restore();
    }

    // The tick completed and the well-formed sibling still produced its nudge.
    expect(nudgeSends(world).length).toBe(1);
    // One ignore log line per malformed row, each naming the row id.
    const ignored = logChunks
      .text()
      .split('\n')
      .filter(line => line.includes('taskmaster.remediation_candidate_ignored'));
    expect(ignored.some(line => line.includes('not-json'))).toBe(true);
    expect(ignored.some(line => line.includes('missing-fields'))).toBe(true);
  });
});

describe('Test 8: attempt 2 on a new head nudges again', () => {
  test('a second candidate for the same PR with a new head and attempt 2 sends again', async () => {
    const world = makeWorld();
    world.candidates.push({ id: 'cand-1', consumed: false, body: candidateBody() });
    const deps = makeDeps(world, { listThreads: async () => [ownerThread()] });
    const state = createTaskmasterState(60_000);

    await tick(state, deps);
    expect(nudgeSends(world).length).toBe(1);

    // A fresh candidate: same PR, new reviewed head, attempt 2.
    world.candidates.push({
      id: 'cand-2',
      consumed: false,
      body: candidateBody({ headSha: 'bbbbbbb2222', attempt: 2 }),
    });
    world.nowMs += 60_000;
    await tick(state, deps);

    const sends = nudgeSends(world);
    expect(sends.length).toBe(2);
    const second = sends[1]!;
    expect(second.idempotency_key).toBe('tm:remediation_nudge:owner/repo#5:2:bbbbbbb');
    expect(second.body).toContain('attempt 2');
    expect(world.consumeCalls.sort()).toEqual(['cand-1', 'cand-2'].sort());
  });
});

/** Minimal DispatchMessage row for the reader tests (only read fields set). */
function fakeDispatchRow(
  partial: Pick<DispatchMessage, 'id' | 'recipient' | 'task_type' | 'body'>
): DispatchMessage {
  return {
    id: partial.id,
    correlation_id: `corr-${partial.id}`,
    idempotency_key: `idem-${partial.id}`,
    task_type: partial.task_type,
    sender: 'overseer',
    sender_principal_id: 'system:overseer',
    recipient: partial.recipient,
    body: partial.body,
    status: 'queued',
    result_body: null,
    created_at: new Date(T0).toISOString(),
    claimed_at: null,
    completed_at: null,
    not_before: null,
    lease_owner: null,
    lease_expires_at: null,
    fencing_token: 0,
    recipient_alias: null,
    motion_id: null,
    motion_revision_sha: null,
    resolved_recipient: null,
    resolved_xo_lease_id: null,
    resolved_xo_fencing_token: null,
    resolved_at: null,
    priority: 'normal',
    task_outcome: null,
    acknowledged_at: null,
    acknowledged_by: null,
    addressed_at: null,
    addressed_by: null,
    escalated_tg_at: null,
    escalated_sms_at: null,
    subject_key: null,
    route_disposition: null,
    route_disposed_at: null,
    supersedes_id: null,
    repeat_reason: null,
  };
}

/** Capture pino log output for assertions, mirroring loop.test.ts. */
function captureLogChunks(): { text: () => string; restore: () => void } {
  const streamSymbol = Object.getOwnPropertySymbols(rootLogger).find(
    symbol => symbol.description === 'pino.stream'
  );
  if (streamSymbol === undefined) throw new Error('pino.stream symbol missing on rootLogger');
  const stream = (rootLogger as unknown as Record<symbol, { write: (chunk: string) => boolean }>)[
    streamSymbol
  ];
  const chunks: string[] = [];
  const originalWrite = stream.write;
  stream.write = (chunk: string): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    text: () => chunks.join(''),
    restore: () => {
      stream.write = originalWrite;
    },
  };
}
