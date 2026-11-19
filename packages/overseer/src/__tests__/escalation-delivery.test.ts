import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { join } from 'path';
import {
  appendDeliveryReceipt,
  appendOperatorCard,
  claimDueDeliveryJob,
  closeDatabase,
  completeDeliveryJob,
  getDatabase,
  getOperatorCard,
  listMessages,
  resetDatabase,
} from '@archon/core/db';
import {
  buildOperatorCard,
  canonicalizeActionableEvent,
  deriveOperatorCardId,
  type ActionableEventIdentity,
} from '../operator-card';
import {
  buildOwnerEscalationText,
  createDefaultOperatorCardChannels,
  OWNER_ESCALATION_LINE,
  parseOwnerRouteTable,
  runDueOperatorCardDeliveries,
  type OperatorCardChannel,
} from '../escalation-delivery';
import { runEscalation } from '../escalate';
import type { WorkOwnerResolution } from '../owner-resolution';

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
      repository: 'thinmansoftware/bdc-harness',
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
    removeTempDirWithRetry(home);
  });

  async function persistCard(): Promise<string> {
    const built = buildOperatorCard(identity, {
      repository: 'thinmansoftware/bdc-harness',
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
    const channels: OperatorCardChannel[] = ['builder_monitor', 'dispatch'].map(channel => ({
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
    }));

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
    ).toHaveLength(4);
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
      lease_owner: 'crashed-runner',
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

  test('reclaims an expired third attempt and reconciles without a fourth provider call', async () => {
    const cardId = await persistCard();
    let deliverCalls = 0;
    let reconcileCalls = 0;
    const channel: OperatorCardChannel = {
      channel: 'dispatch',
      deliver: async () => {
        deliverCalls += 1;
        return { outcome: 'transient_failure', sanitized_status: 'retry_safe' };
      },
      reconcile: async () => {
        reconcileCalls += 1;
        return { outcome: 'indeterminate', sanitized_status: 'provider_state_unknown' };
      },
    };
    const claimDispatch = (input: Parameters<typeof claimDueDeliveryJob>[0]) =>
      claimDueDeliveryJob({ ...input, channel: 'dispatch' });
    const store = {
      claimDueDeliveryJob: claimDispatch,
      getOperatorCard,
      appendDeliveryReceipt,
      completeDeliveryJob,
    };

    await runDueOperatorCardDeliveries({
      channels: [channel],
      owner: 'runner-1',
      now: '2026-07-16T08:00:00.000Z',
      store,
    });
    await runDueOperatorCardDeliveries({
      channels: [channel],
      owner: 'runner-2',
      now: '2026-07-16T08:00:30.000Z',
      store,
    });
    const crashed = await claimDispatch({
      owner: 'runner-3-crashed',
      now: '2026-07-16T08:02:00.000Z',
      lease_duration_ms: 1_000,
    });
    expect(crashed?.attempts_started).toBe(3);
    await appendDeliveryReceipt({
      card_id: cardId,
      channel: 'dispatch',
      attempt_number: 3,
      phase: 'started',
      started_at: '2026-07-16T08:02:00.000Z',
      fencing_token: crashed!.fencing_token,
      lease_owner: 'runner-3-crashed',
    });

    await runDueOperatorCardDeliveries({
      channels: [channel],
      owner: 'recovery-runner',
      now: '2026-07-16T08:02:02.000Z',
      store,
    });

    const view = await getOperatorCard(cardId);
    expect(deliverCalls).toBe(2);
    expect(reconcileCalls).toBe(1);
    expect(view?.delivery_summary.dispatch.state).toBe('indeterminate');
    expect(view?.delivery_summary.dispatch.attempts_started).toBe(3);
    expect(view?.receipts.filter(receipt => receipt.phase === 'started')).toHaveLength(3);
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

  test('treats a thrown response-loss transport as indeterminate and never retries', async () => {
    const cardId = await persistCard();
    let calls = 0;
    const channel: OperatorCardChannel = {
      channel: 'dispatch',
      deliver: async () => {
        calls += 1;
        throw new Error('response_lost_after_post');
      },
      reconcile: async () => ({
        outcome: 'indeterminate',
        sanitized_status: 'provider_state_unknown',
      }),
    };
    const claimDispatch = (input: Parameters<typeof claimDueDeliveryJob>[0]) =>
      claimDueDeliveryJob({ ...input, channel: 'dispatch' });
    const store = {
      claimDueDeliveryJob: claimDispatch,
      getOperatorCard,
      appendDeliveryReceipt,
      completeDeliveryJob,
    };

    await runDueOperatorCardDeliveries({
      channels: [channel],
      owner: 'response-loss-runner',
      now: '2026-07-16T08:00:00.000Z',
      store,
    });
    await runDueOperatorCardDeliveries({
      channels: [channel],
      owner: 'response-loss-runner',
      now: '2026-07-16T09:00:00.000Z',
      store,
    });
    const view = await getOperatorCard(cardId);
    expect(calls).toBe(1);
    expect(view?.delivery_summary.dispatch.state).toBe('indeterminate');
    expect(view?.delivery_summary.dispatch.attempts_started).toBe(1);
    expect(view?.receipts.at(-1)?.outcome).toBe('indeterminate');
    expect(view?.receipts.at(-1)?.next_attempt_at).toBeNull();
  });

  test('uses card persistence time as retry epoch for an hours-old source event', async () => {
    const sourceTime = '2026-07-15T00:00:00.000Z';
    const card = await runEscalation(
      'run-old-event',
      { decision: 'escalate', reason: 'old actionable event' },
      {
        errorClass: 'validator_rejected',
        woId: 'WO-OLD-EVENT-01',
        repository: 'thinmansoftware/bdc-harness',
      },
      {
        sourceEventId: 'event-old-1',
        eventType: 'node_failed',
        stepName: 'verify',
        eventCreatedAt: sourceTime,
      }
    );
    const view = await getOperatorCard(card.card_id);
    expect(card.actionable_event_at).toBe(sourceTime);
    expect(card.created_at).not.toBe(sourceTime);
    expect(view?.jobs.every(job => job.next_attempt_at === card.created_at)).toBe(true);
    expect(
      await claimDueDeliveryJob({
        channel: 'dispatch',
        owner: 'too-early-runner',
        now: '2026-07-15T01:00:00.000Z',
      })
    ).toBeNull();
    const attempt1 = await claimDueDeliveryJob({
      channel: 'dispatch',
      owner: 'epoch-runner',
      now: card.created_at,
    });
    expect(attempt1?.attempts_started).toBe(1);
    if (!attempt1) throw new Error('attempt_1_not_claimed');
    await completeDeliveryJob({
      card_id: card.card_id,
      channel: 'dispatch',
      owner: 'epoch-runner',
      fencing_token: attempt1.fencing_token,
      outcome: 'transient_failure',
      now: card.created_at,
    });
    const plus = (milliseconds: number) =>
      new Date(new Date(card.created_at).getTime() + milliseconds).toISOString();
    expect(
      await claimDueDeliveryJob({
        channel: 'dispatch',
        owner: 'epoch-runner',
        now: plus(29_999),
      })
    ).toBeNull();
    const attempt2 = await claimDueDeliveryJob({
      channel: 'dispatch',
      owner: 'epoch-runner',
      now: plus(30_000),
    });
    expect(attempt2?.attempts_started).toBe(2);
    if (!attempt2) throw new Error('attempt_2_not_claimed');
    await completeDeliveryJob({
      card_id: card.card_id,
      channel: 'dispatch',
      owner: 'epoch-runner',
      fencing_token: attempt2.fencing_token,
      outcome: 'transient_failure',
      now: plus(30_000),
    });
    expect(
      await claimDueDeliveryJob({
        channel: 'dispatch',
        owner: 'epoch-runner',
        now: plus(119_999),
      })
    ).toBeNull();
    const attempt3 = await claimDueDeliveryJob({
      channel: 'dispatch',
      owner: 'epoch-runner',
      now: plus(120_000),
    });
    expect(attempt3?.attempts_started).toBe(3);
  });
});

describe('default informational channel adapters', () => {
  let home = '';
  const oldHome = process.env.ARCHON_HOME;
  const oldUrl = process.env.DATABASE_URL;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    home = join(import.meta.dir, `.test-default-channels-${Date.now()}-${Math.random()}`);
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;
    globalThis.fetch = mock(async () => {
      throw new Error('poison_global_network');
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await closeDatabase();
    resetDatabase();
    if (oldHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = oldHome;
    if (oldUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldUrl;
    removeTempDirWithRetry(home);
  });

  async function defaultCardView() {
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
    if (!view) throw new Error('default_channel_card_missing');
    return view;
  }

  test('default Dispatch adapter routes a guarded run report to t3-desktop with the owner seat in the body', async () => {
    const view = await defaultCardView();
    const dispatch = createDefaultOperatorCardChannels({
      fetch: globalThis.fetch,
      resolve_owner: mock(async () => 'Grok'),
    }).find(channel => channel.channel === 'dispatch');
    if (!dispatch) throw new Error('dispatch_channel_missing');
    const result = await dispatch.deliver(view, `operator-card:${view.card.card_id}:dispatch`);
    const messages = await listMessages({ recipient: 't3-desktop' });
    expect(result.outcome).toBe('succeeded');
    expect(messages).toHaveLength(1);
    expect(await listMessages({ recipient: 'Grok' })).toHaveLength(0);
    expect(JSON.parse(messages[0]?.body ?? '{}')).toMatchObject({
      card_id: view.card.card_id,
      payload_digest: view.card.payload_digest,
      owner_seat: 'Grok',
    });
  });

  test('default Dispatch adapter still delivers to t3-desktop when owner resolution returns null', async () => {
    const view = await defaultCardView();
    const dispatch = createDefaultOperatorCardChannels({
      fetch: globalThis.fetch,
      resolve_owner: mock(async () => null),
    }).find(channel => channel.channel === 'dispatch');
    if (!dispatch) throw new Error('dispatch_channel_missing');
    await dispatch.deliver(view, `operator-card:${view.card.card_id}:dispatch`);
    const messages = await listMessages({ recipient: 't3-desktop' });
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]?.body ?? '{}').owner_seat).toBeNull();
    // Fence 281: an acting-xo report also reaches the operator mailbox.
    const operatorRows = await listMessages({ recipient: 'operator' });
    expect(operatorRows).toHaveLength(1);
    expect(operatorRows[0]?.correlation_id).toBe(messages[0]?.correlation_id);
  });

  test('default builder-monitor adapter uses injected fetch and frozen payload', async () => {
    const view = await defaultCardView();
    const calls: Array<{ url: string; body: unknown }> = [];
    const injected = mock(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const builder = createDefaultOperatorCardChannels({
      fetch: injected,
      builder_monitor_url: 'https://monitor.test/status',
    }).find(channel => channel.channel === 'builder_monitor');
    if (!builder) throw new Error('builder_channel_missing');
    const result = await builder.deliver(view, 'unused');
    expect(result.outcome).toBe('succeeded');
    expect(calls).toEqual([
      {
        url: 'https://monitor.test/status',
        body: {
          builder: 'Cauldron',
          wo_id: view.card.wo_id,
          action: 'needs_human',
          detail: view.card.blocker,
          card_id: view.card.card_id,
        },
      },
    ]);
  });

  test('default builder-monitor adapter retries only 429 and treats 5xx as indeterminate', async () => {
    const view = await defaultCardView();
    for (const [status, outcome] of [
      [401, 'permanent_failure'],
      [422, 'permanent_failure'],
      [429, 'transient_failure'],
      [500, 'indeterminate'],
      [503, 'indeterminate'],
    ] as const) {
      const builder = createDefaultOperatorCardChannels({
        fetch: mock(async () => new Response('failure', { status })) as typeof fetch,
      }).find(channel => channel.channel === 'builder_monitor');
      if (!builder) throw new Error('builder_channel_missing');
      expect((await builder.deliver(view, 'unused')).outcome).toBe(outcome);
    }
  });

  test('no-notion-network: default channels are dispatch and builder_monitor only', async () => {
    const urls: string[] = [];
    const injected = mock(async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const channels = createDefaultOperatorCardChannels({
      fetch: injected,
      resolve_owner: async () => 'operator',
    });
    expect(channels.map(channel => channel.channel).sort()).toEqual([
      'builder_monitor',
      'dispatch',
    ]);
    const view = await defaultCardView();
    await runDueOperatorCardDeliveries({
      channels,
      owner: 'no-notion-runner',
      now: new Date(Date.now() + 1_000).toISOString(),
    });
    expect(urls.some(url => url.includes('api.notion.com'))).toBe(false);
    const delivered = await getOperatorCard(view.card.card_id);
    expect(delivered?.jobs.map(job => job.channel).sort()).toEqual(['builder_monitor', 'dispatch']);
  });

  test('leftover-notion-job-retired closes the legacy job and continues', async () => {
    const view = await defaultCardView();
    const dueAt = view.card.created_at;
    await getDatabase().query(
      `INSERT INTO overseer_operator_card_delivery_jobs (
        card_id, channel, state, attempts_started, next_attempt_at, fencing_token, updated_at
      ) VALUES ($1, 'notion', 'pending', 0, $2, 0, $2)`,
      [view.card.card_id, dueAt]
    );
    const delivered: string[] = [];
    const channels: OperatorCardChannel[] = ['builder_monitor', 'dispatch'].map(channel => ({
      channel,
      deliver: async () => {
        delivered.push(channel);
        return { outcome: 'succeeded' as const, sanitized_status: 'delivered' };
      },
      reconcile: async () => ({ outcome: 'indeterminate' as const, sanitized_status: 'unknown' }),
    }));
    const injected = mock(async () => {
      throw new Error('network_must_not_be_called');
    }) as typeof fetch;
    globalThis.fetch = injected;

    const completed = await runDueOperatorCardDeliveries({
      channels,
      owner: 'retire-runner',
      now: dueAt,
    });

    expect(completed.map(job => job.channel).sort()).toEqual([
      'builder_monitor',
      'dispatch',
      'notion',
    ]);
    const after = await getOperatorCard(view.card.card_id);
    const notionJob = after?.jobs.find(job => job.channel === 'notion');
    const notionReceipts = after?.receipts.filter(receipt => receipt.channel === 'notion') ?? [];
    expect(notionJob?.state).toBe('exhausted');
    expect(notionReceipts).toHaveLength(1);
    expect(notionReceipts[0]).toMatchObject({
      phase: 'terminal',
      outcome: 'permanent_failure',
      sanitized_status: 'channel_retired',
      attempt_number: notionJob?.attempts_started,
      fencing_token: notionJob?.fencing_token,
    });
    expect(delivered.sort()).toEqual(['builder_monitor', 'dispatch']);
    expect(injected).not.toHaveBeenCalled();
  });

  test('active-channel-missing-still-errors', async () => {
    await defaultCardView();
    await expect(
      runDueOperatorCardDeliveries({
        channels: [],
        owner: 'missing-adapter-runner',
        now: new Date(Date.now() + 1_000).toISOString(),
      })
    ).rejects.toThrow(/^operator_card_channel_missing:(dispatch|builder_monitor)$/);
  });
});

// WO-HARNESS-OVERSEER-OWNER-ROUTING-01 Tests 9-13: delivery in mode on.
describe.serial('owner routing delivery (mode on)', () => {
  const homes: string[] = [];
  const oldHome = process.env.ARCHON_HOME;
  const oldUrl = process.env.DATABASE_URL;
  const oldMode = process.env.OVERSEER_OWNER_ROUTING;
  const oldRoutes = process.env.OVERSEER_OWNER_ROUTES_JSON;

  /** Point ARCHON_HOME at a fresh database dir; every dir is removed in afterEach. */
  async function freshDatabase(): Promise<void> {
    await closeDatabase();
    resetDatabase();
    const home = join(import.meta.dir, `.test-owner-routing-${Date.now()}-${Math.random()}`);
    homes.push(home);
    process.env.ARCHON_HOME = home;
  }

  beforeEach(async () => {
    await freshDatabase();
    delete process.env.DATABASE_URL;
    delete process.env.OVERSEER_OWNER_ROUTING;
    delete process.env.OVERSEER_OWNER_ROUTES_JSON;
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    for (const [key, value] of [
      ['ARCHON_HOME', oldHome],
      ['DATABASE_URL', oldUrl],
      ['OVERSEER_OWNER_ROUTING', oldMode],
      ['OVERSEER_OWNER_ROUTES_JSON', oldRoutes],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const home of homes.splice(0)) removeTempDirWithRetry(home);
  });

  const VALID_ROUTES = JSON.stringify({
    codex: { recipient: 't3-desk-local', thread_id: 'thread-codex-1' },
  });
  const ownedCodex = {
    kind: 'owned',
    owner: 'codex',
    assigned_by: 'John Ranson',
    assigned_at: '2026-11-08',
    quote: 'codex owns this',
    source_issue: 'thinmansoftware/bdc-xo#4321',
  } as const;
  const unownedIssue = {
    kind: 'unowned',
    reason: 'no_owner_label',
    source_issue: 'thinmansoftware/bdc-xo#4321',
  } as const;

  async function ownerCard(input: {
    actor: string;
    next: string;
    assignment: WorkOwnerResolution;
    blocker?: string;
  }) {
    const built = buildOperatorCard(identity, {
      repository: 'thinmansoftware/bdc-harness',
      branch: 'feat/example',
      pr_url: 'https://github.com/thinmansoftware/bdc-harness/pull/9001',
      pr_number: 9001,
      head_sha: null,
      base_branch: 'dev',
      base_sha: null,
      checks: {},
      mergeability: 'unknown',
      blocker: input.blocker ?? 'verify failed',
      mechanical_evidence: {},
      recovery_attempted: {},
      proposed_remediation: {},
      next_permitted_action: input.next,
      responsible_actor: input.actor,
      actionable_event_at: identity.event_created_at,
      required_ruling: null,
      evidence_links: {},
      lifecycle_classification: 'recovery',
      governance_classification: 'information-only',
      owner_assignment: input.assignment,
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
    if (!view) throw new Error('owner_card_missing');
    return view;
  }

  const ownedCard = () =>
    ownerCard({ actor: 'codex', next: 'owner codex acts on this card', assignment: ownedCodex });
  const unownedCard = () =>
    ownerCard({
      actor: 'unowned',
      next: 'John assigns an owner on bdc-xo#4321',
      assignment: unownedIssue,
    });

  function channelsFor(overrides: {
    routes?: string;
    useEnv?: boolean;
    logger?: { warn(obj: Record<string, unknown>, msg: string): void };
  }) {
    const monitorBodies: Record<string, unknown>[] = [];
    const fetchSpy = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      monitorBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const channels = createDefaultOperatorCardChannels({
      fetch: fetchSpy,
      builder_monitor_url: 'https://monitor.test/status',
      resolve_owner: async () => null,
      logger: overrides.logger ?? { warn: () => undefined },
      ...(overrides.useEnv
        ? {}
        : { owner_routing_mode: 'on' as const, owner_routes_json: overrides.routes }),
    });
    const dispatch = channels.find(channel => channel.channel === 'dispatch');
    const builder = channels.find(channel => channel.channel === 'builder_monitor');
    if (!dispatch || !builder) throw new Error('channels_missing');
    return { dispatch, builder, monitorBodies };
  }

  async function rows() {
    return {
      owner: await listMessages({ recipient: 't3-desk-local' }),
      t3: await listMessages({ recipient: 't3-desktop' }),
      operator: await listMessages({ recipient: 'operator' }),
    };
  }

  test('Test 9: an invalid route table writes no owner row and logs routes_invalid', async () => {
    for (const routes of [
      '{not json',
      JSON.stringify({ codex: { recipient: 'codex-worker', thread_id: 'thread-codex-1' } }),
      JSON.stringify({ codex: { recipient: 't3-desk-local', thread_id: '  ' } }),
    ]) {
      await freshDatabase();
      const warnings: string[] = [];
      const { dispatch } = channelsFor({
        routes,
        logger: { warn: (_obj, msg) => warnings.push(msg) },
      });
      const view = await ownedCard();
      await dispatch.deliver(view, `operator-card:${view.card.card_id}:dispatch`);
      const after = await rows();
      expect(warnings).toEqual(['overseer.owner_routing.routes_invalid']);
      expect(after.owner).toHaveLength(0);
      expect(after.operator).toHaveLength(0);
      expect(after.t3).toHaveLength(1);
    }
    expect(parseOwnerRouteTable('{not json').invalid_reason).toBe('not_json');
    expect(parseOwnerRouteTable('[]').invalid_reason).toBe('not_an_object');
    expect(parseOwnerRouteTable(undefined)).toEqual({
      routes: new Map(),
      invalid_reason: null,
    });
  }, 30_000);

  test('Test 9 (d): a valid single entry from the environment writes the owner row', async () => {
    process.env.OVERSEER_OWNER_ROUTING = 'on';
    process.env.OVERSEER_OWNER_ROUTES_JSON = VALID_ROUTES;
    const { dispatch } = channelsFor({ useEnv: true });
    const view = await ownedCard();
    await dispatch.deliver(view, `operator-card:${view.card.card_id}:dispatch`);
    const after = await rows();
    expect(after.owner).toHaveLength(1);
    expect(after.owner[0]?.recipient).toBe('t3-desk-local');
  }, 30_000);

  test('Test 10: owned with a route delivers exactly one owner row', async () => {
    const { dispatch } = channelsFor({ routes: VALID_ROUTES });
    const view = await ownedCard();
    const key = `operator-card:${view.card.card_id}:dispatch`;
    expect((await dispatch.deliver(view, key)).outcome).toBe('succeeded');
    expect((await dispatch.deliver(view, key)).outcome).toBe('succeeded');
    expect((await dispatch.reconcile(view, 1)).outcome).toBe('succeeded');

    const after = await rows();
    expect(after.owner).toHaveLength(1);
    expect(after.t3).toHaveLength(1);
    expect(after.operator).toHaveLength(0);
    // The t3-desktop copy is the unchanged run report for this card.
    expect(after.t3[0]?.task_type).toBe('run_report');
    expect(after.t3[0]?.idempotency_key).toBe(key);
    expect(JSON.parse(after.t3[0]?.body ?? '{}')).toMatchObject({
      kind: 'overseer_run_report',
      card_id: view.card.card_id,
      responsible_actor: 'codex',
    });
    const owner = after.owner[0];
    expect(owner?.task_type).toBe('agent_message');
    expect(owner?.sender_principal_id).toBe('system:overseer');
    expect(owner?.idempotency_key).toBe(`${key}:owner`);
    expect(owner?.idempotency_key.endsWith(':owner')).toBe(true);
    const body = JSON.parse(owner?.body ?? '{}') as Record<string, string>;
    expect(body.schema).toBe('t3-thread-nudge/v1');
    expect(body.thread_id).toBe('thread-codex-1');
    expect(body.reason).toBe('owner-escalation');
    expect(body.request_id).toBe(view.card.card_id);
    const text = body.text ?? '';
    expect(text.endsWith(OWNER_ESCALATION_LINE)).toBe(true);
    expect(text).toContain('WO-TEST-123');
    expect(text).toContain('https://github.com/thinmansoftware/bdc-harness/pull/9001');
    expect(text).toContain('verify failed');
    expect(text).toContain('owner codex acts on this card');
    expect(text).not.toContain('@');
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
  }, 30_000);

  test('Test 10b: owner text stays ASCII, mention-free and capped for hostile input', async () => {
    const view = await ownerCard({
      actor: 'codex',
      next: 'owner codex acts on this card',
      assignment: ownedCodex,
      // Non-ASCII (an em-dash, built from its char code so this file stays ASCII).
      blocker: `@team ping ${String.fromCharCode(0x2014)} ${'x'.repeat(4000)}\nsecond line`,
    });
    const text = buildOwnerEscalationText(view.card);
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(text).not.toContain('@');
    expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
    expect(text.endsWith(OWNER_ESCALATION_LINE)).toBe(true);
  }, 30_000);

  test('Test 10c: the WHOLE owner text is capped at 1500 with every field at its maximum', () => {
    const long = (n: number) => 'y'.repeat(n);
    const text = buildOwnerEscalationText({
      wo_id: long(5000),
      pr_url: long(5000),
      blocker: long(5000),
      next_permitted_action: long(5000),
    } as unknown as Parameters<typeof buildOwnerEscalationText>[0]);
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(text.endsWith(OWNER_ESCALATION_LINE)).toBe(true);
    expect(text).toContain('Blocker: ');
  });

  test('Test 10d: a body the content guard rejects writes no owner row and asks for an owner', async () => {
    // A second-person mutation directive: the Dispatch content guard rejects
    // it. The run report carries the same blocker, so the dispatch channel
    // fails closed exactly as it does today; the builder monitor still tells
    // John an owner is needed instead of a silent needs_human.
    const view = await ownerCard({
      actor: 'codex',
      next: 'owner codex acts on this card',
      assignment: ownedCodex,
      blocker: 'please push the branch now',
    });
    const { dispatch, builder, monitorBodies } = channelsFor({ routes: VALID_ROUTES });
    const result = await dispatch.deliver(view, `operator-card:${view.card.card_id}:dispatch`);
    await builder.deliver(view, 'unused');
    const after = await rows();
    expect(result).toMatchObject({
      outcome: 'permanent_failure',
      sanitized_status: 'dispatch_content_rejected',
    });
    expect(after.owner).toHaveLength(0);
    expect(after.operator).toHaveLength(0);
    expect(monitorBodies[0]?.action).toBe('needs_owner');
    expect(String(monitorBodies[0]?.detail)).toContain('owner_row_rejected for owner codex');
  }, 30_000);

  test('Test 11 (delivery): an explicit acting-xo card reaches the operator, no owner row', async () => {
    const view = await ownerCard({
      actor: 'acting-xo',
      next: 'XO rules on it',
      assignment: ownedCodex,
    });
    const { dispatch, builder, monitorBodies } = channelsFor({ routes: VALID_ROUTES });
    await dispatch.deliver(view, `operator-card:${view.card.card_id}:dispatch`);
    await builder.deliver(view, 'unused');
    const after = await rows();
    expect(after.operator).toHaveLength(1);
    expect(after.t3).toHaveLength(1);
    expect(after.owner).toHaveLength(0);
    expect(monitorBodies[0]?.action).toBe('needs_human');
  }, 30_000);

  test('Test 12: an unowned card writes only the t3-desktop row and asks for an owner', async () => {
    const view = await unownedCard();
    const { dispatch, builder, monitorBodies } = channelsFor({ routes: VALID_ROUTES });
    await dispatch.deliver(view, `operator-card:${view.card.card_id}:dispatch`);
    await builder.deliver(view, 'unused');
    const after = await rows();
    expect(after.operator).toHaveLength(0);
    expect(after.owner).toHaveLength(0);
    expect(after.t3).toHaveLength(1);
    expect(monitorBodies).toEqual([
      {
        builder: 'Cauldron',
        wo_id: view.card.wo_id,
        action: 'needs_owner',
        detail:
          'verify failed | assign an owner: https://github.com/thinmansoftware/bdc-xo/issues/4321',
        card_id: view.card.card_id,
      },
    ]);
  }, 30_000);

  test('Test 13: an owned card with no route asks for an owner (owner_route_missing)', async () => {
    for (const routes of [undefined, '', '{not json']) {
      await freshDatabase();
      const view = await ownedCard();
      const { dispatch, builder, monitorBodies } = channelsFor({ routes });
      await dispatch.deliver(view, `operator-card:${view.card.card_id}:dispatch`);
      await builder.deliver(view, 'unused');
      const after = await rows();
      expect(after.operator).toHaveLength(0);
      expect(after.owner).toHaveLength(0);
      expect(after.t3).toHaveLength(1);
      expect(monitorBodies[0]?.action).toBe('needs_owner');
      expect(String(monitorBodies[0]?.detail)).toContain('owner_route_missing');
      expect(String(monitorBodies[0]?.detail)).toContain(
        'https://github.com/thinmansoftware/bdc-xo/issues/4321'
      );
    }
  }, 30_000);

  test('modes off and shadow leave delivery unchanged for the same owned card', async () => {
    for (const mode of ['off', 'shadow'] as const) {
      await freshDatabase();
      const view = await unownedCard();
      const monitorBodies: Record<string, unknown>[] = [];
      const channels = createDefaultOperatorCardChannels({
        fetch: mock(async (_input: string | URL | Request, init?: RequestInit) => {
          monitorBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response('ok', { status: 200 });
        }) as typeof fetch,
        resolve_owner: async () => null,
        owner_routing_mode: mode,
        owner_routes_json: VALID_ROUTES,
      });
      for (const channel of channels) {
        await channel.deliver(view, `operator-card:${view.card.card_id}:${channel.channel}`);
      }
      const after = await rows();
      expect(after.owner).toHaveLength(0);
      expect(after.t3).toHaveLength(1);
      expect(monitorBodies[0]?.action).toBe('needs_human');
      expect(monitorBodies[0]?.detail).toBe('verify failed');
    }
  }, 30_000);
});
