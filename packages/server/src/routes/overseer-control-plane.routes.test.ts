import { describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  registerOverseerControlPlaneRoutes,
  type OverseerControlPlaneRouteDeps,
} from './overseer-control-plane.routes';

const ok = async (): Promise<{ ok: true; value: Record<string, never> }> => ({
  ok: true,
  value: {},
});

function dependencies(
  overrides: Partial<OverseerControlPlaneRouteDeps> = {}
): OverseerControlPlaneRouteDeps {
  return {
    authenticatePrincipal: mock(async () => ({
      actor: 'builder',
      provider: 'openai',
      model_family: 'gpt',
    })),
    admitOverseerParent: mock(ok),
    heartbeatOverseerParent: mock(ok),
    transitionOverseerParentState: mock(ok),
    linkOverseerChild: mock(ok),
    transitionOverseerChildState: mock(ok),
    releaseOverseerParent: mock(ok),
    reconcileExpiredParentCommitments: mock(ok),
    acquireRepositoryMutationLease: mock(ok),
    heartbeatRepositoryMutationLease: mock(ok),
    releaseRepositoryMutationLease: mock(ok),
    registerVerifierRegistry: mock(ok),
    assertIndependentVerifier: mock(ok),
    reserveFusionBudget: mock(ok),
    markFusionBudgetCallStarted: mock(ok),
    reconcileFusionBudget: mock(ok),
    releaseFusionBudgetReservation: mock(ok),
    listOverseerControlEvents: mock(async () => []),
    ...overrides,
  } as OverseerControlPlaneRouteDeps;
}

