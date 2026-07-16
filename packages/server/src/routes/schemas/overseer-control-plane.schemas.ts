/**
 * Strict request schemas for the Overseer control-plane routes
 * (WO-HARNESS-OVERSEER-CONTROL-PLANE-01).
 *
 * Every object is `.strict()`: unknown fields (including caller time, bucket,
 * duration, generated digest, sequence, event ID, and authenticated operator
 * identity) are rejected. Operator identity and actor come from the authenticated
 * principal, never from the request body.
 */
import { z } from '@hono/zod-openapi';

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const tokenSchema = z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/);
const nonEmpty = z.string().min(1);
const positiveInt = z.number().int().positive();

export const parentActiveStateSchema = z.enum([
  'BUILDING',
  'REVIEW',
  'STAGING',
  'RECOVERY',
  'ACTION_PENDING',
]);
export const parentTerminalStateSchema = z.enum(['COMPLETED', 'FAILED', 'CANCELLED']);
export const childStateSchema = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']);
export const fusionCallKindSchema = z.enum(['PRIMARY', 'RETRY', 'FALLBACK', 'INDIRECT']);
export const fusionReleaseReasonSchema = z.enum([
  'call_cancelled_before_start',
  'authorization_revoked_before_start',
  'provider_unavailable_before_start',
]);
export const verifierRoleSchema = z.enum(['REVIEWER', 'RED_TEAM', 'FUSION', 'MERGE_STEWARD']);

export const parentAdmitBodySchema = z
  .object({
    parent_id: nonEmpty,
    owner_id: nonEmpty,
    correlation_id: nonEmpty,
    state: parentActiveStateSchema,
  })
  .strict();

export const parentHeartbeatBodySchema = z
  .object({
    parent_id: nonEmpty,
    owner_id: nonEmpty,
    fencing_token: positiveInt,
  })
  .strict();

export const parentTransitionBodySchema = z
  .object({
    parent_id: nonEmpty,
    owner_id: nonEmpty,
    fencing_token: positiveInt,
    state: parentActiveStateSchema,
  })
  .strict();

export const childLinkBodySchema = z
  .object({
    parent_id: nonEmpty,
    child_id: nonEmpty,
    owner_id: nonEmpty,
    fencing_token: positiveInt,
  })
  .strict();

export const childTransitionBodySchema = z
  .object({
    parent_id: nonEmpty,
    child_id: nonEmpty,
    owner_id: nonEmpty,
    fencing_token: positiveInt,
    state: childStateSchema,
  })
  .strict();

export const parentReleaseBodySchema = z
  .object({
    parent_id: nonEmpty,
    owner_id: nonEmpty,
    fencing_token: positiveInt,
    state: parentTerminalStateSchema,
    terminal_reason: nonEmpty,
  })
  .strict();

export const parentReconcileExpiredBodySchema = z.object({}).strict();

export const repositoryAcquireBodySchema = z
  .object({
    repository: nonEmpty,
    lease_id: nonEmpty,
    owner_id: nonEmpty,
    execution_id: nonEmpty,
    action_kind: nonEmpty,
    capability: nonEmpty,
  })
  .strict();

export const repositoryLeaseIdentityBodySchema = z
  .object({
    repository: nonEmpty,
    lease_id: nonEmpty,
    owner_id: nonEmpty,
    execution_id: nonEmpty,
    fencing_token: positiveInt,
  })
  .strict();

export const verifierEntrySchema = z
  .object({
    verifier_id: tokenSchema,
    provider: tokenSchema,
    model_family: tokenSchema,
    roles: z.array(verifierRoleSchema).min(1),
    enabled: z.boolean(),
  })
  .strict();

export const registryRegisterBodySchema = z
  .object({
    schema_version: z.literal('overseer-verifier-registry-v1'),
    registry_digest: digestSchema,
    entries: z.array(verifierEntrySchema).min(1),
    source_artifact_path: nonEmpty,
    source_git_blob: nonEmpty,
  })
  .strict();

export const verifierAssertBodySchema = z
  .object({
    registry_digest: digestSchema,
    verifier_id: tokenSchema,
    required_role: verifierRoleSchema,
  })
  .strict();

export const fusionReserveBodySchema = z
  .object({
    reservation_id: nonEmpty,
    call_id: nonEmpty,
    proposal_id: nonEmpty,
    execution_id: nonEmpty,
    provider: nonEmpty,
    model: nonEmpty,
    call_kind: fusionCallKindSchema,
    requested_microusd: z.number().int().min(1),
  })
  .strict();

export const fusionMarkStartedBodySchema = z
  .object({
    reservation_id: nonEmpty,
    call_id: nonEmpty,
  })
  .strict();

export const fusionReconcileBodySchema = z
  .object({
    reservation_id: nonEmpty,
    call_id: nonEmpty,
    actual_microusd: z.number().int().min(0),
  })
  .strict();

export const fusionReleaseBodySchema = z
  .object({
    reservation_id: nonEmpty,
    call_id: nonEmpty,
    release_reason: fusionReleaseReasonSchema,
  })
  .strict();

export const controlEventsQuerySchema = z
  .object({
    resource_kind: z
      .enum(['PARENT', 'CHILD', 'REPOSITORY_LEASE', 'VERIFIER_REGISTRY', 'FUSION_BUDGET'])
      .optional(),
    resource_key: z.string().min(1).optional(),
  })
  .strict();

export const controlPlaneResponseSchema = z.record(z.unknown());
