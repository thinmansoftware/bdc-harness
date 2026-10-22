/**
 * Receipt guard (WO-HARNESS-TASKMASTER-RECEIPT-NUDGE-GUARD-01).
 * Ten scenarios from the frozen bdc-xo#1997 comment shape. No network.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { rootLogger } from '@archon/paths';
import { resetGitHubApiMeterForTests } from '@archon/core/github/metering';
import type { DispatchDeliveryMode } from '@archon/core/db/dispatch';
import {
  expectationRegistrationKey,
  type TmActionOutcome,
  type TmActionType,
  type TmAdoptionRow,
  type TmControlState,
  type TmExpectation,
  type TmGrade,
  type TmJournalEntry,
} from '@archon/core/db/taskmaster';
import { DUTY_OFFICER_NUDGE_MARKER } from '../dispatch/duty-officer-clock';
import { TASKMASTER_ESCALATION_MARKER, type EscalationDeliveryDeps } from './escalation-delivery';
import {
  createTaskmasterState,
  defaultListThreads,
  tick,
  type GithubIssueEvidence,
  type TaskmasterDeps,
} from './loop';
import {
  createReceiptCheckState,
  hasReceiptMarker,
  isAutomatedComment,
  latestSubstantiveComment,
  readLatestSubstantiveComment,
  type ReceiptCheckOutcome,
  type ReceiptComment,
} from './receipt-guard';
import { classifyThread, computeNextAction, type ThreadSnapshot } from './rules';
import type { HeadroomReading } from './ledger';

beforeEach(resetGitHubApiMeterForTests);

const SECURITY_DETECTOR_COMMENT_MARKER = '<!-- security-detector -->';
const DISPATCH_WORKER_ALARM_PREFIX = '<!-- dispatch-worker-alarm:';
const RECEIPT_LINE = '## EXECUTED -- Supabase and LSPRO done, Notion needs one click from John';

const T0 = Date.parse('2026-08-07T12:00:00.000Z');
const TODAY_KEY = new Date(T0).toISOString().slice(0, 10);

function atMinute(index: number): string {
  return new Date(Date.parse('2026-09-10T11:00:00.000Z') + index * 60_000).toISOString();
}

/** Frozen 10-comment shape: consumer map, receipt, then eight automated nudges. */
function frozen1997Comments(): ReceiptComment[] {
  const automated = [
    `${TASKMASTER_ESCALATION_MARKER}\nUnclaimed P0: nothing shows a rotation attempted`,
    `${DUTY_OFFICER_NUDGE_MARKER}\nDuty Officer nudge: this item has been idle.`,
    `${SECURITY_DETECTOR_COMMENT_MARKER}\nverdict: clean\nreasons: none`,
    `${DISPATCH_WORKER_ALARM_PREFIX}A:down -->\nold alarm`,
    '[DO nudge 2026-09-10] nothing shows a rotation attempted',
    `${DUTY_OFFICER_NUDGE_MARKER}\nsecond duty-officer nudge`,
    `${TASKMASTER_ESCALATION_MARKER}\nsecond escalation nudge`,
    `${DISPATCH_WORKER_ALARM_PREFIX}A:up -->\nrecovered`,
  ];
  return [
    {
      body: 'Consumer map: seat rotation recorded. No execution receipt on this comment.',
      created_at: atMinute(0),
    },
    { body: RECEIPT_LINE, created_at: '2026-09-10T11:12:32.000Z' },
    ...automated.map((body, index) => ({ body, created_at: atMinute(30 + index) })),
  ];
}

function adoption(overrides: Partial<TmAdoptionRow> = {}): TmAdoptionRow {
  return {
    thread_ref: 'gh:thinmansoftware/bdc-xo#1',
    snapshot_id: 'snap-test',
    repo: 'thinmansoftware/bdc-xo',
    issue_number: 1,
    title: 'Fix the thing',
    priority: 'P0',
    labels_json: '["wo","prio:P0"]',
    owner_login: 'major-build',
    is_blocked: 0,
    blocked_reason: null,
    next_action: 'waiting on review feedback',
    latest_marker_kind: 'PROGRESS',
    latest_marker_at: new Date(T0 - 3 * 3_600_000).toISOString(),
    state: 'open',
    last_movement_at: new Date(T0 - 5 * 3_600_000).toISOString(),
    last_movement_kind: 'progress_comment',
    attempts_24h: 0,
    attempts_total: 0,
    evidence_observed_at: new Date(T0 - 60_000).toISOString(),
    source_updated_at: new Date(T0 - 60_000).toISOString(),
    ...overrides,
  };
}

