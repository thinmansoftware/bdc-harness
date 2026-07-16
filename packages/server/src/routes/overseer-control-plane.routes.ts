import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type {
  acquireRepositoryMutationLease,
  admitOverseerParent,
  assertIndependentVerifier,
  heartbeatOverseerParent,
  heartbeatRepositoryMutationLease,
  linkOverseerChild,
  listOverseerControlEvents,
  markFusionBudgetCallStarted,
  reconcileExpiredParentCommitments,
  reconcileFusionBudget,
  registerVerifierRegistry,
  releaseFusionBudgetReservation,
  releaseOverseerParent,
  releaseRepositoryMutationLease,
  reserveFusionBudget,
  transitionOverseerChildState,
  transitionOverseerParentState,
} from '@archon/core/db/overseer-control-plane';
import {
  childLinkSchema,
  childTransitionSchema,
  fusionIdentitySchema,
  fusionReconcileSchema,
  fusionReleaseSchema,
  fusionReserveSchema,
  overseerControlEventsQuerySchema,
  overseerControlPlaneResponseSchema,
  parentAdmitSchema,
  parentHeartbeatSchema,
  parentReleaseSchema,
  parentTransitionSchema,
  reconcileExpiredParentsSchema,
  repositoryLeaseAcquireSchema,
  repositoryLeaseFenceSchema,
  verifierAssertionSchema,
  verifierRegistryRegisterSchema,
} from './schemas/overseer-control-plane.schemas';

export interface OverseerControlPlanePrincipal {
  readonly actor: string;
  readonly provider: string;
  readonly model_family: string;
}

export interface OverseerControlPlaneRouteDeps {
  readonly authenticatePrincipal: (context: Context) => Promise<OverseerControlPlanePrincipal>;
  readonly admitOverseerParent: typeof admitOverseerParent;
  readonly heartbeatOverseerParent: typeof heartbeatOverseerParent;
  readonly transitionOverseerParentState: typeof transitionOverseerParentState;
  readonly linkOverseerChild: typeof linkOverseerChild;
  readonly transitionOverseerChildState: typeof transitionOverseerChildState;
  readonly releaseOverseerParent: typeof releaseOverseerParent;
  readonly reconcileExpiredParentCommitments: typeof reconcileExpiredParentCommitments;
  readonly acquireRepositoryMutationLease: typeof acquireRepositoryMutationLease;
  readonly heartbeatRepositoryMutationLease: typeof heartbeatRepositoryMutationLease;
  readonly releaseRepositoryMutationLease: typeof releaseRepositoryMutationLease;
  readonly registerVerifierRegistry: typeof registerVerifierRegistry;
  readonly assertIndependentVerifier: typeof assertIndependentVerifier;
  readonly reserveFusionBudget: typeof reserveFusionBudget;
  readonly markFusionBudgetCallStarted: typeof markFusionBudgetCallStarted;
  readonly reconcileFusionBudget: typeof reconcileFusionBudget;
  readonly releaseFusionBudgetReservation: typeof releaseFusionBudgetReservation;
  readonly listOverseerControlEvents: typeof listOverseerControlEvents;
}

type TypedResult =
  | { readonly ok: true; readonly value: unknown; readonly created?: boolean }
  | { readonly ok: false; readonly code: string };

const response = {
  description: 'Overseer control-plane result',
  content: { 'application/json': { schema: overseerControlPlaneResponseSchema } },
} as const;

const responses = {
  200: response,
  201: response,
  400: response,
  401: response,
  404: response,
  409: response,
  500: response,
} as const;

function postRoute(path: string, schema: z.ZodTypeAny): unknown {
  return createRoute({
    method: 'post',
    path,
    request: { body: { content: { 'application/json': { schema } } } },
    responses,
  });
}

