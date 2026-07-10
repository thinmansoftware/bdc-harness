/**
 * Zod schemas for workflow definition types, plus result types for
 * workflow loading and execution (non-schema hand-written discriminated unions).
 */
import { z } from '@hono/zod-openapi';
import {
  dagNodeSchema,
  effortLevelSchema,
  thinkingConfigSchema,
  sandboxSettingsSchema,
} from './dag-node';

// ---------------------------------------------------------------------------
// Shared enum schemas
// ---------------------------------------------------------------------------

export const modelReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']);

export type ModelReasoningEffort = z.infer<typeof modelReasoningEffortSchema>;

export const webSearchModeSchema = z.enum(['disabled', 'cached', 'live']);

export type WebSearchMode = z.infer<typeof webSearchModeSchema>;

// ---------------------------------------------------------------------------
// Workflow-level worktree policy
// ---------------------------------------------------------------------------

/**
 * Per-workflow worktree policy. Pins whether a run uses isolation regardless of
 * how it was invoked (CLI flags, web UI, chat). When the field is omitted the
 * caller's default applies -- worktree for task/issue/pr, etc.
 *
 * Currently one field (`enabled`). Other worktree-shaped settings (copyFiles,
 * initSubmodules, path, baseBranch) live in repo-level `.archon/config.yaml`
 * because they are repo-wide, not per-workflow. This block is deliberately
 * narrow to avoid re-expressing the repo-level knobs here.
 */
export const workflowWorktreePolicySchema = z.object({
  /**
   * Pin worktree isolation on or off for this workflow.
   * - `true`  -- always run inside a worktree; CLI `--no-worktree` hard-errors
   * - `false` -- always run in the live checkout; CLI `--branch` / `--from`
   *             hard-error, orchestrator skips isolation resolution
   * - omitted -- caller decides (current default = worktree for most types)
   */
  enabled: z.boolean().optional(),
});

export type WorkflowWorktreePolicy = z.infer<typeof workflowWorktreePolicySchema>;

export const runAuthorityPolicySchema = z.object({
  required: z.boolean(),
  spec_repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  spec_revision: z.string().min(1),
  spec_paths: z.array(z.string().min(1)).min(1),
  allow_issue_fallback: z.boolean().optional(),
});

export type RunAuthorityPolicy = z.infer<typeof runAuthorityPolicySchema>;

// ---------------------------------------------------------------------------
// WorkflowBase -- common fields shared by all workflow types
// ---------------------------------------------------------------------------

export const workflowBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  provider: z.string().trim().min(1).optional(),
  model: z.string().optional(),
  modelReasoningEffort: modelReasoningEffortSchema.optional(),
  webSearchMode: webSearchModeSchema.optional(),
  additionalDirectories: z.array(z.string()).optional(),
  interactive: z.boolean().optional(),
  effort: effortLevelSchema.optional(),
  thinking: thinkingConfigSchema.optional(),
  fallbackModel: z.string().min(1).optional(),
  betas: z.array(z.string().min(1)).nonempty("'betas' must be a non-empty array").optional(),
  sandbox: sandboxSettingsSchema.optional(),
  /**
   * WO-HARNESS-NODE-PROVIDER-FAILOVER-01: workflow-level default AVAILABILITY
   * failover provider/model. A node inherits these unless it declares its own
   * `failover_provider`/`failover_model`, mirroring how `provider:`/`model:`
   * inheritance works. Control-plane only -- never forwarded to the SDK.
   */
  failover_provider: z.string().trim().min(1).optional(),
  failover_model: z.string().trim().min(1).optional(),
  worktree: workflowWorktreePolicySchema.optional(),
  /** Freeze canonical work-order bytes and repository scope before any workflow node runs. */
  run_authority: runAuthorityPolicySchema.optional(),
  /** Path to file whose content is loaded as systemPrompt for all prompt nodes. BDC patch. */
  policyFile: z.string().optional(),
  /**
   * When `false`, the engine skips the path-exclusive lock for this workflow,
   * allowing N concurrent runs on the same live checkout. The author asserts
   * that concurrent runs will not race (e.g. all writes are per-run-scoped).
   * Defaults to `true` (safe: serialize runs on the same path).
   */
  mutates_checkout: z.boolean().optional(),
  tags: z.array(z.string().min(1)).optional(),
  /**
   * Rule 28: When set, the executor verifies `git remote get-url origin` in the
   * worktree matches this owner/repo before starting any nodes. Mismatches fail
   * immediately with a `dag_workflow_failed` event (reason: target_repo_mismatch).
   * Format: "owner/repo" (e.g. "bluedevilcollectibles/bdc-xo").
   * Anchor: 2026-05-16 cross-repo incident (26 files pushed to wrong remote).
   */
  target_repo: z.string().optional(),
});

