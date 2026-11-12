import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { join } from 'path';
import { closeDatabase, getDatabase, getOperatorCard, resetDatabase } from '@archon/core/db';
import { assessDispatchMessageBody } from '@archon/core/utils/dispatch-content-guard';
import { buildDispatchRunReportBody, runEscalation } from '../escalate';
import { buildOperatorCard, type OperatorCardPayload } from '../operator-card';
import type { WorkOwnerResolution } from '../owner-resolution';

describe.serial('durable escalation card', () => {
  let home = '';
  const originalHome = process.env.ARCHON_HOME;
  const originalUrl = process.env.DATABASE_URL;

  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    home = join(import.meta.dir, `.archon-escalate-${Date.now()}-${Math.random()}`);
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    if (originalHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalHome;
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    removeTempDirWithRetry(home);
  });

  test('persists a card whose guarded Dispatch body derives from canonical payload', async () => {
    const card = await runEscalation(
      'run-report-1',
      { decision: 'escalate', reason: 'gate rejected' },
      {
        errorClass: 'validator_rejected',
        woId: 'WO-RPT-01',
        nodeId: 'gate',
        repository: 'thinmansoftware/bdc-harness',
      },
      {
        sourceEventId: 'event-report-1',
        eventType: 'node_failed',
        stepName: 'gate',
        eventCreatedAt: '2026-07-12T00:00:00.000Z',
      }
    );
    const body = buildDispatchRunReportBody(card);
    expect(assessDispatchMessageBody('run_report', body)).toEqual({ allowed: true });
    expect(JSON.parse(body)).toEqual(
      expect.objectContaining({ card_id: card.card_id, payload_digest: card.payload_digest })
    );
  });

  test('deduplicates the same stable source event into one card and two jobs', async () => {
    const args = [
      'run-dedupe',
      { decision: 'escalate' as const, reason: 'unknown failure' },
      {
        errorClass: 'unknown' as const,
        woId: 'WO-DEDUPE-01',
        repository: 'thinmansoftware/bdc-harness',
      },
      {
        sourceEventId: 'event-dedupe-1',
        eventType: 'node_failed',
        stepName: 'verify',
        eventCreatedAt: '2026-07-12T00:00:00.000Z',
      },
    ] as const;
    const first = await runEscalation(...args);
    const second = await runEscalation(...args);
    const view = await getOperatorCard(first.card_id);
    expect(second.card_id).toBe(first.card_id);
    expect(view?.jobs).toHaveLength(2);
  });

  test('rejects an escalation without stable source event identity', async () => {
    await expect(
      runEscalation(
        'run-missing-source',
        { decision: 'escalate', reason: 'unknown failure' },
        { errorClass: 'unknown', woId: 'WO-MISSING-01' },
        {
          sourceEventId: '',
          eventType: 'node_failed',
          stepName: 'verify',
          eventCreatedAt: '2026-07-12T00:00:00.000Z',
        }
      )
    ).rejects.toThrow('operator_card_identity_invalid:source_event_id');
  });
});

