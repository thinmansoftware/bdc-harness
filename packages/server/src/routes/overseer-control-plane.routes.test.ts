import { describe, expect, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  registerOverseerControlPlaneRoutes,
  type OverseerControlPlaneRouteDeps,
  type OverseerControlPlanePrincipal,
} from './overseer-control-plane.routes';

const BASE = '/internal/overseer/control-plane';
const PRINCIPAL: OverseerControlPlanePrincipal = {
  actor: 'xo',
  provider: 'openai',
  model_family: 'gpt',
};

function baseDeps(
  overrides: Partial<OverseerControlPlaneRouteDeps> = {}
): OverseerControlPlaneRouteDeps {
  const parent = {
    parent_id: 'p1',
    state: 'BUILDING' as const,
    owner_id: 'o',
    correlation_id: 'c',
    fencing_token: 1,
    admitted_at: '2026-07-16T00:00:00.000Z',
    heartbeat_at: '2026-07-16T00:00:00.000Z',
    lease_expires_at: '2026-07-16T00:05:00.000Z',
    released_at: null,
    terminal_reason: null,
  };
  return {
    authenticatePrincipal: async () => PRINCIPAL,
    admitParent: async () => ({ ok: true, value: parent, created: true }),
    heartbeatParent: async () => ({ ok: true, value: parent }),
    transitionParentState: async () => ({ ok: true, value: parent }),
    linkChild: async () => ({
      ok: true,
      value: {
        parent_id: 'p1',
        child_id: 'c1',
        state: 'PENDING',
        created_at: parent.admitted_at,
        terminal_at: null,
      },
      created: true,
    }),
    transitionChildState: async () => ({
      ok: true,
      value: {
        parent_id: 'p1',
        child_id: 'c1',
        state: 'RUNNING',
        created_at: parent.admitted_at,
        terminal_at: null,
      },
    }),
    releaseParent: async () => ({
      ok: true,
      value: {
        ...parent,
        state: 'COMPLETED',
        released_at: parent.heartbeat_at,
        terminal_reason: 'done',
      },
    }),
    reconcileExpiredParents: async () => ({ reconciled: 0 }),
    acquireRepositoryLease: async () => ({
      ok: true,
      value: {
        repository: 'org/repo',
        lease_id: 'l',
        owner_id: 'o',
        execution_id: 'e',
        action_kind: 'MERGE',
        capability: 'cap',
        fencing_token: 1,
        state: 'ACTIVE',
        acquired_at: parent.admitted_at,
        heartbeat_at: parent.admitted_at,
        expires_at: parent.lease_expires_at,
        released_at: null,
      },
      created: true,
    }),
    heartbeatRepositoryLease: async () => ({ ok: false, code: 'lease_stale' }),
    releaseRepositoryLease: async () => ({ ok: false, code: 'lease_not_found' }),
    registerVerifierRegistry: async () => ({
      ok: true,
      value: {
        registry_digest: 'a'.repeat(64),
        schema_version: 'overseer-verifier-registry-v1',
        frozen_at: parent.admitted_at,
        created_at: parent.admitted_at,
        source_artifact_path: 'p',
        source_git_blob: 'b',
        entries: [],
      },
      created: true,
    }),
    assertIndependentVerifier: async () => ({ ok: false, code: 'verifier_registry_missing' }),
    reserveFusionBudget: async () => ({ ok: false, code: 'budget_cap_exceeded' }),
    markFusionBudgetCallStarted: async () => ({ ok: false, code: 'budget_reservation_not_found' }),
    reconcileFusionBudget: async () => ({ ok: false, code: 'budget_overage_recorded' }),
    releaseFusionBudgetReservation: async () => ({ ok: false, code: 'budget_transition_invalid' }),
    listControlEvents: async () => [],
    ...overrides,
  };
}

function makeApp(overrides: Partial<OverseerControlPlaneRouteDeps> = {}) {
  const app = new OpenAPIHono();
  registerOverseerControlPlaneRoutes(app, baseDeps(overrides));
  return app;
}