const route = {
  parentAdmit: postRoute('/internal/overseer/control-plane/parents/admit', parentAdmitSchema),
  parentHeartbeat: postRoute(
    '/internal/overseer/control-plane/parents/heartbeat',
    parentHeartbeatSchema
  ),
  parentTransition: postRoute(
    '/internal/overseer/control-plane/parents/transition',
    parentTransitionSchema
  ),
  childLink: postRoute('/internal/overseer/control-plane/parents/children/link', childLinkSchema),
  childTransition: postRoute(
    '/internal/overseer/control-plane/parents/children/transition',
    childTransitionSchema
  ),
  parentRelease: postRoute('/internal/overseer/control-plane/parents/release', parentReleaseSchema),
  reconcileExpired: postRoute(
    '/internal/overseer/control-plane/parents/reconcile-expired',
    reconcileExpiredParentsSchema
  ),
  repositoryAcquire: postRoute(
    '/internal/overseer/control-plane/repository-leases/acquire',
    repositoryLeaseAcquireSchema
  ),
  repositoryHeartbeat: postRoute(
    '/internal/overseer/control-plane/repository-leases/heartbeat',
    repositoryLeaseFenceSchema
  ),
  repositoryRelease: postRoute(
    '/internal/overseer/control-plane/repository-leases/release',
    repositoryLeaseFenceSchema
  ),
  registryRegister: postRoute(
    '/internal/overseer/control-plane/verifier-registries/register',
    verifierRegistryRegisterSchema
  ),
  verifierAssert: postRoute(
    '/internal/overseer/control-plane/verifiers/assert-independent',
    verifierAssertionSchema
  ),
  fusionReserve: postRoute('/internal/overseer/control-plane/fusion/reserve', fusionReserveSchema),
  fusionStarted: postRoute(
    '/internal/overseer/control-plane/fusion/mark-started',
    fusionIdentitySchema
  ),
  fusionReconcile: postRoute(
    '/internal/overseer/control-plane/fusion/reconcile',
    fusionReconcileSchema
  ),
  fusionRelease: postRoute('/internal/overseer/control-plane/fusion/release', fusionReleaseSchema),
  events: createRoute({
    method: 'get',
    path: '/internal/overseer/control-plane/events',
    request: { query: overseerControlEventsQuerySchema },
    responses,
  }),
} as const;

const missingCodes = new Set([
  'parent_not_found',
  'child_not_found',
  'lease_not_found',
  'verifier_registry_missing',
  'budget_reservation_not_found',
]);

function typedStatus(result: TypedResult, createStatus: 200 | 201): 200 | 201 | 404 | 409 {
  if (result.ok) return result.created === false ? 200 : createStatus;
  return missingCodes.has(result.code) ? 404 : 409;
}

function unknownField(error: z.ZodError): boolean {
  return error.issues.some(issue => issue.code === 'unrecognized_keys');
}

function validationHook(
  result: { readonly success: boolean; readonly error?: z.ZodError },
  context: Context
): Response | undefined {
  if (result.success || !result.error) return;
  return context.json(
    {
      ok: false,
      error: { code: unknownField(result.error) ? 'unknown_field' : 'invalid_request' },
    },
    400
  );
}

async function authenticate(
  context: Context,
  principals: WeakMap<Request, OverseerControlPlanePrincipal>
): Promise<OverseerControlPlanePrincipal | Response> {
  const principal = principals.get(context.req.raw);
  return principal ?? context.json({ ok: false, error: { code: 'unauthorized' } }, 401);
}

function registerBodyRoute(
  app: OpenAPIHono,
  definition: unknown,
  schema: z.ZodTypeAny,
  createStatus: 200 | 201,
  principals: WeakMap<Request, OverseerControlPlanePrincipal>,
  operation: (body: unknown, principal: OverseerControlPlanePrincipal) => Promise<TypedResult>
): void {
  app.openapi(
    definition as never,
    (async (context: Context) => {
      const principal = await authenticate(context, principals);
      if (principal instanceof Response) return principal;
      let raw: unknown;
      try {
        raw = await context.req.json();
      } catch {
        return context.json({ ok: false, error: { code: 'invalid_request' } }, 400);
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return context.json(
          {
            ok: false,
            error: { code: unknownField(parsed.error) ? 'unknown_field' : 'invalid_request' },
          },
          400
        );
      }
      try {
        const result = await operation(parsed.data, principal);
        const status = typedStatus(result, createStatus);
        return result.ok
          ? context.json({ ok: true, data: result.value }, status as never)
          : context.json({ ok: false, error: { code: result.code } }, status as never);
      } catch {
        return context.json({ ok: false, error: { code: 'internal_error' } }, 500);
      }
    }) as never,
    validationHook as never
  );
}

