import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { installOverseerControlPlaneSqlite } from '@archon/core/db/overseer-control-plane-sqlite';

let database: SqliteAdapter;
let databasePath = '';
mock.module('@archon/core/db/connection', () => ({ getDatabase: () => database }));

import { authorizeFusionInvocation } from '../authorization.js';
import {
  FUSION_RECONCILIATION_WINDOW_MS,
  evaluateUnknownActualCostWindow,
  markFusionCallStarted,
  reconcileFusionCallCost,
  reserveFusionBudgetForCall,
} from '../budget.js';
import { buildFusionReceipt } from '../receipts.js';
import {
  fusionVerifierRegistryDigest,
  registerFrozenFusionVerifierRegistry,
  runM28BlindCalibration,
} from '../registry.js';
import type { FusionComponentModelV1 } from '../types.js';
import {
  makeFakeFusionGateway,
  type FakeFusionGatewayResult,
} from './fixtures/fusion-fake-gateway.js';
import fixture from './fixtures/fusion-verifier-registry.synthetic.json';

const registryFixture = fixture;
const componentModel: FusionComponentModelV1 = {
  verifier_id: 'fusion-independent-reviewer',
  provider: 'synthetic-provider',
  model_family: 'synthetic-family',
  model_id: 'synthetic-provider/synthetic-family-v1',
};

beforeEach(async () => {
  databasePath = join(process.cwd(), `.fusion-budget-receipts-${crypto.randomUUID()}.db`);
  database = new SqliteAdapter(databasePath);
  await installOverseerControlPlaneSqlite(database);
});

afterEach(async () => {
  await database.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${databasePath}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
});

async function ledgerRows(): Promise<
  {
    reservation_id: string;
    call_kind: string;
    requested_microusd: number;
    actual_microusd: number | null;
    status: string;
  }[]
> {
  const result = await database.query<{
    reservation_id: string;
    call_kind: string;
    requested_microusd: number;
    actual_microusd: number | null;
    status: string;
  }>(
    `SELECT reservation_id,call_kind,requested_microusd,actual_microusd,status
     FROM overseer_fusion_budget_reservations
     ORDER BY reserved_at,reservation_id`
  );
  return result.rows.map(row => ({
    ...row,
    requested_microusd: Number(row.requested_microusd),
    actual_microusd: row.actual_microusd === null ? null : Number(row.actual_microusd),
  }));
}

function reservationInput(index: number, estimatedCostUsd: number, callKind = 'PRIMARY') {
  return {
    reservation_id: `reservation-${index}`,
    call_id: `call-${index}`,
    proposal_id: 'proposal-fusion-budget',
    execution_id: 'execution-fusion-budget',
    provider: 'synthetic-provider',
    model: 'synthetic-family',
    call_kind: callKind as 'PRIMARY' | 'RETRY' | 'FALLBACK' | 'INDIRECT',
    estimated_cost_usd: estimatedCostUsd,
  };
}

async function registeredRegistry() {
  return registerFrozenFusionVerifierRegistry(registryFixture);
}