interface FakeWorld {
  expectations: Map<string, TmExpectation>;
  journal: TmJournalEntry[];
  control: TmControlState;
  sentMessages: Array<{
    idempotency_key: string;
    recipient: string;
    body: string;
    createdAt: string;
    acknowledged_at?: string | null;
  }>;
  nowMs: number;
  recordCalls: number;
  adoptionRows: TmAdoptionRow[];
  adoptionMeta: {
    committed_snapshot_id: string | null;
    rebuilt_at: string | null;
    row_count: number | null;
    source_commit: string | null;
    complete: number;
  };
}

function makeWorld(): FakeWorld {
  return {
    expectations: new Map(),
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
    recordCalls: 0,
    adoptionRows: [],
    adoptionMeta: {
      committed_snapshot_id: null,
      rebuilt_at: null,
      row_count: null,
      source_commit: null,
      complete: 0,
    },
  };
}

function makeDeps(world: FakeWorld, overrides: Partial<TaskmasterDeps> = {}): TaskmasterDeps {
  let journalSeq = world.journal.length;
  const dal = {
    listPendingFireActions: async () =>
      world.journal.filter(row => row.action_type === 'fire_cauldron' && row.outcome === 'pending'),
    transitionPendingFireAction: async (
      id: string,
      expectedJson: string,
      outcome: 'pending' | 'sent' | 'expired',
      proposalJson: string
    ) => {
      const row = world.journal.find(entry => entry.id === id);
      if (
        !row ||
        row.action_type !== 'fire_cauldron' ||
        row.outcome !== 'pending' ||
        row.proposal_json !== expectedJson
      ) {
        return false;
      }
      row.outcome = outcome;
      row.proposal_json = proposalJson;
      return true;
    },
    registerExpectation: async (data: {
      action_ref?: string | null;
      dispatch_ref: string;
      recipient: string;
      evidence_json: string;
      due_at: string;
      on_absence: 'redispatch' | 'escalate' | 'give_up';
      max_retries: number;
    }) => {
      const key = expectationRegistrationKey(data.action_ref ?? null, data.dispatch_ref);
      const prior = world.expectations.get(key);
      if (prior) return prior.id;
      const row: TmExpectation = {
        ...data,
        id: `expectation-${world.expectations.size + 1}`,
        retries: 0,
        status: 'pending',
        evidence_pointer: null,
        registered_by: 'taskmaster',
        self_supervised: 0,
        created_at: new Date(world.nowMs).toISOString(),
        updated_at: new Date(world.nowMs).toISOString(),
      };
      world.expectations.set(key, row);
      return row.id;
    },
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
      world.recordCalls += 1;
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
      const row = world.journal.find(entry => entry.id === id) ?? null;
      if (row) {
        row.outcome = outcome;
        if (proposalJson !== undefined) row.proposal_json = proposalJson;
      }
      return row;
    },
    gradeAction: async (id: string, grade: TmGrade) => {
      const row = world.journal.find(entry => entry.id === id) ?? null;
      if (row) {
        row.grade = grade;
        row.graded_at = new Date(world.nowMs).toISOString();
      }
      return row;
    },
    getActionsSince: async (sinceIso: string) =>
      world.journal.filter(entry => entry.created_at >= sinceIso),
    getActionByIdempotencyKey: async (key: string) =>
      world.journal.find(entry => entry.idempotency_key === key) ?? null,
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
        entry => entry.snapshot_id === snapshotId && entry.thread_ref === row.thread_ref
      );
      if (idx >= 0) world.adoptionRows[idx] = full;
      else world.adoptionRows.push(full);
    },
    commitAdoptionSnapshot: async (snapshotId: string, sourceCommit?: string | null) => {
      world.adoptionRows = world.adoptionRows.filter(entry => entry.snapshot_id === snapshotId);
      world.adoptionMeta = {
        committed_snapshot_id: snapshotId,
        rebuilt_at: new Date(world.nowMs).toISOString(),
        row_count: world.adoptionRows.length,
        source_commit: sourceCommit ?? null,
        complete: 1,
      };
    },
    abandonAdoptionSnapshot: async (snapshotId: string) => {
      world.adoptionRows = world.adoptionRows.filter(entry => entry.snapshot_id !== snapshotId);
    },
    getAdoption: async () => {
      const id = world.adoptionMeta.committed_snapshot_id;
      if (!id) return [];
      return world.adoptionRows.filter(entry => entry.snapshot_id === id);
    },
    getAdoptionMeta: async () => ({
      id: 1,
      committed_snapshot_id: world.adoptionMeta.committed_snapshot_id,
      rebuilt_at: world.adoptionMeta.rebuilt_at,
      row_count: world.adoptionMeta.row_count,
      source_commit: world.adoptionMeta.source_commit,
      complete: world.adoptionMeta.complete,
    }),
    getSuppression: async () => new Map(),
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
    getHealthSample: async () => null,
    createTask: (async (
      _context: unknown,
      data: { idempotency_key: string; recipient: string; body: string }
    ) => {
      world.sentMessages.push({
        idempotency_key: data.idempotency_key,
        recipient: data.recipient,
        body: data.body,
        createdAt: new Date(world.nowMs).toISOString(),
      });
      return { id: `msg-${world.sentMessages.length}`, status: 'queued' } as never;
    }) as unknown as TaskmasterDeps['createTask'],
    findEffectByIdempotencyKey: async (key: string) => {
      const found = world.sentMessages.find(message => message.idempotency_key === key);
      return found
        ? { id: found.idempotency_key, status: 'queued', createdAt: found.createdAt }
        : null;
    },
    getDispatchMessageById: (async (id: string) => {
      const found = world.sentMessages.find(message => message.idempotency_key === id);
      if (!found) return null;
      return {
        id,
        recipient: found.recipient,
        resolved_recipient: null,
        acknowledged_at: found.acknowledged_at ?? null,
        addressed_at: null,
        addressed_by: null,
      };
    }) as unknown as TaskmasterDeps['getDispatchMessageById'],
    assessDispatchRecipient: (async (recipient: string) => {
      const nonDrain: Record<string, DispatchDeliveryMode> = {
        overseer: 'notify_only',
        cauldron: 'notify_only',
        claude: 'worker_poll',
        codex: 'worker_poll',
        'major-build': 'worker_poll',
        'captain-ci': 'worker_poll',
        board: 'alias_resolved',
      };
      const canonical = recipient.trim().toLowerCase();
      const delivery_mode = nonDrain[canonical] ?? 'drain_on_start';
      return { ok: true, canonical_principal: canonical, delivery_mode, reason: null };
    }) as unknown as TaskmasterDeps['assessDispatchRecipient'],
    listUndeliveredRulings: async () => [],
    listThreads: async () => [],
    getGithubIssueEvidence: async () => null,
    ...overrides,
  };
}

