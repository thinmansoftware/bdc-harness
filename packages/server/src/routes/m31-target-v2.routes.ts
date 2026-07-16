import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type {
  AppendM31DiscrepancyV2Input,
  CreateM31ActionProposalV2Input,
  M31ActionProposalV2,
  M31LiveObservationV2,
  M31PermitResultV2,
  M31TargetV2TypedFailure,
  M31SnapshotV2,
  M31DiscrepancyV2,
  ResolveM31DiscrepancyV2Input,
  RegisterM31SnapshotV2Input,
} from '@archon/core/db/m31-target-v2';
import {
  m31CompareV2RequestSchema,
  m31DiscrepancyV2RequestSchema,
  m31IdParamsSchema,
  m31ProposalV2RequestSchema,
  m31SnapshotDiscrepancyParamsSchema,
  m31SnapshotV2RequestSchema,
  m31V2ResponseSchema,
} from './schemas/m31-target-v2.schemas';

const jsonResponse = {
  content: { 'application/json': { schema: m31V2ResponseSchema } },
  description: 'M-31 target v2 result',
} as const;

const createSnapshotRoute = createRoute({
  method: 'post',
  path: '/api/overseer/m31/v2/snapshots',
  request: { body: { content: { 'application/json': { schema: m31SnapshotV2RequestSchema } } } },
  responses: { 201: jsonResponse, 400: jsonResponse, 401: jsonResponse },
});
const getSnapshotRoute = createRoute({
  method: 'get',
  path: '/api/overseer/m31/v2/snapshots/{id}',
  request: { params: m31IdParamsSchema },
  responses: { 200: jsonResponse, 401: jsonResponse, 404: jsonResponse },
});
const appendDiscrepancyRoute = createRoute({
  method: 'post',
  path: '/api/overseer/m31/v2/snapshots/{snapshot_id}/discrepancies',
  request: {
    params: m31SnapshotDiscrepancyParamsSchema,
    body: { content: { 'application/json': { schema: m31DiscrepancyV2RequestSchema } } },
  },
  responses: { 201: jsonResponse, 400: jsonResponse, 401: jsonResponse },
});
const createProposalRoute = createRoute({
  method: 'post',
  path: '/api/overseer/m31/v2/proposals',
  request: { body: { content: { 'application/json': { schema: m31ProposalV2RequestSchema } } } },
  responses: { 201: jsonResponse, 400: jsonResponse, 401: jsonResponse, 409: jsonResponse },
});
const getProposalRoute = createRoute({
  method: 'get',
  path: '/api/overseer/m31/v2/proposals/{id}',
  request: { params: m31IdParamsSchema },
  responses: { 200: jsonResponse, 401: jsonResponse, 404: jsonResponse },
});
const compareRoute = createRoute({
  method: 'post',
  path: '/api/overseer/m31/v2/proposals/{id}/compare-and-consume',
  request: {
    params: m31IdParamsSchema,
    body: { content: { 'application/json': { schema: m31CompareV2RequestSchema } } },
  },
  responses: { 200: jsonResponse, 400: jsonResponse, 401: jsonResponse, 409: jsonResponse },
});

export interface M31TargetV2RouteDeps {
  readonly authenticatePrincipal: (request: Request) => Promise<void>;
  readonly registerSnapshot: (input: RegisterM31SnapshotV2Input) => Promise<M31SnapshotV2>;
  readonly getSnapshot: (snapshotId: string) => Promise<M31SnapshotV2 | null>;
  readonly appendDiscrepancy: (input: AppendM31DiscrepancyV2Input) => Promise<M31DiscrepancyV2>;
  readonly resolveDiscrepancy: (input: ResolveM31DiscrepancyV2Input) => Promise<M31DiscrepancyV2>;
  readonly createProposal: (
    input: CreateM31ActionProposalV2Input
  ) => Promise<
    | { readonly ok: true; readonly value: M31ActionProposalV2 }
    | { readonly ok: false; readonly failure: M31TargetV2TypedFailure }
  >;
  readonly getProposal: (proposalId: string) => Promise<M31ActionProposalV2 | null>;
  readonly preparePermit: (input: {
    readonly proposal_id: string;
    readonly observation: M31LiveObservationV2;
    readonly validity_window_ms?: number;
  }) => Promise<M31PermitResultV2>;
}