export function registerOverseerControlPlaneRoutes(
  app: OpenAPIHono,
  dependencies: OverseerControlPlaneRouteDeps
): void {
  const principals = new WeakMap<Request, OverseerControlPlanePrincipal>();
  app.use('/internal/overseer/control-plane/*', async (context, next) => {
    try {
      principals.set(context.req.raw, await dependencies.authenticatePrincipal(context));
      await next();
      return undefined;
    } catch {
      return context.json({ ok: false, error: { code: 'unauthorized' } }, 401);
    }
  });

  registerBodyRoute(app, route.parentAdmit, parentAdmitSchema, 201, principals, body =>
    dependencies.admitOverseerParent(body as never)
  );
  registerBodyRoute(app, route.parentHeartbeat, parentHeartbeatSchema, 200, principals, body =>
    dependencies.heartbeatOverseerParent(body as never)
  );
  registerBodyRoute(app, route.parentTransition, parentTransitionSchema, 200, principals, body =>
    dependencies.transitionOverseerParentState(body as never)
  );
  registerBodyRoute(app, route.childLink, childLinkSchema, 201, principals, body =>
    dependencies.linkOverseerChild(body as never)
  );
  registerBodyRoute(app, route.childTransition, childTransitionSchema, 200, principals, body =>
    dependencies.transitionOverseerChildState(body as never)
  );
  registerBodyRoute(app, route.parentRelease, parentReleaseSchema, 200, principals, body =>
    dependencies.releaseOverseerParent(body as never)
  );
  registerBodyRoute(
    app,
    route.reconcileExpired,
    reconcileExpiredParentsSchema,
    200,
    principals,
    () => dependencies.reconcileExpiredParentCommitments()
  );
  registerBodyRoute(
    app,
    route.repositoryAcquire,
    repositoryLeaseAcquireSchema,
    201,
    principals,
    body => dependencies.acquireRepositoryMutationLease(body as never)
  );
  registerBodyRoute(
    app,
    route.repositoryHeartbeat,
    repositoryLeaseFenceSchema,
    200,
    principals,
    body => dependencies.heartbeatRepositoryMutationLease(body as never)
  );
  registerBodyRoute(
    app,
    route.repositoryRelease,
    repositoryLeaseFenceSchema,
    200,
    principals,
    body => dependencies.releaseRepositoryMutationLease(body as never)
  );
  registerBodyRoute(
    app,
    route.registryRegister,
    verifierRegistryRegisterSchema,
    201,
    principals,
    body => dependencies.registerVerifierRegistry(body as never)
  );
  registerBodyRoute(
    app,
    route.verifierAssert,
    verifierAssertionSchema,
    200,
    principals,
    (body, principal) =>
      dependencies.assertIndependentVerifier({
        ...(body as {
          registry_digest: string;
          verifier_id: string;
          required_role: 'REVIEWER' | 'RED_TEAM' | 'FUSION' | 'MERGE_STEWARD';
        }),
        operator_provider: principal.provider,
        operator_model_family: principal.model_family,
      })
  );
  registerBodyRoute(app, route.fusionReserve, fusionReserveSchema, 201, principals, body =>
    dependencies.reserveFusionBudget(body as never)
  );
  registerBodyRoute(app, route.fusionStarted, fusionIdentitySchema, 200, principals, body =>
    dependencies.markFusionBudgetCallStarted(body as never)
  );
  registerBodyRoute(app, route.fusionReconcile, fusionReconcileSchema, 200, principals, body =>
    dependencies.reconcileFusionBudget(body as never)
  );
  registerBodyRoute(app, route.fusionRelease, fusionReleaseSchema, 200, principals, body =>
    dependencies.releaseFusionBudgetReservation(body as never)
  );

  app.openapi(
    route.events,
    (async (context: Context) => {
      const principal = await authenticate(context, principals);
      if (principal instanceof Response) return principal;
      const parsed = overseerControlEventsQuerySchema.safeParse(context.req.query());
      if (!parsed.success) {
        return context.json(
          {
            ok: false,
            error: { code: unknownField(parsed.error) ? 'unknown_field' : 'invalid_request' },
          },
          400
        );
      }
      try {
        return context.json(
          { ok: true, data: await dependencies.listOverseerControlEvents(parsed.data) },
          200
        );
      } catch {
        return context.json({ ok: false, error: { code: 'internal_error' } }, 500);
      }
    }) as never,
    validationHook as never
  );
}
