import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import { rmSync } from 'fs';
import { join } from 'path';
import {
  appendDeliveryReceipt,
  appendOperatorCard,
  claimDueDeliveryJob,
  closeDatabase,
  completeDeliveryJob,
  getOperatorCard,
  resetDatabase,
} from '@archon/core/db';
import {
  buildOperatorCard,
  canonicalizeActionableEvent,
  deriveOperatorCardId,
  type ActionableEventIdentity,
} from '../operator-card';
import { runDueOperatorCardDeliveries, type OperatorCardChannel } from '../escalation-delivery';
import { lookupNotionPageId } from '../escalate';

const identity: ActionableEventIdentity = {
  identity_version: 'overseer-actionable-event-v1',
  source_event_id: 'event-123',
  run_id: 'run-123',
  wo_id: 'WO-TEST-123',
  event_type: 'node_failed',
  step_name: 'verify',
  event_created_at: '2026-07-16T08:00:00.000Z',
  error_class: 'validator_rejected',
};

describe('operator card identity', () => {
  test('canonicalizes the exact frozen identity key order and derives lowercase sha256', () => {
    const canonical = canonicalizeActionableEvent(identity);

    expect(canonical).toBe(
      '{"identity_version":"overseer-actionable-event-v1","source_event_id":"event-123","run_id":"run-123","wo_id":"WO-TEST-123","event_type":"node_failed","step_name":"verify","event_created_at":"2026-07-16T08:00:00.000Z","error_class":"validator_rejected"}'
    );
    expect(deriveOperatorCardId(identity)).toBe(
      createHash('sha256').update(canonical, 'utf8').digest('hex')
    );
  });

  test('rejects a missing stable source event id', () => {
    expect(() =>
      deriveOperatorCardId({
        ...identity,
        source_event_id: '',
      })
    ).toThrow('operator_card_identity_invalid:source_event_id');
  });

  test('builds a deterministic full payload digest independent of nested object key order', () => {
    const first = buildOperatorCard(identity, {
      repository: 'bluedevilcollectibles/bdc-harness',
      branch: 'feat/example',
      pr_url: null,
      pr_number: null,
      head_sha: null,
      base_branch: 'dev',
      base_sha: 'a'.repeat(40),
      checks: { failed: 1, total: 2 },
      mergeability: 'unknown',
      blocker: 'validator rejected',
      mechanical_evidence: { z: 2, a: 1 },
      recovery_attempted: { attempted: false },
      proposed_remediation: { steps: ['review validator output'] },
      next_permitted_action: 'await operator ruling',
      responsible_actor: 'acting-xo',
      actionable_event_at: identity.event_created_at,
      required_ruling: 'approve repair',
      evidence_links: { run: '/runs/run-123' },
      lifecycle_classification: 'recovery',
      governance_classification: 'non-production',
    });
    const second = buildOperatorCard(identity, {
      ...first.payload,
      checks: { total: 2, failed: 1 },
      mechanical_evidence: { a: 1, z: 2 },
    });

    expect(first.card_id).toMatch(/^[0-9a-f]{64}$/);
    expect(first.payload_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.card_id).toBe(first.card_id);
    expect(second.payload_digest).toBe(first.payload_digest);
    expect(second.payload).toEqual(first.payload);
  });
});

