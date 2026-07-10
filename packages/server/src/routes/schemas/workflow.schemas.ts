/**
 * Zod schemas for workflow API endpoints.
 */
import { z } from '@hono/zod-openapi';
import { workflowDefinitionSchema as engineWorkflowDefinitionSchema } from '@archon/workflows/schemas/workflow';

/** Workflow definition schema -- derived from engine schema via direct subpath import. */
export const workflowDefinitionSchema =
  engineWorkflowDefinitionSchema.openapi('WorkflowDefinition');

/** A workflow load error entry returned in GET /api/workflows `errors` field. */
export const workflowLoadErrorSchema = z
  .object({
    filename: z.string(),
    path: z.string().optional(),
    error: z.string(),
    errorType: z.enum(['read_error', 'parse_error', 'validation_error']),
    error_type: z
      .enum(['parse_error', 'dag_invalid', 'missing_required_field', 'schema_violation'])
      .optional(),
    message: z.string().optional(),
    last_attempt_at: z.string().optional(),
  })
  .openapi('WorkflowLoadError');

export const workflowValidationErrorSchema = z
  .object({
    filename: z.string(),
    path: z.string().optional(),
    error_type: z.enum([
      'parse_error',
      'dag_invalid',
      'missing_required_field',
      'schema_violation',
    ]),
    message: z.string(),
    last_attempt_at: z.string(),
  })
  .openapi('WorkflowValidationError');

/**
 * Workflow source -- project-defined, bundled default, or home-scoped (global).
 * Precedence for same-named entries: `bundled` < `global` < `project`.
 */
export const workflowSourceSchema = z
  .enum(['project', 'bundled', 'global'])
  .openapi('WorkflowSource');

/** A workflow entry in the list response, including its source. */
export const workflowListEntrySchema = z
  .object({
    workflow: workflowDefinitionSchema,
    source: workflowSourceSchema,
  })
  .openapi('WorkflowListEntry');

/** GET /api/workflows response. */
export const workflowListResponseSchema = z
  .object({
    workflows: z.array(workflowListEntrySchema),
    errors: z.array(workflowLoadErrorSchema).optional(),
    validation_errors: z.object({
      count: z.number(),
      endpoint: z.string(),
    }),
  })
  .openapi('WorkflowListResponse');

export const workflowErrorsResponseSchema = z
  .object({
    errors: z.array(workflowValidationErrorSchema),
    count: z.number(),
  })
  .openapi('WorkflowErrorsResponse');

/** GET /api/workflows/:name response. */
export const getWorkflowResponseSchema = z
  .object({
    workflow: workflowDefinitionSchema,
    filename: z.string(),
    source: workflowSourceSchema,
  })
  .openapi('GetWorkflowResponse');

/** Request body for workflow definition endpoints (PUT and POST /validate). */
const definitionBodySchema = z.object({ definition: z.record(z.unknown()) });

/** PUT /api/workflows/:name request body. */
export const saveWorkflowBodySchema = definitionBodySchema.openapi('SaveWorkflowBody');

/** POST /api/workflows/validate request body. */
export const validateWorkflowBodySchema = definitionBodySchema.openapi('ValidateWorkflowBody');

/** POST /api/workflows/validate response. */
export const validateWorkflowResponseSchema = z
  .object({
    valid: z.boolean(),
    errors: z.array(z.string()).optional(),
  })
  .openapi('ValidateWorkflowResponse');

/** DELETE /api/workflows/:name response. */
export const deleteWorkflowResponseSchema = z
  .object({ deleted: z.boolean(), name: z.string() })
  .openapi('DeleteWorkflowResponse');

/** A single command entry returned by GET /api/commands. */
export const commandEntrySchema = z
  .object({
    name: z.string(),
    source: workflowSourceSchema,
  })
  .openapi('CommandEntry');

/** GET /api/commands response. */
export const commandListResponseSchema = z
  .object({ commands: z.array(commandEntrySchema) })
  .openapi('CommandListResponse');

// =========================================================================
// Workflow run schemas
// =========================================================================

/** Workflow run status values.
 *  'escalated' = gate-rejection ladder uplift (WO-HARNESS-ESCALATED-RUN-STATUS-01),
 *  terminal, distinct from failed.
 *
 *  Storage alignment: remote_agent_workflow_runs.status is free TEXT (see
 *  migrations/008_workflow_runs.sql / sqlite adapter). There is no DB-level
 *  enum or CHECK constraint to update. This API schema is the source of truth
 *  for allowed values; DB accepts any string and the app validates here. */
export const workflowRunStatusSchema = z
  .enum([
    'pending',
    'running',
    'waiting_provider',
    'interrupted',
    'completed',
    'failed',
    'escalated',
    'cancelled',
    'paused',
  ])
  .openapi('WorkflowRunStatus');