function seedDigestSent(world: FakeWorld): void {
  world.journal.push({
    id: 'journal-digest-seed',
    created_at: new Date(world.nowMs).toISOString(),
    thread_ref: `digest:${TODAY_KEY}`,
    action_type: 'digest',
    proposal_json: '{}',
    idempotency_key: `tm:digest:${TODAY_KEY}`,
    before_hash: null,
    proof_predicate: null,
    proof_deadline_at: null,
    outcome: 'sent',
    graded_at: null,
    grade: null,
  });
}

function restoreEnv(name: string, prior: string | undefined): void {
  if (prior === undefined) delete process.env[name];
  else process.env[name] = prior;
}

async function capturePino(run: () => Promise<void>): Promise<string> {
  const streamSymbol = Object.getOwnPropertySymbols(rootLogger).find(
    symbol => symbol.description === 'pino.stream'
  );
  if (streamSymbol === undefined) throw new Error('pino.stream symbol missing on rootLogger');
  const stream = (rootLogger as unknown as Record<symbol, { write: (chunk: string) => boolean }>)[
    streamSymbol
  ];
  const chunks: string[] = [];
  const originalWrite = stream.write;
  stream.write = (chunk: string) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await run();
    return chunks.join('');
  } finally {
    stream.write = originalWrite;
  }
}

