/**
 * Taskmaster Slice 1 loop (WO-HARNESS-TASKMASTER-SLICE1-01, M-133 CARRIED 3-0).
 *
 * Always-on deterministic loop that moves stalled work forward by sending
 * messages: delivering undelivered ratified rulings, nudging idle threads,
 * and escalating unclaimed P0s. All sends go through the dispatch DAL
 * (createMessage) -- there is no second messaging path.
 *
 * Tick order (spec Section 8): pause state + epoch -> headroom -> reads ->
 * classify -> propose -> two-tick confirm -> guard -> journal ROW FIRST ->
 * epoch re-check -> createMessage -> journal outcome + proof deadline.
 *
 * Budgets (ratified Q1): max 10 effects/tick, 1 effect/item/tick, max 3
 * automated interventions per item per 24h.
 */
import { createHash } from 'crypto';
import { createLogger } from '@archon/paths';
import { getDatabase } from '@archon/core';
import {
  createMessage,
  getMessage,
  listMessages,
  type DispatchMessage,
} from '@archon/core/db/dispatch';
import * as taskmasterDb from '@archon/core/db/taskmaster';
import {
  classifyThread,
  computeNextAction,
  type ActionProposal,
  type ThreadSnapshot,
  type ThreadPriority,
} from './rules';
import { validateProposal } from './guard';
import { currentHeadroom, type HeadroomReading } from './ledger';
import {
  createDeadmanState,
  recordTickAttempt,
  recordTickHeartbeat,
  tickHealth,
  type DeadmanState,
  type TickHealth,
} from './deadman';

const log = createLogger('taskmaster/loop');

/** Ratified Q1 budgets. */
export const MAX_EFFECTS_PER_TICK = 10;

/** Journal lookback used for dedupe and per-item budgets. */
const JOURNAL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PROOF_DEADLINE_MS = 24 * 60 * 60 * 1000;

export interface TaskmasterState {
  deadman: DeadmanState;
  tickIndex: number;
  /** Two-tick confirmation ledger: proposal key -> {tickIndex, epoch}. */
  pendingConfirm: Map<string, { tickIndex: number; epoch: number }>;
  /** Restart reconciliation runs once per process. */
  reconciled: boolean;
}

export function createTaskmasterState(intervalMs: number): TaskmasterState {
  return {
    deadman: createDeadmanState(intervalMs),
    tickIndex: 0,
    pendingConfirm: new Map(),
    reconciled: false,
  };
}

type TaskmasterDal = Pick<
  typeof taskmasterDb,
  | 'recordAction'
  | 'updateActionOutcome'
  | 'getActionsSince'
  | 'getPauseState'
  | 'setPauseState'
  | 'expireParkedActions'
  | 'gradeAction'
  | 'getActionByIdempotencyKey'
>;

export interface GithubIssueEvidence {
  state: 'open' | 'closed';
  updatedAt: string;
  labels: string[];
  assigneeCount: number;
  closedAt: string | null;
  assignedAt: string | null;
  activeStatusAt: string | null;
  progressRecordedAt: string | null;
}

export interface TaskmasterDeps {
  now?: () => Date;
  db?: TaskmasterDal;
  createTask?: typeof createMessage;
  listUndeliveredRulings?: () => Promise<ThreadSnapshot[]>;
  listThreads?: () => Promise<ThreadSnapshot[]>;
  headroom?: () => Promise<HeadroomReading>;
  /** External-SOR check: does a dispatch row exist for this key? */
  findEffectByIdempotencyKey?: (key: string) => Promise<{ id: string; status: string } | null>;
  getDispatchMessageById?: (id: string) => Promise<DispatchMessage | null>;
  getGithubIssueEvidence?: (
    threadRef: string,
    sinceIso: string
  ) => Promise<GithubIssueEvidence | null>;
}