export const runOutcomeSchema = z
  .object({
    executionState: z.enum([
      'queued',
      'running',
      'waiting_provider',
      'paused_human',
      'interrupted',
      'completed',
      'failed',
      'cancelled',
    ]),
    deliverableState: z.enum([
      'none',
      'worktree_changes',
      'committed',
      'pushed',
      'pr_open',
      'pr_ready',
    ]),
    validationState: z.enum(['not_run', 'passed', 'failed', 'indeterminate']),
    recoveryState: z.enum([
      'not_needed',
      'recoverable',
      'recovering',
      'recovered',
      'abandoned_by_operator',
    ]),
    routeState: z.enum(['current', 'failed_over', 'escalated', 'spec_repair', 'exhausted']),
    primaryReason: z.string(),
    reasonCodes: z.array(z.string()),
    evidenceRefs: z.array(z.string()),
  })
  .openapi('RunOutcome');

/** A workflow run record. */
export const workflowRunSchema = z
  .object({
    id: z.string(),
    workflow_name: z.string(),
    conversation_id: z.string(),
    parent_conversation_id: z.string().nullable(),
    codebase_id: z.string().nullable(),
    status: workflowRunStatusSchema,
    user_message: z.string(),
    metadata: z.record(z.unknown()),
    started_at: z.string(),
    completed_at: z.string().nullable(),
    last_activity_at: z.string().nullable(),
    working_path: z.string().nullable(),
    archived_at: z.string().nullable(),
    archived_by: z.string().nullable(),
    archive_reason: z.string().nullable(),
    outcome: runOutcomeSchema.nullable().optional(),
  })
  .openapi('WorkflowRun');

/**
 * Derived Max-20x quota-window summary returned by GET /api/workflows/runs.
 *
 * `windowTokens` is an ESTIMATE computed from the current page of runs
 * (not a full-window DB aggregation), and is NOT a billed quota -- it is a
 * rough rate-limit indicator for the Max-20x subscription window.
 * `windowBudget` is `null` when MAX20X_WINDOW_TOKENS env var is unset.
 */
export const quotaWindowSchema = z
  .object({
    windowTokens: z.number(),
    windowBudget: z.number().nullable(),
    windowResetAt: z.string(),
  })
  .openapi('QuotaWindow');

/** GET /api/workflows/runs response. */
export const workflowRunListResponseSchema = z
  .object({
    runs: z.array(workflowRunSchema),
    quotaWindow: quotaWindowSchema,
  })
  .openapi('WorkflowRunListResponse');

/** A workflow event record. */
export const workflowEventSchema = z
  .object({
    id: z.string(),
    workflow_run_id: z.string(),
    event_type: z.string(),
    step_index: z.number().nullable(),
    step_name: z.string().nullable(),
    data: z.record(z.unknown()),
    created_at: z.string(),
  })
  .openapi('WorkflowEvent');

/** GET /api/workflows/runs/:runId/nodes/:nodeId/events query params. */
export const nodeEventsQuerySchema = z.object({
  // String -- handler parses and clamps to [1, 20]; default 5.
  limit: z.string().optional(),
});

/** GET /api/workflows/runs/:runId/nodes/:nodeId/events response. */
export const nodeEventsResponseSchema = z
  .object({ events: z.array(workflowEventSchema) })
  .openapi('NodeEventsResponse');

/** GET /api/workflows/runs/:runId response. */
export const workflowRunDetailSchema = z
  .object({
    run: workflowRunSchema.extend({
      worker_platform_id: z.string().optional(),
      parent_platform_id: z.string().optional(),
      conversation_platform_id: z.string().nullable(),
      token_totals: z.record(z.unknown()).optional(),
    }),
    events: z.array(workflowEventSchema),
  })
  .openapi('WorkflowRunDetail');

/** GET /api/workflows/runs/by-worker/:platformId response. */
export const workflowRunByWorkerResponseSchema = z
  .object({ run: workflowRunSchema })
  .openapi('WorkflowRunByWorkerResponse');

/** POST /api/workflows/runs/:runId/cancel request body. */
export const cancelWorkflowRunBodySchema = z
  .object({ reason: z.string().optional() })
  .openapi('CancelWorkflowRunBody');

/** POST /api/workflows/runs/:runId/cancel response. */
export const cancelWorkflowRunResponseSchema = z
  .object({ success: z.boolean(), message: z.string(), run: workflowRunSchema })
  .openapi('CancelWorkflowRunResponse');

/** POST /api/workflows/runs/cancel-stale response. */
export const cancelStaleRunsResponseSchema = z
  .object({ cancelled: z.number(), runIds: z.array(z.string()) })
  .openapi('CancelStaleRunsResponse');

/** POST /api/workflows/runs/:runId/pause request body. */
export const pauseWorkflowRunBodySchema = z
  .object({ reason: z.string().optional() })
  .openapi('PauseWorkflowRunBody');