describe('durable operator-card delivery', () => {
  let home = '';
  const oldHome = process.env.ARCHON_HOME;
  const oldUrl = process.env.DATABASE_URL;

  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    home = join(
      import.meta.dir,
      `.test-escalation-delivery-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    if (oldHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = oldHome;
    if (oldUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldUrl;
    rmSync(home, { recursive: true, force: true });
  });

  async function persistCard(): Promise<string> {
    const built = buildOperatorCard(identity, {
      repository: 'bluedevilcollectibles/bdc-harness',
      branch: 'feat/example',
      pr_url: null,
      pr_number: null,
      head_sha: null,
      base_branch: 'dev',
      base_sha: 'a'.repeat(40),
      checks: { failed: 1, total: 1 },
      mergeability: 'unknown',
      blocker: 'validator rejected',
      mechanical_evidence: { source: 'deterministic-test' },
      recovery_attempted: { attempted: false },
      proposed_remediation: { steps: ['review'] },
      next_permitted_action: 'await operator ruling',
      responsible_actor: 'acting-xo',
      actionable_event_at: identity.event_created_at,
      required_ruling: 'approve repair',
      evidence_links: { run: '/runs/run-123' },
      lifecycle_classification: 'recovery',
      governance_classification: 'non-production',
    });
    await appendOperatorCard({
      ...built,
      ...built.payload,
      run_id: identity.run_id,
      wo_id: identity.wo_id,
      created_at: identity.event_created_at,
    });
    return built.card_id;
  }

  test('survives restart and succeeds only on the fixed third attempt', async () => {
    const cardId = await persistCard();
    const calls: string[] = [];
    const channels: OperatorCardChannel[] = ['builder_monitor', 'dispatch', 'notion'].map(
      channel => ({
        channel: channel as OperatorCardChannel['channel'],
        deliver: async (_card, key) => {
          calls.push(`${channel}:${key}`);
          if (
            channel === 'dispatch' &&
            calls.filter(value => value.startsWith('dispatch:')).length < 3
          ) {
            return { outcome: 'transient_failure' as const, sanitized_status: 'retryable' };
          }
          return { outcome: 'succeeded' as const, sanitized_status: 'delivered' };
        },
        reconcile: async () => ({ outcome: 'indeterminate', sanitized_status: 'unknown' }),
      })
    );

    await runDueOperatorCardDeliveries({
      channels,
      owner: 'runner-1',
      now: '2026-07-16T08:00:00.000Z',
    });
    await closeDatabase();
    resetDatabase();
    await runDueOperatorCardDeliveries({
      channels,
      owner: 'runner-2',
      now: '2026-07-16T08:00:30.000Z',
    });
    await runDueOperatorCardDeliveries({
      channels,
      owner: 'runner-2',
      now: '2026-07-16T08:02:00.000Z',
    });
    await runDueOperatorCardDeliveries({
      channels,
      owner: 'runner-2',
      now: '2026-07-16T09:00:00.000Z',
    });

    const view = await getOperatorCard(cardId);
    expect(calls.filter(value => value.startsWith('dispatch:'))).toHaveLength(3);
    expect(view?.delivery_summary.dispatch.state).toBe('succeeded');
    expect(view?.receipts.filter(receipt => receipt.channel === 'dispatch')).toHaveLength(6);
    expect(
      view?.receipts.map(receipt => receipt.phase).filter(phase => phase === 'started')
    ).toHaveLength(5);
  });

  test('reconciles an expired STARTED attempt to indeterminate without blind delivery', async () => {
    const cardId = await persistCard();
    const job = await claimDueDeliveryJob({
      channel: 'dispatch',
      owner: 'crashed-runner',
      now: '2026-07-16T08:00:00.000Z',
      lease_duration_ms: 1_000,
    });
    expect(job).not.toBeNull();
    await appendDeliveryReceipt({
      card_id: cardId,
      channel: 'dispatch',
      attempt_number: 1,
      phase: 'started',
      started_at: '2026-07-16T08:00:00.000Z',
      fencing_token: job!.fencing_token,
    });
    let deliverCalls = 0;
    let reconcileCalls = 0;
    const channel: OperatorCardChannel = {
      channel: 'dispatch',
      deliver: async () => {
        deliverCalls += 1;
        return { outcome: 'succeeded', sanitized_status: 'unexpected' };
      },
      reconcile: async () => {
        reconcileCalls += 1;
        return { outcome: 'indeterminate', sanitized_status: 'provider_state_unknown' };
      },
    };

    const store = {
      claimDueDeliveryJob: input => claimDueDeliveryJob({ ...input, channel: 'dispatch' }),
      getOperatorCard,
      appendDeliveryReceipt,
      completeDeliveryJob,
    };
    await runDueOperatorCardDeliveries({
      channels: [channel],
      owner: 'recovery-runner',
      now: '2026-07-16T08:00:02.000Z',
      store,
    });
    const view = await getOperatorCard(cardId);
    expect(deliverCalls).toBe(0);
    expect(reconcileCalls).toBe(1);
    expect(view?.delivery_summary.dispatch.state).toBe('indeterminate');
    expect(view?.receipts.at(-1)?.outcome).toBe('indeterminate');
  });

  test('finishes an expired lease from its existing TERMINAL receipt without redelivery', async () => {
    const cardId = await persistCard();
    let deliveries = 0;
    let reconciliations = 0;
    const channel: OperatorCardChannel = {
      channel: 'dispatch',
      deliver: async () => {
        deliveries += 1;
        return { outcome: 'succeeded', sanitized_status: 'queued' };
      },
      reconcile: async () => {
        reconciliations += 1;
        return { outcome: 'indeterminate', sanitized_status: 'unexpected' };
      },
    };
    const claimDispatch = (input: Parameters<typeof claimDueDeliveryJob>[0]) =>
      claimDueDeliveryJob({ ...input, channel: 'dispatch' });
    const crashAfterTerminal = {
      claimDueDeliveryJob: claimDispatch,
      getOperatorCard,
      appendDeliveryReceipt,
      completeDeliveryJob: async () => {
        throw new Error('simulated_crash_after_terminal_receipt');
      },
    };
    await expect(
      runDueOperatorCardDeliveries({
        channels: [channel],
        owner: 'runner-before-crash',
        now: '2026-07-16T08:00:00.000Z',
        store: crashAfterTerminal,
      })
    ).rejects.toThrow('simulated_crash_after_terminal_receipt');

    await runDueOperatorCardDeliveries({
      channels: [channel],
      owner: 'runner-after-restart',
      now: '2026-07-16T08:01:01.000Z',
      store: {
        claimDueDeliveryJob: claimDispatch,
        getOperatorCard,
        appendDeliveryReceipt,
        completeDeliveryJob,
      },
    });
    const view = await getOperatorCard(cardId);
    expect(deliveries).toBe(1);
    expect(reconciliations).toBe(0);
    expect(view?.delivery_summary.dispatch.state).toBe('succeeded');
    expect(view?.receipts.filter(receipt => receipt.channel === 'dispatch')).toHaveLength(2);
  });
});

describe('Notion WO lookup', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('queries separate candidates in frozen order and returns first success', async () => {
    const queried: string[] = [];
    globalThis.fetch = mock(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { filter: { property: string } };
      queried.push(body.filter.property);
      if (body.filter.property === 'Name') {
        return Response.json({ results: [{ id: 'page-1' }] });
      }
      return new Response('unknown property', { status: 400 });
    }) as typeof fetch;

    expect(await lookupNotionPageId('test-key', 'db-1', 'WO-1')).toBe('page-1');
    expect(queried).toEqual(['Task', 'WO ID', 'Name']);
  });

  test('fails soft after all candidate queries fail', async () => {
    const queried: string[] = [];
    globalThis.fetch = mock(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { filter: { property: string } };
      queried.push(body.filter.property);
      return new Response('unknown property', { status: 400 });
    }) as typeof fetch;

    expect(await lookupNotionPageId('test-key', 'db-1', 'WO-1')).toBeNull();
    expect(queried).toEqual(['Task', 'WO ID', 'Name', 'Title', 'WO_ID']);
  });
});