export interface TickResult {
  ran: boolean;
  successful: boolean;
  pauseState: taskmasterDb.TmPauseState;
  epoch: number;
  headroomState: HeadroomReading['state'];
  proposals: number;
  effects: number;
  parked: number;
  deferred: number;
  rejected: number;
  expired: number;
  failed: number;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function defaultFindEffectByIdempotencyKey(
  key: string
): Promise<{ id: string; status: string } | null> {
  const result = await getDatabase().query<{ id: string; status: string }>(
    'SELECT id, status FROM agent_dispatch_messages WHERE idempotency_key = $1',
    [key]
  );
  return result.rows[0] ?? null;
}

/** Undelivered ratified rulings: queued board-motion mailbox rows not yet acknowledged. */
async function defaultListUndeliveredRulings(): Promise<ThreadSnapshot[]> {
  const queued: DispatchMessage[] = await listMessages({ status: 'queued', limit: 200 });
  return queued
    .filter(m => m.task_type === 'board_motion' && m.acknowledged_at === null)
    .map(m => ({
      ref: `dispatch:${m.id}`,
      priority: 'P1' as ThreadPriority,
      lastActivityAt: m.created_at,
      undeliveredRulingId: m.id,
      recipient: m.resolved_recipient ?? m.recipient,
    }));
}

function priorityFromLabels(labels: string[]): ThreadPriority {
  for (const p of ['P0', 'P1', 'P2', 'P3'] as const) {
    if (
      labels.some(label => {
        const match = /^(?:prio:|priority:)?p([0-3])$/i.exec(label.trim());
        return match?.[1] === p.slice(1);
      })
    )
      return p;
  }
  return 'P2';
}

interface GithubIssue {
  number: number;
  updated_at: string;
  labels: ({ name?: string } | string)[];
  assignees?: { login?: string }[];
  pull_request?: unknown;
}

/**
 * Both work labels the spec names (Section 8: "gh issues (label wo/arc)").
 * The GitHub issues API treats `labels=a,b` as AND (issues carrying BOTH
 * labels), so each label is queried separately and results are deduped by
 * issue number -- OR semantics, never requiring both simultaneously.
 */
const WORK_LABELS = ['wo', 'project', 'arc'] as const;

/**
 * Work-SOR read: open GitHub issues labeled wo, project, or arc across the configured
 * repos (one request per label -- see WORK_LABELS). Rate-limit-aware (Claude
 * seat amendment): honors x-ratelimit-remaining and backs off rather than
 * spinning. A failed read yields an empty list (no nudges this tick) --
 * never a crash. Exported for tests; production callers use the tick()
 * default. `fetchImpl` is injectable for tests only.
 */
export async function defaultListThreads(
  fetchImpl: typeof fetch = fetch
): Promise<ThreadSnapshot[]> {
  const repos = (process.env.TASKMASTER_GH_REPOS ?? 'bluedevilcollectibles/bdc-xo')
    .split(',')
    .map(r => r.trim())
    .filter(Boolean);
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const threads: ThreadSnapshot[] = [];
  let rateLimited = false;

  for (const repo of repos) {
    if (rateLimited) break; // back off: stop reading further repos this tick
    const seen = new Set<number>();
    for (const label of WORK_LABELS) {
      try {
        const response = await fetchImpl(
          `https://api.github.com/repos/${repo}/issues?state=open&labels=${label}&per_page=100`,
          {
            headers: {
              accept: 'application/vnd.github+json',
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
          }
        );
        const remaining = Number.parseInt(response.headers.get('x-ratelimit-remaining') ?? '', 10);
        if (Number.isInteger(remaining) && remaining < 5) {
          log.warn({ repo, label, remaining }, 'taskmaster.github_rate_limit_backoff');
          rateLimited = true;
          break; // stop reading further labels and repos this tick
        }
        if (!response.ok) {
          log.warn({ repo, label, status: response.status }, 'taskmaster.github_read_failed');
          continue;
        }
        const issues = (await response.json()) as GithubIssue[];
        for (const issue of issues) {
          if (issue.pull_request) continue;
          if (seen.has(issue.number)) continue; // carried both labels
          seen.add(issue.number);
          const labels = issue.labels.map(l => (typeof l === 'string' ? l : (l.name ?? '')));
          const priority = priorityFromLabels(labels);
          const normalizedLabels = labels.map(label => label.trim().toLowerCase());
          const hasClaimStatus = normalizedLabels.some(label =>
            ['status:building', 'status:review'].includes(label)
          );
          threads.push({
            ref: `gh:${repo}#${issue.number}`,
            priority,
            isCustomerFacing: labels.some(l => l.toLowerCase() === 'customer'),
            lastActivityAt: issue.updated_at,
            isBlocked: normalizedLabels.some(label =>
              ['blocked', 'status:blocked'].includes(label)
            ),
            isUnclaimedP0:
              priority === 'P0' && (issue.assignees ?? []).length === 0 && !hasClaimStatus,
            recipient: 'xo',
          });
        }
      } catch (error) {
        log.warn({ err: error as Error, repo, label }, 'taskmaster.github_read_error');
      }
    }
  }
  return threads;
}

interface GithubIssueDetail extends GithubIssue {
  state: 'open' | 'closed';
  closed_at?: string | null;
}

interface GithubIssueComment {
  created_at: string;
  body?: string | null;
  user?: { login?: string; type?: string } | null;
}

interface GithubIssueEvent {
  event?: string;
  created_at: string;
  label?: { name?: string } | null;
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function defaultGetGithubIssueEvidence(
  threadRef: string,
  sinceIso: string
): Promise<GithubIssueEvidence | null> {
  const match = /^gh:([^#]+)#(\d+)$/.exec(threadRef);
  if (!match) return null;
  const repo = match[1];
  const issueNumber = match[2];
  const issueResponse = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
    headers: githubHeaders(),
  });
  if (!issueResponse.ok) return null;
  const issue = (await issueResponse.json()) as GithubIssueDetail;
  const [commentsResponse, eventsResponse] = await Promise.all([
    fetch(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments?since=${encodeURIComponent(sinceIso)}&per_page=100`,
      { headers: githubHeaders() }
    ),
    fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/events?per_page=100`, {
      headers: githubHeaders(),
    }),
  ]);
  const comments = commentsResponse.ok
    ? ((await commentsResponse.json()) as GithubIssueComment[])
    : [];
  const events = eventsResponse.ok ? ((await eventsResponse.json()) as GithubIssueEvent[]) : [];
  const progress = comments
    .filter(comment => {
      const login = comment.user?.login?.toLowerCase() ?? '';
      const isBot =
        comment.user?.type === 'Bot' || login.endsWith('[bot]') || login === 'taskmaster';
      return (
        !isBot &&
        /^\s*\[(?:PROGRESS|BLOCKED)\]\s+\S/i.test(comment.body ?? '') &&
        Date.parse(comment.created_at) >= Date.parse(sinceIso)
      );
    })
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  const postSendEvents = events.filter(
    event => Date.parse(event.created_at) >= Date.parse(sinceIso)
  );
  const latestEventAt = (predicate: (event: GithubIssueEvent) => boolean): string | null =>
    postSendEvents
      .filter(predicate)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]?.created_at ?? null;
  return {
    state: issue.state,
    updatedAt: issue.updated_at,
    labels: issue.labels.map(label => (typeof label === 'string' ? label : (label.name ?? ''))),
    assigneeCount: issue.assignees?.length ?? 0,
    closedAt: latestEventAt(event => event.event === 'closed'),
    assignedAt: latestEventAt(event => event.event === 'assigned'),
    activeStatusAt: latestEventAt(
      event =>
        event.event === 'labeled' &&
        ['status:building', 'status:review'].includes(event.label?.name?.trim().toLowerCase() ?? '')
    ),
    progressRecordedAt: progress?.created_at ?? null,
  };
}

function digestProposal(actions24h: taskmasterDb.TmJournalEntry[], nowMs: number): ActionProposal {
  const dateKey = new Date(nowMs).toISOString().slice(0, 10);
  const counts: Record<string, number> = {};
  for (const action of actions24h) {
    counts[`${action.action_type}:${action.outcome}`] =
      (counts[`${action.action_type}:${action.outcome}`] ?? 0) + 1;
  }
  const summary =
    Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ') || 'no actions in the last 24h';
  return {
    type: 'digest',
    threadRef: `digest:${dateKey}`,
    recipient: 'operator',
    body:
      `Taskmaster daily digest for ${dateKey}: ${summary}. ` +
      'Pause/resume/status runbook: xo-wiki/wiki/tools/taskmaster/_index.md.',
    idempotencyKey: `tm:digest:${dateKey}`,
    actsImmediately: true,
  };
}

/**
 * Restart reconciliation (Section 11 test 4): a journal row left 'pending'
 * (in-flight marker) is resolved against the external SOR. If the dispatch
 * row exists, the effect happened -- mark 'sent' WITHOUT a second
 * createMessage. If it does not, expire the row so a future tick may
 * re-propose fresh. No key is ever re-sent from reconciliation.
 */
async function reconcilePendingActions(
  dal: TaskmasterDal,
  findEffect: NonNullable<TaskmasterDeps['findEffectByIdempotencyKey']>,
  nowMs: number
): Promise<void> {
  const since = new Date(nowMs - JOURNAL_LOOKBACK_MS).toISOString();
  const actions = await dal.getActionsSince(since);
  for (const action of actions) {
    if (action.outcome !== 'pending' || !action.idempotency_key) continue;
    const effect = await findEffect(action.idempotency_key);
    if (effect) {
      await dal.updateActionOutcome(action.id, 'sent');
      log.info(
        { journalId: action.id, idempotencyKey: action.idempotency_key },
        'taskmaster.reconcile_pending_marked_sent'
      );
    } else {
      await dal.updateActionOutcome(action.id, 'expired');
      log.info(
        { journalId: action.id, idempotencyKey: action.idempotency_key },
        'taskmaster.reconcile_pending_expired'
      );
    }
  }
}

/**
 * Grade sent actions against the external SOR: a sent action whose dispatch
 * row exists (and was not cancelled) is graded 'useful'. Grading is a read
 * of the SOR, not a self-report.
 */
async function gradeSentActions(
  actions: taskmasterDb.TmJournalEntry[],
  dal: TaskmasterDal,
  findEffect: NonNullable<TaskmasterDeps['findEffectByIdempotencyKey']>,
  getDispatchById: NonNullable<TaskmasterDeps['getDispatchMessageById']>,
  getIssueEvidence: NonNullable<TaskmasterDeps['getGithubIssueEvidence']>,
  nowMs: number
): Promise<number> {
  let failures = 0;
  for (const action of actions) {
    if (action.outcome !== 'sent' || action.grade !== null || !action.idempotency_key) continue;
    try {
      const effect = await findEffect(action.idempotency_key);
      if (!effect) continue;
      if (effect.status === 'cancelled') {
        await dal.gradeAction(action.id, 'noise');
        continue;
      }
      if (action.action_type === 'digest') continue;

      const createdAtMs = Date.parse(action.created_at);
      const deadlineMs = action.proof_deadline_at ? Date.parse(action.proof_deadline_at) : NaN;
      let usefulAtMs: number | null = null;
      if (action.action_type === 'deliver_ruling') {
        const rulingId = action.thread_ref.startsWith('dispatch:')
          ? action.thread_ref.slice('dispatch:'.length)
          : '';
        const ruling = rulingId ? await getDispatchById(rulingId) : null;
        const addressedAtMs = ruling?.addressed_at ? Date.parse(ruling.addressed_at) : NaN;
        const expectedRecipient = ruling?.resolved_recipient ?? ruling?.recipient;
        if (
          ruling &&
          ruling.addressed_by === expectedRecipient &&
          Number.isFinite(addressedAtMs) &&
          addressedAtMs >= createdAtMs
        ) {
          usefulAtMs = addressedAtMs;
        }
      } else {
        const issue = await getIssueEvidence(action.thread_ref, action.created_at);
        if (issue) {
          const closedAtMs = issue.closedAt ? Date.parse(issue.closedAt) : NaN;
          const assignedAtMs = issue.assignedAt ? Date.parse(issue.assignedAt) : NaN;
          const activeStatusAtMs = issue.activeStatusAt ? Date.parse(issue.activeStatusAt) : NaN;
          const progressAtMs = issue.progressRecordedAt
            ? Date.parse(issue.progressRecordedAt)
            : NaN;
          if (Number.isFinite(closedAtMs) && closedAtMs >= createdAtMs) usefulAtMs = closedAtMs;
          if (Number.isFinite(progressAtMs) && progressAtMs >= createdAtMs) {
            usefulAtMs = progressAtMs;
          }
          if (action.action_type === 'escalate_p0') {
            if (Number.isFinite(assignedAtMs) && assignedAtMs >= createdAtMs) {
              usefulAtMs = assignedAtMs;
            }
            if (Number.isFinite(activeStatusAtMs) && activeStatusAtMs >= createdAtMs) {
              usefulAtMs = activeStatusAtMs;
            }
          }
        }
      }

      if (usefulAtMs !== null && (!Number.isFinite(deadlineMs) || usefulAtMs <= deadlineMs)) {
        await dal.gradeAction(action.id, 'useful');
      } else if (Number.isFinite(deadlineMs) && nowMs >= deadlineMs) {
        await dal.gradeAction(action.id, 'noise');
      }
    } catch (error) {
      failures += 1;
      log.warn({ err: error as Error, journalId: action.id }, 'taskmaster.grade_failed');
    }
  }
  return failures;
}

function proofPredicate(proposal: ActionProposal): string {
  if (proposal.type === 'deliver_ruling') {
    return 'original ruling row is addressed by its resolved recipient after this journal row';
  }
  if (proposal.type === 'nudge') {
    return 'source issue closes or records a post-send [PROGRESS] or [BLOCKED] comment by a non-bot';
  }
  if (proposal.type === 'escalate_p0') {
    return 'source issue closes, gains an assignee or active status, or records post-send progress';
  }
  return 'digest delivery only; never qualifies as an SC7 useful action';
}

export async function tick(state: TaskmasterState, deps: TaskmasterDeps = {}): Promise<TickResult> {
  const now = deps.now ?? ((): Date => new Date());
  const dal = deps.db ?? taskmasterDb;
  const createTask = deps.createTask ?? createMessage;
  const findEffect = deps.findEffectByIdempotencyKey ?? defaultFindEffectByIdempotencyKey;
  const getDispatchById = deps.getDispatchMessageById ?? getMessage;
  const getIssueEvidence = deps.getGithubIssueEvidence ?? defaultGetGithubIssueEvidence;
  const nowMs = now().getTime();

  state.tickIndex += 1;
  recordTickAttempt(state.deadman, nowMs);
  let tickFailures = 0;

  // 1. Pause state + epoch captured.
  let control = await dal.getPauseState();
  const epoch = control.epoch;

  // Drop confirmations from a previous epoch: resume expires stale
  // proposals rather than replaying them.
  for (const [key, entry] of state.pendingConfirm) {
    if (entry.epoch !== epoch) state.pendingConfirm.delete(key);
  }

  // 2. Headroom -- own ledger reading; failure is UNKNOWN, never capacity.
  //    Slice 1 verbs are all dispatch messages (no model spend), so headroom
  //    is recorded and surfaced, not used to suppress messaging.
  let headroom: HeadroomReading;
  try {
    headroom = await (deps.headroom ?? ((): Promise<HeadroomReading> => currentHeadroom()))();
  } catch (error) {
    log.warn({ err: error as Error }, 'taskmaster.headroom_read_failed');
    headroom = {
      state: 'UNKNOWN',
      tokensRemaining: null,
      isUnknown: true,
      source: 'none',
      observedAt: new Date(nowMs).toISOString(),
    };
  }

  // 3. Restart reconciliation (once per process, before any new effect).
  if (!state.reconciled) {
    state.reconciled = true;
    try {
      await reconcilePendingActions(dal, findEffect, nowMs);
    } catch (error) {
      tickFailures += 1;
      log.warn({ err: error as Error }, 'taskmaster.reconcile_failed');
    }
  }

  // 4. Journal lookback: dedupe set + per-item 24h intervention counts.
  const lookback = await dal.getActionsSince(new Date(nowMs - JOURNAL_LOOKBACK_MS).toISOString());
  const actionsByKey = new Map<string, taskmasterDb.TmJournalEntry>();
  const interventions24hByThread = new Map<string, number>();
  const since24h = nowMs - DAY_MS;
  for (const action of lookback) {
    if (action.idempotency_key && !actionsByKey.has(action.idempotency_key))
      actionsByKey.set(action.idempotency_key, action);
    if (action.outcome === 'sent' && Date.parse(action.created_at) >= since24h) {
      interventions24hByThread.set(
        action.thread_ref,
        (interventions24hByThread.get(action.thread_ref) ?? 0) + 1
      );
    }
  }
  const actions24h = lookback.filter(a => Date.parse(a.created_at) >= since24h);

  // Grade previously sent actions against the external SOR.
  tickFailures += await gradeSentActions(
    actions24h,
    dal,
    findEffect,
    getDispatchById,
    getIssueEvidence,
    nowMs
  );

  // 5. Reads -> classify -> propose.
  const result: TickResult = {
    ran: true,
    successful: true,
    pauseState: control.pause_state,
    epoch,
    headroomState: headroom.state,
    proposals: 0,
    effects: 0,
    parked: 0,
    deferred: 0,
    rejected: 0,
    expired: 0,
    failed: 0,
  };

  let rulings: ThreadSnapshot[] = [];
  let threads: ThreadSnapshot[] = [];
  try {
    rulings = await (deps.listUndeliveredRulings ?? defaultListUndeliveredRulings)();
  } catch (error) {
    tickFailures += 1;
    log.warn({ err: error as Error }, 'taskmaster.rulings_read_failed');
  }
  try {
    threads = await (deps.listThreads ?? defaultListThreads)();
  } catch (error) {
    tickFailures += 1;
    log.warn({ err: error as Error }, 'taskmaster.threads_read_failed');
  }

  const proposals: ActionProposal[] = [];
  for (const item of [...rulings, ...threads]) {
    const classification = classifyThread(item, nowMs);
    const proposal = computeNextAction(item, classification, {
      interventionsLast24h: interventions24hByThread.get(item.ref) ?? 0,
      nowMs,
    });
    if (proposal) proposals.push(proposal);
  }

  // Daily digest: one summary message per UTC day through the same path.
  const digest = digestProposal(actions24h, nowMs);
  proposals.push(digest);

  // Exceptions first so the per-tick budget can never starve them.
  proposals.sort((a, b) => Number(b.actsImmediately) - Number(a.actsImmediately));
  result.proposals = proposals.length;

  const touchedThisTick = new Set<string>();

  for (const proposal of proposals) {
    let existingAction =
      actionsByKey.get(proposal.idempotencyKey) ??
      (await dal.getActionByIdempotencyKey(proposal.idempotencyKey));
    if (existingAction) actionsByKey.set(proposal.idempotencyKey, existingAction);

    if (
      existingAction &&
      ['sent', 'pending', 'rejected', 'expired', 'parked'].includes(existingAction.outcome)
    ) {
      continue;
    }
    if (existingAction?.outcome === 'failed') {
      const deadlineMs = existingAction.proof_deadline_at
        ? Date.parse(existingAction.proof_deadline_at)
        : NaN;
      if (!Number.isFinite(deadlineMs) || nowMs >= deadlineMs) {
        await dal.updateActionOutcome(existingAction.id, 'expired');
        existingAction.outcome = 'expired';
        result.expired += 1;
        continue;
      }
    }
    const retrying = existingAction?.outcome === 'failed' || existingAction?.outcome === 'deferred';

    // Two-consecutive-tick confirmation for ordinary nudges. Exceptions
    // (rulings, unclaimed P0s, digest) act on the confirming tick.
    if (!proposal.actsImmediately && !retrying) {
      const pending = state.pendingConfirm.get(proposal.idempotencyKey);
      if (pending?.tickIndex !== state.tickIndex - 1) {
        state.pendingConfirm.set(proposal.idempotencyKey, {
          tickIndex: state.tickIndex,
          epoch,
        });
        continue;
      }
      state.pendingConfirm.delete(proposal.idempotencyKey);
    }

    // Guard: allowlist + content guard. Reject = journal only; a forbidden
    // effect additionally HARD-PAUSES effects (tighten, never KILL).
    const guardResult = validateProposal(proposal);
    if (!guardResult.allowed) {
      result.rejected += 1;
      await dal.recordAction({
        thread_ref: proposal.threadRef,
        action_type: proposal.type,
        proposal_json: JSON.stringify({ ...proposal, guardReason: guardResult.reason }),
        idempotency_key: proposal.idempotencyKey,
        before_hash: sha256(proposal.body),
        outcome: 'rejected',
      });
      if (guardResult.forbiddenEffect && control.pause_state === 'RUNNING') {
        control = await dal.setPauseState({
          pause_state: 'HARD_PAUSE',
          pause_scope: 'effects',
          pause_reason: `auto-circuit: ${guardResult.reason ?? 'forbidden effect'}`,
          pause_actor: 'taskmaster:auto-circuit',
        });
        result.pauseState = control.pause_state;
      }
      continue;
    }

    // Mode matrix: PAUSED/HARD_PAUSE stop sends but never watching --
    // P0 escalation and the digest stay alive.
    const pauseExempt = proposal.type === 'escalate_p0' || proposal.type === 'digest';
    if (control.pause_state !== 'RUNNING' && !pauseExempt) {
      result.parked += 1;
      await dal.recordAction({
        thread_ref: proposal.threadRef,
        action_type: proposal.type,
        proposal_json: JSON.stringify({ ...proposal, parked: true }),
        idempotency_key: proposal.idempotencyKey,
        before_hash: sha256(proposal.body),
        outcome: 'parked',
      });
      continue;
    }

    // Budgets: max 10 effects/tick, 1 effect/item/tick. Overflow is
    // journaled as deferred, not dropped.
    if (result.effects >= MAX_EFFECTS_PER_TICK || touchedThisTick.has(proposal.threadRef)) {
      result.deferred += 1;
      if (!existingAction) {
        existingAction = await dal.recordAction({
          thread_ref: proposal.threadRef,
          action_type: proposal.type,
          proposal_json: JSON.stringify({ ...proposal, deferred: true }),
          idempotency_key: proposal.idempotencyKey,
          before_hash: sha256(proposal.body),
          proof_predicate: proofPredicate(proposal),
          proof_deadline_at: new Date(nowMs + PROOF_DEADLINE_MS).toISOString(),
          outcome: 'deferred',
        });
        actionsByKey.set(proposal.idempotencyKey, existingAction);
      }
      continue;
    }

    // ROW FIRST, always -- then the effect.
    let journalRow: taskmasterDb.TmJournalEntry;
    if (existingAction && retrying) {
      const reused = await dal.updateActionOutcome(existingAction.id, 'pending');
      if (!reused) throw new Error(`taskmaster_retry_row_missing:${existingAction.id}`);
      journalRow = reused;
    } else {
      journalRow = await dal.recordAction({
        thread_ref: proposal.threadRef,
        action_type: proposal.type,
        proposal_json: JSON.stringify(proposal),
        idempotency_key: proposal.idempotencyKey,
        before_hash: sha256(proposal.body),
        proof_predicate: proofPredicate(proposal),
        proof_deadline_at: new Date(nowMs + PROOF_DEADLINE_MS).toISOString(),
        outcome: 'pending',
      });
    }
    actionsByKey.set(proposal.idempotencyKey, journalRow);

    // Re-check pause epoch immediately before the effect.
    const fresh = await dal.getPauseState();
    if (fresh.epoch !== epoch || (fresh.pause_state !== 'RUNNING' && !pauseExempt)) {
      result.expired += 1;
      await dal.updateActionOutcome(journalRow.id, 'expired');
      continue;
    }

    try {
      await createTask({
        correlation_id: `tm-${journalRow.id}`,
        idempotency_key: proposal.idempotencyKey,
        task_type: 'agent_message',
        sender: 'taskmaster',
        recipient: proposal.recipient,
        body: proposal.body,
      });
      await dal.updateActionOutcome(journalRow.id, 'sent');
      journalRow.outcome = 'sent';
      touchedThisTick.add(proposal.threadRef);
      result.effects += 1;
      log.info(
        {
          actionType: proposal.type,
          threadRef: proposal.threadRef,
          idempotencyKey: proposal.idempotencyKey,
        },
        'taskmaster.effect_sent'
      );
    } catch (error) {
      await dal.updateActionOutcome(journalRow.id, 'failed');
      journalRow.outcome = 'failed';
      tickFailures += 1;
      log.error({ err: error as Error, threadRef: proposal.threadRef }, 'taskmaster.effect_failed');
    }
  }

  result.failed = tickFailures;
  result.successful = tickFailures === 0;
  if (result.successful) recordTickHeartbeat(state.deadman, nowMs);
  return result;
}

// ---------------------------------------------------------------------------
// Scheduler singleton (skeleton cloned from the provider-wait scheduler in
// packages/server/src/routes/api.ts).
// ---------------------------------------------------------------------------

export interface TaskmasterRuntime {
  state: TaskmasterState;
  intervalMs: number;
  ownerId: string;
  lastTickResult: TickResult | null;
}

let taskmasterTimer: ReturnType<typeof setInterval> | undefined;
let taskmasterRuntime: TaskmasterRuntime | undefined;

export function stopTaskmaster(): void {
  if (taskmasterTimer) clearInterval(taskmasterTimer);
  taskmasterTimer = undefined;
  taskmasterRuntime = undefined;
}

export function getTaskmasterRuntime(): TaskmasterRuntime | undefined {
  return taskmasterRuntime;
}

export function getTickHealth(nowMs: number = Date.now()): TickHealth {
  if (!taskmasterRuntime) return 'not_running';
  return tickHealth(taskmasterRuntime.state.deadman, nowMs);
}

/**
 * Parse TASKMASTER_INTERVAL_MS: integer > 0 enables the loop at that
 * interval; 0 is KILLED (no tick); anything else falls back to 60000.
 */
export function resolveTaskmasterIntervalMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  return 60_000;
}

/**
 * Start the taskmaster loop. Module-scope singleton: subsequent calls are
 * no-ops while a timer exists. TASKMASTER_INTERVAL_MS=0 disables (KILLED).
 */
export function startTaskmaster(ownerIdSuffix: string, deps: TaskmasterDeps = {}): void {
  if (taskmasterTimer !== undefined) return;
  const intervalMs = resolveTaskmasterIntervalMs(process.env.TASKMASTER_INTERVAL_MS);
  if (intervalMs === 0) {
    log.info({}, 'taskmaster.disabled_by_interval_env');
    return;
  }
  const state = createTaskmasterState(intervalMs);
  taskmasterRuntime = {
    state,
    intervalMs,
    ownerId: `taskmaster:${ownerIdSuffix}`,
    lastTickResult: null,
  };
  let inFlight = false;
  const runTick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const tickResult = await tick(state, deps);
      if (taskmasterRuntime) taskmasterRuntime.lastTickResult = tickResult;
      if (tickResult.effects > 0 || tickResult.rejected > 0) {
        log.info(tickResult, 'taskmaster.tick_completed');
      }
    } catch (error) {
      log.error({ err: error as Error }, 'taskmaster.tick_failed');
    } finally {
      inFlight = false;
    }
  };
  taskmasterTimer = setInterval(() => void runTick(), intervalMs);
  taskmasterTimer.unref?.();
  void runTick();
}