function post(app: OpenAPIHono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validParent = {
  parent_id: 'parent-1',
  owner_id: 'owner-1',
  correlation_id: 'correlation-1',
  state: 'BUILDING',
} as const;

describe('registerOverseerControlPlaneRoutes', () => {
  test('authenticates before strict parsing and maps frozen statuses without provider authority', async () => {
    const deniedStore = mock(ok);
    const deniedDeps = dependencies({
      authenticatePrincipal: mock(async () => {
        throw new Error('unauthorized');
      }),
      admitOverseerParent: deniedStore as never,
    });
    const deniedApp = new OpenAPIHono();
    registerOverseerControlPlaneRoutes(deniedApp, deniedDeps);
    const denied = await post(deniedApp, '/internal/overseer/control-plane/parents/admit', {
      forged_clock: true,
    });
    expect(denied.status).toBe(401);
    expect(deniedStore).toHaveBeenCalledTimes(0);

    const admit = mock(async () => ({ ok: true as const, value: { parent_id: 'parent-1' } }));
    const deps = dependencies({ admitOverseerParent: admit as never });
    const app = new OpenAPIHono();
    registerOverseerControlPlaneRoutes(app, deps);
    const unknown = await post(app, '/internal/overseer/control-plane/parents/admit', {
      ...validParent,
      lease_duration: 300,
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ ok: false, error: { code: 'unknown_field' } });
    expect(admit).toHaveBeenCalledTimes(0);

    const created = await post(app, '/internal/overseer/control-plane/parents/admit', validParent);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ ok: true, data: { parent_id: 'parent-1' } });
    expect(admit).toHaveBeenCalledTimes(1);

    const missingApp = new OpenAPIHono();
    registerOverseerControlPlaneRoutes(
      missingApp,
      dependencies({
        heartbeatOverseerParent: mock(async () => ({
          ok: false as const,
          code: 'parent_not_found' as const,
        })) as never,
      })
    );
    const missing = await post(missingApp, '/internal/overseer/control-plane/parents/heartbeat', {
      parent_id: 'missing',
      owner_id: 'owner',
      fencing_token: 1,
    });
    expect(missing.status).toBe(404);

    const conflictApp = new OpenAPIHono();
    registerOverseerControlPlaneRoutes(
      conflictApp,
      dependencies({
        reserveFusionBudget: mock(async () => ({
          ok: false as const,
          code: 'budget_cap_exceeded' as const,
        })) as never,
      })
    );
    const conflict = await post(conflictApp, '/internal/overseer/control-plane/fusion/reserve', {
      reservation_id: 'r',
      call_id: 'c',
      proposal_id: 'p',
      execution_id: 'e',
      provider: 'fake',
      model: 'fake-model',
      call_kind: 'PRIMARY',
      requested_microusd: 1,
    });
    expect(conflict.status).toBe(409);

    const unexpectedApp = new OpenAPIHono();
    registerOverseerControlPlaneRoutes(
      unexpectedApp,
      dependencies({
        reconcileExpiredParentCommitments: mock(async () => {
          throw new Error('database detail must not escape');
        }) as never,
      })
    );
    const unexpected = await post(
      unexpectedApp,
      '/internal/overseer/control-plane/parents/reconcile-expired',
      {}
    );
    expect(unexpected.status).toBe(500);
    expect(await unexpected.text()).not.toContain('database detail');
  });

  test('maps every exact create-class replay to frozen HTTP 200', async () => {
    const replay = mock(async () => ({ ok: true as const, created: false as const, value: {} }));
    const app = new OpenAPIHono();
    registerOverseerControlPlaneRoutes(
      app,
      dependencies({
        admitOverseerParent: replay as never,
        linkOverseerChild: replay as never,
        registerVerifierRegistry: replay as never,
        reserveFusionBudget: replay as never,
      })
    );

    const cases = [
      ['/internal/overseer/control-plane/parents/admit', validParent],
      [
        '/internal/overseer/control-plane/parents/children/link',
        { parent_id: 'parent-1', child_id: 'child-1', owner_id: 'owner-1', fencing_token: 1 },
      ],
      [
        '/internal/overseer/control-plane/verifier-registries/register',
        {
          schema_version: 'overseer-verifier-registry-v1',
          registry_digest: 'a'.repeat(64),
          entries: [],
          source_artifact_path: 'artifacts/verifiers.json',
          source_git_blob: 'b'.repeat(40),
        },
      ],
      [
        '/internal/overseer/control-plane/fusion/reserve',
        {
          reservation_id: 'reservation-1',
          call_id: 'call-1',
          proposal_id: 'proposal-1',
          execution_id: 'execution-1',
          provider: 'fake',
          model: 'fake-model',
          call_kind: 'PRIMARY',
          requested_microusd: 1,
        },
      ],
    ] as const;

    for (const [path, body] of cases) {
      const response = await post(app, path, body);
      expect(response.status).toBe(200);
    }
    expect(replay).toHaveBeenCalledTimes(4);
  });

  test('registers all exact routes and injects authenticated verifier identity', async () => {
    const assertIndependent = mock(ok);
    const listEvents = mock(async () => [{ event_id: 'ocp-event-1' }]);
    const app = new OpenAPIHono();
    registerOverseerControlPlaneRoutes(
      app,
      dependencies({
        assertIndependentVerifier: assertIndependent as never,
        listOverseerControlEvents: listEvents as never,
      })
    );

    const asserted = await post(
      app,
      '/internal/overseer/control-plane/verifiers/assert-independent',
      {
        registry_digest: 'a'.repeat(64),
        verifier_id: 'fable.review',
        required_role: 'REVIEWER',
      }
    );
    expect(asserted.status).toBe(200);
    expect(assertIndependent).toHaveBeenCalledWith({
      operator_provider: 'openai',
      operator_model_family: 'gpt',
      registry_digest: 'a'.repeat(64),
      verifier_id: 'fable.review',
      required_role: 'REVIEWER',
    });

    const events = await app.request(
      '/internal/overseer/control-plane/events?resource_kind=PARENT&resource_key=parent-1'
    );
    expect(events.status).toBe(200);
    expect(listEvents).toHaveBeenCalledWith({ resource_kind: 'PARENT', resource_key: 'parent-1' });

    const openapi = app.getOpenAPI31Document({ info: { title: 'test', version: '1' } });
    expect(Object.keys(openapi.paths ?? {}).sort()).toEqual(
      [
        '/internal/overseer/control-plane/events',
        '/internal/overseer/control-plane/fusion/mark-started',
        '/internal/overseer/control-plane/fusion/reconcile',
        '/internal/overseer/control-plane/fusion/release',
        '/internal/overseer/control-plane/fusion/reserve',
        '/internal/overseer/control-plane/parents/admit',
        '/internal/overseer/control-plane/parents/children/link',
        '/internal/overseer/control-plane/parents/children/transition',
        '/internal/overseer/control-plane/parents/heartbeat',
        '/internal/overseer/control-plane/parents/reconcile-expired',
        '/internal/overseer/control-plane/parents/release',
        '/internal/overseer/control-plane/parents/transition',
        '/internal/overseer/control-plane/repository-leases/acquire',
        '/internal/overseer/control-plane/repository-leases/heartbeat',
        '/internal/overseer/control-plane/repository-leases/release',
        '/internal/overseer/control-plane/verifier-registries/register',
        '/internal/overseer/control-plane/verifiers/assert-independent',
      ].sort()
    );
  });
});
