/**
 * WO-HARNESS-DISPATCH-ROUTING-CUTOFF-01 -- Tests 1-8.
 *
 * Every test runs against a REAL SqliteAdapter (fresh ARCHON_HOME per test) and
 * the real dispatch DAL, so a principal missing from the seed, a receipt that
 * still lands at `operator`, or a fenced history row that gets touched fails
 * here with the real symptom instead of passing against a fake.
 */
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { appendOperatorCard, closeDatabase, getOperatorCard, resetDatabase } from '@archon/core/db';
import { getDatabase } from '@archon/core/db/connection';
import {
  createAuthenticatedMessage,
  disposeMessageByMachine,
  listMessages,
} from '@archon/core/db/dispatch';
import {
  OPERATOR_HISTORY_CUTOFF,
  PR_REVIEW_LOG_RECIPIENT,
  T3_DESKTOP_RECIPIENT,
} from '@archon/core/db/dispatch-routing';
import * as taskmasterDb from '@archon/core/db/taskmaster';
import {
  createRealIngestDeps,
  createRealSubmitDeps,
  reviewSubjectKey,
  REVIEW_RECIPIENT,
} from '@archon/overseer/pr-review-wiring';
import { createRealRecheckIngestDeps } from '@archon/overseer/pr-review-check-wiring';
import { recheckCorrelationId } from '@archon/overseer/pr-review-check-ingest';
import { createDefaultOperatorCardChannels } from '@archon/overseer/escalation-delivery';
import { buildOperatorCard, type ActionableEventIdentity } from '@archon/overseer/operator-card';
import { drainOperatorInbox, isPreCutoffOperatorRow } from './operator-inbox-consumer';
import { validateProposal } from '../taskmaster/guard';
import { computeNextAction, ESCALATE_P0_CLOCK_MS, type ActionProposal } from '../taskmaster/rules';
import {
  createTaskmasterState,
  tick,
  type ListedThread,
  type TaskmasterDeps,
} from '../taskmaster/loop';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const OWNER = 'thinmansoftware';
const REPO = 'bdc-harness';
const PR = 4118;
const CONFIG = {
  webhookSecret: 'routing-cutoff-secret',
  reviewerIdentity: 'thinman-overseer[bot]',
};

