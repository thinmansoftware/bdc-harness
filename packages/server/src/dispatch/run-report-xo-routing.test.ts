/**
 * Fence 281 (P1): Overseer run reports owned by the acting XO were delivered
 * ONLY to the t3-desktop mailbox after WO-HARNESS-DISPATCH-ROUTING-CUTOFF-01,
 * so the XO session-start drain never saw them (69 rows 2026-11-01..04).
 *
 * Every test runs against a REAL SqliteAdapter (fresh ARCHON_HOME per test),
 * the real dispatch DAL and the real recipient resolver. The Overseer cases go
 * through the real default dispatch channel; the P0 case runs a real
 * Taskmaster tick whose sends go through the real createAuthenticatedMessage.
 */
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { appendOperatorCard, closeDatabase, getOperatorCard, resetDatabase } from '@archon/core/db';
import { getDatabase } from '@archon/core/db/connection';
import {
  assessDispatchRecipient,
  createAuthenticatedMessage,
  getMessage,
  listMessages,
} from '@archon/core/db/dispatch';
import {
  isXoResponsibleActor,
  OPERATOR_RECIPIENT,
  T3_DESKTOP_RECIPIENT,
} from '@archon/core/db/dispatch-routing';
import * as taskmasterDb from '@archon/core/db/taskmaster';
import { createDefaultOperatorCardChannels } from '@archon/overseer/escalation-delivery';
import { buildOperatorCard, type ActionableEventIdentity } from '@archon/overseer/operator-card';
import { drainOperatorInbox } from './operator-inbox-consumer';
import {
  createTaskmasterState,
  tick,
  type ListedThread,
  type TaskmasterDeps,
} from '../taskmaster/loop';

let home = '';
const oldHome = process.env.ARCHON_HOME;
const oldUrl = process.env.DATABASE_URL;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await closeDatabase();
  resetDatabase();
  home = mkdtempSync(join(tmpdir(), 'archon-run-report-xo-'));
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

function dispatchChannel() {
  const channel = createDefaultOperatorCardChannels({
    fetch: globalThis.fetch,
    resolve_owner: async () => null,
  }).find(c => c.channel === 'dispatch');
  if (!channel) throw new Error('dispatch_channel_missing');
  return channel;
}