async function authenticated(c: Context, deps: M31TargetV2RouteDeps): Promise<Response | null> {
  try {
    await deps.authenticatePrincipal(c.req.raw);
    return null;
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }
}

function badRequest(c: Context, error: unknown): Response {
  return c.json(
    { error: error instanceof Error ? error.message : 'm31_target_v2_request_failed' },
    400
  );
}

export function registerM31TargetV2Routes(app: OpenAPIHono, deps: M31TargetV2RouteDeps): void {
  app.openapi(createSnapshotRoute, (async (c: Context) => {
    const denied = await authenticated(c, deps);
    if (denied) return denied;
    try {
      const body = m31SnapshotV2RequestSchema.parse(await c.req.json());
      return c.json(await deps.registerSnapshot(body), 201);
    } catch (error) {
      return badRequest(c, error);
    }
  }) as never);

  app.openapi(getSnapshotRoute, (async (c: Context) => {
    const denied = await authenticated(c, deps);
    if (denied) return denied;
    const { id } = m31IdParamsSchema.parse(c.req.param());
    const snapshot = await deps.getSnapshot(id);
    return snapshot ? c.json(snapshot, 200) : c.json({ error: 'not_found' }, 404);
  }) as never);

  app.openapi(appendDiscrepancyRoute, (async (c: Context) => {
    const denied = await authenticated(c, deps);
    if (denied) return denied;
    try {
      const { snapshot_id: snapshotId } = m31SnapshotDiscrepancyParamsSchema.parse(c.req.param());
      const body = m31DiscrepancyV2RequestSchema.parse(await c.req.json());
      const input: AppendM31DiscrepancyV2Input = {
        snapshot_id: snapshotId,
        evidence_git_blob: body.evidence_git_blob,
        affected_targets: body.affected_targets,
        conflict: body.conflict,
        recorded_by: body.recorded_by,
        predecessor_discrepancy_id: body.predecessor_discrepancy_id,
        resolution: body.resolution,
        resolved_by: body.resolved_by,
      };
      const value = input.resolution
        ? await deps.resolveDiscrepancy(input as ResolveM31DiscrepancyV2Input)
        : await deps.appendDiscrepancy(input);
      return c.json(value, 201);
    } catch (error) {
      return badRequest(c, error);
    }
  }) as never);

  app.openapi(createProposalRoute, (async (c: Context) => {
    const denied = await authenticated(c, deps);
    if (denied) return denied;
    try {
      const body = m31ProposalV2RequestSchema.parse(await c.req.json());
      const input: CreateM31ActionProposalV2Input = {
        repository: body.repository,
        target: body.target,
        snapshot_id: body.snapshot_id,
        evidence_path: body.evidence_path,
        action_kind: body.action_kind,
        action_parameters: body.action_parameters,
        actor: body.actor,
        policy_digest: body.policy_digest,
        verifier_registry_digest: body.verifier_registry_digest,
        ttl_ms: body.ttl_ms,
        max_evidence_age_ms: body.max_evidence_age_ms,
      };
      const result = await deps.createProposal(input);
      return c.json(result, result.ok ? 201 : 409);
    } catch (error) {
      return badRequest(c, error);
    }
  }) as never);

  app.openapi(getProposalRoute, (async (c: Context) => {
    const denied = await authenticated(c, deps);
    if (denied) return denied;
    const { id } = m31IdParamsSchema.parse(c.req.param());
    const proposal = await deps.getProposal(id);
    return proposal ? c.json(proposal, 200) : c.json({ error: 'not_found' }, 404);
  }) as never);

  app.openapi(compareRoute, (async (c: Context) => {
    const denied = await authenticated(c, deps);
    if (denied) return denied;
    try {
      const { id } = m31IdParamsSchema.parse(c.req.param());
      const body = m31CompareV2RequestSchema.parse(await c.req.json());
      const result = await deps.preparePermit({
        proposal_id: id,
        observation: body.observation,
        validity_window_ms: body.validity_window_ms,
      });
      return c.json(result, result.ok ? 200 : 409);
    } catch (error) {
      return badRequest(c, error);
    }
  }) as never);
}