/**
 * POST /api/workflows/runs/:runId/pause response.
 * Mirrors cancelWorkflowRunResponseSchema so the operator sees the updated row
 * back after a successful pause.
 */
export const pauseWorkflowRunResponseSchema = z
  .object({ success: z.boolean(), message: z.string(), run: workflowRunSchema })
  .openapi('PauseWorkflowRunResponse');

/** Generic workflow run action response (resume, abandon, delete). */
export const workflowRunActionResponseSchema = z
  .object({ success: z.boolean(), message: z.string() })
  .openapi('WorkflowRunActionResponse');

/** POST /api/workflows/runs/:runId/approve request body. */
export const approveWorkflowRunBodySchema = z
  .object({
    comment: z.string().optional(),
    decision_verb: z.enum(['approve_as_is', 'approve_with_fix']).default('approve_as_is'),
    authorized_fix_ids: z.array(z.string()).optional(),
  })
  .openapi('ApproveWorkflowRunBody');

/** POST /api/workflows/runs/:runId/reject request body. */
export const rejectWorkflowRunBodySchema = z
  .object({ reason: z.string().optional() })
  .openapi('RejectWorkflowRunBody');

/** Dashboard enriched workflow run (with joined codebase/conversation data). */
export const dashboardWorkflowRunSchema = workflowRunSchema
  .extend({
    codebase_name: z.string().nullable(),
    platform_type: z.string().nullable(),
    worker_platform_id: z.string().nullable(),
    parent_platform_id: z.string().nullable(),
    current_step_name: z.string().nullable(),
    total_steps: z.number().nullable(),
    current_step_status: z.enum(['running', 'completed', 'failed']).nullable(),
    agents_completed: z.number().nullable(),
    agents_failed: z.number().nullable(),
    agents_total: z.number().nullable(),
  })
  .openapi('DashboardWorkflowRun');

/** GET /api/dashboard/runs response. */
export const dashboardRunsResponseSchema = z
  .object({
    runs: z.array(dashboardWorkflowRunSchema),
    total: z.number(),
    counts: z.object({
      all: z.number(),
      running: z.number(),
      completed: z.number(),
      failed: z.number(),
      escalated: z.number(),
      cancelled: z.number(),
      pending: z.number(),
      paused: z.number(),
    }),
  })
  .openapi('DashboardRunsResponse');

/** POST /api/workflows/:name/run request body. */
export const conductorDispatchSchema = z.object({
  enabled: z.literal(true),
  woId: z.string().regex(/^WO-[A-Z0-9-]+$/),
  project: z.string().min(1),
  woClass: z.enum(['CODE', 'INFRA', 'MIXED']).optional(),
  tags: z.array(z.string().min(1)).optional(),
  entryOverride: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
  dryRun: z.boolean().optional(),
});

export const runWorkflowBodySchema = z
  .object({
    conversationId: z.string(),
    message: z.string(),
    conductor: conductorDispatchSchema.optional(),
  })
  .openapi('RunWorkflowBody');

/** GET /api/dashboard/runs query params. */
export const dashboardRunsQuerySchema = z.object({
  // z.string() -- handler validates the enum value and ignores invalid values
  status: z.string().optional(),
  codebaseId: z.string().optional(),
  search: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  includeArchived: z.string().optional(),
});

// =========================================================================
// Archive / bulk-delete schemas
// =========================================================================

/** POST /api/workflows/runs/:runId/archive request body. */
export const archiveWorkflowRunBodySchema = z
  .object({ reason: z.string().optional() })
  .openapi('ArchiveWorkflowRunBody');

/** POST /api/workflows/runs/:runId/unarchive request body (empty). */
export const unarchiveWorkflowRunBodySchema = z.object({}).openapi('UnarchiveWorkflowRunBody');

/** POST /api/workflows/runs/bulk-archive request body. */
export const bulkArchiveBodySchema = z
  .object({
    status: z.enum(['failed', 'cancelled', 'completed']),
    olderThan: z.string().optional(),
  })
  .openapi('BulkArchiveBody');

/** POST /api/workflows/runs/bulk-archive response. */
export const bulkArchiveResponseSchema = z
  .object({ archivedCount: z.number(), runIds: z.array(z.string()) })
  .openapi('BulkArchiveResponse');

/** DELETE /api/workflows/runs/bulk-failed response. */
export const bulkDeleteFailedResponseSchema = z
  .object({ deletedCount: z.number(), runIds: z.array(z.string()), dryRun: z.boolean() })
  .openapi('BulkDeleteFailedResponse');

/** GET /api/workflows/runs query params. */
export const workflowRunsQuerySchema = z.object({
  conversationId: z.string().optional(),
  // z.string() -- handler validates the enum value and ignores invalid values
  status: z.string().optional(),
  codebaseId: z.string().optional(),
  limit: z.string().optional(),
});
