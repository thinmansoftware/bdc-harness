/**
 * Authenticated, UNMOUNTED Overseer control-plane routes
 * (WO-HARNESS-OVERSEER-CONTROL-PLANE-01).
 *
 * `registerOverseerControlPlaneRoutes(app, deps)` requires an explicit deps object
 * with no defaults. Every handler authenticates BEFORE parsing or invoking any
 * store dependency. Operator identity and actor come from the authenticated
 * principal, never from the request body.
 *
 * This module imports NO provider, network, credential, child-process, or central
 * runtime module and remains UNMOUNTED until Slice 8 wires it into the server.
 * All type imports below are erased at compile time.
 */
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { z } from '@hono/zod-openapi';
import type {
  ControlResult,
  OverseerControlFailure,
  OverseerParentCommitment,
  OverseerParentChild,
  OverseerRepositoryLease,
  OverseerVerifierRegistry,
  OverseerFusionReservation,
  OverseerControlEvent,
  IndependentVerifierDecision,
  AdmitOverseerParentInput,
  HeartbeatOverseerParentInput,
  TransitionOverseerParentStateInput,
  LinkOverseerChildInput,
  TransitionOverseerChildStateInput,
  ReleaseOverseerParentInput,
  AcquireRepositoryMutationLeaseInput,
  HeartbeatRepositoryMutationLeaseInput,
  ReleaseRepositoryMutationLeaseInput,
  RegisterVerifierRegistryInput,
  AssertIndependentVerifierInput,
  ReserveFusionBudgetInput,
  MarkFusionBudgetCallStartedInput,
  ReconcileFusionBudgetInput,
  ReleaseFusionBudgetReservationInput,
  ListOverseerControlEventsFilter,
} from '@archon/core/db/overseer-control-plane';
import {
  parentAdmitBodySchema,
  parentHeartbeatBodySchema,
  parentTransitionBodySchema,
  childLinkBodySchema,
  childTransitionBodySchema,
  parentReleaseBodySchema,
  parentReconcileExpiredBodySchema,
  repositoryAcquireBodySchema,
  repositoryLeaseIdentityBodySchema,
  registryRegisterBodySchema,
  verifierAssertBodySchema,
  fusionReserveBodySchema,
  fusionMarkStartedBodySchema,
  fusionReconcileBodySchema,
  fusionReleaseBodySchema,
  controlEventsQuerySchema,
  controlPlaneResponseSchema,
} from './schemas/overseer-control-plane.schemas';

/** Strict authenticated principal; operator identity for verifier independence. */
export interface OverseerControlPlanePrincipal {
  readonly actor: string;
  readonly provider: string;
  readonly model_family: string;
}

export interface OverseerControlPlaneRouteDeps {
  readonly authenticatePrincipal: (context: Context) => Promise<OverseerControlPlanePrincipal>;
  readonly admitParent: (
    input: AdmitOverseerParentInput
  ) => Promise<ControlResult<OverseerParentCommitment>>;
  readonly heartbeatParent: (
    input: HeartbeatOverseerParentInput
  ) => Promise<ControlResult<OverseerParentCommitment>>;
  readonly transitionParentState: (
    input: TransitionOverseerParentStateInput
  ) => Promise<ControlResult<OverseerParentCommitment>>;
  readonly linkChild: (
    input: LinkOverseerChildInput
  ) => Promise<ControlResult<OverseerParentChild>>;
  readonly transitionChildState: (
    input: TransitionOverseerChildStateInput
  ) => Promise<ControlResult<OverseerParentChild>>;
  readonly releaseParent: (
    input: ReleaseOverseerParentInput
  ) => Promise<ControlResult<OverseerParentCommitment>>;
  readonly reconcileExpiredParents: () => Promise<{ readonly reconciled: number }>;
  readonly acquireRepositoryLease: (
    input: AcquireRepositoryMutationLeaseInput
  ) => Promise<ControlResult<OverseerRepositoryLease>>;
  readonly heartbeatRepositoryLease: (
    input: HeartbeatRepositoryMutationLeaseInput
  ) => Promise<ControlResult<OverseerRepositoryLease>>;
  readonly releaseRepositoryLease: (
    input: ReleaseRepositoryMutationLeaseInput
  ) => Promise<ControlResult<OverseerRepositoryLease>>;
  readonly registerVerifierRegistry: (
    input: RegisterVerifierRegistryInput
  ) => Promise<ControlResult<OverseerVerifierRegistry>>;
  readonly assertIndependentVerifier: (
    input: AssertIndependentVerifierInput
  ) => Promise<ControlResult<IndependentVerifierDecision>>;
  readonly reserveFusionBudget: (
    input: ReserveFusionBudgetInput
  ) => Promise<ControlResult<OverseerFusionReservation>>;
  readonly markFusionBudgetCallStarted: (
    input: MarkFusionBudgetCallStartedInput
  ) => Promise<ControlResult<OverseerFusionReservation>>;
  readonly reconcileFusionBudget: (
    input: ReconcileFusionBudgetInput
  ) => Promise<ControlResult<OverseerFusionReservation>>;
  readonly releaseFusionBudgetReservation: (
    input: ReleaseFusionBudgetReservationInput
  ) => Promise<ControlResult<OverseerFusionReservation>>;
  readonly listControlEvents: (
    filter: ListOverseerControlEventsFilter
  ) => Promise<readonly OverseerControlEvent[]>;
}