async function cardFor(woId: string, responsibleActor: string) {
  const identity: ActionableEventIdentity = {
    identity_version: 'overseer-actionable-event-v1',
    source_event_id: `event-${woId}`,
    run_id: `run-${woId}`,
    wo_id: woId,
    event_type: 'node_failed',
    step_name: 'verify',
    event_created_at: '2026-11-03T08:00:00.000Z',
    error_class: 'validator_rejected',
  };
  const built = buildOperatorCard(identity, {
    repository: 'thinmansoftware/bdc-harness',
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
    responsible_actor: responsibleActor,
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

async function runReportRows(): Promise<
  { id: string; recipient: string; correlation_id: string; body: string }[]
> {
  const result = await getDatabase().query<{
    id: string;
    recipient: string;
    correlation_id: string;
    body: string;
  }>(
    "SELECT id, recipient, correlation_id, body FROM agent_dispatch_messages WHERE task_type = 'run_report' ORDER BY recipient"
  );
  return result.rows;
}

describe('fence 281: XO-owned run reports reach the operator mailbox', () => {
  test('run_report_for_acting_xo_lands_in_operator_drain', async () => {
    const view = await cardFor('WO-FENCE281-XO-01', 'acting-xo');
    const key = `operator-card:${view.card.card_id}:dispatch`;
    expect((await dispatchChannel().deliver(view, key)).outcome).toBe('succeeded');

    // Visible in the operator list the XO session-start drain reads.
    const operatorRows = await listMessages({ recipient: OPERATOR_RECIPIENT, status: 'queued' });
    expect(operatorRows).toHaveLength(1);
    expect(operatorRows[0]?.task_type).toBe('run_report');
    expect(operatorRows[0]?.correlation_id).toBe(view.card.run_id);
    expect(JSON.parse(operatorRows[0]?.body ?? '{}')).toMatchObject({
      kind: 'overseer_run_report',
      card_id: view.card.card_id,
      responsible_actor: 'acting-xo',
    });

    // And the operator-inbox-consumer drain actually surfaces it.
    const surfaced: string[] = [];
    const drained = await drainOperatorInbox({
      surface: async entry => {
        surfaced.push(entry.messageId);
      },
    });
    expect(drained.found).toBe(1);
    expect(drained.processed).toBe(1);
    expect(drained.needsHuman).toBe(1);
    expect(surfaced).toEqual([operatorRows[0]?.id ?? 'missing']);
    const after = await getMessage(operatorRows[0]?.id ?? '');
    expect(after?.route_disposition).toBe('auto_surfaced');
  });

  test('run_report_for_acting_xo_not_t3_only', async () => {
    const view = await cardFor('WO-FENCE281-XO-02', 'acting-xo');
    const key = `operator-card:${view.card.card_id}:dispatch`;
    const channel = dispatchChannel();
    expect((await channel.deliver(view, key)).outcome).toBe('succeeded');
    // Redelivery and reconcile are exactly-once per mailbox.
    expect((await channel.deliver(view, key)).outcome).toBe('succeeded');
    expect((await channel.reconcile(view, 2)).outcome).toBe('succeeded');

    const rows = await runReportRows();
    expect(rows.map(row => row.recipient)).toEqual([OPERATOR_RECIPIENT, T3_DESKTOP_RECIPIENT]);
    // Linked: same run id, same card, distinct rows.
    expect(new Set(rows.map(row => row.correlation_id))).toEqual(new Set([view.card.run_id]));
    expect(new Set(rows.map(row => JSON.parse(row.body).card_id))).toEqual(
      new Set([view.card.card_id])
    );
    expect(rows[0]?.id).not.toBe(rows[1]?.id);

    // Every explicit XO principal spelling.
    for (const actor of ['acting-xo', 'xo', 'operator', ' Acting-XO ']) {
      expect(isXoResponsibleActor(actor)).toBe(true);
    }
    // WO-HARNESS-OVERSEER-OWNER-ROUTING-01 (M-93 clause 2): XO is never
    // automatically assigned, so a blank actor and the explicit unowned
    // bucket are NOT XO principals. Cards always carry an explicit actor
    // (responsible_actor is NOT NULL and runEscalation always sets one).
    for (const actor of ['', '  ', 'unowned']) {
      expect(isXoResponsibleActor(actor)).toBe(false);
    }
  });

  test('non_xo_run_report_routing_unchanged', async () => {
    const view = await cardFor('WO-FENCE281-SEAT-01', 'major-build');
    expect(isXoResponsibleActor('major-build')).toBe(false);
    const key = `operator-card:${view.card.card_id}:dispatch`;
    expect((await dispatchChannel().deliver(view, key)).outcome).toBe('succeeded');

    const rows = await runReportRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipient).toBe(T3_DESKTOP_RECIPIENT);
    expect(await listMessages({ recipient: OPERATOR_RECIPIENT })).toHaveLength(0);
  });

  test('p0_escalation_routing_unchanged', async () => {
    const START = Date.parse('2026-11-04T12:00:00.000Z');
    const THREAD = 'gh:thinmansoftware/bdc-harness#281';
    setSystemTime(new Date(START));
    const thread: ListedThread = {
      ref: THREAD,
      priority: 'P0',
      lastActivityAt: new Date(START - 6 * 3_600_000).toISOString(),
      recipient: 'xo',
      title: 'WO-HARNESS-FENCE281-P0-01 stuck P0',
      ownerLogin: null,
      labels: ['wo', 'prio:P0'],
      isUnclaimed: true,
      isUnclaimedP0: true,
    };
    const deps = {
      now: () => new Date(),
      db: { ...taskmasterDb } as unknown as TaskmasterDeps['db'],
      fireBudget: {
        reserveAutomaticFire: value => taskmasterDb.reserveAutomaticFire(value),
        authorizeAutomaticFire: value => taskmasterDb.authorizeAutomaticFire(value),
        releaseAutomaticFire: value => taskmasterDb.releaseAutomaticFire(value),
        settleAutomaticFire: value => taskmasterDb.settleAutomaticFire(value),
        seedAutomaticFireHistory: value => taskmasterDb.seedAutomaticFireHistory(value),
        listAutomaticFireAdmissions: () => taskmasterDb.listAutomaticFireAdmissions(),
        updateAutomaticFireExpectation: value => taskmasterDb.updateAutomaticFireExpectation(value),
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
      listThreads: async () => [thread],
      listUndeliveredRulings: async () => [],
      getGithubIssueEvidence: async () => null,
      checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
      findEffectByIdempotencyKey: async () => null,
      getDispatchMessageById: getMessage as unknown as TaskmasterDeps['getDispatchMessageById'],
      assessDispatchRecipient:
        assessDispatchRecipient as unknown as TaskmasterDeps['assessDispatchRecipient'],
      createTask: createAuthenticatedMessage,
    } as TaskmasterDeps;

    // Exercise the Dispatch send path (not the GitHub issue-comment path).
    const oldEscalateToIssue = process.env.TASKMASTER_ESCALATE_TO_ISSUE;
    process.env.TASKMASTER_ESCALATE_TO_ISSUE = 'false';
    try {
      await tick(createTaskmasterState(60_000), deps);
    } finally {
      if (oldEscalateToIssue === undefined) delete process.env.TASKMASTER_ESCALATE_TO_ISSUE;
      else process.env.TASKMASTER_ESCALATE_TO_ISSUE = oldEscalateToIssue;
    }

    const result = await getDatabase().query<{ recipient: string; task_type: string }>(
      "SELECT recipient, task_type FROM agent_dispatch_messages WHERE idempotency_key LIKE 'tm:escalate_p0:%'"
    );
    expect(result.rows).toEqual([{ recipient: T3_DESKTOP_RECIPIENT, task_type: 'agent_message' }]);
    expect(await listMessages({ recipient: OPERATOR_RECIPIENT })).toHaveLength(0);
  });
});