describe('Fusion M-42 budget authorization and receipts', () => {
  test('reservation is atomic under concurrent workers with no oversubscription', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        reserveFusionBudgetForCall(reservationInput(index, 3))
      )
    );

    expect(results.filter(result => result.ok)).toHaveLength(6);
    expect(
      results.filter(result => !result.ok && result.code === 'budget_cap_exceeded')
    ).toHaveLength(4);
    const rows = await ledgerRows();
    expect(rows).toHaveLength(6);
    expect(rows.reduce((sum, row) => sum + row.requested_microusd, 0)).toBe(18_000_000);
  });

  test('per-call cap refuses estimated cost over USD 3 before call start', async () => {
    const result = await reserveFusionBudgetForCall(reservationInput(1, 3.01));

    expect(result).toEqual({ ok: false, code: 'budget_cap_exceeded' });
    expect(await ledgerRows()).toHaveLength(0);
  });

  test('daily and monthly UTC caps include retries fallbacks and indirect invocations', async () => {
    const callKinds = ['PRIMARY', 'RETRY', 'FALLBACK', 'INDIRECT', 'PRIMARY', 'RETRY'] as const;
    const dayResults = await Promise.all(
      callKinds.map((callKind, index) =>
        reserveFusionBudgetForCall(reservationInput(index, 3, callKind))
      )
    );
    const dayBlocked = await reserveFusionBudgetForCall(reservationInput(99, 3, 'FALLBACK'));
    expect(dayResults.every(result => result.ok)).toBe(true);
    expect(dayBlocked).toEqual({ ok: false, code: 'budget_cap_exceeded' });
    expect((await ledgerRows()).map(row => row.call_kind)).toEqual([...callKinds]);

    database = new SqliteAdapter(databasePath);
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    for (let index = 0; index < 33; index += 1) {
      const day = String((index % 28) + 1).padStart(2, '0');
      await database.query(
        `INSERT INTO overseer_fusion_budget_reservations
         (reservation_id,call_id,proposal_id,execution_id,provider,model,call_kind,utc_day,utc_month,
          requested_microusd,actual_microusd,status,reserved_at,call_started_at,reconciled_at,released_at,release_reason)
         VALUES ($1,$2,'proposal-month','execution-month','synthetic-provider','synthetic-family','INDIRECT',
          $3,$4,3000000,3000000,'RECONCILED',$5,$5,$5,NULL,NULL)`,
        [
          `month-reservation-${index}`,
          `month-call-${index}`,
          `${month}-${day}`,
          month,
          `${month}-${day}T00:00:00.000Z`,
        ]
      );
    }
    const monthlyBlocked = await reserveFusionBudgetForCall({
      ...reservationInput(100, 2, 'INDIRECT'),
      reservation_id: 'month-over-cap',
      call_id: 'month-over-cap-call',
    });
    expect(monthlyBlocked).toEqual({ ok: false, code: 'budget_cap_exceeded' });
  });

  test('synthetic provider usage response reconciles ledger to actual cost', async () => {
    const reserve = await reserveFusionBudgetForCall(reservationInput(1, 1));
    if (!reserve.ok) throw new Error(reserve.code);
    const started = await markFusionCallStarted(reserve.reservation);
    if (!started.ok) throw new Error(started.code);
    const gateway = makeFakeFusionGateway({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      actual_cost_usd: 0.5,
    });
    const usage = (await gateway({
      role: 'fusion',
      modelId: 'synthetic-provider/synthetic-family-v1',
      prompt: 'synthetic prompt',
    })) as FakeFusionGatewayResult;
    const reconciled = await reconcileFusionCallCost(started.reservation, {
      actual_cost_usd: usage.syntheticUsage.actual_cost_usd,
    });

    expect(reconciled.ok).toBe(true);
    expect(await ledgerRows()).toEqual([
      {
        reservation_id: 'reservation-1',
        call_kind: 'PRIMARY',
        requested_microusd: 1_000_000,
        actual_microusd: 500_000,
        status: 'RECONCILED',
      },
    ]);
  });

  test('unknown actual cost past reconciliation window fails closed without releasing hold', async () => {
    const reserve = await reserveFusionBudgetForCall(reservationInput(1, 1));
    if (!reserve.ok) throw new Error(reserve.code);
    const started = await markFusionCallStarted(reserve.reservation);
    if (!started.ok) throw new Error(started.code);
    const result = evaluateUnknownActualCostWindow(
      started.reservation,
      Date.parse(started.reservation.call_started_at ?? '') + FUSION_RECONCILIATION_WINDOW_MS + 1
    );

    expect(result).toEqual({
      ok: false,
      code: 'reconciliation_window_expired',
      reservation: started.reservation,
    });
    expect(await ledgerRows()).toMatchObject([{ status: 'IN_FLIGHT', actual_microusd: null }]);
  });

  test('unregistered component model or provider family is blocked', async () => {
    const registry = await registeredRegistry();
    const result = await authorizeFusionInvocation(
      {
        invocation_id: 'invocation-unregistered',
        proposal_id: 'proposal-auth',
        verifier_registry_digest: registry.registry_digest,
        component_models: [{ ...componentModel, provider: 'hidden-provider' }],
        raw_dissent: 'raw dissent',
        prompt: 'prompt',
        result: 'result',
        model_disclosure: 'model disclosure',
        reserved_cost_usd: 1,
        actual_cost_usd: 0.5,
        reconciliation_status: 'reconciled',
        web_enabled: false,
        operator_provider: 'builder-provider',
        operator_model_family: 'builder-family',
      },
      registry
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('component_model_unregistered');
  });

  test('web enabled missing dissent missing disclosure and non-independent verifier are blocked', async () => {
    const registry = await registeredRegistry();
    const baseRequest = {
      invocation_id: 'invocation-negative-auth',
      proposal_id: 'proposal-auth',
      verifier_registry_digest: registry.registry_digest,
      component_models: [componentModel],
      raw_dissent: 'raw dissent',
      prompt: 'prompt',
      result: 'result',
      model_disclosure: 'model disclosure',
      reserved_cost_usd: 1,
      actual_cost_usd: 0.5,
      reconciliation_status: 'reconciled' as const,
      web_enabled: false,
      operator_provider: 'builder-provider',
      operator_model_family: 'builder-family',
    };

    const webEnabled = await authorizeFusionInvocation(
      { ...baseRequest, web_enabled: true },
      registry
    );
    const missingDissent = await authorizeFusionInvocation(
      { ...baseRequest, raw_dissent: '' },
      registry
    );
    const missingDisclosure = await authorizeFusionInvocation(
      { ...baseRequest, model_disclosure: '', component_models: [] },
      registry
    );
    const nonIndependent = await authorizeFusionInvocation(
      {
        ...baseRequest,
        component_models: [
          {
            verifier_id: 'fusion-action-owner',
            provider: 'builder-provider',
            model_family: 'builder-family',
            model_id: 'builder-provider/builder-family-v1',
          },
        ],
      },
      registry
    );

    expect(webEnabled).toMatchObject({ ok: false, code: 'web_enabled' });
    expect(missingDissent).toMatchObject({ ok: false, code: 'raw_dissent_missing' });
    expect(missingDisclosure).toMatchObject({ ok: false, code: 'model_disclosure_missing' });
    expect(nonIndependent).toMatchObject({ ok: false, code: 'verifier_not_independent' });
  });

  test('process restart mid-flight preserves reservation and circuit state without double spend', async () => {
    const reserve = await reserveFusionBudgetForCall(reservationInput(1, 1));
    if (!reserve.ok) throw new Error(reserve.code);
    const started = await markFusionCallStarted(reserve.reservation);
    if (!started.ok) throw new Error(started.code);

    await database.close();
    database = new SqliteAdapter(databasePath);
    await installOverseerControlPlaneSqlite(database);
    const replay = await reserveFusionBudgetForCall(reservationInput(1, 1));
    const rows = await ledgerRows();

    expect(replay.ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requested_microusd: 1_000_000, status: 'IN_FLIGHT' });
  });

  test('Fusion-required action cannot downgrade to cheaper verifier after Fusion failure', async () => {
    const registry = await registeredRegistry();
    const result = await authorizeFusionInvocation(
      {
        invocation_id: 'invocation-no-downgrade',
        proposal_id: 'proposal-auth',
        verifier_registry_digest: registry.registry_digest,
        component_models: [componentModel],
        raw_dissent: 'raw dissent',
        prompt: 'prompt',
        result: 'result',
        model_disclosure: 'model disclosure',
        reserved_cost_usd: 1,
        actual_cost_usd: null,
        reconciliation_status: 'blocked',
        web_enabled: false,
        operator_provider: 'builder-provider',
        operator_model_family: 'builder-family',
      },
      registry
    );

    expect(result.ok).toBe(false);
    expect('fallback_verifier' in result).toBe(false);
    expect('cheaper_verifier' in result).toBe(false);
    if (!result.ok && result.authorization) {
      expect('fallback_verifier' in result.authorization).toBe(false);
      expect('cheaper_verifier' in result.authorization).toBe(false);
    }
  });

  test('M-28 blind-calibration proof runs green against frozen registry', async () => {
    const registryDigest = fusionVerifierRegistryDigest(registryFixture.entries);
    expect(registryDigest).toHaveLength(64);

    const proof = runM28BlindCalibration(registryFixture);
    expect(proof).toEqual({
      ok: true,
      artifact_digest: fixture.m28_blind_calibration.expected_digest,
    });
  });

  test('receipt records digest artifacts and USD cost fields tied to event chain', async () => {
    const reserve = await reserveFusionBudgetForCall(reservationInput(1, 1));
    if (!reserve.ok) throw new Error(reserve.code);
    const started = await markFusionCallStarted(reserve.reservation);
    if (!started.ok) throw new Error(started.code);
    const reconciled = await reconcileFusionCallCost(started.reservation, {
      actual_cost_usd: 0.75,
    });
    if (!reconciled.ok) throw new Error(reconciled.code);

    const receipt = await buildFusionReceipt({
      invocation_id: 'invocation-receipt',
      proposal_id: 'proposal-receipt',
      verifier_registry_digest: fusionVerifierRegistryDigest(registryFixture.entries),
      component_models: [componentModel],
      raw_dissent: 'raw dissent',
      prompt: 'prompt',
      result: 'result',
      model_disclosure: 'model disclosure',
      reservation: reconciled.reservation,
    });

    expect(receipt.authorization.reserved_cost_usd).toBe(1);
    expect(receipt.authorization.actual_cost_usd).toBe(0.75);
    expect(receipt.authorization.raw_dissent_artifact_digest).toHaveLength(64);
    expect(receipt.authorization.prompt_digest).toHaveLength(64);
    expect(receipt.authorization.result_digest).toHaveLength(64);
    expect(receipt.event_count).toBeGreaterThanOrEqual(3);
  });
});