let home = '';
const oldHome = process.env.ARCHON_HOME;
const oldUrl = process.env.DATABASE_URL;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await closeDatabase();
  resetDatabase();
  home = mkdtempSync(join(tmpdir(), 'archon-routing-cutoff-'));
  process.env.ARCHON_HOME = home;
  delete process.env.DATABASE_URL;
  globalThis.fetch = mock(async () => {
    throw new Error('poison_global_network');
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  setSystemTime();
  globalThis.fetch = originalFetch;
  await closeDatabase();
  resetDatabase();
  if (oldHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = oldHome;
  if (oldUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = oldUrl;
  removeTempDirWithRetry(home);
});

async function setCreatedAt(id: string, createdAt: string): Promise<void> {
  await getDatabase().query('UPDATE agent_dispatch_messages SET created_at = $1 WHERE id = $2', [
    createdAt,
    id,
  ]);
}

async function rowById(id: string): Promise<Record<string, unknown> | undefined> {
  const result = await getDatabase().query<Record<string, unknown>>(
    'SELECT * FROM agent_dispatch_messages WHERE id = $1',
    [id]
  );
  return result.rows[0];
}

describe('WO-HARNESS-DISPATCH-ROUTING-CUTOFF-01', () => {
  test('Test 1: receipts go to the log, not operator', async () => {
    const headSha = 'a'.repeat(40);
    const ingest = createRealIngestDeps(CONFIG);
    const submit = createRealSubmitDeps(CONFIG.reviewerIdentity, {
      octokit: {} as never,
      patOctokit: null,
      recordApprovalVerdict: async () => {},
    });
    const recheck = createRealRecheckIngestDeps(CONFIG);

    await ingest.recordReceipt({
      deliveryId: 'delivery-ingest-1',
      correlationId: recheckCorrelationId({ owner: OWNER, repo: REPO, prNumber: PR, headSha }),
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha,
      disposition: 'queued',
    } as Parameters<typeof ingest.recordReceipt>[0]);
    await submit.recordReceipt({
      correlationId: recheckCorrelationId({ owner: OWNER, repo: REPO, prNumber: PR, headSha }),
      messageId: 'work-1',
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha,
      disposition: 'changes_requested',
      event: 'REQUEST_CHANGES',
    } as Parameters<typeof submit.recordReceipt>[0]);
    await recheck.recordReceipt({
      deliveryId: 'delivery-recheck-1',
      correlationId: recheckCorrelationId({ owner: OWNER, repo: REPO, prNumber: PR, headSha }),
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha,
      disposition: 'queued',
    } as Parameters<typeof recheck.recordReceipt>[0]);

    const rows = await getDatabase().query<{ recipient: string; body: string }>(
      "SELECT recipient, body FROM agent_dispatch_messages WHERE task_type = 'run_report'"
    );
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.every(row => row.recipient === PR_REVIEW_LOG_RECIPIENT)).toBe(true);
    expect(rows.rows.map(row => (JSON.parse(row.body) as { kind: string }).kind).sort()).toEqual([
      'pr_review_ingest_receipt',
      'pr_review_recheck_ingest_receipt',
      'pr_review_submit_receipt',
    ]);
    expect(await listMessages({ recipient: 'operator' })).toHaveLength(0);
  });

  test('Test 2: reviewer still finds verdicts across the cut-off', async () => {
    const subjectKey = reviewSubjectKey(OWNER, REPO, PR);
    const heads = { before: 'b'.repeat(40), after: 'c'.repeat(40) };

    async function seedWork(headSha: string): Promise<string> {
      const work = await createAuthenticatedMessage(
        { kind: 'system', sender: 'overseer' },
        {
          correlation_id: recheckCorrelationId({ owner: OWNER, repo: REPO, prNumber: PR, headSha }),
          idempotency_key: `work:${headSha}`,
          task_type: 'run_review',
          recipient: REVIEW_RECIPIENT,
          subject_key: subjectKey,
          body: JSON.stringify({
            owner: OWNER,
            repo: REPO,
            prNumber: PR,
            headSha,
            baseRef: 'dev',
            author: 'builder',
            headCiGreen: true,
          }),
        }
      );
      if (!work) throw new Error('work_not_created');
      return work.id;
    }

    async function seedReceipt(
      recipient: string,
      headSha: string,
      messageId: string,
      createdAt: string
    ): Promise<string> {
      const receipt = await createAuthenticatedMessage(
        { kind: 'system', sender: 'overseer' },
        {
          correlation_id: recheckCorrelationId({ owner: OWNER, repo: REPO, prNumber: PR, headSha }),
          idempotency_key: `receipt:${headSha}`,
          task_type: 'run_report',
          recipient,
          subject_key: subjectKey,
          body: JSON.stringify({
            kind: 'pr_review_submit_receipt',
            messageId,
            owner: OWNER,
            repo: REPO,
            prNumber: PR,
            headSha,
            disposition: 'changes_requested',
          }),
        }
      );
      if (!receipt) throw new Error('receipt_not_created');
      await setCreatedAt(receipt.id, createdAt);
      return receipt.id;
    }

    const workBefore = await seedWork(heads.before);
    const workAfter = await seedWork(heads.after);
    const receiptBefore = await seedReceipt(
      'operator',
      heads.before,
      workBefore,
      '2026-10-31T12:00:00.000Z'
    );
    const receiptAfter = await seedReceipt(
      PR_REVIEW_LOG_RECIPIENT,
      heads.after,
      workAfter,
      '2026-11-02T12:00:00.000Z'
    );

    const prior = await createRealIngestDeps(CONFIG).listPriorReviewWork({
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
    } as Parameters<ReturnType<typeof createRealIngestDeps>['listPriorReviewWork']>[0]);
    const byHead = new Map(prior.map(work => [work.headSha, work]));
    expect(byHead.get(heads.before)?.verdictId).toBe(receiptBefore);
    expect(byHead.get(heads.after)?.verdictId).toBe(receiptAfter);
    expect(byHead.get(heads.before)?.verdict).not.toBeNull();
    expect(byHead.get(heads.after)?.verdict).toBe(byHead.get(heads.before)?.verdict ?? null);

    const recheck = createRealRecheckIngestDeps(CONFIG);
    for (const [headSha, recordedAt] of [
      [heads.before, '2026-10-31T12:00:00.000Z'],
      [heads.after, '2026-11-02T12:00:00.000Z'],
    ] as const) {
      const standing = await recheck.readStandingVerdict({
        owner: OWNER,
        repo: REPO,
        prNumber: PR,
        headSha,
      } as Parameters<typeof recheck.readStandingVerdict>[0]);
      expect(standing).toMatchObject({ headSha, disposition: 'changes_requested', recordedAt });
    }
  });

  test('Test 3: run reports and owner cards go to t3-desktop once (XO copy to operator)', async () => {
    const owners: Record<string, string | null> = {
      'WO-ROUTING-OWNED-01': 'Grok',
      'WO-ROUTING-ORPHAN-01': null,
    };
    const dispatch = createDefaultOperatorCardChannels({
      fetch: globalThis.fetch,
      resolve_owner: async woId => owners[woId] ?? null,
    }).find(channel => channel.channel === 'dispatch');
    if (!dispatch) throw new Error('dispatch_channel_missing');

    async function cardFor(woId: string) {
      const identity: ActionableEventIdentity = {
        identity_version: 'overseer-actionable-event-v1',
        source_event_id: `event-${woId}`,
        run_id: `run-${woId}`,
        wo_id: woId,
        event_type: 'node_failed',
        step_name: 'verify',
        event_created_at: '2026-11-01T08:00:00.000Z',
        error_class: 'validator_rejected',
      };
      const built = buildOperatorCard(identity, {
        repository: `${OWNER}/${REPO}`,
        branch: 'feat/example',
        pr_url: null,
        pr_number: null,
        head_sha: null,
        base_branch: 'dev',
        base_sha: null,
        checks: {},
        mergeability: 'unknown',
        blocker: 'validator rejected',
        mechanical_evidence: {},
        recovery_attempted: {},
        proposed_remediation: {},
        next_permitted_action: 'await operator ruling',
        responsible_actor: 'acting-xo',
        actionable_event_at: identity.event_created_at,
        required_ruling: null,
        evidence_links: {},
        lifecycle_classification: 'recovery',
        governance_classification: 'information-only',
      });
      await appendOperatorCard({
        ...built,
        canonical_event_identity: { ...built.canonical_event_identity },
        payload: { ...built.payload },
        ...built.payload,
        run_id: identity.run_id,
        wo_id: identity.wo_id,
      });
      const view = await getOperatorCard(built.card_id);
      if (!view) throw new Error('card_missing');
      return view;
    }

    const owned = await cardFor('WO-ROUTING-OWNED-01');
    const orphan = await cardFor('WO-ROUTING-ORPHAN-01');
    const ownedKey = `operator-card:${owned.card.card_id}:dispatch`;
    expect((await dispatch.deliver(owned, ownedKey)).outcome).toBe('succeeded');
    expect((await dispatch.deliver(owned, ownedKey)).outcome).toBe('succeeded');
    expect(
      (await dispatch.deliver(orphan, `operator-card:${orphan.card.card_id}:dispatch`)).outcome
    ).toBe('succeeded');

    const rows = await listMessages({ recipient: T3_DESKTOP_RECIPIENT });
    expect(rows).toHaveLength(2);
    const bodies = new Map(
      rows.map(row => {
        const body = JSON.parse(row.body) as { card_id: string; kind: string; owner_seat: unknown };
        return [body.card_id, body];
      })
    );
    expect(bodies.get(owned.card.card_id)).toMatchObject({
      kind: 'overseer_run_report',
      owner_seat: 'Grok',
    });
    expect(bodies.get(orphan.card.card_id)).toMatchObject({
      kind: 'overseer_run_report',
      owner_seat: null,
    });
    // Fence 281: both cards are acting-xo, so each also has exactly one
    // operator copy (redelivery of `owned` made no second one).
    expect(await listMessages({ recipient: 'operator' })).toHaveLength(2);
    expect(await listMessages({ recipient: 'Grok' })).toHaveLength(0);
  });

  test('Test 4: pre-cutoff operator rows are untouched', async () => {
    async function seedOperatorRow(key: string, createdAt: string): Promise<string> {
      const row = await createAuthenticatedMessage(
        { kind: 'system', sender: 'overseer' },
        {
          correlation_id: key,
          idempotency_key: key,
          task_type: 'run_report',
          recipient: 'operator',
          body: JSON.stringify({
            kind: 'overseer_run_report',
            blocker:
              'Overseer judge health failure (evidence_unavailable) after 3 retries: judge_daily_budget_exceeded',
            woId: 'WO-HARNESS-JUDGE-BUDGET-01',
            runId: key,
          }),
        }
      );
      if (!row) throw new Error('operator_row_not_created');
      await setCreatedAt(row.id, createdAt);
      return row.id;
    }

    // SQLite datetime text for the history row, ISO for the new one: the
    // column holds both shapes in the live store.
    const historyId = await seedOperatorRow('history-row', '2026-10-31 12:00:00');
    const freshId = await seedOperatorRow('fresh-row', '2026-11-02T12:00:00.000Z');
    const historyBefore = await rowById(historyId);
    expect(historyBefore).toBeDefined();

    const disposed: string[] = [];
    const deps = {
      surface: async () => {},
      disposeMessageByMachine: async (data: {
        id: string;
        actor: string;
        disposition: 'expired' | 'auto_surfaced';
      }) => {
        disposed.push(data.id);
        return disposeMessageByMachine(data);
      },
    };
    await drainOperatorInbox(deps);
    await drainOperatorInbox(deps);

    expect(await rowById(historyId)).toEqual(historyBefore);
    expect(disposed).not.toContain(historyId);
    expect(disposed).toContain(freshId);
    expect((await rowById(freshId))?.route_disposition).not.toBeNull();

    // The in-code fence compares instants for both stored shapes.
    expect(OPERATOR_HISTORY_CUTOFF).toBe('2026-11-01T00:00:00.000Z');
    expect(isPreCutoffOperatorRow('2026-10-31T23:59:59.999Z')).toBe(true);
    expect(isPreCutoffOperatorRow('2026-10-31 23:59:59')).toBe(true);
    expect(isPreCutoffOperatorRow('2026-11-01 00:00:00')).toBe(false);
    expect(isPreCutoffOperatorRow('2026-11-01T00:00:00.000Z')).toBe(false);
    expect(isPreCutoffOperatorRow('not-a-date')).toBe(true);
  });

  describe('Taskmaster escalate_p0 (real tick, real journal)', () => {
    const START = Date.parse('2026-11-02T12:00:00.000Z');
    const THREAD = 'dispatch:orphan-p0-routing';

    function unclaimedP0(): ListedThread {
      return {
        ref: THREAD,
        priority: 'P0',
        lastActivityAt: new Date(START - 6 * 3_600_000).toISOString(),
        recipient: 'xo',
        title: 'WO-HARNESS-EXAMPLE-01 stuck P0',
        ownerLogin: null,
        labels: ['wo', 'prio:P0'],
        isUnclaimed: true,
        isUnclaimedP0: true,
      };
    }

    function failingDeps(attempts: string[]): TaskmasterDeps {
      return {
        now: () => new Date(),
        db: { ...taskmasterDb } as unknown as TaskmasterDeps['db'],
        fireBudget: {
          reserveAutomaticFire: value => taskmasterDb.reserveAutomaticFire(value),
          authorizeAutomaticFire: value => taskmasterDb.authorizeAutomaticFire(value),
          releaseAutomaticFire: value => taskmasterDb.releaseAutomaticFire(value),
          settleAutomaticFire: value => taskmasterDb.settleAutomaticFire(value),
          seedAutomaticFireHistory: value => taskmasterDb.seedAutomaticFireHistory(value),
          listAutomaticFireAdmissions: () => taskmasterDb.listAutomaticFireAdmissions(),
          updateAutomaticFireExpectation: value =>
            taskmasterDb.updateAutomaticFireExpectation(value),
        },
        readFireCascade: async () => null,
        readFireCascadeEvidence: async () => null as never,
        getDispatchReceiptCutoverAt: async () => null,
        checkExpectations: async () => {},
        refreshLaneHealth: async () => {},
        headroom: async () => ({
          state: 'OK',
          tokensRemaining: 500_000,
          isUnknown: false,
          source: 'local_artifacts',
          observedAt: new Date().toISOString(),
        }),
        listThreads: async () => [unclaimedP0()],
        listUndeliveredRulings: async () => [],
        getGithubIssueEvidence: async () => null,
        checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
        findEffectByIdempotencyKey: async () => null,
        getDispatchMessageById: (async () =>
          null) as unknown as TaskmasterDeps['getDispatchMessageById'],
        assessDispatchRecipient: (async (recipient: string) => ({
          ok: true,
          canonical_principal: recipient.trim().toLowerCase(),
          delivery_mode: 'drain_on_start',
          reason: null,
        })) as unknown as TaskmasterDeps['assessDispatchRecipient'],
        createTask: (async (
          _context: unknown,
          data: { idempotency_key: string; recipient: string }
        ) => {
          if (data.idempotency_key.startsWith('tm:escalate_p0:')) {
            attempts.push(data.recipient);
            throw new Error('dispatch_send_failed_for_test');
          }
          return { id: `msg-${data.idempotency_key}`, status: 'queued' } as never;
        }) as unknown as TaskmasterDeps['createTask'],
      } as TaskmasterDeps;
    }

    async function escalateRows(): Promise<taskmasterDb.TmJournalEntry[]> {
      const rows = await taskmasterDb.getActionsSince('1970-01-01T00:00:00.000Z', THREAD);
      return rows.filter(row => row.action_type === 'escalate_p0');
    }

    // WO-HARNESS-TASKMASTER-ESCALATE-P0-FLOOD-01 Amendment 7b: a suppressed
    // re-proposal is journaled ONCE as a recent_escalation skip row, separate from
    // the delivery attempts these tests count.
    const isSkip = (row: taskmasterDb.TmJournalEntry): boolean =>
      JSON.parse(row.proposal_json).suppressed === 'recent_escalation';
    async function attemptRows(): Promise<taskmasterDb.TmJournalEntry[]> {
      return (await escalateRows()).filter(row => !isSkip(row));
    }
    async function skipRows(): Promise<taskmasterDb.TmJournalEntry[]> {
      return (await escalateRows()).filter(isSkip);
    }

    test('Test 5: one escalate_p0 per stall, even when delivery fails', async () => {
      setSystemTime(new Date(START));
      const attempts: string[] = [];
      const deps = failingDeps(attempts);
      const state = createTaskmasterState(60_000);
      // Four ticks over 28 minutes (0, 9, 18, 27 min... then 28).
      for (const offsetMin of [0, 9, 18, 28]) {
        setSystemTime(new Date(START + offsetMin * 60_000));
        await tick(state, deps);
      }
      // Still one delivery attempt per stall: exactly one row that is not a skip.
      const rows = await attemptRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toBe('failed');
      expect(JSON.parse(rows[0]?.proposal_json ?? '{}')).toMatchObject({
        recipient: T3_DESKTOP_RECIPIENT,
        failure: 'dispatch_send_failed_for_test',
      });
      expect(attempts).toEqual([T3_DESKTOP_RECIPIENT]);
      // The re-proposals inside the 6 h failed backoff are journaled ONCE (the old
      // rule dropped them with no row, so a regression fails here).
      const skips = await skipRows();
      expect(skips).toHaveLength(1);
      expect(skips[0]?.outcome).toBe('expired');
      expect(JSON.parse(skips[0]?.proposal_json ?? '{}')).toMatchObject({
        suppressed: 'recent_escalation',
        reason: 'unclaimed_p0',
        window_basis: 'failed_backoff',
        window_start: rows[0]?.created_at,
      });
    });

    test('Test 6: a stall unmoved after 24 hours escalates once more', async () => {
      setSystemTime(new Date(START));
      const attempts: string[] = [];
      const deps = failingDeps(attempts);
      const state = createTaskmasterState(60_000);
      await tick(state, deps);
      expect(await attemptRows()).toHaveLength(1);
      expect(await skipRows()).toHaveLength(0);

      // After 24 hours the stall escalates once more (one more delivery attempt).
      setSystemTime(new Date(START + 25 * 3_600_000));
      await tick(state, deps);
      const afterDay = await attemptRows();
      expect(afterDay).toHaveLength(2);
      expect(await skipRows()).toHaveLength(0);

      // 30 min later: no third attempt; the duplicate is journaled ONCE. Every
      // delivery in this test fails, so the last attempt is a failed row and the
      // window that applies is the 6 h failed backoff (no sent row ever exists).
      setSystemTime(new Date(START + 25 * 3_600_000 + 30 * 60_000));
      await tick(state, deps);
      expect(await attemptRows()).toHaveLength(2);
      expect(attempts).toEqual([T3_DESKTOP_RECIPIENT, T3_DESKTOP_RECIPIENT]);
      const skips = await skipRows();
      expect(skips).toHaveLength(1);
      expect(skips[0]?.outcome).toBe('expired');
      const newest = afterDay.reduce((a, b) => (a.created_at > b.created_at ? a : b));
      expect(JSON.parse(skips[0]?.proposal_json ?? '{}')).toMatchObject({
        suppressed: 'recent_escalation',
        reason: 'unclaimed_p0',
        window_basis: 'failed_backoff',
        window_start: newest.created_at,
      });
      expect(ESCALATE_P0_CLOCK_MS).toBe(24 * 60 * 60 * 1000);
    });
  });

  test('Test 7: t3-desktop is admitted only for escalate_p0', () => {
    const escalate = computeNextAction(
      {
        ref: 'gh:thinmansoftware/bdc-harness#7',
        priority: 'P0',
        lastActivityAt: '2026-11-01T00:00:00.000Z',
        recipient: 'xo',
        isUnclaimedP0: true,
      },
      'ready',
      { interventionsLast24h: 0, nowMs: Date.parse('2026-11-02T00:00:00.000Z') }
    );
    if (!escalate) throw new Error('escalate_p0_not_proposed');
    expect(escalate.type).toBe('escalate_p0');
    expect(escalate.recipient).toBe(T3_DESKTOP_RECIPIENT);

    const base: ActionProposal = {
      type: 'nudge',
      threadRef: 'gh:thinmansoftware/bdc-harness#7',
      recipient: T3_DESKTOP_RECIPIENT,
      body:
        'Nudge (P1): "Fix the export mapper" -- owner: major-build. ' +
        'Next action: rerun the failing export suite. Last movement 5h ago. ' +
        'https://github.com/thinmansoftware/bdc-harness/issues/7 Reply on the issue ' +
        'starting with [PROGRESS] or [BLOCKED] so the source-of-truth change can be verified.',
      idempotencyKey: 'tm:test:routing-cutoff',
      actsImmediately: false,
    };
    for (const type of ['nudge', 'digest', 'blocker_report'] as const) {
      const verdict = validateProposal({ ...base, type });
      expect(verdict.allowed).toBe(false);
      expect(verdict.forbiddenEffect).toBe(true);
    }
    const toXo = validateProposal({ ...escalate, recipient: 'xo' });
    expect(toXo.allowed).toBe(false);
    expect(toXo.forbiddenEffect).toBe(true);

    expect(validateProposal(escalate).allowed).toBe(true);
    expect(validateProposal({ ...base, type: 'digest', recipient: 'operator' }).allowed).toBe(true);
  });

  test('Test 8: both new principals exist on every seed path', async () => {
    for (const recipient of [T3_DESKTOP_RECIPIENT, PR_REVIEW_LOG_RECIPIENT]) {
      const sent = await createAuthenticatedMessage(
        { kind: 'system', sender: 'overseer' },
        {
          correlation_id: `seed-check:${recipient}`,
          idempotency_key: `seed-check:${recipient}`,
          task_type: 'run_report',
          recipient,
          body: JSON.stringify({ kind: 'seed_check' }),
        }
      );
      expect(sent?.recipient).toBe(recipient);
    }
    const migration065 = readFileSync(
      join(REPO_ROOT, 'migrations', '065_dispatch_t3_desktop_and_pr_review_log.sql'),
      'utf8'
    );
    const combined = readFileSync(join(REPO_ROOT, 'migrations', '000_combined.sql'), 'utf8');
    for (const text of [migration065, combined]) {
      expect(text).toContain("'t3-desktop'");
      expect(text).toContain("'pr-review-log'");
    }
  });
});