const BASE = '/internal/overseer/control-plane';

const NOT_FOUND_CODES: ReadonlySet<OverseerControlFailure> = new Set([
  'parent_not_found',
  'child_not_found',
  'lease_not_found',
  'verifier_registry_missing',
  'budget_reservation_not_found',
]);

const jsonResponse = {
  content: { 'application/json': { schema: controlPlaneResponseSchema } },
  description: 'Overseer control-plane result',
} as const;

function route(method: 'post' | 'get', path: string): ReturnType<typeof createRoute> {
  return createRoute({
    method,
    path,
    responses: {
      200: jsonResponse,
      201: jsonResponse,
      400: jsonResponse,
      401: jsonResponse,
      404: jsonResponse,
      409: jsonResponse,
      500: jsonResponse,
    },
  });
}

function errorBody(code: string): { ok: false; error: { code: string } } {
  return { ok: false as const, error: { code } };
}

async function authenticate(
  c: Context,
  deps: OverseerControlPlaneRouteDeps
): Promise<OverseerControlPlanePrincipal | null> {
  try {
    return await deps.authenticatePrincipal(c);
  } catch {
    return null;
  }
}

function statusForFailure(code: OverseerControlFailure): 404 | 409 {
  return NOT_FOUND_CODES.has(code) ? 404 : 409;
}

/** Map a mutation result to the frozen HTTP status + JSON body. */
function sendResult<T>(c: Context, result: ControlResult<T>): Response {
  if (result.ok) {
    const status = result.created === true ? 201 : 200;
    return c.json({ ok: true, data: result.value }, status);
  }
  return c.json(errorBody(result.code), statusForFailure(result.code));
}

type BodySchema = z.ZodType<Record<string, unknown>>;

/** Authenticate, then strict-parse the JSON body; on parse failure return 400. */
async function authAndParse<S extends BodySchema>(
  c: Context,
  deps: OverseerControlPlaneRouteDeps,
  schema: S
): Promise<
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'bad_request' }
  | {
      readonly kind: 'ok';
      readonly principal: OverseerControlPlanePrincipal;
      readonly body: z.infer<S>;
    }
> {
  const principal = await authenticate(c, deps);
  if (!principal) return { kind: 'unauthorized' };
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { kind: 'bad_request' };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { kind: 'bad_request' };
  return { kind: 'ok', principal, body: parsed.data as z.infer<S> };
}