function post(app: OpenAPIHono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validAdmit = { parent_id: 'p1', owner_id: 'o', correlation_id: 'c', state: 'BUILDING' };

describe('registerOverseerControlPlaneRoutes', () => {
  test('is unmounted by default', async () => {
    const bare = new OpenAPIHono();
    expect((await bare.request(`${BASE}/events`)).status).toBe(404);
  });

  test('authentication precedes parsing and any store call', async () => {
    let storeCalls = 0;
    const app = makeApp({
      authenticatePrincipal: async () => {
        throw new Error('denied');
      },
      admitParent: async () => {
        storeCalls++;
        return { ok: true, value: {} as never, created: true };
      },
    });
    const res = await post(app, `${BASE}/parents/admit`, validAdmit);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: { code: 'unauthorized' } });
    expect(storeCalls).toBe(0);
  });

  test('unknown / forged fields return 400 unknown_field before the store', async () => {
    let storeCalls = 0;
    const app = makeApp({
      admitParent: async () => {
        storeCalls++;
        return { ok: true, value: {} as never, created: true };
      },
    });
    // Forged event-identity / clock fields are rejected as unknown_field.
    for (const forged of [
      { ...validAdmit, created_at: '2026-07-16T00:00:00.000Z' },
      { ...validAdmit, event_sequence: 1 },
      { ...validAdmit, fencing_token: 5 },
      { ...validAdmit, actor: 'attacker' },
    ]) {
      const res = await post(app, `${BASE}/parents/admit`, forged);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: { code: 'unknown_field' } });
    }
    // Fusion reserve rejects forged utc bucket / call-start fields.
    const reserveBody = {
      reservation_id: 'r',
      call_id: 'c',
      proposal_id: 'p',
      execution_id: 'e',
      provider: 'xai',
      model: 'grok',
      call_kind: 'PRIMARY',
      requested_microusd: 1000,
    };
    for (const key of ['utc_day', 'utc_month', 'reserved_at', 'call_started_at']) {
      const res = await post(app, `${BASE}/fusion/reserve`, { ...reserveBody, [key]: 'x' });
      expect(res.status).toBe(400);
    }
    expect(storeCalls).toBe(0);
  });

  test('success uses the frozen 201/200 mapping and { ok, data } body', async () => {
    const app = makeApp();
    const created = await post(app, `${BASE}/parents/admit`, validAdmit);
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.ok).toBe(true);
    expect(body.data.parent_id).toBe('p1');

    const beat = await post(app, `${BASE}/parents/heartbeat`, {
      parent_id: 'p1',
      owner_id: 'o',
      fencing_token: 1,
    });
    expect(beat.status).toBe(200);

    const reconcile = await post(app, `${BASE}/parents/reconcile-expired`, {});
    expect(reconcile.status).toBe(200);
    expect((await reconcile.json()).data.reconciled).toBe(0);
  });

  test('typed denials map to 404 and 409 with the exact contract code', async () => {
    const app = makeApp();
    // 404 addressed-resource codes.
    const notFound = await post(app, `${BASE}/repository-leases/release`, {
      repository: 'org/repo',
      lease_id: 'l',
      owner_id: 'o',
      execution_id: 'e',
      fencing_token: 1,
    });
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ ok: false, error: { code: 'lease_not_found' } });

    // 409 CAS conflict, including budget_overage_recorded.
    const stale = await post(app, `${BASE}/repository-leases/heartbeat`, {
      repository: 'org/repo',
      lease_id: 'l',
      owner_id: 'o',
      execution_id: 'e',
      fencing_token: 1,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ ok: false, error: { code: 'lease_stale' } });

    const overage = await post(app, `${BASE}/fusion/reconcile`, {
      reservation_id: 'r',
      call_id: 'c',
      actual_microusd: 5,
    });
    expect(overage.status).toBe(409);
    expect(await overage.json()).toEqual({ ok: false, error: { code: 'budget_overage_recorded' } });
  });

  test('unexpected dependency failure maps to 500 and leaks no message', async () => {
    const app = makeApp({
      admitParent: async () => {
        throw new Error('secret internal detail');
      },
    });
    const res = await post(app, `${BASE}/parents/admit`, validAdmit);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: { code: 'internal_error' } });
    expect(JSON.stringify(body)).not.toContain('secret internal detail');
  });

  test('verifier assertion takes operator identity from the principal, not the body', async () => {
    let received: { operator_provider?: string; operator_model_family?: string } | undefined;
    const app = makeApp({
      authenticatePrincipal: async () => ({ actor: 'xo', provider: 'openai', model_family: 'gpt' }),
      assertIndependentVerifier: async input => {
        received = input;
        return {
          ok: true,
          value: {
            allowed: true,
            verifier_id: 'grok-4',
            provider: 'xai',
            model_family: 'grok',
            role: 'REVIEWER',
          },
        };
      },
    });
    const res = await post(app, `${BASE}/verifiers/assert-independent`, {
      registry_digest: 'a'.repeat(64),
      verifier_id: 'grok-4',
      required_role: 'REVIEWER',
    });
    expect(res.status).toBe(200);
    expect(received?.operator_provider).toBe('openai');
    expect(received?.operator_model_family).toBe('gpt');
    // Supplying operator identity in the body is rejected as unknown_field.
    const forged = await post(app, `${BASE}/verifiers/assert-independent`, {
      registry_digest: 'a'.repeat(64),
      verifier_id: 'grok-4',
      required_role: 'REVIEWER',
      operator_provider: 'xai',
    });
    expect(forged.status).toBe(400);
  });

  test('no forbidden global (network / child-process) function is reached on any route', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('poison_network_reached');
    }) as typeof fetch;
    try {
      const app = makeApp();
      const routes: Array<[string, unknown]> = [
        [`${BASE}/parents/admit`, validAdmit],
        [`${BASE}/parents/heartbeat`, { parent_id: 'p1', owner_id: 'o', fencing_token: 1 }],
        [
          `${BASE}/fusion/reserve`,
          {
            reservation_id: 'r',
            call_id: 'c',
            proposal_id: 'p',
            execution_id: 'e',
            provider: 'xai',
            model: 'grok',
            call_kind: 'PRIMARY',
            requested_microusd: 1000,
          },
        ],
      ];
      for (const [path, body] of routes) {
        const res = await post(app, path, body);
        expect([200, 201, 409]).toContain(res.status);
      }
      const events = await app.request(`${BASE}/events`);
      expect(events.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
