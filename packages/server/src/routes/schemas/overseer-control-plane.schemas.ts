import { z } from '@hono/zod-openapi';

const nonempty = z.string().trim().min(1);
const positiveInteger = z.number().int().positive();
const nonnegativeInteger = z.number().int().nonnegative();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const canonicalIdentity = z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/);

export const overseerParentActiveStateSchema = z.enum([
  'BUILDING',
  'REVIEW',
  'STAGING',
  'RECOVERY',
  'ACTION_PENDING',
]);
export const overseerParentTerminalStateSchema = z.enum(['COMPLETED', 'FAILED', 'CANCELLED']);
export const overseerChildStateSchema = z.enum([
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export const overseerVerifierRoleSchema = z.enum([
  'REVIEWER',
  'RED_TEAM',
  'FUSION',
  'MERGE_STEWARD',
]);
export const overseerControlResourceKindSchema = z.enum([
  'PARENT',
  'CHILD',
  'REPOSITORY_LEASE',
  'VERIFIER_REGISTRY',
  'FUSION_BUDGET',
]);

export const parentAdmitSchema = z
  .object({
    parent_id: nonempty,
    owner_id: nonempty,
    correlation_id: nonempty,
    state: overseerParentActiveStateSchema,
  })
  .strict();
export const parentHeartbeatSchema = z
  .object({ parent_id: nonempty, owner_id: nonempty, fencing_token: positiveInteger })
  .strict();
export const parentTransitionSchema = parentHeartbeatSchema
  .extend({ state: overseerParentActiveStateSchema })
  .strict();
export const childLinkSchema = parentHeartbeatSchema.extend({ child_id: nonempty }).strict();
export const childTransitionSchema = childLinkSchema
  .extend({ state: overseerChildStateSchema })
  .strict();
export const parentReleaseSchema = parentHeartbeatSchema
  .extend({ state: overseerParentTerminalStateSchema, terminal_reason: nonempty })
  .strict();
export const reconcileExpiredParentsSchema = z.object({}).strict();

export const repositoryLeaseAcquireSchema = z
  .object({
    repository: nonempty,
    lease_id: nonempty,
    owner_id: nonempty,
    execution_id: nonempty,
    action_kind: nonempty,
    capability: nonempty,
  })
  .strict();
export const repositoryLeaseFenceSchema = z
  .object({
    repository: nonempty,
    lease_id: nonempty,
    owner_id: nonempty,
    execution_id: nonempty,
    fencing_token: positiveInteger,
  })
  .strict();

export const verifierRegistryEntrySchema = z
  .object({
    verifier_id: canonicalIdentity,
    provider: canonicalIdentity,
    model_family: canonicalIdentity,
    roles: z.array(overseerVerifierRoleSchema).min(1),
    enabled: z.boolean(),
  })
  .strict();
export const verifierRegistryRegisterSchema = z
  .object({
    schema_version: z.literal('overseer-verifier-registry-v1'),
    registry_digest: digest,
    entries: z.array(verifierRegistryEntrySchema),
    source_artifact_path: nonempty,
    source_git_blob: nonempty,
  })
  .strict();
export const verifierAssertionSchema = z
  .object({
    registry_digest: digest,
    verifier_id: canonicalIdentity,
    required_role: overseerVerifierRoleSchema,
  })
  .strict();

export const fusionReserveSchema = z
  .object({
    reservation_id: nonempty,
    call_id: nonempty,
    proposal_id: nonempty,
    execution_id: nonempty,
    provider: canonicalIdentity,
    model: canonicalIdentity,
    call_kind: z.enum(['PRIMARY', 'RETRY', 'FALLBACK', 'INDIRECT']),
    requested_microusd: positiveInteger.max(3_000_000),
  })
  .strict();
export const fusionIdentitySchema = z
  .object({ reservation_id: nonempty, call_id: nonempty })
  .strict();
export const fusionReconcileSchema = fusionIdentitySchema
  .extend({ actual_microusd: nonnegativeInteger })
  .strict();
export const fusionReleaseSchema = fusionIdentitySchema
  .extend({
    release_reason: z.enum([
      'call_cancelled_before_start',
      'authorization_revoked_before_start',
      'provider_unavailable_before_start',
    ]),
  })
  .strict();

export const overseerControlEventsQuerySchema = z
  .object({
    resource_kind: overseerControlResourceKindSchema.optional(),
    resource_key: nonempty.optional(),
  })
  .strict();

export const overseerControlPlaneResponseSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string() }).optional(),
});

export type ParentAdmitBody = z.infer<typeof parentAdmitSchema>;
export type ParentHeartbeatBody = z.infer<typeof parentHeartbeatSchema>;
export type ParentTransitionBody = z.infer<typeof parentTransitionSchema>;
export type ChildLinkBody = z.infer<typeof childLinkSchema>;
export type ChildTransitionBody = z.infer<typeof childTransitionSchema>;
export type ParentReleaseBody = z.infer<typeof parentReleaseSchema>;
export type RepositoryLeaseAcquireBody = z.infer<typeof repositoryLeaseAcquireSchema>;
export type RepositoryLeaseFenceBody = z.infer<typeof repositoryLeaseFenceSchema>;
export type VerifierRegistryRegisterBody = z.infer<typeof verifierRegistryRegisterSchema>;
export type VerifierAssertionBody = z.infer<typeof verifierAssertionSchema>;
export type FusionReserveBody = z.infer<typeof fusionReserveSchema>;
export type FusionIdentityBody = z.infer<typeof fusionIdentitySchema>;
export type FusionReconcileBody = z.infer<typeof fusionReconcileSchema>;
export type FusionReleaseBody = z.infer<typeof fusionReleaseSchema>;