export function registerOverseerControlPlaneRoutes(
  app: OpenAPIHono,
  deps: OverseerControlPlaneRouteDeps
): void {
  const handler =
    <S extends BodySchema>(
      schema: S,
      run: (
        body: z.infer<S>,
        principal: OverseerControlPlanePrincipal
      ) => Promise<Response | ControlResult<unknown>>
    ) =>
    async (c: Context): Promise<Response> => {
      const gate = await authAndParse(c, deps, schema);
      if (gate.kind === 'unauthorized') return c.json(errorBody('unauthorized'), 401);
      if (gate.kind === 'bad_request') return c.json(errorBody('unknown_field'), 400);
      try {
        const outcome = await run(gate.body, gate.principal);
        return outcome instanceof Response ? outcome : sendResult(c, outcome);
      } catch {
        return c.json(errorBody('internal_error'), 500);
      }
    };

  app.openapi(
    route('post', `${BASE}/parents/admit`),
    handler(parentAdmitBodySchema, (body, p) =>
      deps.admitParent({ ...body, actor: p.actor })
    ) as never
  );

  app.openapi(
    route('post', `${BASE}/parents/heartbeat`),
    handler(parentHeartbeatBodySchema, (body, p) =>
      deps.heartbeatParent({ ...body, actor: p.actor })
    ) as never
  );

  app.openapi(
    route('post', `${BASE}/parents/transition`),
    handler(parentTransitionBodySchema, (body, p) =>
      deps.transitionParentState({ ...body, actor: p.actor })
    ) as never
  );

  app.openapi(
    route('post', `${BASE}/parents/children/link`),
    handler(childLinkBodySchema, (body, p) => deps.linkChild({ ...body, actor: p.actor })) as never
  );

  app.openapi(
    route('post', `${BASE}/parents/children/transition`),
    handler(childTransitionBodySchema, (body, p) =>
      deps.transitionChildState({ ...body, actor: p.actor })
    ) as never
  );

  app.openapi(
    route('post', `${BASE}/parents/release`),
    handler(parentReleaseBodySchema, (body, p) =>
      deps.releaseParent({ ...body, actor: p.actor })
    ) as never
  );

  app.openapi(
    route('post', `${BASE}/parents/reconcile-expired`),
    handler(parentReconcileExpiredBodySchema, async () => {
      const value = await deps.reconcileExpiredParents();
      return { ok: true as const, value };
    }) as never
  );

  app.openapi(
    route('post', `${BASE}/repository-leases/acquire`),
    handler(repositoryAcquireBodySchema, (body, p) =>
      deps.acquireRepositoryLease({ ...body, actor: p.actor })
    ) as never
  );

  app.openapi(
    route('post', `${BASE}/repository-leases/heartbeat`),
    handler(repositoryLeaseIdentityBodySchema, (body, p) =>
      deps.heartbeatRepositoryLease({ ...body, actor: p.actor })
    ) as never
  );

  app.openapi(
    route('post', `${BASE}/repository-leases/release`),
    handler(repositoryLeaseIdentityBodySchema, (body, p) =>
      deps.releaseRepositoryLease({ ...body, actor: p.actor })
    ) as never
  );

  app.openapi(
    route('post', `${BASE}/verifier-registries/register`),
    handler(registryRegisterBodySchema, (body, p) =>
      deps.registerVerifierRegistry({ ...body, actor: p.actor })
    ) as never
  );

  app.openapi(
    route('post', `${BASE}/verifiers/assert-independent`),
    handler(verifierAssertBodySchema, (body, p) =>
      deps.assertIndependentVerifier({
        registry_digest: body.registry_digest,
        verifier_id: body.verifier_id,
        required_role: body.required_role,
        operator_provider: p.provider,
        operator_model_family: p.model_family,
      })
    ) as never
  );

  app.openapi(
    route('post', `${BASE}/fusion/reserve`),
    handler(fusionReserveBodySchema, (body, p) =>
      deps.reserveFusionBudget({ ...body, actor: p.actor })
    ) as never
  );

  app.openapi(
    route('post', `${BASE}/fusion/mark-started`),
    handler(fusionMarkStartedBodySchema, (body, p) =>
      deps.markFusionBudgetCallStarted({ ...body, actor: p.actor })
    ) as never
  );

  app.openapi(
    route('post', `${BASE}/fusion/reconcile`),
    handler(fusionReconcileBodySchema, (body, p) =>
      deps.reconcileFusionBudget({ ...body, actor: p.actor })
    ) as never
  );

  app.openapi(
    route('post', `${BASE}/fusion/release`),
    handler(fusionReleaseBodySchema, (body, p) =>
      deps.releaseFusionBudgetReservation({ ...body, actor: p.actor })
    ) as never
  );

  app.openapi(route('get', `${BASE}/events`), (async (c: Context): Promise<Response> => {
    const principal = await authenticate(c, deps);
    if (!principal) return c.json(errorBody('unauthorized'), 401);
    const parsed = controlEventsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json(errorBody('unknown_field'), 400);
    try {
      const events = await deps.listControlEvents(parsed.data);
      return c.json({ ok: true, data: events }, 200);
    } catch {
      return c.json(errorBody('internal_error'), 500);
    }
  }) as never);
}