function progressEvidence(): GithubIssueEvidence {
  return {
    state: 'open',
    updatedAt: new Date(T0).toISOString(),
    labels: ['wo', 'prio:P1'],
    assigneeCount: 1,
    closedAt: null,
    assignedAt: null,
    activeStatusAt: null,
    progressRecordedAt: null,
    ownerLogin: 'major-build',
    latestMarkerKind: 'PROGRESS',
    latestMarkerText: 'waiting on review feedback',
    latestMarkerAt: new Date(T0 - 3 * 3_600_000).toISOString(),
    lastMovementAt: new Date(T0 - 3 * 3_600_000).toISOString(),
    lastMovementKind: 'progress_comment',
  };
}

describe('receipt guard', () => {
  test('1. frozen 1997 fixture yields the receipt', () => {
    const latest = latestSubstantiveComment(frozen1997Comments());
    expect(latest?.body).toBe(RECEIPT_LINE);
    expect(hasReceiptMarker(latest?.body ?? '')).toBe(true);
  });

  test('2. no receipt means no suppression', () => {
    const comments: ReceiptComment[] = [
      { body: 'Looking at the consumer map.', created_at: atMinute(0) },
      { body: 'The hostname is still open.', created_at: atMinute(1) },
      {
        body: `${DUTY_OFFICER_NUDGE_MARKER}\nDuty Officer nudge: idle.`,
        created_at: atMinute(2),
      },
    ];
    const latest = latestSubstantiveComment(comments);
    expect(latest?.body).toBe('The hostname is still open.');
    expect(hasReceiptMarker(latest?.body ?? '')).toBe(false);
  });

  test('3. quoted, fenced, or mid-comment receipt text does not count', () => {
    const quoted = '> ## EXECUTED -- quoted so it does not count\n';
    const fenced = '```\n## EXECUTED -- inside the fence\n```\n';
    const later =
      'Is the Notion click still required?\n\nEXECUTED was mentioned later in the thread.\n';
    expect(hasReceiptMarker(quoted)).toBe(false);
    expect(hasReceiptMarker(fenced)).toBe(false);
    expect(hasReceiptMarker(later)).toBe(false);
  });

  test('4. new genuine discussion after a receipt reopens the thread', () => {
    const comments = [
      ...frozen1997Comments(),
      {
        body: 'Notion closeout is still open. Who clicks?',
        created_at: '2026-09-29T16:00:00.000Z',
      },
    ];
    const latest = latestSubstantiveComment(comments);
    expect(latest?.body).toBe('Notion closeout is still open. Who clicks?');
    expect(hasReceiptMarker(latest?.body ?? '')).toBe(false);
  });

  test('5. every automated marker is recognized', () => {
    const samples = [
      `${TASKMASTER_ESCALATION_MARKER}\nUnclaimed P0`,
      `${DUTY_OFFICER_NUDGE_MARKER}\nDuty Officer nudge: idle.`,
      `${SECURITY_DETECTOR_COMMENT_MARKER}\nverdict: clean`,
      `${DISPATCH_WORKER_ALARM_PREFIX}A:down -->\nold alarm`,
      '[DO nudge 2026-09-29] nothing shows a rotation attempted',
    ];
    for (const body of samples) expect(isAutomatedComment(body)).toBe(true);
    expect(isAutomatedComment('Please confirm the Notion click is still needed.')).toBe(false);
    expect(isAutomatedComment('<!-- security-detector-issue -->\nfiled')).toBe(false);
  });

  test('6. rules suppress both verbs on every tick', () => {
    const nowMs = Date.parse('2026-08-07T12:00:00.000Z');
    const laterMs = nowMs + 31 * 60_000;
    const staleAt = new Date(nowMs - 5 * 3_600_000).toISOString();
    const row = adoption();
    const escalateReceipt: ThreadSnapshot = {
      ref: 'gh:thinmansoftware/bdc-xo#1',
      priority: 'P0',
      lastActivityAt: staleAt,
      recipient: 'operator',
      isUnclaimed: true,
      isUnclaimedP0: true,
      hasReceipt: true,
    };
    const escalateControl: ThreadSnapshot = {
      ref: 'gh:thinmansoftware/bdc-xo#2',
      priority: 'P0',
      lastActivityAt: staleAt,
      recipient: 'operator',
      isUnclaimed: true,
      isUnclaimedP0: true,
      hasReceipt: false,
    };
    const nudgeReceipt: ThreadSnapshot = {
      ref: 'gh:thinmansoftware/bdc-xo#3',
      priority: 'P0',
      lastActivityAt: staleAt,
      recipient: 'xo',
      isUnclaimed: false,
      isUnclaimedP0: false,
      hasReceipt: true,
    };
    const nudgeControl: ThreadSnapshot = {
      ref: 'gh:thinmansoftware/bdc-xo#4',
      priority: 'P0',
      lastActivityAt: staleAt,
      recipient: 'xo',
      isUnclaimed: false,
      isUnclaimedP0: false,
      hasReceipt: false,
    };

    const escalateActions = [nowMs, laterMs].map(bucketMs =>
      computeNextAction(escalateReceipt, classifyThread(escalateReceipt, bucketMs), {
        interventionsLast24h: 0,
        nowMs: bucketMs,
        adoption: row,
      })
    );
    const escalateControls = [nowMs, laterMs].map(bucketMs =>
      computeNextAction(escalateControl, classifyThread(escalateControl, bucketMs), {
        interventionsLast24h: 0,
        nowMs: bucketMs,
        adoption: row,
      })
    );
    const nudgeActions = [nowMs, laterMs].map(bucketMs =>
      computeNextAction(nudgeReceipt, classifyThread(nudgeReceipt, bucketMs), {
        interventionsLast24h: 0,
        nowMs: bucketMs,
        adoption: row,
      })
    );
    const nudgeControls = [nowMs, laterMs].map(bucketMs =>
      computeNextAction(nudgeControl, classifyThread(nudgeControl, bucketMs), {
        interventionsLast24h: 0,
        nowMs: bucketMs,
        adoption: row,
      })
    );

    expect(escalateActions).toEqual([null, null]);
    expect(nudgeActions).toEqual([null, null]);
    expect(escalateControls.map(proposal => proposal?.type)).toEqual([
      'escalate_p0',
      'escalate_p0',
    ]);
    expect(nudgeControls.map(proposal => proposal?.type)).toEqual(['nudge', 'nudge']);
    expect(escalateControls[0]?.idempotencyKey).not.toBe(escalateControls[1]?.idempotencyKey);
    expect(nudgeControls[0]?.idempotencyKey).not.toBe(nudgeControls[1]?.idempotencyKey);
  });

  test('7. loop filter runs after confirmation and budgets, before the journal', async () => {
    const priorFire = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    const priorBlocker = process.env.TASKMASTER_BLOCKER_REPORT;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'false';
    process.env.TASKMASTER_BLOCKER_REPORT = 'false';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const refA = 'gh:thinmansoftware/bdc-xo#1997';
      const refB = 'gh:thinmansoftware/bdc-xo#1998';
      const refC = 'gh:thinmansoftware/bdc-xo#1999';
      const activityA = '2026-09-10T11:12:32.000Z';
      const activityB = '2026-09-11T11:12:32.000Z';
      const activityC = '2026-09-12T11:12:32.000Z';
      world.journal.push({
        id: 'journal-c-sent',
        created_at: new Date(world.nowMs).toISOString(),
        thread_ref: refC,
        action_type: 'escalate_p0',
        proposal_json: '{}',
        idempotency_key: `tm:escalate_p0:${refC}:seed`,
        before_hash: null,
        proof_predicate: null,
        proof_deadline_at: null,
        outcome: 'sent',
        graded_at: null,
        grade: null,
      });
      const calls: Array<{ ref: string; updatedAt: string }> = [];
      const posts: string[] = [];
      const listed = [
        {
          ref: refA,
          priority: 'P0' as const,
          lastActivityAt: activityA,
          recipient: 'xo',
          isUnclaimed: true,
          isUnclaimedP0: true,
          title: 'Receipt thread',
          ownerLogin: null,
          labels: ['wo', 'prio:P0'],
        },
        {
          ref: refB,
          priority: 'P0' as const,
          lastActivityAt: activityB,
          recipient: 'xo',
          isUnclaimed: true,
          isUnclaimedP0: true,
          title: 'Ordinary thread',
          ownerLogin: null,
          labels: ['wo', 'prio:P0'],
        },
        {
          ref: refC,
          priority: 'P0' as const,
          lastActivityAt: activityC,
          recipient: 'xo',
          isUnclaimed: true,
          isUnclaimedP0: true,
          title: 'Recently escalated thread',
          ownerLogin: null,
          labels: ['wo', 'prio:P0'],
        },
      ];
      const delivery: EscalationDeliveryDeps = {
        listIssueComments: async () => [],
        postIssueComment: async issue => {
          posts.push(`gh:${issue.owner}/${issue.repo}#${issue.number}`);
        },
        posterLogin: async () => 'taskmaster-bot',
        now: () => new Date(world.nowMs),
      };
      const deps = makeDeps(world, {
        listThreads: async () => listed,
        escalationDelivery: delivery,
        readIssueComments: async (threadRef, updatedAt): Promise<ReceiptCheckOutcome> => {
          calls.push({ ref: threadRef, updatedAt });
          if (threadRef === refA) {
            return { failOpen: false, comments: frozen1997Comments() };
          }
          return {
            failOpen: false,
            comments: [
              {
                body: 'Still waiting on a human answer.',
                created_at: '2026-09-29T08:00:00.000Z',
              },
            ],
          };
        },
      });
      const state = createTaskmasterState(60_000);
      state.pendingConfirm.set(`tm:nudge:${refA}:1`, { tickIndex: 0, epoch: 0 });
      state.pendingConfirm.set(`tm:escalate_p0:${refA}:9`, { tickIndex: 0, epoch: 0 });
      state.pendingConfirm.set(`tm:nudge:${refB}:1`, { tickIndex: 0, epoch: 0 });

      await tick(state, deps);

      expect(calls).toEqual([
        { ref: refA, updatedAt: activityA },
        { ref: refB, updatedAt: activityB },
      ]);
      expect(world.journal.filter(row => row.thread_ref === refA)).toHaveLength(0);
      expect(posts).toEqual([refB]);
      const delivered = world.journal.filter(
        row => row.thread_ref === refB && row.action_type === 'escalate_p0'
      );
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.outcome).toBe('sent');
      expect(world.journal.filter(row => row.thread_ref === refC)).toHaveLength(1);
      const pending = [...state.pendingConfirm.keys()];
      expect(pending.some(key => key.startsWith(`tm:nudge:${refA}:`))).toBe(false);
      expect(pending.some(key => key.startsWith(`tm:escalate_p0:${refA}:`))).toBe(false);
      expect(pending.some(key => key.startsWith(`tm:nudge:${refB}:`))).toBe(true);
    } finally {
      restoreEnv('TASKMASTER_FIRE_VERB_ENABLED', priorFire);
      restoreEnv('TASKMASTER_BLOCKER_REPORT', priorBlocker);
    }
  });

  test('8. comment read failure fails open', async () => {
    const priorFire = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    const priorBlocker = process.env.TASKMASTER_BLOCKER_REPORT;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'false';
    process.env.TASKMASTER_BLOCKER_REPORT = 'false';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const ref = 'gh:thinmansoftware/bdc-xo#42';
      let calls = 0;
      const deps = makeDeps(world, {
        listThreads: async () => [
          {
            ref,
            priority: 'P1' as const,
            lastActivityAt: new Date(T0 - 5 * 3_600_000).toISOString(),
            recipient: 'xo',
            isUnclaimed: false,
            isUnclaimedP0: false,
            title: 'Stale claimed item',
            ownerLogin: 'major-build',
            labels: ['wo', 'prio:P1'],
          },
        ],
        getGithubIssueEvidence: async () => progressEvidence(),
        readIssueComments: async () => {
          calls += 1;
          throw new Error('comment read failed');
        },
      });
      const state = createTaskmasterState(60_000);
      const logs = await capturePino(async () => {
        await tick(state, deps);
        world.nowMs += 60_000;
        await tick(state, deps);
      });

      expect(calls).toBe(1);
      const nudges = world.journal.filter(
        row => row.thread_ref === ref && row.action_type === 'nudge'
      );
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.outcome).toBe('sent');
      expect(
        world.sentMessages.filter(message => message.idempotency_key.startsWith('tm:nudge:'))
      ).toHaveLength(1);
      expect(logs).toContain('taskmaster.receipt_check_failed');
    } finally {
      restoreEnv('TASKMASTER_FIRE_VERB_ENABLED', priorFire);
      restoreEnv('TASKMASTER_BLOCKER_REPORT', priorBlocker);
    }
  });

  test('9. pagination, cache, and request budget', async () => {
    const state = createReceiptCheckState();
    const updatedAt = '2026-09-29T12:00:00.000Z';
    const refA = 'gh:thinmansoftware/bdc-xo#1';
    let commentRequests = 0;
    const rateHeaders = {
      'content-type': 'application/json',
      'x-ratelimit-remaining': '4000',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-resource': 'core',
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'ghs_test',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200, headers: rateHeaders }
        );
      }
      commentRequests += 1;
      const parsed = new URL(url);
      expect(parsed.searchParams.get('per_page')).toBe('100');
      const issueNumber = Number(parsed.pathname.split('/')[5]);
      const page = Number(parsed.searchParams.get('page'));
      if (issueNumber === 1) {
        const start = (page - 1) * 100;
        const count = page === 3 ? 30 : 100;
        const rows = Array.from({ length: count }, (_, offset) => {
          const index = start + offset;
          const isReceipt = index === 229;
          return {
            body: isReceipt ? RECEIPT_LINE : `${DUTY_OFFICER_NUDGE_MARKER}\nidle ${index}`,
            created_at: new Date(
              Date.parse('2026-01-01T00:00:00.000Z') + index * 60_000
            ).toISOString(),
          };
        });
        return new Response(JSON.stringify(rows), { status: 200, headers: rateHeaders });
      }
      return new Response(
        JSON.stringify([
          { body: `ordinary ${issueNumber}`, created_at: '2026-09-01T00:00:00.000Z' },
        ]),
        { status: 200, headers: rateHeaders }
      );
    }) as typeof fetch;

    const logs = await capturePino(async () => {
      const first = await readLatestSubstantiveComment(refA, updatedAt, state, fetchImpl);
      const afterFirst = commentRequests;
      const second = await readLatestSubstantiveComment(refA, updatedAt, state, fetchImpl);
      expect(commentRequests).toBe(afterFirst);
      expect(second).toBe(first);
      expect(first.failOpen).toBe(false);
      if (!first.failOpen) {
        expect(first.comments).toHaveLength(230);
        const latest = latestSubstantiveComment(first.comments);
        expect(latest?.body).toBe(RECEIPT_LINE);
        expect(hasReceiptMarker(latest?.body ?? '')).toBe(true);
      }

      const outcomes: ReceiptCheckOutcome[] = [];
      for (let issue = 2; issue <= 12; issue += 1) {
        outcomes.push(
          await readLatestSubstantiveComment(
            `gh:thinmansoftware/bdc-xo#${issue}`,
            updatedAt,
            state,
            fetchImpl
          )
        );
      }
      expect(commentRequests).toBe(10);
      expect(outcomes.slice(0, 7).every(outcome => outcome.failOpen === false)).toBe(true);
      expect(outcomes.slice(7)).toEqual([
        { failOpen: true, reason: 'budget' },
        { failOpen: true, reason: 'budget' },
        { failOpen: true, reason: 'budget' },
        { failOpen: true, reason: 'budget' },
      ]);
    });
    const logged = logs.split('taskmaster.receipt_check_budget_exhausted').length - 1;
    expect(logged).toBe(4);
  });

  test('10. owner label suppresses only the unclaimed-P0 escalation', async () => {
    const priorFire = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    const priorBlocker = process.env.TASKMASTER_BLOCKER_REPORT;
    const priorRepos = process.env.TASKMASTER_GH_REPOS;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    process.env.TASKMASTER_BLOCKER_REPORT = 'false';
    process.env.TASKMASTER_GH_REPOS = 'thinmansoftware/bdc-xo';
    try {
      const issues = [
        {
          number: 1997,
          title: 'Cursor owned P0',
          updated_at: '2026-09-29T12:00:00.000Z',
          labels: [{ name: 'wo' }, { name: 'prio:P0' }, { name: 'owner:cursor' }],
          assignees: [],
        },
        {
          number: 1998,
          title: 'Malformed owner P0',
          updated_at: '2026-09-29T12:00:00.000Z',
          labels: [{ name: 'wo' }, { name: 'prio:P0' }, { name: 'owner:bad login!' }],
          assignees: [],
        },
        {
          number: 1999,
          title: 'No owner P0',
          updated_at: '2026-09-29T12:00:00.000Z',
          labels: [{ name: 'wo' }, { name: 'prio:P0' }],
          assignees: [],
        },
      ];
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        const label = new URL(url).searchParams.get('labels') ?? '';
        const body = label === 'wo' ? issues : [];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-remaining': '100',
          },
        });
      }) as typeof fetch;

      const threads = await defaultListThreads(fetchImpl);
      const owner = threads.find(thread => thread.labels?.includes('owner:cursor'));
      const malformed = threads.find(thread => thread.labels?.includes('owner:bad login!'));
      const plain = threads.find(
        thread => !thread.labels?.some(label => label.startsWith('owner:'))
      );
      expect(owner).toBeDefined();
      expect(malformed).toBeDefined();
      expect(plain).toBeDefined();
      if (!owner || !malformed || !plain) return;

      expect(owner.isUnclaimed).toBe(true);
      expect(owner.isUnclaimedP0).toBe(true);
      expect(owner.hasOwnerLabel).toBe(true);
      expect(malformed.hasOwnerLabel).toBe(false);
      expect(plain.hasOwnerLabel).toBe(false);
      expect((owner.isUnclaimed ?? owner.isUnclaimedP0) && !owner.isBlocked && !owner.isHeld).toBe(
        true
      );

      const nowMs = Date.parse('2026-09-29T12:00:00.000Z');
      const context = { interventionsLast24h: 0, nowMs };
      expect(computeNextAction(owner, classifyThread(owner, nowMs), context)).toBeNull();
      expect(computeNextAction(malformed, classifyThread(malformed, nowMs), context)?.type).toBe(
        'escalate_p0'
      );
      expect(computeNextAction(plain, classifyThread(plain, nowMs), context)?.type).toBe(
        'escalate_p0'
      );

      const checked: string[] = [];
      const world = makeWorld();
      seedDigestSent(world);
      const delivery: EscalationDeliveryDeps = {
        listIssueComments: async () => [],
        postIssueComment: async () => undefined,
        posterLogin: async () => 'taskmaster-bot',
        now: () => new Date(world.nowMs),
      };
      const deps = makeDeps(world, {
        listThreads: async () => threads,
        escalationDelivery: delivery,
        readIssueComments: async (): Promise<ReceiptCheckOutcome> => ({
          failOpen: false,
          comments: [],
        }),
        checkFireEligibility: async (title: string) => {
          checked.push(title);
          return { eligible: false };
        },
      });
      await tick(createTaskmasterState(60_000), deps);
      expect(checked).toContain('Cursor owned P0');
      expect(checked).toContain('Malformed owner P0');
      expect(checked).toContain('No owner P0');
    } finally {
      restoreEnv('TASKMASTER_FIRE_VERB_ENABLED', priorFire);
      restoreEnv('TASKMASTER_BLOCKER_REPORT', priorBlocker);
      restoreEnv('TASKMASTER_GH_REPOS', priorRepos);
    }
  });
});