export type WorkflowBase = z.infer<typeof workflowBaseSchema>;

// ---------------------------------------------------------------------------
// WorkflowDefinition -- DAG-based workflow with nodes
// ---------------------------------------------------------------------------

/**
 * Workflow definition parsed from YAML.
 * All workflows use DAG-based execution with `nodes`.
 */
export const workflowDefinitionSchema = workflowBaseSchema.extend({
  nodes: z.array(dagNodeSchema),
  /**
   * Workflow-level input declarations with default values.
   * In bash nodes, reference as `${input.name}` -- the executor substitutes these
   * before passing the script to the shell (`.` is not valid in bash identifiers,
   * so no collision with real bash parameter expansion exists).
   * In prompt nodes, reference as `${input.name}` -- the AI sees the literal token
   * inside its system prompt, so prompt-level input interpolation is intentionally
   * left to the AI rather than the executor.
   */
  inputs: z.record(z.string(), z.object({ default: z.string() })).optional(),
});

/** Workflow definition with fully typed nodes (DagNode[]) derived from the schema. */
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema> & { prompt?: never };

// ---------------------------------------------------------------------------
// LoadCommandResult -- discriminated union for command load outcomes
// ---------------------------------------------------------------------------

/**
 * Result of loading a command prompt - discriminated union for specific error handling
 *
 * On success, `content` is non-empty (enforced at load time in executor-shared.ts, not by the type).
 */
export type LoadCommandResult =
  | { success: true; content: string }
  | {
      success: false;
      reason: 'invalid_name' | 'empty_file' | 'not_found' | 'permission_denied' | 'read_error';
      message: string;
    };

// ---------------------------------------------------------------------------
// WorkflowExecutionResult -- discriminated union for execution outcomes
// ---------------------------------------------------------------------------

/**
 * Result of workflow execution - allows callers to detect success/failure
 */
export type WorkflowExecutionResult =
  | { success: true; workflowRunId: string; summary?: string }
  | { success: false; workflowRunId?: string; error: string }
  | { success: true; paused: true; workflowRunId: string };

// ---------------------------------------------------------------------------
// WorkflowLoadError / WorkflowLoadResult -- workflow discovery results
// ---------------------------------------------------------------------------

/**
 * Workflow origin:
 * - `bundled` -- embedded in the Archon binary / bundled defaults
 * - `global`  -- user-level, discovered at `~/.archon/workflows/` (applies to every repo)
 * - `project` -- repo-local, discovered at `<repoRoot>/.archon/workflows/`
 *
 * Precedence for same-named files: `bundled` < `global` < `project`.
 */
export type WorkflowSource = 'bundled' | 'global' | 'project';

/** A workflow definition paired with its discovery source. */
export interface WorkflowWithSource {
  readonly workflow: WorkflowDefinition;
  readonly source: WorkflowSource;
}

/**
 * Error encountered while loading a workflow file
 */
export interface WorkflowLoadError {
  readonly filename: string;
  readonly path?: string;
  readonly error: string;
  readonly errorType: 'read_error' | 'parse_error' | 'validation_error';
  readonly error_type?:
    | 'parse_error'
    | 'dag_invalid'
    | 'missing_required_field'
    | 'schema_violation';
  readonly message?: string;
  readonly last_attempt_at?: string;
}

/**
 * Result of workflow discovery - includes both successful loads and errors
 */
export interface WorkflowLoadResult {
  readonly workflows: readonly WorkflowWithSource[];
  readonly errors: readonly WorkflowLoadError[];
}