// WO-HARNESS-OVERSEER-OWNER-ROUTING-01 Tests 4-7 and 11 (card creation).
describe.serial('owner routing on escalation cards', () => {
  let home = '';
  const originalHome = process.env.ARCHON_HOME;
  const originalUrl = process.env.DATABASE_URL;
  const originalMode = process.env.OVERSEER_OWNER_ROUTING;

  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    home = join(import.meta.dir, `.archon-owner-routing-${Date.now()}-${Math.random()}`);
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;
    delete process.env.OVERSEER_OWNER_ROUTING;
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    if (originalHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalHome;
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (originalMode === undefined) delete process.env.OVERSEER_OWNER_ROUTING;
    else process.env.OVERSEER_OWNER_ROUTING = originalMode;
    removeTempDirWithRetry(home);
  });

  const source = {
    sourceEventId: 'event-owner-1',
    eventType: 'node_failed',
    stepName: 'verify',
    eventCreatedAt: '2026-11-08T12:00:00.000Z',
  };
  const decision = { decision: 'escalate' as const, reason: 'verify failed' };
  const context = {
    errorClass: 'validator_rejected' as const,
    woId: 'WO-OWNER-ROUTE-01',
    nodeId: 'verify',
    repository: 'thinmansoftware/bdc-harness',
    prUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/9001',
    prNumber: 9001,
  };
  const unownedIssue: WorkOwnerResolution = {
    kind: 'unowned',
    reason: 'no_owner_label',
    source_issue: 'thinmansoftware/bdc-xo#4321',
  };
  const ownedCodex: WorkOwnerResolution = {
    kind: 'owned',
    owner: 'codex',
    assigned_by: 'John Ranson',
    assigned_at: '2026-11-08',
    quote: 'codex owns this',
    source_issue: 'thinmansoftware/bdc-xo#4321',
  };

  const DEV_BASELINE_CARD_ID = '05fad1633aad730dba62d54406db8f09738e4aae1999a612ed3cd126a195c3f3';
  const DEV_BASELINE_PAYLOAD_DIGEST =
    'af550721fb55368744dce8cc46b092bed6fb5db8175ceb5ad3963a5bcf12d791';

  /** The exact payload dev cda6cb87 wrote for these inputs (no owner_assignment). */
  const devBaselinePayload: OperatorCardPayload = {
    repository: 'thinmansoftware/bdc-harness',
    branch: null,
    pr_url: 'https://github.com/thinmansoftware/bdc-harness/pull/9001',
    pr_number: 9001,
    head_sha: null,
    base_branch: null,
    base_sha: null,
    checks: {},
    mergeability: 'unknown',
    blocker: 'verify failed',
    mechanical_evidence: { node_id: 'verify', validator_output: null },
    recovery_attempted: {},
    proposed_remediation: { steps: [] },
    next_permitted_action: 'await operator ruling',
    responsible_actor: 'acting-xo',
    actionable_event_at: '2026-11-08T12:00:00.000Z',
    required_ruling: null,
    evidence_links: {},
    lifecycle_classification: 'recovery',
    governance_classification: 'information-only',
  };

  async function cardCount(): Promise<number> {
    const result = await getDatabase().query<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM overseer_operator_cards'
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  test('Test 4: mode on, unowned card names the unowned bucket and the issue', async () => {
    process.env.OVERSEER_OWNER_ROUTING = 'on';
    const card = await runEscalation('run-owner-4', decision, context, source, {
      resolveOwner: async () => unownedIssue,
    });
    expect(card.responsible_actor).toBe('unowned');
    expect(card.next_permitted_action).toBe('John assigns an owner on bdc-xo#4321');
    expect(card.payload.owner_assignment).toEqual(unownedIssue);
    expect((card.payload.owner_assignment as { reason: string }).reason).toBe('no_owner_label');
    expect(card.responsible_actor).not.toBe('acting-xo');
    expect(card.next_permitted_action).not.toBe('await operator ruling');
  }, 30_000);

  test('Test 4b: mode on, unowned with no WO issue names the WO', async () => {
    process.env.OVERSEER_OWNER_ROUTING = 'on';
    const card = await runEscalation('run-owner-4b', decision, context, source, {
      resolveOwner: async () => ({ kind: 'unowned', reason: 'no_issue', source_issue: null }),
    });
    expect(card.responsible_actor).toBe('unowned');
    expect(card.next_permitted_action).toBe(
      'John assigns an owner (no WO issue found for WO-OWNER-ROUTE-01)'
    );
  }, 30_000);

  test('Test 5: mode on, owned card carries the owner and full provenance', async () => {
    process.env.OVERSEER_OWNER_ROUTING = 'on';
    const resolveOwner = mock(async () => ownedCodex);
    const card = await runEscalation('run-owner-5', decision, context, source, { resolveOwner });
    expect(resolveOwner).toHaveBeenCalledWith({
      woId: 'WO-OWNER-ROUTE-01',
      repository: 'thinmansoftware/bdc-harness',
      prNumber: 9001,
    });
    expect(card.responsible_actor).toBe('codex');
    expect(card.next_permitted_action).toBe('owner codex acts on this card');
    expect(card.payload.owner_assignment).toEqual({
      kind: 'owned',
      owner: 'codex',
      assigned_by: 'John Ranson',
      assigned_at: '2026-11-08',
      quote: 'codex owns this',
      source_issue: 'thinmansoftware/bdc-xo#4321',
    });
  }, 30_000);

  test('Test 6: unset and "ON " are byte-identical to the dev baseline; resolver not called', async () => {
    const baseline = buildOperatorCard(
      {
        identity_version: 'overseer-actionable-event-v1',
        source_event_id: source.sourceEventId,
        run_id: 'run-owner-6',
        wo_id: context.woId,
        event_type: source.eventType,
        step_name: source.stepName,
        event_created_at: source.eventCreatedAt,
        error_class: context.errorClass,
      },
      devBaselinePayload
    );
    for (const mode of [undefined, 'ON ']) {
      await closeDatabase();
      resetDatabase();
      if (mode === undefined) delete process.env.OVERSEER_OWNER_ROUTING;
      else process.env.OVERSEER_OWNER_ROUTING = mode;
      const resolveOwner = mock(async () => ownedCodex);
      const card = await runEscalation(
        'run-owner-6',
        decision,
        context,
        { ...source, sourceEventId: source.sourceEventId },
        { resolveOwner }
      );
      expect(resolveOwner).not.toHaveBeenCalled();
      expect(card.card_id).toBe(baseline.card_id);
      expect(card.payload).toEqual(baseline.payload as unknown as Record<string, unknown>);
      expect(card.payload_digest).toBe(baseline.payload_digest);
      // Captured by running dev 1bad06ad's own escalate.ts + operator-card.ts
      // (unchanged from cda6cb87 in these files) with these exact inputs.
      expect(card.card_id).toBe(DEV_BASELINE_CARD_ID);
      expect(card.payload_digest).toBe(DEV_BASELINE_PAYLOAD_DIGEST);
      expect('owner_assignment' in card.payload).toBe(false);
    }
  }, 30_000);

  test('Test 6b: shadow adds owner_assignment but keeps acting-xo and the default action', async () => {
    process.env.OVERSEER_OWNER_ROUTING = 'shadow';
    const card = await runEscalation('run-owner-6s', decision, context, source, {
      resolveOwner: async () => ownedCodex,
    });
    expect(card.payload.owner_assignment).toEqual(ownedCodex);
    expect(card.responsible_actor).toBe('acting-xo');
    expect(card.next_permitted_action).toBe('await operator ruling');
  }, 30_000);

  test('Test 7: a retry after a label change returns the first card and does not throw', async () => {
    process.env.OVERSEER_OWNER_ROUTING = 'on';
    const first = await runEscalation('run-owner-7', decision, context, source, {
      resolveOwner: async () => unownedIssue,
    });
    const second = await runEscalation('run-owner-7', decision, context, source, {
      resolveOwner: async () => ownedCodex,
    });
    expect(second.card_id).toBe(first.card_id);
    expect(second.payload_digest).toBe(first.payload_digest);
    expect(second.responsible_actor).toBe('unowned');
    expect(await cardCount()).toBe(1);
  }, 30_000);

  test('Test 7b: with routing off a digest conflict still propagates', async () => {
    const first = await runEscalation('run-owner-7b', decision, context, source);
    expect(first.responsible_actor).toBe('acting-xo');
    await expect(
      runEscalation('run-owner-7b', { ...decision, reason: 'different blocker' }, context, source)
    ).rejects.toThrow('operator_card_digest_conflict');
  }, 30_000);

  test('Test 11 (card): an explicit acting-xo caller value wins in mode on', async () => {
    process.env.OVERSEER_OWNER_ROUTING = 'on';
    const card = await runEscalation(
      'run-owner-11',
      decision,
      { ...context, responsibleActor: 'acting-xo', nextPermittedAction: 'XO rules on it' },
      source,
      { resolveOwner: async () => ownedCodex }
    );
    expect(card.responsible_actor).toBe('acting-xo');
    expect(card.next_permitted_action).toBe('XO rules on it');
    expect(card.payload.owner_assignment).toEqual(ownedCodex);
  }, 30_000);
});
