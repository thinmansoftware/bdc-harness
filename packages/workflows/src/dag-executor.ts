/**
 * DAG Workflow Executor
 *
 * Executes a `nodes:`-based workflow in topological order.
 * Independent nodes within the same layer run concurrently via Promise.allSettled.
 * Captures all assistant output regardless of streaming mode for $node_id.output substitution.
 */
import { existsSync } from 'fs';
import { chmod, mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import {
  isAbsolute,
  join,
  posix as posixPath,
  resolve as resolvePath,
  win32 as win32Path,
} from 'path';
import { execFileAsync } from '@archon/git';
import { discoverScriptsForCwd } from './script-discovery';
import type {
  IWorkflowPlatform,
  WorkflowMessageMetadata,
  WorkflowConfig,
  WorkflowDeps,
} from './deps';
import type {
  SendQueryOptions,
  NodeConfig,
  ProviderCapabilities,
  TokenUsage,
  MessageChunk,
} from '@archon/providers/types';
import {
  getProviderCapabilities,
  getRegisteredProviders,
  isRegisteredProvider,
} from '@archon/providers';
import type {
  DagNode,
  ApprovalNode,
  BashNode,
  CommandNode,
  PromptNode,
  LoopNode,
  ScriptNode,
  EvidenceNode,
  NodeOutput,
  TriggerRule,
  WorkflowRun,
  EffortLevel,
  ThinkingConfig,
  SandboxSettings,
} from './schemas';
import { deriveNodeExecutionRequirements } from './schemas/dag-node';
import {
  isBashNode,
  isLoopNode,
  isApprovalNode,
  isCancelNode,
  isScriptNode,
  isEvidenceNode,
  isApprovalContext,
} from './schemas';
import { collectRuntimeEvidence, renderManifestV2 } from './reliability/evidence-collector';
import { formatToolCall } from './utils/tool-formatter';
import { createLogger } from '@archon/paths';
import { getWorkflowEventEmitter, buildGateResultField } from './event-emitter';
import type { GateResult } from './event-emitter';
import type { IWorkflowStore } from './store';
import { detectSilentFailure } from './silent-failure-detector';
import { handleNodeFailure } from './overseer-bridge';
import { evaluateCondition } from './condition-evaluator';
import {
  logNodeStart,
  logNodeComplete,
  logNodeSkip,
  logNodeError,
  logAssistant,
  logTool,
  logWorkflowComplete,
  logWorkflowError,
} from './logger';
import {
  withIdleTimeout,
  STEP_IDLE_TIMEOUT_MS,
  resolveLoopIterationIdleTimeoutMs,
  resolveLoopIterationWallTimeoutMs,
} from './utils/idle-timeout';
import {
  classifyError,
  detectCreditExhaustion,
  loadCommandPrompt,
  substituteWorkflowVariables,
  substituteInputRefs,
  buildPromptWithContext,
  detectCompletionSignal,
  detectPlanReviewApproval,
  stripCompletionTags,
  isInlineScript,
  formatSubprocessFailure,
  resolveAgentPersona,
  InfrastructureClassBlock,
  isPaperworkNode,
  hasPushArtifact,
} from './executor-shared';
import {
  assertProviderCanExecuteNode,
  isAvailabilityError,
  selectQuotaExhaustionRoute,
} from './node-failover';
import { loadAgentRegistry, resolveAgent } from './agents/registry';
import type { AgentRegistry } from './agents/registry';
import { loadContext } from '@archon/persona-context-loader';
import { deriveEntryRung, computeFrontierCost } from './model-rates';
import {
  markEngineDarkIfZeroUsage,
  resolveRouterEngine,
  sweepExpiredMarks,
} from './engine-availability';
import { isDeclaredServedMatch } from './model-alias';
import { emitRunTokenTotals } from './token-rollup';
import type {
  ExecutionCapability,
  OutcomeReasonCode,
  ProviderAttemptOutcomeClass,
  ProviderAttemptRecord,
  RunOutcome,
  TerminalWorkflowPersistence,
} from './reliability/types';
import { withRunLease } from './run-lease';

function cancellationPersistence(
  runId: string,
  reason: string,
  stepName?: string
): TerminalWorkflowPersistence {
  return {
    outcome: {
      executionState: 'cancelled',
      deliverableState: 'none',
      validationState: 'not_run',
      recoveryState: 'not_needed',
      routeState: 'current',
      primaryReason: 'cancelled_by_operator',
      reasonCodes: ['cancelled_by_operator'],
      evidenceRefs: [`run:${runId}`],
    },
    eventData: { reason, reason_code: 'cancelled_by_operator' },
    updatedAt: new Date().toISOString(),
    stepName,
  };
}

async function persistCancellation(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  nodeId: string,
  reason: string
): Promise<boolean> {
  try {
    await deps.store.cancelWorkflowRun(
      workflowRun.id,
      cancellationPersistence(workflowRun.id, reason, nodeId)
    );
    return true;
  } catch (error) {
    const failedAt = new Date().toISOString();
    getLog().error(
      { err: error as Error, workflowRunId: workflowRun.id, nodeId },
      'dag_cancel_persist_failed'
    );
    const currentStatus = await deps.store.getWorkflowRunStatus(workflowRun.id).catch(() => null);
    if (currentStatus === 'running') {
      await deps.store
        .updateWorkflowRun(workflowRun.id, {
          status: 'interrupted',
          metadata: {
            terminal_persist_failure: {
              attempted_status: 'cancelled',
              reason_code: 'status_persist_failed',
              failed_at: failedAt,
            },
          },
        })
        .catch(() => undefined);
      await deps.store
        .upsertRunOutcome(
          workflowRun.id,
          {
            executionState: 'interrupted',
            deliverableState: 'none',
            validationState: 'not_run',
            recoveryState: 'recoverable',
            routeState: 'current',
            primaryReason: 'status_persist_failed',
            reasonCodes: ['status_persist_failed'],
            evidenceRefs: [`run:${workflowRun.id}`, 'status_persist_failed'],
          },
          failedAt
        )
        .catch(() => undefined);
    }
    await deps.store.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'status_persist_failed',
      step_name: nodeId,
      data: { attempted_status: 'cancelled', reason_code: 'status_persist_failed' },
    });
    getWorkflowEventEmitter().emit({
      type: 'status_persist_failed',
      runId: workflowRun.id,
      attemptedStatus: 'cancelled',
      reason: 'status_persist_failed',
    });
    await safeSendMessage(
      platform,
      conversationId,
      'Warning: workflow cancellation could not be saved. The run is recoverable and no cancellation event was published.',
      { workflowId: workflowRun.id, nodeName: nodeId }
    );
    return false;
  }
}

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.dag-executor');
  return cachedLog;
}

// Agent registry cache: keyed by agents directory path, populated on first use.
// One cache entry per unique repo root -- each worktree gets its own registry.
const agentRegistryCache = new Map<string, AgentRegistry>();

async function getAgentRegistry(cwd: string): Promise<AgentRegistry> {
  const agentsDir = join(resolvePath(cwd, '.archon', 'agents'));
  const cached = agentRegistryCache.get(agentsDir);
  if (cached !== undefined) return cached;
  const registry = await loadAgentRegistry(agentsDir);
  agentRegistryCache.set(agentsDir, registry);
  return registry;
}

/** Clear the agent registry cache -- exposed for testing only. */
export function clearAgentRegistryCache(): void {
  agentRegistryCache.clear();
}

const MCP_FAILURE_PREFIX = 'MCP server connection failed: ';
const CODEX_FAILBACK_PREFIX = '[CODEX FAILBACK]';
const WARNING_PREFIX = '[WARNING]';
const PLAN_REVIEW_NODE_ID = 'plan-review';

function containsPlanReviewApproval(output: string): boolean {
  return detectPlanReviewApproval(output);
}

function containsPlanReviewEscalation(output: string): boolean {
  return /^[ \t]*ESCALATION_REQUIRED[ \t]*=[ \t]*true[ \t]*$/im.test(output);
}

function extractPlanReviewField(output: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^[ \\t]*${escapedKey}[ \\t]*=[ \\t]*(.*)$`, 'im').exec(output);
  return match?.[1]?.trim();
}

function sanitizeArtifactKey(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'unknown';
}

async function writePlanReviewEscalationPacket(
  artifactsDir: string,
  workflowRun: WorkflowRun,
  nodeId: string,
  iteration: number,
  maxIterations: number,
  output: string
): Promise<string> {
  const userMessageWoMatch = /\bWO-[A-Z0-9-]+\b/.exec(workflowRun.user_message);
  const woId = extractPlanReviewField(output, 'WO_ID') ?? userMessageWoMatch?.[0] ?? 'UNKNOWN_WO';
  const packet = {
    type: 'plan_review_escalation',
    workflowRunId: workflowRun.id,
    workflowName: workflowRun.workflow_name,
    nodeId,
    woId,
    iteration,
    maxIterations,
    escalationRequired: true,
    escalationReason: extractPlanReviewField(output, 'ESCALATION_REASON') ?? null,
    whatFailed: extractPlanReviewField(output, 'WHAT_FAILED') ?? null,
    whatWasTried: extractPlanReviewField(output, 'WHAT_WAS_TRIED') ?? null,
    lastReviewFindings: extractPlanReviewField(output, 'LAST_REVIEW_FINDINGS') ?? null,
    singleDecisionNeeded: extractPlanReviewField(output, 'SINGLE_DECISION_NEEDED') ?? null,
    safeState: extractPlanReviewField(output, 'SAFE_STATE') ?? null,
    rawOutput: output,
    createdAt: new Date().toISOString(),
  };
  const packetDir = join(artifactsDir, 'escalations');
  const packetPath = join(
    packetDir,
    `${sanitizeArtifactKey(woId)}-${sanitizeArtifactKey(nodeId)}-escalation.json`
  );
  await mkdir(packetDir, { recursive: true });
  await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');
  return packetPath;
}

function hasUnapprovedFailedPlanReviewAncestor(
  node: DagNode,
  allNodes: readonly DagNode[],
  nodeOutputs: Map<string, NodeOutput>
): boolean {
  const byId = new Map(allNodes.map(n => [n.id, n]));
  const visited = new Set<string>();
  const stack = [...(node.depends_on ?? [])];

  while (stack.length > 0) {
    const ancestorId = stack.pop();
    if (!ancestorId || visited.has(ancestorId)) continue;
    visited.add(ancestorId);

    const output = nodeOutputs.get(ancestorId);
    if (
      ancestorId === PLAN_REVIEW_NODE_ID &&
      output?.state === 'failed' &&
      !containsPlanReviewApproval(output.output)
    ) {
      return true;
    }

    const ancestor = byId.get(ancestorId);
    if (ancestor) stack.push(...(ancestor.depends_on ?? []));
  }

  return false;
}

/** A failed MCP server entry parsed from the SDK message. `segment` is the
 *  original substring (e.g. `"telegram (disconnected)"`) so callers can
 *  reconstruct a filtered message without losing the status detail. */
export interface McpFailureEntry {
  name: string;
  segment: string;
}

/**
 * Parse the SDK's "MCP server connection failed: a (status), b (status)"
 * message. Best-effort -- malformed or prefix-free messages return `[]`.
 * Entries are ordered and deduped by name; the segment of the first
 * occurrence wins.
 */
export function parseMcpFailureServerNames(message: string): McpFailureEntry[] {
  if (!message.startsWith(MCP_FAILURE_PREFIX)) return [];
  const seen = new Set<string>();
  const entries: McpFailureEntry[] = [];
  for (const raw of message.slice(MCP_FAILURE_PREFIX.length).split(', ')) {
    const segment = raw.trim();
    const name = segment.split(' (')[0]?.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      entries.push({ name, segment });
    }
  }
  return entries;
}

/**
 * Load the set of MCP server names that a node's `mcp:` config file declares.
 *
 * Returns an empty set when no `mcp:` is configured or when the file can't be
 * read/parsed. Used to distinguish workflow-configured failures (surface to
 * user) from user-plugin failures (silent debug log). We intentionally do not
 * validate or env-expand here -- the provider owns full loading and will
 * surface its own parse errors via the warning channel if the file is broken.
 *
 * Read failures are debug-logged so a transient I/O error (EMFILE/EBUSY) that
 * leaves us with an empty set -- and silently reclassifies a real workflow-MCP
 * failure as plugin noise -- is at least observable.
 */
export async function loadConfiguredMcpServerNames(
  nodeMcpPath: string | undefined,
  cwd: string
): Promise<Set<string>> {
  if (!nodeMcpPath) return new Set();
  const fullPath = isAbsolute(nodeMcpPath) ? nodeMcpPath : resolvePath(cwd, nodeMcpPath);
  try {
    const raw = await readFile(fullPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(Object.keys(parsed as Record<string, unknown>));
  } catch (err) {
    getLog().debug({ err, nodeMcpPath, fullPath }, 'dag.mcp_filter_config_read_failed');
    return new Set();
  }
}

/** Workflow-level Claude SDK options -- per-node overrides take precedence via ?? */
interface WorkflowLevelOptions {
  effort?: EffortLevel;
  thinking?: ThinkingConfig;
  fallbackModel?: string;
  betas?: string[];
  sandbox?: SandboxSettings;
  // WO-HARNESS-NODE-PROVIDER-FAILOVER-01: workflow-level default availability
  // failover target. A node inherits these unless it declares its own
  // failover_provider/failover_model. Control-plane only -- never sent to the SDK.
  failoverProvider?: string;
  failoverModel?: string;
}

/**
 * Resolve a node's declared AVAILABILITY failover target
 * (WO-HARNESS-NODE-PROVIDER-FAILOVER-01): node-level `failover_provider`/
 * `failover_model` win over the workflow-level defaults. `failover_agent` is
 * node-only because persona compatibility is specific to each node. Returns null when no
 * failover provider is declared at either level (node behaves as before).
 * These are pure control-plane fields -- the executor uses them to pick the
 * sideways re-dispatch target; they are never forwarded into SDK options.
 */
function resolveFailoverTarget(
  node: DagNode,
  workflowLevelOptions: WorkflowLevelOptions
): { provider: string; model: string | undefined; agent: string | undefined } | null {
  const ref = node as {
    failover_provider?: string;
    failover_model?: string;
    failover_agent?: string;
  };
  const provider = ref.failover_provider ?? workflowLevelOptions.failoverProvider;
  if (!provider) return null;
  return {
    provider,
    model: ref.failover_model ?? workflowLevelOptions.failoverModel,
    agent: ref.failover_agent,
  };
}

/** Clone an AI node for a provider failover without retaining an incompatible persona. */
function buildFailoverNode(
  node: DagNode,
  target: { provider: string; model: string | undefined; agent?: string }
): DagNode {
  return {
    ...node,
    provider: target.provider,
    model: target.model,
    ...(target.agent !== undefined ? { agent: target.agent, persona: undefined } : {}),
  } as DagNode;
}

/**
 * Emit + persist a `node_failover` event (WO-HARNESS-NODE-PROVIDER-FAILOVER-01).
 * Records the sideways re-dispatch from the primary provider/model to the
 * failover provider/model, plus the error class that triggered it.
 */
function emitNodeFailover(
  deps: WorkflowDeps,
  runId: string,
  nodeId: string,
  from: { provider: string; model: string | undefined },
  to: { provider: string; model: string | undefined },
  errorClass: string
): void {
  getLog().warn(
    {
      nodeId,
      fromProvider: from.provider,
      fromModel: from.model,
      toProvider: to.provider,
      toModel: to.model,
      errorClass,
    },
    'dag.node_failover'
  );
  deps.store
    .createWorkflowEvent({
      workflow_run_id: runId,
      event_type: 'node_failover',
      step_name: nodeId,
      data: {
        from_provider: from.provider,
        ...(from.model !== undefined ? { from_model: from.model } : {}),
        to_provider: to.provider,
        ...(to.model !== undefined ? { to_model: to.model } : {}),
        error_class: errorClass,
      },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: runId, eventType: 'node_failover' },
        'workflow_event_persist_failed'
      );
    });
  getWorkflowEventEmitter().emit({
    type: 'node_failover',
    runId,
    nodeId,
    fromProvider: from.provider,
    ...(from.model !== undefined ? { fromModel: from.model } : {}),
    toProvider: to.provider,
    ...(to.model !== undefined ? { toModel: to.model } : {}),
    errorClass,
  });
}

/** Internal node execution result -- extends NodeOutput with cost + token data for aggregation. */
type NodeExecutionResult = NodeOutput & {
  costUsd?: number;
  tokens?: TokenUsage;
  modelUsage?: Record<string, unknown>;
  frontierCostUsd?: number;
  /**
   * Declared/requested/served model + mismatch pass-through for the per-run
   * rollup (WO-HARNESS-TELEMETRY-DECLARED-MODEL-AND-COST-01). See
   * resolveNodeProviderAndModel's declaredModelId doc for the declared/requested
   * distinction. modelMismatch is the alias-aware comparison result (only set
   * when both declaredModelId and a non-null servedModelId are known).
   */
  declaredModelId?: string;
  requestedModelId?: string;
  servedModelId?: string | null;
  modelMismatch?: boolean;
  quotaExhausted?: {
    attemptId: string;
    attemptNumber: number;
    attemptStartedAt: string;
    provider: string;
    info: ResourceExhaustedInfo;
    iteration?: number;
  };
};

/** Throttle state for cancel checks (reads -- no write contention in WAL mode) */
const lastNodeCancelCheck = new Map<string, number>();
const CANCEL_CHECK_INTERVAL_MS = 10_000;

/**
 * Policy for the during-streaming cancel check: should the currently-streaming
 * node be allowed to continue for a given observed run status?
 *
 * - `running`: the normal case -> continue.
 * - `paused`: a concurrent approval node in the same topological layer has
 *   transitioned the run to paused. The streaming node should finish its own
 *   output; workflow progression is gated by the approval node, not by tearing
 *   down unrelated in-flight streams.
 * - `null` (run deleted), `cancelled`, `failed`, `completed`, or any other
 *   state -> abort the stream.
 *
 * Exported for unit testing; the full streaming-cancel branch in
 * `executeNodeInternal` only fires once per 10s (CANCEL_CHECK_INTERVAL_MS), so
 * integration-level coverage of the policy is timing-sensitive and flaky.
 */
export function shouldContinueStreamingForStatus(status: string | null): boolean {
  return status === 'running' || status === 'paused';
}

/** Throttle state for activity heartbeat writes (only used for stale/zombie detection) */
const lastNodeActivityUpdate = new Map<string, number>();
const ACTIVITY_HEARTBEAT_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Layer 1: Cascade-step emit + gate-result plumbing
// (WO-HARNESS-LAYER1-CLIMB-AND-GATE-EVENTS-01, Phase 3)
// ---------------------------------------------------------------------------

// Pending gate results keyed by `${runId}:${nodeId}`. Phase 5 cascade engine
// calls recordGateResult() before the node completes; the node_completed
// emit-site consumes and clears this entry.
const pendingGateResults = new Map<string, GateResult>();

/** Phase 5 cascade engine calls this to attach a gate outcome to the next
 *  node_completed event for (runId, nodeId). No-op until Phase 5 wires it. */
export function recordGateResult(runId: string, nodeId: string, result: GateResult): void {
  pendingGateResults.set(`${runId}:${nodeId}`, result);
}

/** Exported for test cleanup only -- clears all pending gate results. */
export function clearPendingGateResults(): void {
  pendingGateResults.clear();
}

/** Emit a cascade_step event (store + in-process emitter) when a job
 *  escalates from one tier to another. Called by Phase 5 cascade engine.
 *  No callers exist in Phase 3 -- the plumbing is wired, not triggered.
 *
 *  DISTINCT from node_failed / overseer_decision=escalate (salvage path). */
export function emitCascadeStep(
  store: Pick<IWorkflowStore, 'createWorkflowEvent'>,
  workflowRun: Pick<WorkflowRun, 'id'>,
  nodeId: string,
  params: { from_tier: string; to_tier: string; gate: string; reason: string }
): void {
  store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'cascade_step',
      step_name: nodeId,
      data: {
        from_tier: params.from_tier,
        to_tier: params.to_tier,
        gate: params.gate,
        reason: params.reason,
      },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'cascade_step' },
        'workflow_event_persist_failed'
      );
    });

  getWorkflowEventEmitter().emit({
    type: 'cascade_step',
    runId: workflowRun.id,
    nodeId,
    from_tier: params.from_tier,
    to_tier: params.to_tier,
    gate: params.gate,
    reason: params.reason,
  });
}

/** Context for platform message sending */
interface SendMessageContext {
  workflowId?: string;
  nodeName?: string;
}

/** Default DAG node retry for TRANSIENT errors */
const DEFAULT_NODE_MAX_RETRIES = 2;
const DEFAULT_NODE_RETRY_DELAY_MS = 3000;

/**
 * Get effective retry config for a DAG node.
 */
function getEffectiveNodeRetryConfig(node: DagNode): {
  maxRetries: number;
  delayMs: number;
  onError: 'transient' | 'all';
} {
  if ('retry' in node && node.retry) {
    return {
      maxRetries: node.retry.max_attempts,
      delayMs: node.retry.delay_ms ?? DEFAULT_NODE_RETRY_DELAY_MS,
      onError: node.retry.on_error ?? 'transient',
    };
  }
  return {
    maxRetries: DEFAULT_NODE_MAX_RETRIES,
    delayMs: DEFAULT_NODE_RETRY_DELAY_MS,
    onError: 'transient',
  };
}

/**
 * Check if a NodeOutput failure is transient by delegating to classifyError.
 * FATAL patterns (auth, permission, credits) take priority over TRANSIENT patterns,
 * matching the same precedence rules as classifyError(). This prevents an error
 * message that contains both a FATAL substring and a TRANSIENT substring (e.g.
 * "unauthorized: process exited with code 1") from being silently retried.
 */
function isTransientNodeError(errorMessage: string): boolean {
  return classifyError(new Error(errorMessage)) === 'TRANSIENT';
}

/**
 * True when a node error message is the SDK success-contradiction
 * (WO-HARNESS-PR-STATUS-TRUTH-AND-AUTOMERGE-01). The throw site formats it as
 * `Node '<id>' failed: SDK returned success...`; the outer retry loop uses this
 * to grant the node exactly one extra re-run, independent of the transient budget.
 */
function isSdkSuccessContradiction(errorMessage: string): boolean {
  return /failed: SDK returned success\b/.test(errorMessage);
}

type ResourceExhaustedReason = 'quota_or_rate_limit_message';

interface ResourceExhaustedInfo {
  reason: ResourceExhaustedReason;
  detail: string;
}

interface ResourceExhaustedRetryState {
  firstDetectedAt: number;
  attempt: number;
}

class ResourceExhaustedPause extends Error {
  readonly info: ResourceExhaustedInfo;

  constructor(info: ResourceExhaustedInfo) {
    super(`resource_exhausted: ${info.detail}`);
    this.name = 'ResourceExhaustedPause';
    this.info = info;
  }
}

const RESOURCE_EXHAUSTED_DEFAULT_BACKOFF_MS = [60_000, 300_000, 900_000, 1_800_000];
const RESOURCE_EXHAUSTED_DEFAULT_CEILING_MS = 6 * 60 * 60 * 1000;
const PROVIDER_TOTAL_ATTEMPT_CEILING = 8;

const EXECUTION_CAPABILITY_LEDGER_MAP = {
  text: 'text_generation',
  repositoryRead: 'repo_read',
  repositoryWrite: 'repo_write',
  shell: 'shell',
} as const satisfies Record<string, ExecutionCapability>;

function getProviderTotalAttemptCeiling(): number {
  const configured = Number.parseInt(process.env.ARCHON_PROVIDER_TOTAL_ATTEMPT_CEILING ?? '', 10);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : PROVIDER_TOTAL_ATTEMPT_CEILING;
}

async function persistProviderRouteChange(
  deps: WorkflowDeps,
  runId: string,
  nodeId: string,
  attemptId: string,
  route: Extract<MessageChunk, { type: 'provider_route' }>
): Promise<void> {
  await deps.store.createWorkflowEvent({
    workflow_run_id: runId,
    event_type: 'node_failover',
    step_name: nodeId,
    data: {
      node_id: nodeId,
      attempt_id: attemptId,
      route: route.route,
      from_provider: route.fromProvider,
      ...(route.fromModel ? { from_model: route.fromModel } : {}),
      to_provider: route.toProvider,
      ...(route.toModel ? { to_model: route.toModel } : {}),
      reason_code: route.reasonCode,
    },
  });
  getWorkflowEventEmitter().emit({
    type: 'node_failover',
    runId,
    nodeId,
    fromProvider: route.fromProvider,
    ...(route.fromModel ? { fromModel: route.fromModel } : {}),
    toProvider: route.toProvider,
    ...(route.toModel ? { toModel: route.toModel } : {}),
    errorClass: route.reasonCode,
  });
}

async function beginProviderAttempt(
  deps: WorkflowDeps,
  workflowRun: WorkflowRun,
  node: CommandNode | PromptNode | LoopNode,
  provider: string,
  model: string | undefined,
  declaredModel: string | undefined
): Promise<ProviderAttemptRecord> {
  const prior = await deps.store.listProviderAttempts(workflowRun.id, node.id);
  const ceiling = getProviderTotalAttemptCeiling();
  if (prior.length >= ceiling) {
    throw new Error(
      `provider_attempt_ceiling_exceeded: node '${node.id}' reached ${String(ceiling)} total provider calls`
    );
  }
  const latest = prior.reduce<ProviderAttemptRecord | null>(
    (current, attempt) =>
      current === null || attempt.attemptNumber > current.attemptNumber ? attempt : current,
    null
  );
  const requestedModel = model ?? declaredModel ?? 'provider-default';
  const attempt: ProviderAttemptRecord = {
    attemptId: randomUUID(),
    runId: workflowRun.id,
    nodeId: node.id,
    attemptNumber: (latest?.attemptNumber ?? 0) + 1,
    provider,
    model: requestedModel,
    declaredProvider: node.provider ?? provider,
    declaredModel: declaredModel ?? requestedModel,
    requiredCapabilities: deriveNodeExecutionRequirements(node).map(
      capability => EXECUTION_CAPABILITY_LEDGER_MAP[capability]
    ),
    startedAt: new Date().toISOString(),
    completedAt: null,
    servedModelId: null,
    outcomeClass: null,
    reasonCode: null,
    resumeAt: null,
    supersedesAttemptId: latest?.attemptId ?? null,
  };
  if (!(await deps.store.createProviderAttempt(attempt))) {
    throw new Error(
      `provider_attempt_persist_failed: could not reserve attempt ${String(attempt.attemptNumber)} for node '${node.id}'`
    );
  }
  return attempt;
}

async function finishProviderAttempt(
  deps: WorkflowDeps,
  attempt: ProviderAttemptRecord,
  data: {
    servedModelId: string | null;
    outcomeClass: ProviderAttemptOutcomeClass;
    reasonCode: OutcomeReasonCode;
    resumeAt?: string | null;
  }
): Promise<void> {
  const completed = await deps.store.completeProviderAttempt({
    attemptId: attempt.attemptId,
    completedAt: new Date().toISOString(),
    servedModelId: data.servedModelId,
    outcomeClass: data.outcomeClass,
    reasonCode: data.reasonCode,
    resumeAt: data.resumeAt ?? null,
  });
  if (!completed) {
    throw new Error(`provider_attempt_complete_failed: attempt ${attempt.attemptId}`);
  }
}

function parsePositiveIntegerList(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const parsed = value
    .split(',')
    .map(part => Number.parseInt(part.trim(), 10))
    .filter(n => Number.isFinite(n) && n > 0);
  return parsed.length > 0 ? parsed : undefined;
}

function getResourceExhaustedBackoffMs(attempt: number): number {
  const configured =
    parsePositiveIntegerList(process.env.ARCHON_RESOURCE_EXHAUSTED_BACKOFF_MS) ??
    RESOURCE_EXHAUSTED_DEFAULT_BACKOFF_MS;
  const index = Math.min(Math.max(attempt - 1, 0), configured.length - 1);
  return configured[index];
}

function getResourceExhaustedCeilingMs(): number {
  const configured = Number.parseInt(process.env.ARCHON_RESOURCE_EXHAUSTED_MAX_WAIT_MS ?? '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : RESOURCE_EXHAUSTED_DEFAULT_CEILING_MS;
}

function getTokenTotal(tokens: TokenUsage | undefined): number | undefined {
  if (!tokens) return undefined;
  if (tokens.total !== undefined) return tokens.total;
  return tokens.input + tokens.output;
}

function hasPositiveUsage(tokens: TokenUsage | undefined, cost: number | undefined): boolean {
  const tokenTotal = getTokenTotal(tokens);
  return (tokenTotal !== undefined && tokenTotal > 0) || (cost !== undefined && cost > 0);
}

function stringifySdkFields(msg: {
  errorSubtype?: string;
  errors?: string[];
  stopReason?: string;
}): string {
  return [msg.errorSubtype, msg.stopReason, ...(msg.errors ?? [])].filter(Boolean).join(' ');
}

function classifyResourceExhaustionText(text: string): ResourceExhaustedInfo | undefined {
  const normalized = text.toLowerCase();
  if (
    /you're out of extra usage|out of extra usage|out of credits|credit exhaustion|credit balance|insufficient credit|quota (?:is )?(?:exhausted|depleted)|usage (?:limit|quota).*(?:reached|exhausted)|resume when credits reset/.test(
      normalized
    )
  ) {
    return {
      reason: 'quota_or_rate_limit_message',
      detail: text.length > 500 ? `${text.slice(0, 500)}...` : text,
    };
  }
  return undefined;
}

function classifyResourceExhaustedSdkResult(msg: {
  isError?: boolean;
  errorSubtype?: string;
  errors?: string[];
  stopReason?: string;
  tokens?: TokenUsage;
  cost?: number;
}): ResourceExhaustedInfo | undefined {
  const explicitEvidence = classifyResourceExhaustionText(stringifySdkFields(msg));
  if (explicitEvidence) return explicitEvidence;

  // Token/cost counters are integrity evidence, not quota evidence. In particular,
  // the SDK success-contradiction can report zero work with no quota message. That
  // result gets the one bounded contradiction retry; it must never start a long
  // provider wait merely because all counters are zero.
  if (hasPositiveUsage(msg.tokens, msg.cost)) return undefined;
  return undefined;
}

async function emitResourceExhaustedRetry(
  deps: WorkflowDeps,
  workflowRunId: string,
  nodeId: string,
  info: ResourceExhaustedInfo,
  state: ResourceExhaustedRetryState,
  backoffMs: number,
  ceilingMs: number,
  iteration?: number
): Promise<void> {
  const elapsedMs = Date.now() - state.firstDetectedAt;
  const eventData = {
    nodeId,
    attempt: state.attempt,
    backoffMs,
    elapsedMs,
    ceilingMs,
    reason: info.reason,
    detail: info.detail,
    ...(iteration !== undefined ? { iteration } : {}),
  };
  getWorkflowEventEmitter().emit({
    type: 'resource_exhausted_retry',
    runId: workflowRunId,
    nodeId,
    attempt: state.attempt,
    backoffMs,
    elapsedMs,
    ceilingMs,
    reason: info.reason,
    detail: info.detail,
    ...(iteration !== undefined ? { iteration } : {}),
  });
  await deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRunId,
      event_type: 'resource_exhausted_retry',
      step_name: nodeId,
      data: eventData,
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId, nodeId, eventType: 'resource_exhausted_retry' },
        'resource_exhausted_retry_event_persist_failed'
      );
    });
}

async function scheduleDurableProviderWait(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  nodeId: string,
  exhausted: NonNullable<NodeExecutionResult['quotaExhausted']>
): Promise<NodeExecutionResult> {
  const now = Date.now();
  const state: ResourceExhaustedRetryState = {
    firstDetectedAt: new Date(exhausted.attemptStartedAt).getTime(),
    attempt: exhausted.attemptNumber,
  };
  const ceilingMs = getResourceExhaustedCeilingMs();
  const backoffMs = getResourceExhaustedBackoffMs(state.attempt);
  const resumeAt = new Date(now + backoffMs).toISOString();
  const waitId = randomUUID();
  const scheduled = await deps.store.scheduleProviderWait({
    waitId,
    runId: workflowRun.id,
    attemptId: exhausted.attemptId,
    provider: exhausted.provider,
    reasonCode: 'provider_quota_wait',
    resumeAt,
    state: 'scheduled',
    claimOwnerId: null,
    claimToken: null,
    createdAt: new Date(now).toISOString(),
    claimedAt: null,
    cancelledAt: null,
    completedAt: null,
  });
  if (!scheduled) {
    throw new Error(`provider_wait_schedule_failed: run ${workflowRun.id} node ${nodeId}`);
  }
  await deps.store.updateWorkflowRun(workflowRun.id, {
    status: 'waiting_provider',
    metadata: {
      provider_wait: {
        wait_id: waitId,
        attempt_id: exhausted.attemptId,
        node_id: nodeId,
        ...(exhausted.iteration !== undefined ? { iteration: exhausted.iteration } : {}),
        provider: exhausted.provider,
        reason_code: 'provider_quota_wait',
        resume_at: resumeAt,
      },
    },
  });
  const outcomeUpdated = await deps.store.upsertRunOutcome(
    workflowRun.id,
    {
      executionState: 'waiting_provider',
      deliverableState: 'none',
      validationState: 'not_run',
      recoveryState: 'recoverable',
      routeState: 'exhausted',
      primaryReason: 'provider_quota_wait',
      reasonCodes: ['provider_quota_wait'],
      evidenceRefs: [`run:${workflowRun.id}`, `attempt:${exhausted.attemptId}`, `wait:${waitId}`],
    },
    new Date(now).toISOString()
  );
  if (!outcomeUpdated) {
    throw new Error(`provider_wait_outcome_persist_failed: run ${workflowRun.id}`);
  }
  await emitResourceExhaustedRetry(
    deps,
    workflowRun.id,
    nodeId,
    exhausted.info,
    state,
    backoffMs,
    ceilingMs,
    exhausted.iteration
  );
  await safeSendMessage(
    platform,
    conversationId,
    `! Node \`${nodeId}\` is durably waiting for ${exhausted.provider} usage to recover. It is eligible to resume at ${resumeAt}.`,
    { workflowId: workflowRun.id, nodeName: nodeId }
  );
  return { state: 'skipped', output: '' };
}

/**
 * Max characters of the serialized SDK message we persist in a contradiction
 * dump. Mirrors the `SUBPROCESS_ERROR_MAX_CHARS` diagnostic-cap precedent in
 * executor-shared.ts: a verbose SDK `errors[]`/message must never write an
 * unbounded blob into `remote_agent_workflow_events`. More generous than the
 * 2000-char user-facing cap because this field is root-cause evidence, but
 * still bounded. The head is kept (JSON structure starts there).
 */
const SDK_CONTRADICTION_DUMP_MAX_CHARS = 8000;

/**
 * Persist a `sdk-contradiction-dump` node event carrying the full raw SDK
 * message JSON plus the persona-load state, for root-cause evidence when the
 * SDK reports isError=true with errorSubtype='success'. Uses event_type
 * 'tool_called' / tool_name 'sdk-contradiction-dump' (Section 6 of the WO) so
 * it rides the existing remote_agent_workflow_events schema with no migration.
 * Awaited (not fire-and-forget) so the evidence is durable before the node throws.
 */
async function emitSdkContradictionDump(
  deps: WorkflowDeps,
  workflowRunId: string,
  nodeId: string,
  sdkMessage: unknown,
  personaContextState: string
): Promise<void> {
  let sdkMessageJson: string;
  try {
    sdkMessageJson = JSON.stringify(sdkMessage);
  } catch (serializeErr) {
    sdkMessageJson = `<<unserializable SDK message: ${(serializeErr as Error).message}>>`;
  }
  if (sdkMessageJson.length > SDK_CONTRADICTION_DUMP_MAX_CHARS) {
    sdkMessageJson = sdkMessageJson.slice(0, SDK_CONTRADICTION_DUMP_MAX_CHARS) + '...[truncated]';
  }
  await deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRunId,
      event_type: 'tool_called',
      step_name: nodeId,
      data: {
        tool_name: 'sdk-contradiction-dump',
        tool_input: {
          node_id: nodeId,
          persona_context_state: personaContextState,
          sdk_message: sdkMessageJson,
        },
      },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId, nodeId, eventType: 'tool_called' },
        'dag.sdk_contradiction_dump_persist_failed'
      );
    });
}

/**
 * Safely send a message to the platform without crashing on failure.
 * Returns true if message was sent successfully, false otherwise.
 */
async function safeSendMessage(
  platform: IWorkflowPlatform,
  conversationId: string,
  message: string,
  context?: SendMessageContext,
  metadata?: WorkflowMessageMetadata
): Promise<boolean> {
  try {
    await platform.sendMessage(conversationId, message, metadata);
    return true;
  } catch (error) {
    const err = error as Error;
    const errorType = classifyError(err);

    getLog().error(
      {
        err,
        conversationId,
        messageLength: message.length,
        errorType,
        platformType: platform.getPlatformType(),
        ...context,
      },
      'dag_node_message_send_failed'
    );

    if (errorType === 'FATAL') {
      throw new Error(`Platform authentication/permission error: ${err.message}`);
    }

    return false;
  }
}

/**
 * Single-quote a string for safe inline shell use.
 * Replaces each ' with '\'' (end quote, literal single-quote, re-open quote).
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Substitute $node_id.output and $node_id.output.field references in a prompt.
 * Called AFTER the standard substituteWorkflowVariables pass.
 *
 * @param escapedForBash - When true, wraps substituted values in single quotes so
 *   they are safe to embed in bash scripts passed to `bash -c`. Set true only for
 *   bash node script substitution; AI/command prompt substitution should use false.
 *
 * When escapedForBash is on, this function ALSO detects the
 *   "$node.output"   (exact double-quoted substitution)
 * anti-pattern and swallows the surrounding double quotes. shellQuote already
 * produces safe single-quote wrapping; wrapping that in additional double quotes
 * mis-tokenizes multi-line node output -- line 2+ of the output becomes bare
 * commands. Anchor: WO-HARNESS-NODE-OUTPUT-BASH-QUOTING-01 (bdc-xo#153) 2026-05-16.
 * YAMLs that write `"$node.output"` are now safe to author this natural way; the
 * older pattern of `VAR=$node.output ... "$VAR"` continues to work unchanged.
 */
export function substituteNodeOutputRefs(
  prompt: string,
  nodeOutputs: Map<string, NodeOutput>,
  escapedForBash = false
): string {
  const pattern = escapedForBash
    ? /(")?\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?(")?/g
    : /\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?/g;

  return prompt.replace(pattern, (match: string, ...rest: (string | undefined)[]) => {
    let leadingQuote: string;
    let nodeId: string;
    let field: string | undefined;
    let trailingQuote: string;
    if (escapedForBash) {
      leadingQuote = rest[0] ?? '';
      nodeId = rest[1] ?? '';
      field = rest[2];
      trailingQuote = rest[3] ?? '';
    } else {
      leadingQuote = '';
      nodeId = rest[0] ?? '';
      field = rest[1];
      trailingQuote = '';
    }
    const swallowQuotes = leadingQuote === '"' && trailingQuote === '"';
    const wrap = (val: string): string =>
      escapedForBash && !swallowQuotes ? `${leadingQuote}${val}${trailingQuote}` : val;

    const nodeOutput = nodeOutputs.get(nodeId);
    if (!nodeOutput) {
      getLog().warn({ nodeId, match }, 'dag_node_output_ref_unknown_node');
      return escapedForBash ? wrap("''") : '';
    }
    if (!field) {
      return escapedForBash ? wrap(shellQuote(nodeOutput.output)) : nodeOutput.output;
    }
    try {
      const parsed = JSON.parse(nodeOutput.output) as Record<string, unknown>;
      const value = parsed[field];
      if (typeof value === 'string') return escapedForBash ? wrap(shellQuote(value)) : value;
      // numbers and booleans from JSON.parse are shell-safe without quoting:
      // JSON disallows NaN/Infinity, so String(number) contains only digits, sign, and '.'.
      // String(boolean) is 'true' or 'false' -- no shell metacharacters.
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      // arrays and objects: JSON-stringify. Bash passes substitution as a single
      // argument, so downstream tools (jq, etc.) receive a JSON literal they can parse.
      if (Array.isArray(value) || typeof value === 'object') {
        return escapedForBash ? wrap(shellQuote(JSON.stringify(value))) : JSON.stringify(value);
      }
      return escapedForBash ? wrap("''") : ''; // null, undefined, symbol, bigint -> empty
    } catch (jsonErr) {
      getLog().warn(
        { nodeId, field, outputPreview: nodeOutput.output.slice(0, 100), err: jsonErr as Error },
        'dag_node_output_ref_json_parse_failed'
      );
      return escapedForBash ? wrap("''") : '';
    }
  });
}

// buildSDKHooksFromYAML moved to @archon/providers/src/claude/provider.ts
// loadMcpConfig moved to @archon/providers/src/claude/provider.ts

/**
 * Resolve per-node provider and model.
 * Node-level overrides take precedence over workflow defaults.
 *
 * Provider-agnostic: builds universal base options + raw nodeConfig.
 * The provider internally translates nodeConfig to SDK-specific options.
 * Capability warnings inform users when features are unsupported.
 */
async function resolveNodeProviderAndModel(
  node: DagNode,
  workflowProvider: string,
  workflowModel: string | undefined,
  config: WorkflowConfig,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRunId: string,
  cwd: string,
  workflowLevelOptions: WorkflowLevelOptions
): Promise<{
  provider: string;
  model: string | undefined;
  options: SendQueryOptions | undefined;
  /**
   * Declared model per WO-HARNESS-TELEMETRY-DECLARED-MODEL-AND-COST-01: the
   * pre-persona effective model (node.model ?? workflow/assistant default),
   * captured BEFORE any `agent:`/`persona:` override at line ~577 below. This
   * is the value that reflects the raw parsed YAML pin (the #298 parse-layer
   * bug class this WO's integrity check targets) and is distinct from the
   * post-persona `model` returned above (the actual "requested" value sent to
   * the SDK, unchanged from prior behavior).
   */
  declaredModelId: string | undefined;
  /**
   * Persona wiki/oracle context-load state, forwarded to the SDK-contradiction
   * dump (WO-HARNESS-PR-STATUS-TRUTH-AND-AUTOMERGE-01) for root-cause evidence:
   *   - 'none'    -- node declares no persona, or the persona has no context block
   *   - 'skipped' -- paperwork node: loadContext deliberately NOT called
   *   - 'loaded'  -- loadContext returned a non-empty context block
   *   - 'empty'   -- loadContext returned an empty string
   *   - 'failed'  -- loadContext threw and was caught
   */
  personaContextState: string;
}> {
  // Provider is explicit: node.provider ?? workflow.provider. Model never
  // influences provider selection. Model strings pass through to the SDK.
  const provider: string = node.provider ?? workflowProvider;
  if (!isRegisteredProvider(provider)) {
    throw new Error(
      `Node '${node.id}': unknown provider '${provider}'. ` +
        `Registered: ${getRegisteredProviders()
          .map(p => p.id)
          .join(', ')}`
    );
  }

  const providerAssistantConfig = config.assistants[provider];
  const model: string | undefined =
    node.model ??
    (provider === workflowProvider
      ? workflowModel
      : (providerAssistantConfig?.model as string | undefined));

  // Get provider capabilities for capability warnings (static lookup, no instantiation)
  const caps = getProviderCapabilities(provider);

  // Capability warnings -- inform users when features are unsupported
  const capChecks: [string, keyof ProviderCapabilities, boolean][] = [
    [
      'allowed_tools/denied_tools',
      'toolRestrictions',
      node.allowed_tools !== undefined || node.denied_tools !== undefined,
    ],
    ['hooks', 'hooks', node.hooks !== undefined],
    ['mcp', 'mcp', node.mcp !== undefined],
    ['skills', 'skills', node.skills !== undefined && node.skills.length > 0],
    ['agents', 'agents', node.agents !== undefined],
    ['effort', 'effortControl', (node.effort ?? workflowLevelOptions.effort) !== undefined],
    ['thinking', 'thinkingControl', (node.thinking ?? workflowLevelOptions.thinking) !== undefined],
    ['maxBudgetUsd', 'costControl', node.maxBudgetUsd !== undefined],
    [
      'fallbackModel',
      'fallbackModel',
      (node.fallbackModel ?? workflowLevelOptions.fallbackModel) !== undefined,
    ],
    ['sandbox', 'sandbox', (node.sandbox ?? workflowLevelOptions.sandbox) !== undefined],
    ['env', 'envInjection', (config.envVars && Object.keys(config.envVars).length > 0) === true],
  ];

  const unsupported: string[] = [];
  for (const [field, cap, isSet] of capChecks) {
    if (isSet && !caps[cap]) {
      unsupported.push(field);
    }
  }

  if (unsupported.length > 0) {
    getLog().warn({ nodeId: node.id, provider, unsupported }, 'dag.unsupported_capabilities');
    const delivered = await safeSendMessage(
      platform,
      conversationId,
      `Warning: Node '${node.id}' uses ${unsupported.join(', ')} but ${provider} doesn't support ${unsupported.length === 1 ? 'it' : 'them'} -- ${unsupported.length === 1 ? 'this will be' : 'these will be'} ignored.`,
      { workflowId: workflowRunId, nodeName: node.id }
    );
    if (!delivered) {
      getLog().error({ nodeId: node.id, workflowRunId }, 'dag.capability_warning_delivery_failed');
    }
  }

  // Surface agents + skills ID collision -- user-defined 'dag-node-skills'
  // silently overrides Archon's skills wrapper. User wins (by design) but
  // the operator should know they've neutered the wrapper.
  if (
    node.agents?.['dag-node-skills'] !== undefined &&
    node.skills !== undefined &&
    node.skills.length > 0
  ) {
    getLog().warn({ nodeId: node.id }, 'dag.agents_skills_id_collision');
    await safeSendMessage(
      platform,
      conversationId,
      `Warning: Node '${node.id}' defines an agent with reserved ID 'dag-node-skills' AND uses 'skills:'. Your inline agent overrides Archon's automatic skills wrapper -- the 'skills:' field will NOT take effect. Rename the agent or remove 'skills:' to fix.`,
      { workflowId: workflowRunId, nodeName: node.id }
    );
  }

  // Resolve agent persona (if node declares `agent:` or `persona:`).
  // `persona:` is the human-facing alias for `agent:` -- both resolve identically.
  // If both are set they must agree (enforced at parse time by dagNodeSchema).
  // The persona's model overrides the node-resolved model; its system prompt is
  // prepended to any node-level systemPrompt; its tools list (if present) is
  // used as allowed_tools (node-level allowed_tools take precedence if set).
  let effectiveModel = model;
  let effectiveSystemPrompt = node.systemPrompt;
  let effectiveAllowedTools = node.allowed_tools;
  // Persona wiki/oracle context-load state, forwarded to the contradiction dump.
  let personaContextState = 'none';

  const nodeAgentRef = node as { agent?: string; persona?: string };
  const agentName = nodeAgentRef.agent ?? nodeAgentRef.persona;
  if (agentName) {
    const registry = await getAgentRegistry(cwd);
    const persona = resolveAgent(agentName, registry);
    if (persona) {
      const personaResolution = resolveAgentPersona(persona, effectiveModel, provider);
      effectiveModel = personaResolution.model;
      // Prepend agent system prompt (agent role comes before node task)
      effectiveSystemPrompt = effectiveSystemPrompt
        ? `${personaResolution.systemPrompt}\n\n${effectiveSystemPrompt}`
        : personaResolution.systemPrompt;
      // Agent tools only apply when node doesn't already restrict tools
      if (personaResolution.allowedTools && !effectiveAllowedTools) {
        effectiveAllowedTools = personaResolution.allowedTools;
      }

      // Load persona context (wiki + oracle) and prepend to system prompt.
      // Paperwork/tail nodes (WO-HARNESS-PR-STATUS-TRUTH-AND-AUTOMERGE-01) run
      // with a bare model -- skip the live wiki/oracle fetch entirely. Every
      // failing tail node in the 2026-07-06 incident carried persona: xo and a
      // context load; skipping it removes that failure surface. Model/system
      // prompt/tools are still resolved above; only the context fetch is skipped.
      if (persona.context) {
        if (isPaperworkNode(node.id)) {
          personaContextState = 'skipped';
          getLog().debug({ nodeId: node.id, agentName }, 'dag.persona_context_skipped_paperwork');
        } else {
          const contextBlock = await loadContext(persona).catch((err: unknown) => {
            getLog().warn({ agentName, err: (err as Error).message }, 'agent.context_load_failed');
            personaContextState = 'failed';
            return '';
          });
          if (contextBlock) {
            personaContextState = 'loaded';
            effectiveSystemPrompt = effectiveSystemPrompt
              ? `${contextBlock}\n\n${effectiveSystemPrompt}`
              : contextBlock;
          } else if (personaContextState !== 'failed') {
            personaContextState = 'empty';
          }
        }
      }
    }
  }

  // Build universal base options
  const baseOptions: SendQueryOptions = {};
  if (effectiveModel) baseOptions.model = effectiveModel;
  if (config.envVars && Object.keys(config.envVars).length > 0) {
    baseOptions.env = config.envVars;
  }
  if (effectiveSystemPrompt !== undefined) baseOptions.systemPrompt = effectiveSystemPrompt;
  if (node.maxBudgetUsd !== undefined) baseOptions.maxBudgetUsd = node.maxBudgetUsd;
  const fb = node.fallbackModel ?? workflowLevelOptions.fallbackModel;
  if (fb) baseOptions.fallbackModel = fb;
  if (node.output_format) {
    baseOptions.outputFormat = { type: 'json_schema', schema: node.output_format };
  }

  // Build raw nodeConfig -- provider translates internally
  const nodeConfig: NodeConfig = {
    mcp: node.mcp,
    hooks: node.hooks,
    skills: node.skills,
    agents: node.agents,
    allowed_tools: effectiveAllowedTools,
    denied_tools: node.denied_tools,
    effort: node.effort ?? workflowLevelOptions.effort,
    thinking: node.thinking ?? workflowLevelOptions.thinking,
    sandbox: node.sandbox ?? workflowLevelOptions.sandbox,
    betas: node.betas ?? workflowLevelOptions.betas,
    output_format: node.output_format,
    maxBudgetUsd: node.maxBudgetUsd,
    systemPrompt: effectiveSystemPrompt,
    fallbackModel: fb,
  };

  // Pass assistantConfig from config -- provider parses internally
  const assistantConfig = config.assistants[provider] ?? {};

  const options: SendQueryOptions = {
    ...baseOptions,
    nodeConfig,
    assistantConfig,
  };

  return {
    provider,
    model: effectiveModel,
    options,
    declaredModelId: model,
    personaContextState,
  };
}

/** Evaluate trigger rule for a node given its upstream states */
export function checkTriggerRule(
  node: DagNode,
  nodeOutputs: Map<string, NodeOutput>
): 'run' | 'skip' {
  const nodeDeps = node.depends_on ?? [];
  if (nodeDeps.length === 0) return 'run';

  const upstreams = nodeDeps.map(
    id =>
      nodeOutputs.get(id) ??
      ({
        state: 'failed',
        output: '',
        error: `upstream '${id}' missing from outputs`,
      } as NodeOutput)
  );
  const rule: TriggerRule = node.trigger_rule ?? 'all_success';

  switch (rule) {
    case 'all_success':
      return upstreams.every(u => u.state === 'completed') ? 'run' : 'skip';
    case 'one_success':
      return upstreams.some(u => u.state === 'completed') ? 'run' : 'skip';
    case 'none_failed_min_one_success': {
      const anyFailed = upstreams.some(u => u.state === 'failed');
      const anySucceeded = upstreams.some(u => u.state === 'completed');
      return !anyFailed && anySucceeded ? 'run' : 'skip';
    }
    case 'all_done':
      return upstreams.every(u => u.state !== 'pending' && u.state !== 'running') ? 'run' : 'skip';
  }
}

/**
 * Build topological layers from DAG nodes using Kahn's algorithm.
 * Layer 0: nodes with no dependencies.
 * Layer N: nodes whose dependencies are all in layers 0..N-1.
 *
 * Cycle detection: if the sum of all layer sizes < nodes.length, a cycle exists.
 * (Cycle detection at load time is the primary guard; this is a runtime safety check.)
 */
export function buildTopologicalLayers(nodes: readonly DagNode[]): DagNode[][] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, node.depends_on?.length ?? 0);
    for (const dep of node.depends_on ?? []) {
      const existing = dependents.get(dep) ?? [];
      existing.push(node.id);
      dependents.set(dep, existing);
    }
  }

  const layers: DagNode[][] = [];
  let ready = [...nodes].filter(n => (inDegree.get(n.id) ?? 0) === 0);

  while (ready.length > 0) {
    layers.push(ready);
    const nextIds: string[] = [];
    for (const node of ready) {
      for (const depId of dependents.get(node.id) ?? []) {
        const newDegree = (inDegree.get(depId) ?? 0) - 1;
        inDegree.set(depId, newDegree);
        if (newDegree === 0) nextIds.push(depId);
      }
    }
    ready = nextIds
      .map(id => nodes.find(n => n.id === id))
      .filter((n): n is DagNode => n !== undefined);
  }

  const totalPlaced = layers.reduce((sum, l) => sum + l.length, 0);
  if (totalPlaced < nodes.length) {
    // Should never happen -- cycle detection runs at load time
    throw new Error(
      '[DagExecutor] Cycle detected at runtime -- was cycle detection skipped at load?'
    );
  }

  return layers;
}

/**
 * Execute a single DAG node. Returns NodeExecutionResult regardless of success/failure.
 * Always accumulates assistant text output (for $node_id.output substitution).
 * Parallel nodes and context: 'fresh' nodes always receive fresh sessions (caller ensures resumeSessionId is undefined).
 */
async function executeNodeInternal(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflowRun: WorkflowRun,
  node: CommandNode | PromptNode,
  provider: string,
  nodeOptions: SendQueryOptions | undefined,
  declaredModelId: string | undefined,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  nodeOutputs: Map<string, NodeOutput>,
  resumeSessionId: string | undefined,
  configuredCommandFolder?: string,
  issueContext?: string,
  // Persona wiki/oracle context-load state from resolveNodeProviderAndModel,
  // dumped alongside the raw SDK message on a success-contradiction for
  // root-cause evidence (WO-HARNESS-PR-STATUS-TRUTH-AND-AUTOMERGE-01).
  personaContextState = 'none'
): Promise<NodeExecutionResult> {
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };

  const configuredMcpNames = await loadConfiguredMcpServerNames(node.mcp, cwd);

  getLog().info({ nodeId: node.id, provider }, 'dag_node_started');
  await logNodeStart(logDir, workflowRun.id, node.id, node.command ?? '<inline>');

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_started',
      step_name: node.id,
      data: { command: node.command ?? null, provider },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'node_started' },
        'workflow_event_persist_failed'
      );
    });

  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'node_started',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: node.command ?? node.id,
  });

  // M-20260726-87: opportunistically sweep expired engine-dark marks on each
  // node dispatch (no background timer -- a permanently-poisoned engine is
  // worse than the failure being fixed, so expiry must not depend on a
  // future failure ever happening on that same engine again). Persist each
  // expiry so "why did this run pick that model" stays reconstructable.
  for (const expiry of sweepExpiredMarks()) {
    getLog().info({ ...expiry }, 'dag.engine_mark_expired');
    await deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'engine_availability_changed',
        step_name: node.id,
        data: { ...expiry },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'engine_availability_changed' },
          'workflow_event_persist_failed'
        );
      });
  }

  // Load prompt
  let rawPrompt: string;
  if (node.command !== undefined) {
    const promptResult = await loadCommandPrompt(deps, cwd, node.command, configuredCommandFolder);
    if (!promptResult.success) {
      const errMsg = promptResult.message;
      getLog().error({ nodeId: node.id, error: errMsg }, 'dag_node_command_load_failed');
      const failResult = await handleNodeFailure(
        { store: deps.store, emitter, log: getLog(), logNodeError },
        workflowRun,
        node,
        {
          errorMsg: errMsg,
          logDir,
          outputSoFar: '',
          gateResult: { passed: false, nodeType: 'ai' },
        }
      );
      return failResult.output;
    }
    rawPrompt = promptResult.content;
  } else {
    // node is PromptNode -- prompt: string is guaranteed by the discriminated union
    rawPrompt = node.prompt;
  }

  // Standard variable substitution
  let substitutedPrompt: string;
  try {
    substitutedPrompt = buildPromptWithContext(
      rawPrompt,
      workflowRun.id,
      workflowRun.user_message,
      artifactsDir,
      baseBranch,
      docsDir,
      issueContext,
      `dag node '${node.id}' prompt`
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ nodeId: node.id, error: err.message }, 'dag.node_prompt_substitution_failed');
    await safeSendMessage(
      platform,
      conversationId,
      `Node '${node.id}' failed: ${err.message}`,
      nodeContext
    );
    return { state: 'failed', output: '', error: err.message };
  }

  // Substitute upstream node output references
  const finalPrompt = substituteNodeOutputRefs(substitutedPrompt, nodeOutputs);

  const aiClient = deps.getAgentProvider(provider);
  const streamingMode = platform.getStreamingMode();

  let nodeOutputText = ''; // Always accumulate regardless of streaming mode
  let structuredOutput: unknown;
  let newSessionId: string | undefined;
  let nodeTokens: TokenUsage | undefined;
  let nodeCostUsd: number | undefined;
  let nodeStopReason: string | undefined;
  let nodeNumTurns: number | undefined;
  let nodeModelUsage: Record<string, unknown> | undefined;
  // Layer 1 served-model capture (WO-HARNESS-LAYER1-SERVED-MODEL-CAPTURE-01):
  // requested = the model the node asked for (nodeOptions?.model, resolved
  // from per-node + workflow + config). served = the model that actually
  // responded, surfaced by each provider's result chunk. null = the provider
  // SDK does not expose it (Codex); undefined = the provider has not yet
  // declared support. served_model_mismatch is only meaningful when served
  // is a non-null string.
  let nodeServedModelId: string | null | undefined;
  let nodeServedMissingReason: string | undefined;
  const batchMessages: string[] = [];

  // Create per-node abort controller for idle timeout cleanup
  const nodeAbortController = new AbortController();
  // Fork when resuming -- leaves the source session untouched so retries are safe.
  const shouldForkSession = resumeSessionId !== undefined;
  const nodeOptionsWithAbort: SendQueryOptions | undefined = {
    ...nodeOptions,
    abortSignal: nodeAbortController.signal,
    ...(shouldForkSession ? { forkSession: true } : {}),
  };
  let nodeIdleTimedOut = false;
  const effectiveIdleTimeout = node.idle_timeout ?? STEP_IDLE_TIMEOUT_MS;
  let lastToolStartedAt: { toolName: string; startedAt: number } | null = null;
  let providerAttempt = await beginProviderAttempt(
    deps,
    workflowRun,
    node,
    provider,
    nodeOptions?.model,
    declaredModelId
  );
  let providerAttemptCompleted = false;

  try {
    for await (const msg of withIdleTimeout(
      aiClient.sendQuery(finalPrompt, cwd, resumeSessionId, nodeOptionsWithAbort),
      effectiveIdleTimeout,
      () => {
        nodeIdleTimedOut = true;
        getLog().warn(
          { nodeId: node.id, timeoutMs: effectiveIdleTimeout },
          'dag_node_idle_timeout_reached'
        );
        nodeAbortController.abort();
      }
    )) {
      const tickNow = Date.now();
      const nodeKey = `${workflowRun.id}:${node.id}`;

      // Cancel/pause check -- read-only, no write contention in WAL mode (every 10s).
      //
      // `paused` is tolerated here: an approval node can transition the run to
      // paused while this concurrent node is mid-stream (same topological layer).
      // The streaming node should be allowed to finish its own output -- the
      // paused gate owns workflow progression, not individual node lifecycles.
      // Only truly terminal / unknown states (null, cancelled, failed, completed)
      // abort the in-flight stream.
      if (tickNow - (lastNodeCancelCheck.get(nodeKey) ?? 0) > CANCEL_CHECK_INTERVAL_MS) {
        lastNodeCancelCheck.set(nodeKey, tickNow);
        try {
          const streamStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
          if (!shouldContinueStreamingForStatus(streamStatus)) {
            getLog().info(
              { workflowRunId: workflowRun.id, nodeId: node.id, status: streamStatus ?? 'deleted' },
              'dag.stop_detected_during_streaming'
            );
            nodeAbortController.abort();
            break;
          }
        } catch (cancelCheckErr) {
          getLog().warn(
            { err: cancelCheckErr as Error, workflowRunId: workflowRun.id, nodeId: node.id },
            'dag.status_check_failed'
          );
        }
      }

      // Activity heartbeat -- write, throttled to every 60s (only for stale/zombie detection)
      if (tickNow - (lastNodeActivityUpdate.get(nodeKey) ?? 0) > ACTIVITY_HEARTBEAT_INTERVAL_MS) {
        lastNodeActivityUpdate.set(nodeKey, tickNow);
        try {
          await deps.store.updateWorkflowActivity(workflowRun.id);
        } catch (e) {
          getLog().warn(
            { err: e as Error, workflowRunId: workflowRun.id },
            'dag.activity_update_failed'
          );
        }
      }

      if (msg.type === 'provider_route') {
        await finishProviderAttempt(deps, providerAttempt, {
          servedModelId: null,
          outcomeClass: 'availability',
          reasonCode: msg.reasonCode,
        });
        providerAttemptCompleted = true;
        await persistProviderRouteChange(
          deps,
          workflowRun.id,
          node.id,
          providerAttempt.attemptId,
          msg
        );
        providerAttempt = await beginProviderAttempt(
          deps,
          workflowRun,
          node,
          msg.toProvider,
          msg.toModel,
          declaredModelId
        );
        providerAttemptCompleted = false;
      } else if (msg.type === 'assistant' && msg.content) {
        nodeOutputText += msg.content; // ALWAYS capture for $node_id.output
        if (streamingMode === 'stream' || msg.flush) {
          // `flush` chunks (e.g. Pi notify() emitting a plannotator review URL)
          // must reach the user before the node blocks. Drain any queued batch
          // content first so order is preserved.
          if (streamingMode === 'batch' && batchMessages.length > 0) {
            await safeSendMessage(
              platform,
              conversationId,
              batchMessages.join('\n\n'),
              nodeContext
            );
            batchMessages.length = 0;
          }
          await safeSendMessage(platform, conversationId, msg.content, nodeContext);
        } else {
          batchMessages.push(msg.content);
        }
        await logAssistant(logDir, workflowRun.id, msg.content);
      } else if (msg.type === 'tool' && msg.toolName) {
        const now = Date.now();

        // Emit tool_completed for the previous tool (fire-and-forget)
        if (lastToolStartedAt) {
          const prevTool = lastToolStartedAt;
          getWorkflowEventEmitter().emit({
            type: 'tool_completed',
            runId: workflowRun.id,
            toolName: prevTool.toolName,
            stepName: node.id,
            durationMs: now - prevTool.startedAt,
          });
          deps.store
            .createWorkflowEvent({
              workflow_run_id: workflowRun.id,
              event_type: 'tool_completed',
              step_name: node.id,
              data: {
                tool_name: prevTool.toolName,
                duration_ms: now - prevTool.startedAt,
              },
            })
            .catch((err: Error) => {
              getLog().error(
                { err, workflowRunId: workflowRun.id, eventType: 'tool_completed' },
                'workflow_event_persist_failed'
              );
            });
        }
        lastToolStartedAt = { toolName: msg.toolName, startedAt: now };

        // Emit tool_started for the current tool (fire-and-forget)
        getWorkflowEventEmitter().emit({
          type: 'tool_started',
          runId: workflowRun.id,
          toolName: msg.toolName,
          stepName: node.id,
        });

        if (streamingMode === 'stream') {
          const toolMsg = formatToolCall(msg.toolName, msg.toolInput);
          await safeSendMessage(platform, conversationId, toolMsg, nodeContext, {
            category: 'tool_call_formatted',
          } as WorkflowMessageMetadata);

          // Send structured event to adapters that support it (Web UI)
          if (platform.sendStructuredEvent) {
            await platform.sendStructuredEvent(conversationId, msg);
          }
        }
        await logTool(logDir, workflowRun.id, msg.toolName, msg.toolInput ?? {});

        // Persist tool_called event for ALL adapters (fire-and-forget)
        deps.store
          .createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'tool_called',
            step_name: node.id,
            data: {
              tool_name: msg.toolName,
              tool_input: msg.toolInput ?? {},
            },
          })
          .catch((err: Error) => {
            getLog().error(
              { err, workflowRunId: workflowRun.id, eventType: 'tool_called' },
              'workflow_event_persist_failed'
            );
          });
      } else if (msg.type === 'tool_result' && msg.toolName) {
        if (streamingMode === 'stream' && platform.sendStructuredEvent) {
          await platform.sendStructuredEvent(conversationId, msg);
        }
      } else if (msg.type === 'result') {
        // Emit tool_completed for the last tool in the node
        if (lastToolStartedAt) {
          const prevTool = lastToolStartedAt;
          getWorkflowEventEmitter().emit({
            type: 'tool_completed',
            runId: workflowRun.id,
            toolName: prevTool.toolName,
            stepName: node.id,
            durationMs: Date.now() - prevTool.startedAt,
          });
          deps.store
            .createWorkflowEvent({
              workflow_run_id: workflowRun.id,
              event_type: 'tool_completed',
              step_name: node.id,
              data: {
                tool_name: prevTool.toolName,
                duration_ms: Date.now() - prevTool.startedAt,
              },
            })
            .catch((err: Error) => {
              getLog().error(
                { err, workflowRunId: workflowRun.id, eventType: 'tool_completed' },
                'workflow_event_persist_failed'
              );
            });
          lastToolStartedAt = null;
        }
        if (msg.sessionId) newSessionId = msg.sessionId;
        if (msg.tokens) nodeTokens = msg.tokens;
        if (msg.cost !== undefined) nodeCostUsd = msg.cost;
        if (msg.stopReason !== undefined) nodeStopReason = msg.stopReason;
        if (msg.numTurns !== undefined) nodeNumTurns = msg.numTurns;
        if (msg.modelUsage) nodeModelUsage = msg.modelUsage;
        if (msg.structuredOutput !== undefined) structuredOutput = msg.structuredOutput;
        // Layer 1 served-model capture (WO-HARNESS-LAYER1-SERVED-MODEL-CAPTURE-01):
        // Forward provider-reported served-model fields. null is a valid signal
        // (Codex SDK has no model field) so use explicit undefined checks.
        if (msg.servedModelId !== undefined) nodeServedModelId = msg.servedModelId;
        if (msg.servedModelMissingReason !== undefined) {
          nodeServedMissingReason = msg.servedModelMissingReason;
        }
        // Fail the node if the SDK reports a cost cap exceeded error
        if (msg.isError && msg.errorSubtype === 'error_max_budget_usd') {
          const cap = nodeOptions?.maxBudgetUsd;
          getLog().warn(
            { nodeId: node.id, maxBudgetUsd: cap, durationMs: Date.now() - nodeStartTime },
            'dag.node_budget_cap_exceeded'
          );
          throw new Error(
            `Node '${node.id}' exceeded cost cap${cap !== undefined ? ` of $${cap.toFixed(2)}` : ''}.`
          );
        }
        // Fail loudly on any other SDK error result. Previously we broke out of
        // the stream silently, producing empty/partial output without signaling
        // failure -- which let failed iterations masquerade as successes (#1208).
        if (msg.isError) {
          const resourceExhausted = classifyResourceExhaustedSdkResult(msg);
          if (resourceExhausted) {
            getLog().warn(
              {
                nodeId: node.id,
                errorSubtype: msg.errorSubtype,
                errors: msg.errors,
                reason: resourceExhausted.reason,
                detail: resourceExhausted.detail,
                durationMs: Date.now() - nodeStartTime,
              },
              'dag.node_resource_exhausted'
            );
            if (msg.errorSubtype === 'success') {
              await emitSdkContradictionDump(
                deps,
                workflowRun.id,
                node.id,
                msg,
                personaContextState
              );
            }
            throw new ResourceExhaustedPause(resourceExhausted);
          }
          const subtype = msg.errorSubtype ?? 'unknown';
          const errorsDetail = msg.errors?.length ? ` -- ${msg.errors.join('; ')}` : '';
          getLog().error(
            {
              nodeId: node.id,
              errorSubtype: subtype,
              errors: msg.errors,
              sessionId: msg.sessionId,
              stopReason: msg.stopReason,
              durationMs: Date.now() - nodeStartTime,
            },
            'dag.node_sdk_error_result'
          );
          // SDK success-contradiction (isError=true AND errorSubtype='success'):
          // the SDK reports both "done successfully" and "errored" at once --
          // the 2026-07-06 failure class (bdc-harness#344). Dump the full raw
          // SDK message + persona-load state to a node event for root-cause
          // evidence BEFORE throwing. The node still fails here; the outer retry
          // loop re-runs it exactly once (retry-once, per the WO). If the retry
          // also contradicts, another dump is written and the node fails for real.
          if (msg.errorSubtype === 'success') {
            await emitSdkContradictionDump(deps, workflowRun.id, node.id, msg, personaContextState);
          }
          throw new Error(`Node '${node.id}' failed: SDK returned ${subtype}${errorsDetail}`);
        }
        break; // Result is the "I'm done" signal -- don't wait for subprocess to exit
      } else if (msg.type === 'system' && msg.content) {
        // Providers yield system chunks for user-actionable issues (missing env
        // vars, Haiku+MCP, structured output failures, etc.). MCP-failure
        // chunks need filtering: user-level plugin MCPs inherited from
        // `~/.claude/` (e.g. `telegram`) routinely fail to connect inside the
        // headless subprocess and aren't actionable for the workflow author.
        // Other warnings (!) are always actionable and surface verbatim.
        if (msg.content.startsWith(MCP_FAILURE_PREFIX)) {
          const failedEntries = parseMcpFailureServerNames(msg.content);
          const workflowFailures = failedEntries.filter(e => configuredMcpNames.has(e.name));
          const pluginFailures = failedEntries.filter(e => !configuredMcpNames.has(e.name));

          if (workflowFailures.length > 0) {
            const filteredMsg = `${MCP_FAILURE_PREFIX}${workflowFailures.map(e => e.segment).join(', ')}`;
            getLog().warn(
              { nodeId: node.id, systemContent: filteredMsg },
              'dag.provider_warning_forwarded'
            );
            const delivered = await safeSendMessage(
              platform,
              conversationId,
              filteredMsg,
              nodeContext
            );
            if (!delivered) {
              getLog().error(
                { nodeId: node.id, workflowRunId: workflowRun.id },
                'dag.provider_warning_delivery_failed'
              );
            }
          }
          if (pluginFailures.length > 0) {
            getLog().debug(
              { nodeId: node.id, pluginFailures: pluginFailures.map(e => e.name) },
              'dag.mcp_plugin_connection_suppressed'
            );
          }
        } else if (msg.content.startsWith('!')) {
          getLog().warn(
            { nodeId: node.id, systemContent: msg.content },
            'dag.provider_warning_forwarded'
          );
          const delivered = await safeSendMessage(
            platform,
            conversationId,
            msg.content,
            nodeContext
          );
          if (!delivered) {
            getLog().error(
              { nodeId: node.id, workflowRunId: workflowRun.id },
              'dag.provider_warning_delivery_failed'
            );
          }
        } else if (msg.content.startsWith(CODEX_FAILBACK_PREFIX)) {
          // Codex failback disclosure: surface to platform AND node output.
          getLog().warn(
            { nodeId: node.id, systemContent: msg.content },
            'dag.provider_warning_forwarded'
          );
          const deliveredFailback = await safeSendMessage(
            platform,
            conversationId,
            msg.content,
            nodeContext
          );
          if (!deliveredFailback) {
            getLog().error(
              { nodeId: node.id, workflowRunId: workflowRun.id },
              'dag.provider_warning_delivery_failed'
            );
          }
          // Append disclosure so CROSS_MODEL_REVIEW is visible in node output.
          nodeOutputText += msg.content;
        } else if (msg.content.startsWith(WARNING_PREFIX)) {
          // Resume-warning: surface to platform stream.
          getLog().warn(
            { nodeId: node.id, systemContent: msg.content },
            'dag.provider_warning_forwarded'
          );
          const deliveredWarning = await safeSendMessage(
            platform,
            conversationId,
            msg.content,
            nodeContext
          );
          if (!deliveredWarning) {
            getLog().error(
              { nodeId: node.id, workflowRunId: workflowRun.id },
              'dag.provider_warning_delivery_failed'
            );
          }
        } else {
          getLog().debug(
            { nodeId: node.id, systemContent: msg.content },
            'dag.system_message_unhandled'
          );
        }
      }
      // rate_limit chunks: already log.warn'd in claude.ts; not surfaced to SSE per design
    }

    // When output_format is set and the provider returned structured_output,
    // use it instead of the concatenated assistant text (which includes prose).
    // Each provider normalizes its own structured output onto the result chunk --
    // no provider-specific branching here.
    if (nodeOptions?.outputFormat) {
      if (structuredOutput !== undefined) {
        try {
          nodeOutputText =
            typeof structuredOutput === 'string'
              ? structuredOutput
              : JSON.stringify(structuredOutput);
        } catch (serializeErr) {
          const err = serializeErr as Error;
          throw new Error(
            `Node '${node.id}': failed to serialize structured_output to JSON: ${err.message}`
          );
        }
        getLog().debug({ nodeId: node.id, streamingMode }, 'dag.structured_output_override');
      } else {
        // Provider did not populate structuredOutput -- warn the user.
        // If the provider detected invalid output, it already yielded a system warning.
        getLog().warn(
          { nodeId: node.id, workflowRunId: workflowRun.id },
          'dag.structured_output_missing'
        );
        await safeSendMessage(
          platform,
          conversationId,
          `Warning: Node '${node.id}' requested output_format but the provider did not return structured output. Downstream conditions may not evaluate correctly.`,
          nodeContext
        );
      }
    }

    // Idle is absence of progress, not evidence of completion. Persist the
    // typed attempt outcome and fail closed so failover/climb policy can act.
    if (nodeIdleTimedOut) {
      getLog().warn(
        { nodeId: node.id, timeoutMs: effectiveIdleTimeout },
        'dag_node_progress_timeout'
      );
      if (!providerAttemptCompleted) {
        await finishProviderAttempt(deps, providerAttempt, {
          servedModelId: nodeServedModelId ?? null,
          outcomeClass: 'progress',
          reasonCode: 'progress_timeout',
        });
        providerAttemptCompleted = true;
      }
      const progressError = `Node '${node.id}' exceeded idle timeout (${String(effectiveIdleTimeout)}ms) without meaningful progress`;
      await safeSendMessage(
        platform,
        conversationId,
        `! Node \`${node.id}\` failed its progress deadline after ${String(effectiveIdleTimeout)}ms.`,
        nodeContext
      );
      const failResult = await handleNodeFailure(
        { store: deps.store, emitter, log: getLog(), logNodeError },
        workflowRun,
        node,
        {
          errorMsg: progressError,
          logDir,
          outputSoFar: nodeOutputText,
          hasOutput: nodeOutputText.length > 0,
          gateResult: { passed: false, nodeType: 'ai' },
          extraEventData: {
            reason_code: 'progress_timeout',
            idle_timeout_ms: effectiveIdleTimeout,
          },
        }
      );
      return failResult.output;
    }

    // If cancelled during streaming (not idle timeout), return as failed with cancel reason
    if (nodeAbortController.signal.aborted && !nodeIdleTimedOut) {
      if (!providerAttemptCompleted) {
        await finishProviderAttempt(deps, providerAttempt, {
          servedModelId: nodeServedModelId ?? null,
          outcomeClass: 'cancelled',
          reasonCode: 'attempt_cancelled',
        });
        providerAttemptCompleted = true;
      }
      const duration = Date.now() - nodeStartTime;
      getLog().info(
        { nodeId: node.id, durationMs: duration },
        'dag_node_cancelled_during_streaming'
      );

      const cancelMsg = 'Cancelled by user';
      const failResult = await handleNodeFailure(
        { store: deps.store, emitter, log: getLog(), logNodeError },
        workflowRun,
        node,
        {
          errorMsg: cancelMsg,
          logDir,
          outputSoFar: nodeOutputText,
          hasOutput: nodeOutputText.length > 0,
          gateResult: { passed: false, nodeType: 'ai' },
          extraEventData: { duration_ms: duration },
        }
      );

      // Clean up throttle entries
      lastNodeCancelCheck.delete(`${workflowRun.id}:${node.id}`);
      lastNodeActivityUpdate.delete(`${workflowRun.id}:${node.id}`);

      return failResult.output;
    }

    if (streamingMode === 'batch' && batchMessages.length > 0) {
      const batchContent =
        structuredOutput !== undefined && nodeOptions?.outputFormat
          ? nodeOutputText
          : batchMessages.join('\n\n');
      await safeSendMessage(platform, conversationId, batchContent, nodeContext);
    }

    // Detect credit exhaustion: SDK returns it as assistant text, not a thrown error.
    const creditError = detectCreditExhaustion(nodeOutputText);

    if (creditError) {
      const resourceExhausted = classifyResourceExhaustionText(creditError);
      if (resourceExhausted) {
        throw new ResourceExhaustedPause(resourceExhausted);
      }
      const duration = Date.now() - nodeStartTime;
      getLog().warn({ nodeId: node.id, durationMs: duration }, 'dag.node_credit_exhausted');

      const failResult = await handleNodeFailure(
        { store: deps.store, emitter, log: getLog(), logNodeError },
        workflowRun,
        node,
        {
          errorMsg: creditError,
          logDir,
          outputSoFar: nodeOutputText,
          hasOutput: nodeOutputText.length > 0,
          gateResult: { passed: false, nodeType: 'ai' },
          extraEventData: { duration_ms: duration },
        }
      );

      lastNodeCancelCheck.delete(`${workflowRun.id}:${node.id}`);
      lastNodeActivityUpdate.delete(`${workflowRun.id}:${node.id}`);

      return failResult.output;
    }

    // Empty assistant output is a failure for AI nodes -- a provider stream
    // that closed cleanly with zero content typically means a silent
    // rejection or interruption that didn't produce a result.isError chunk.
    // Bash/script/approval nodes don't reach this path; they have their
    // own dispatch and never stream through this loop.
    //
    if (nodeOutputText.trim() === '' && structuredOutput === undefined) {
      const duration = Date.now() - nodeStartTime;
      const emptyError = `Node '${node.id}' produced no assistant output. The provider stream closed without yielding content -- likely a silent provider rejection or stream interruption.`;
      getLog().error({ nodeId: node.id, durationMs: duration }, 'dag.node_empty_output');
      if (!providerAttemptCompleted) {
        await finishProviderAttempt(deps, providerAttempt, {
          servedModelId: nodeServedModelId ?? null,
          outcomeClass: 'contradiction',
          reasonCode: 'sdk_contradiction',
        });
        providerAttemptCompleted = true;
      }

      const failResult = await handleNodeFailure(
        { store: deps.store, emitter, log: getLog(), logNodeError },
        workflowRun,
        node,
        {
          errorMsg: emptyError,
          logDir,
          outputSoFar: '',
          hasOutput: false,
          gateResult: { passed: false, nodeType: 'ai' },
          extraEventData: { duration_ms: duration },
        }
      );

      lastNodeCancelCheck.delete(`${workflowRun.id}:${node.id}`);
      lastNodeActivityUpdate.delete(`${workflowRun.id}:${node.id}`);

      return failResult.output;
    }

    await finishProviderAttempt(deps, providerAttempt, {
      servedModelId: nodeServedModelId ?? null,
      outcomeClass: 'success',
      reasonCode: 'execution_completed',
    });
    providerAttemptCompleted = true;

    const duration = Date.now() - nodeStartTime;
    getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');
    await logNodeComplete(logDir, workflowRun.id, node.id, node.command ?? '<inline>', {
      durationMs: duration,
      tokens: nodeTokens,
    });

    // Consume any gate result registered for this node (Phase 5 cascade engine
    // calls recordGateResult before node completion). Always clear the map entry.
    const gateResultKey = `${workflowRun.id}:${node.id}`;
    const nodeGateResult = pendingGateResults.get(gateResultKey);
    pendingGateResults.delete(gateResultKey);

    await deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_completed',
        step_name: node.id,
        data: {
          duration_ms: duration,
          node_output: nodeOutputText,
          ...(nodeCostUsd !== undefined ? { cost_usd: nodeCostUsd } : {}),
          ...(nodeStopReason ? { stop_reason: nodeStopReason } : {}),
          ...(nodeNumTurns !== undefined ? { num_turns: nodeNumTurns } : {}),
          ...(nodeModelUsage ? { model_usage: nodeModelUsage } : {}),
          ...(nodeTokens ? { tokens: nodeTokens } : {}),
          // Layer 1 served-model capture (WO-HARNESS-LAYER1-SERVED-MODEL-CAPTURE-01),
          // extended by WO-HARNESS-TELEMETRY-DECLARED-MODEL-AND-COST-01:
          // declared = the pre-persona effective model (node.model ?? workflow/
          // assistant default -- reflects the raw parsed YAML pin). requested =
          // nodeOptions?.model (post-persona effective per-node model, unchanged
          // from prior behavior). served = provider-reported. served_model_mismatch
          // is now computed via alias-aware comparison against declared_model_id
          // (not requested_model_id) so alias resolution (declared 'sonnet' served
          // 'claude-sonnet-5') is NOT flagged, while a genuine silent substitution
          // still is. Only written when served is a non-null string AND declared is
          // known -- a null served or missing declared has no meaningful mismatch
          // signal, so omit the flag entirely in that case to avoid false negatives
          // in downstream readers.
          ...(declaredModelId !== undefined ? { declared_model_id: declaredModelId } : {}),
          ...(nodeOptions?.model !== undefined ? { requested_model_id: nodeOptions.model } : {}),
          ...(nodeServedModelId !== undefined ? { served_model_id: nodeServedModelId } : {}),
          ...(nodeServedMissingReason !== undefined
            ? { served_model_missing_reason: nodeServedMissingReason }
            : {}),
          ...(typeof nodeServedModelId === 'string' && declaredModelId !== undefined
            ? { served_model_mismatch: !isDeclaredServedMatch(declaredModelId, nodeServedModelId) }
            : {}),
          // Layer 1 tier + counterfactual cost (WO-HARNESS-LAYER1-TIER-AND-COUNTERFACTUAL-COST-01).
          // entry_rung is derived from provider + effective per-node model. Phase 4 (router
          // tiers) will replace this with the router-assigned rung. frontier_cost_usd is
          // tokens * frontier-model rate -- the counterfactual cost if this node had run on
          // the frontier rung instead of where it actually ran. Omit-when-absent for tokens.
          entry_rung: deriveEntryRung(provider, nodeOptions?.model),
          ...(nodeTokens ? { frontier_cost_usd: computeFrontierCost(nodeTokens) } : {}),
          // Layer 1 gate_result field (WO-HARNESS-LAYER1-CLIMB-AND-GATE-EVENTS-01).
          // Present only when Phase 5 cascade engine registered a gate_result for
          // this node via recordGateResult() before it completed.
          ...buildGateResultField(nodeGateResult),
        },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'node_completed' },
          'workflow_event_persist_failed'
        );
      });

    emitter.emit({
      type: 'node_completed',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeName: node.command ?? node.id,
      duration,
      ...(nodeCostUsd !== undefined ? { costUsd: nodeCostUsd } : {}),
      ...(nodeStopReason ? { stopReason: nodeStopReason } : {}),
      ...(nodeNumTurns !== undefined ? { numTurns: nodeNumTurns } : {}),
      ...buildGateResultField(nodeGateResult),
    });

    // Clean up throttle entries on completion
    lastNodeCancelCheck.delete(`${workflowRun.id}:${node.id}`);
    lastNodeActivityUpdate.delete(`${workflowRun.id}:${node.id}`);
    return {
      state: 'completed',
      output: nodeOutputText,
      sessionId: newSessionId,
      costUsd: nodeCostUsd,
      ...(nodeTokens ? { tokens: nodeTokens } : {}),
      ...(nodeModelUsage ? { modelUsage: nodeModelUsage } : {}),
      ...(nodeTokens ? { frontierCostUsd: computeFrontierCost(nodeTokens) } : {}),
      ...(declaredModelId !== undefined ? { declaredModelId } : {}),
      ...(nodeOptions?.model !== undefined ? { requestedModelId: nodeOptions.model } : {}),
      ...(nodeServedModelId !== undefined ? { servedModelId: nodeServedModelId } : {}),
      ...(typeof nodeServedModelId === 'string' && declaredModelId !== undefined
        ? { modelMismatch: !isDeclaredServedMatch(declaredModelId, nodeServedModelId) }
        : {}),
    };
  } catch (error) {
    const failureError: unknown = error;
    if (!providerAttemptCompleted && !(error instanceof ResourceExhaustedPause)) {
      const attemptOutcome: {
        outcomeClass: ProviderAttemptOutcomeClass;
        reasonCode: OutcomeReasonCode;
      } =
        error instanceof ResourceExhaustedPause
          ? { outcomeClass: 'quota', reasonCode: 'provider_quota_wait' }
          : nodeAbortController.signal.aborted && !nodeIdleTimedOut
            ? { outcomeClass: 'cancelled', reasonCode: 'attempt_cancelled' }
            : nodeIdleTimedOut
              ? { outcomeClass: 'progress', reasonCode: 'progress_timeout' }
              : isSdkSuccessContradiction((error as Error).message)
                ? { outcomeClass: 'contradiction', reasonCode: 'sdk_contradiction' }
                : isAvailabilityError((error as Error).message)
                  ? { outcomeClass: 'availability', reasonCode: 'provider_unavailable' }
                  : { outcomeClass: 'quality', reasonCode: 'execution_failed' };
      await finishProviderAttempt(deps, providerAttempt, {
        servedModelId: nodeServedModelId ?? null,
        ...attemptOutcome,
      });
      providerAttemptCompleted = true;
    }
    if (error instanceof ResourceExhaustedPause) {
      lastNodeCancelCheck.delete(`${workflowRun.id}:${node.id}`);
      lastNodeActivityUpdate.delete(`${workflowRun.id}:${node.id}`);
      getLog().warn(
        {
          nodeId: node.id,
          attempt: providerAttempt.attemptNumber,
          provider,
          reason: error.info.reason,
        },
        'dag.node_resource_exhausted_route_pending'
      );
      await finishProviderAttempt(deps, providerAttempt, {
        servedModelId: nodeServedModelId ?? null,
        outcomeClass: 'quota',
        reasonCode: 'provider_quota_exhausted',
      });
      providerAttemptCompleted = true;
      return {
        state: 'failed',
        output: '',
        error: `resource_exhausted: ${error.info.detail}`,
        quotaExhausted: {
          attemptId: providerAttempt.attemptId,
          attemptNumber: providerAttempt.attemptNumber,
          attemptStartedAt: providerAttempt.startedAt,
          provider,
          info: error.info,
        },
      };
    }

    const err = failureError as Error;

    // Clean up throttle entries on failure
    lastNodeCancelCheck.delete(`${workflowRun.id}:${node.id}`);
    lastNodeActivityUpdate.delete(`${workflowRun.id}:${node.id}`);

    // Consume and clear any pending gate result for this node. The success path
    // consumes this inside the try block; the exception path must clear it here
    // to avoid stale map entries and to include the gate outcome on node_failed.
    const catchGateResultKey = `${workflowRun.id}:${node.id}`;
    const catchNodeGateResult = pendingGateResults.get(catchGateResultKey);
    pendingGateResults.delete(catchGateResultKey);
    const failureGateResult =
      catchNodeGateResult ??
      (err.message.startsWith('resource_exhausted_timeout')
        ? ({ passed: false, nodeType: 'ai' } satisfies GateResult)
        : undefined);

    // If the abort was triggered by user cancel (not idle timeout), classify as cancel.
    // Must call handleNodeFailure here (not early-return) so the node_failed event is
    // persisted and emitted -- and so catchNodeGateResult is forwarded rather than
    // silently dropped. Mirrors the in-stream cancel path at dag-executor.ts:1257.
    if (nodeAbortController.signal.aborted && !nodeIdleTimedOut) {
      getLog().info({ nodeId: node.id }, 'dag_node_cancelled_via_abort');
      const cancelMsg = 'Cancelled by user';
      const failResult = await handleNodeFailure(
        { store: deps.store, emitter, log: getLog(), logNodeError },
        workflowRun,
        node,
        {
          errorMsg: cancelMsg,
          logDir,
          outputSoFar: nodeOutputText,
          hasOutput: nodeOutputText.length > 0,
          gateResult: catchNodeGateResult ?? { passed: false, nodeType: 'ai' },
        }
      );
      return failResult.output;
    }

    getLog().error({ err, nodeId: node.id }, 'dag_node_failed');
    await logNodeError(logDir, workflowRun.id, node.id, err.message);

    // M-20260726-87 Cause 1: mark the engine dark ONLY on the binding
    // zero-usage token signature (never derived from err.message). No-op
    // when tokens flowed (a real failure, not a quota/availability wall) or
    // when this provider+model has no corresponding router.yaml engine.
    const failedEngine = resolveRouterEngine(provider, declaredModelId);
    if (failedEngine !== undefined) {
      const availabilityEvent = markEngineDarkIfZeroUsage(failedEngine, nodeTokens, nodeCostUsd, {
        runId: workflowRun.id,
        nodeId: node.id,
      });
      if (availabilityEvent !== null) {
        getLog().warn({ nodeId: node.id, ...availabilityEvent }, 'dag.engine_marked_dark');
        await deps.store
          .createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'engine_availability_changed',
            step_name: node.id,
            data: { ...availabilityEvent },
          })
          .catch((err: Error) => {
            getLog().error(
              { err, workflowRunId: workflowRun.id, eventType: 'engine_availability_changed' },
              'workflow_event_persist_failed'
            );
          });
      }
    }

    await deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_failed',
        step_name: node.id,
        // If the SDK emitted a result (tokens) BEFORE throwing on msg.isError,
        // persist that partial usage so per-node token attribution survives the
        // failure path. Omit-when-absent (never 0, never {}) mirrors the
        // node_completed contract.
        data: {
          error: err.message,
          provider,
          ...(declaredModelId !== undefined ? { declared_model_id: declaredModelId } : {}),
          ...(nodeOptions?.model !== undefined ? { requested_model_id: nodeOptions.model } : {}),
          ...(nodeServedModelId !== undefined ? { served_model_id: nodeServedModelId } : {}),
          ...(nodeServedMissingReason !== undefined
            ? { served_model_missing_reason: nodeServedMissingReason }
            : {}),
          ...(typeof nodeServedModelId === 'string' && declaredModelId !== undefined
            ? {
                served_model_mismatch: !isDeclaredServedMatch(declaredModelId, nodeServedModelId),
              }
            : {}),
          entry_rung: deriveEntryRung(provider, nodeOptions?.model),
          ...(err.message.startsWith('resource_exhausted_timeout')
            ? { reason: 'resource_exhausted_timeout' }
            : {}),
          ...(nodeModelUsage ? { model_usage: nodeModelUsage } : {}),
          ...(nodeTokens ? { tokens: nodeTokens } : {}),
          // Layer 1 gate_result field: present when Phase 5 registered a gate
          // outcome before the SDK threw (e.g. gate check fired then SDK errored).
          ...buildGateResultField(failureGateResult),
        },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'node_failed' },
          'workflow_event_persist_failed'
        );
      });

    emitter.emit({
      type: 'node_failed',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeName: node.command ?? node.id,
      error: err.message,
      ...buildGateResultField(failureGateResult),
    });

    return {
      state: 'failed',
      output: '',
      error: err.message,
      costUsd: nodeCostUsd,
      ...(nodeTokens ? { tokens: nodeTokens } : {}),
      ...(nodeModelUsage ? { modelUsage: nodeModelUsage } : {}),
      ...(nodeTokens ? { frontierCostUsd: computeFrontierCost(nodeTokens) } : {}),
      // Mirrors the completed-path fields (same variables, same omit-when-absent
      // convention) so the rollup accumulator's node_model_summary stays
      // consistent with its cost/token accumulation, which already includes
      // failed nodes that reported partial usage before the SDK threw.
      ...(declaredModelId !== undefined ? { declaredModelId } : {}),
      ...(nodeOptions?.model !== undefined ? { requestedModelId: nodeOptions.model } : {}),
      ...(nodeServedModelId !== undefined ? { servedModelId: nodeServedModelId } : {}),
      ...(typeof nodeServedModelId === 'string' && declaredModelId !== undefined
        ? { modelMismatch: !isDeclaredServedMatch(declaredModelId, nodeServedModelId) }
        : {}),
    };
  }
}

/** Default timeout for subprocess nodes (bash, script): 2 minutes */
const SUBPROCESS_DEFAULT_TIMEOUT = 120_000;

/**
 * Execute a bash (shell script) DAG node.
 * Runs the script via a temp file, captures stdout as node output.
 * No AI session is created -- bash nodes are free/deterministic.
 */
async function executeBashNode(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflowRun: WorkflowRun,
  node: BashNode,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  nodeOutputs: Map<string, NodeOutput>,
  issueContext?: string,
  envVars?: Record<string, string>,
  resolvedInputs?: Record<string, string>
): Promise<NodeOutput> {
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };

  getLog().info({ nodeId: node.id, type: 'bash' }, 'dag_node_started');
  await logNodeStart(logDir, workflowRun.id, node.id, '<bash>');

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_started',
      step_name: node.id,
      data: { type: 'bash' },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'node_started' },
        'workflow_event_persist_failed'
      );
    });

  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'node_started',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: node.id,
  });

  // Variable substitution on script
  const { prompt: substitutedScript } = substituteWorkflowVariables(
    node.bash,
    workflowRun.id,
    workflowRun.user_message,
    artifactsDir,
    baseBranch,
    docsDir,
    issueContext
  );
  const nodeRefResolved = substituteNodeOutputRefs(substitutedScript, nodeOutputs, true);
  // Substitute ${input.X} references from workflow inputs (safe: '.' is not a valid bash
  // identifier character, so these patterns can never collide with real bash expansions).
  const finalScript = resolvedInputs
    ? substituteInputRefs(nodeRefResolved, resolvedInputs)
    : nodeRefResolved;

  const timeout = node.timeout ?? SUBPROCESS_DEFAULT_TIMEOUT;
  // Inject workflow inputs as INPUT_<NAME> env vars (belt-and-suspenders alongside template substitution).
  const inputEnvVars: Record<string, string> = resolvedInputs
    ? Object.fromEntries(
        Object.entries(resolvedInputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])
      )
    : {};
  const subprocessEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ARTIFACTS_DIR: artifactsDir,
    LOG_DIR: logDir,
    BASE_BRANCH: baseBranch,
    // WORKFLOW_ID and WORKTREE_PATH as actual env vars (complement the $WORKFLOW_ID template token).
    WORKFLOW_ID: workflowRun.id,
    WORKTREE_PATH: cwd,
    ...inputEnvVars,
    ...(envVars ?? {}),
  };

  const safeNodeId = node.id.replace(/[^A-Za-z0-9._-]/g, '_');
  const safeRunId = workflowRun.id.replace(/[^A-Za-z0-9._-]/g, '_');
  const scriptDir = artifactsDir || tmpdir();
  const scriptFile = join(scriptDir, `node-${safeNodeId}-${safeRunId}.sh`);

  try {
    let stdout = '';
    let stderr = '';
    try {
      try {
        await mkdir(scriptDir, { recursive: true });
        await writeFile(scriptFile, finalScript, { mode: 0o600 });
        await chmod(scriptFile, 0o600);
      } catch (error) {
        const err = error as Error & { code?: number | string };
        const details = err.message ? `: ${err.message}` : '';
        throw Object.assign(new Error(`${scriptFile}${details}`), {
          code: err.code,
          cause: err,
          scriptFile,
          scriptPreparationFailed: true,
        });
      }
      ({ stdout, stderr } = await execFileAsync('bash', [scriptFile], {
        cwd,
        timeout,
        env: subprocessEnv,
      }));
    } finally {
      try {
        await unlink(scriptFile);
      } catch {
        // Best-effort cleanup: deletion failures must not change node outcome.
      }
    }

    // Trim trailing newline from stdout (common shell behavior)
    const output = stdout.replace(/\n$/, '');

    if (stderr.trim()) {
      getLog().warn({ nodeId: node.id, stderr: stderr.trim() }, 'bash_node_stderr');
      await safeSendMessage(
        platform,
        conversationId,
        `Bash node '${node.id}' stderr:\n\`\`\`\n${stderr.trim()}\n\`\`\``,
        nodeContext
      );
    }

    const duration = Date.now() - nodeStartTime;

    // WO-170: detect silent-failure pattern in stdout even though exit code was 0.
    // Load-bearing nodes (per WO-167 doctrine) get any STATUS=*_failed flagged;
    // all nodes get always-dangerous patterns (push_failed, commit_failed, ...) flagged.
    const warning = detectSilentFailure(output, node.load_bearing === true);

    if (warning) {
      getLog().warn(
        {
          nodeId: node.id,
          durationMs: duration,
          patterns: warning.patterns,
          loadBearing: warning.loadBearing,
        },
        'dag_node_completed_with_warning'
      );
      await logNodeComplete(logDir, workflowRun.id, node.id, '<bash>', {
        durationMs: duration,
      });

      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'node_completed_with_warning',
          step_name: node.id,
          data: {
            duration_ms: duration,
            type: 'bash',
            node_output: output,
            warning_status_line: warning.statusLine,
            warning_patterns: warning.patterns,
            warning_load_bearing: warning.loadBearing,
          },
        })
        .catch((err: Error) => {
          getLog().error(
            { err, workflowRunId: workflowRun.id, eventType: 'node_completed_with_warning' },
            'workflow_event_persist_failed'
          );
        });

      emitter.emit({
        type: 'node_completed_with_warning',
        runId: workflowRun.id,
        nodeId: node.id,
        nodeName: node.id,
        duration,
        statusLine: warning.statusLine,
        patterns: warning.patterns,
        loadBearing: warning.loadBearing,
      });

      // Downstream nodes still see this node as completed -- the warning is an
      // observability signal, not a graph-control change. Failing the node
      // here would block dependents; rolling-up at workflow level is the UI's
      // job (see WorkflowExecution.tsx).
      // Clear any Phase 5 gate result registered for this node so the map does
      // not leak when the warning path exits instead of the normal success path.
      pendingGateResults.delete(`${workflowRun.id}:${node.id}`);
      return { state: 'completed', output };
    }

    getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');
    await logNodeComplete(logDir, workflowRun.id, node.id, '<bash>', { durationMs: duration });

    // Section 1 gate_result contract: field required on BOTH success AND failure for
    // bash nodes. Consume any gate result registered for this bash node (Phase 5
    // cascade engine calls recordGateResult before node completion). If Phase 5 has
    // not stored a result, synthesize a default pass result (always clear the entry).
    const bashGateResultKey = `${workflowRun.id}:${node.id}`;
    const bashNodeGateResult: GateResult = pendingGateResults.get(bashGateResultKey) ?? {
      passed: true,
      nodeType: 'bash',
    };
    pendingGateResults.delete(bashGateResultKey);

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_completed',
        step_name: node.id,
        data: {
          duration_ms: duration,
          type: 'bash',
          node_output: output,
          gate_result: bashNodeGateResult,
        },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'node_completed' },
          'workflow_event_persist_failed'
        );
      });

    emitter.emit({
      type: 'node_completed',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeName: node.id,
      duration,
      gate_result: bashNodeGateResult,
    });

    return { state: 'completed', output };
  } catch (error) {
    const err = error as Error & {
      killed?: boolean;
      code?: number | string;
      stderr?: string;
      scriptFile?: string;
      scriptPreparationFailed?: boolean;
    };
    const isTimeout = err.killed === true || (err.message ?? '').includes('timed out');
    const label = `Bash node '${node.id}'`;
    // Always run the formatter so logs get sanitized fields regardless of which
    // user-facing branch we end up in. Spawn failures can still include
    // command metadata, and the formatter keeps log output constrained.
    const formatted = formatSubprocessFailure(err, label);
    let errorMsg: string;
    if (err.scriptPreparationFailed) {
      errorMsg = `${label} failed: unable to prepare temporary script at ${err.scriptFile ?? scriptFile}`;
    } else if (isTimeout) {
      errorMsg = `${label} timed out after ${String(timeout)}ms`;
    } else if (err.message?.includes('ENOENT')) {
      errorMsg = `${label} failed: bash executable not found in PATH`;
    } else if (err.message?.includes('EACCES')) {
      errorMsg = `${label} failed: permission denied (check cwd permissions)`;
    } else {
      errorMsg = formatted.userMessage;
    }

    getLog().error(
      { ...formatted.logFields, nodeId: node.id, nodeType: 'bash', isTimeout },
      'dag_node_failed'
    );

    // Route through overseer-bridge so bash-node failures get classified and the
    // silent-dead-end classes (implement_loop_no_output, validator_feedback_not_applied,
    // validator_rejected, implement_loop_skipped) trigger escalation side effects.
    // Pre-WO-OVERSEER-FAILURE-CLASSES-EXPANSION-01 this site inlined the logNodeError
    // + createWorkflowEvent + emitter.emit + return-failed pattern and missed the
    // bash-node failure mode entirely.
    const validatorOutput = nodeOutputs.get('war-council-validator')?.output ?? undefined;
    const woIdMatch = workflowRun.user_message
      ? /\bWO-[A-Z0-9-]+/.exec(workflowRun.user_message)
      : null;
    const woId = woIdMatch ? woIdMatch[0] : undefined;
    const exitCode = typeof err.code === 'number' ? err.code : undefined;

    const failResult = await handleNodeFailure(
      { store: deps.store, emitter, log: getLog(), logNodeError },
      workflowRun,
      node,
      {
        errorMsg,
        logDir,
        outputSoFar: '',
        hasOutput: false,
        nodeType: 'bash',
        exitCode,
        validatorOutput,
        woId,
        gateResult: { passed: false, nodeType: 'bash', exitCode, isTimeout },
        extraEventData: { type: 'bash', isTimeout },
      }
    );

    return failResult.output;
  }
}

/**
 * Execute a script (TypeScript via bun or Python via uv) DAG node.
 * Supports both inline code snippets and named scripts discovered from .archon/scripts/.
 * stdout is captured and trimmed as the node output; stderr is logged as a warning.
 */
async function executeScriptNode(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflowRun: WorkflowRun,
  node: ScriptNode,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  nodeOutputs: Map<string, NodeOutput>,
  issueContext?: string,
  envVars?: Record<string, string>
): Promise<NodeOutput> {
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };

  getLog().info({ nodeId: node.id, type: 'script', runtime: node.runtime }, 'dag_node_started');
  await logNodeStart(logDir, workflowRun.id, node.id, '<script>');

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_started',
      step_name: node.id,
      data: { type: 'script', runtime: node.runtime },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'node_started' },
        'workflow_event_persist_failed'
      );
    });

  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'node_started',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: node.id,
  });

  // Variable substitution on script field
  const { prompt: substitutedScript } = substituteWorkflowVariables(
    node.script,
    workflowRun.id,
    workflowRun.user_message,
    artifactsDir,
    baseBranch,
    docsDir,
    issueContext
  );
  const finalScript = substituteNodeOutputRefs(substitutedScript, nodeOutputs, false);

  const timeout = node.timeout ?? SUBPROCESS_DEFAULT_TIMEOUT;
  const subprocessEnv =
    envVars && Object.keys(envVars).length > 0 ? { ...process.env, ...envVars } : undefined;

  // Build the command and args based on runtime and inline vs named
  let cmd = '';
  let args: string[] = [];

  const nodeDeps = node.deps ?? [];

  try {
    if (isInlineScript(finalScript)) {
      // Inline code execution
      if (node.runtime === 'bun') {
        cmd = resolveBunRuntimeExecutable();
        // --no-env-file prevents Bun from auto-loading .env from the execution
        // cwd (the target repo). Without this, repo .env leaks into the script
        // subprocess despite Archon's parent process cleanup.
        args = ['--no-env-file', '-e', finalScript];
      } else {
        // uv run --with dep1 --with dep2 python -c <code>
        cmd = 'uv';
        const withFlags = nodeDeps.flatMap(dep => ['--with', dep]);
        args = ['run', ...withFlags, 'python', '-c', finalScript];
      }
    } else {
      // Named script -- look up across repo and home scopes.
      // Precedence: <cwd>/.archon/scripts/ > ~/.archon/scripts/ (repo wins).
      // Wrap discovery in its own try/catch so a permission error on ~/.archon/scripts/
      // isn't mis-attributed by the outer catch's "permission denied (check cwd
      // permissions)" branch -- that branch is for execFileAsync EACCES.
      let scripts: Awaited<ReturnType<typeof discoverScriptsForCwd>>;
      try {
        scripts = await discoverScriptsForCwd(cwd);
      } catch (discoveryErr) {
        const err = discoveryErr as Error;
        const errorMsg = `Script node '${node.id}': failed to discover scripts -- ${err.message}`;
        getLog().error({ err, nodeId: node.id, cwd }, 'script_discovery_failed');
        await safeSendMessage(platform, conversationId, errorMsg, nodeContext);
        await logNodeError(logDir, workflowRun.id, node.id, errorMsg);

        emitter.emit({
          type: 'node_failed',
          runId: workflowRun.id,
          nodeId: node.id,
          nodeName: node.id,
          error: errorMsg,
        });
        deps.store
          .createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'node_failed',
            step_name: node.id,
            data: { error: errorMsg, type: 'script' },
          })
          .catch((dbErr: Error) => {
            getLog().error(
              { err: dbErr, workflowRunId: workflowRun.id, eventType: 'node_failed' },
              'workflow_event_persist_failed'
            );
          });

        return { state: 'failed', output: '', error: errorMsg };
      }
      const scriptDef = scripts.get(finalScript);

      if (!scriptDef) {
        const errorMsg = `Script node '${node.id}': named script '${finalScript}' not found in .archon/scripts/ or ~/.archon/scripts/`;
        getLog().error({ nodeId: node.id, scriptName: finalScript }, 'script_not_found');
        await safeSendMessage(platform, conversationId, errorMsg, nodeContext);
        await logNodeError(logDir, workflowRun.id, node.id, errorMsg);

        emitter.emit({
          type: 'node_failed',
          runId: workflowRun.id,
          nodeId: node.id,
          nodeName: node.id,
          error: errorMsg,
        });
        deps.store
          .createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'node_failed',
            step_name: node.id,
            data: { error: errorMsg, type: 'script' },
          })
          .catch((dbErr: Error) => {
            getLog().error(
              { err: dbErr, workflowRunId: workflowRun.id, eventType: 'node_failed' },
              'workflow_event_persist_failed'
            );
          });

        return { state: 'failed', output: '', error: errorMsg };
      }

      // Use scriptDef.runtime (canonical source) instead of re-deriving from extension
      if (scriptDef.runtime === 'uv') {
        cmd = 'uv';
        const withFlags = nodeDeps.flatMap(dep => ['--with', dep]);
        args = ['run', ...withFlags, scriptDef.path];
      } else {
        cmd = resolveBunRuntimeExecutable();
        args = ['--no-env-file', 'run', scriptDef.path];
      }
    }

    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout,
      env: subprocessEnv,
    });

    // Trim trailing newline from stdout (common shell behavior)
    const output = stdout.replace(/\n$/, '');

    if (stderr.trim()) {
      getLog().warn({ nodeId: node.id, stderr: stderr.trim() }, 'script_node_stderr');
      await safeSendMessage(
        platform,
        conversationId,
        `Script node '${node.id}' stderr:\n\`\`\`\n${stderr.trim()}\n\`\`\``,
        nodeContext
      );
    }

    const duration = Date.now() - nodeStartTime;

    // WO-170: same silent-failure detection on script nodes -- STATUS=*_failed
    // on stdout when exit code was 0 is a yellow-state signal.
    const warning = detectSilentFailure(output, node.load_bearing === true);

    if (warning) {
      getLog().warn(
        {
          nodeId: node.id,
          durationMs: duration,
          patterns: warning.patterns,
          loadBearing: warning.loadBearing,
        },
        'dag_node_completed_with_warning'
      );
      await logNodeComplete(logDir, workflowRun.id, node.id, '<script>', {
        durationMs: duration,
      });

      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'node_completed_with_warning',
          step_name: node.id,
          data: {
            duration_ms: duration,
            type: 'script',
            node_output: output,
            warning_status_line: warning.statusLine,
            warning_patterns: warning.patterns,
            warning_load_bearing: warning.loadBearing,
          },
        })
        .catch((err: Error) => {
          getLog().error(
            { err, workflowRunId: workflowRun.id, eventType: 'node_completed_with_warning' },
            'workflow_event_persist_failed'
          );
        });

      emitter.emit({
        type: 'node_completed_with_warning',
        runId: workflowRun.id,
        nodeId: node.id,
        nodeName: node.id,
        duration,
        statusLine: warning.statusLine,
        patterns: warning.patterns,
        loadBearing: warning.loadBearing,
      });

      // Clear any Phase 5 gate result registered for this node so the map does
      // not leak when the warning path exits instead of the normal success path
      // (same map hygiene as the success path at scriptGateResultKey below;
      // see bash counterpart in executeBashNode).
      pendingGateResults.delete(`${workflowRun.id}:${node.id}`);
      return { state: 'completed', output };
    }

    getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');
    await logNodeComplete(logDir, workflowRun.id, node.id, '<script>', { durationMs: duration });

    // Section 1 gate_result contract: field required on BOTH success AND failure for
    // script nodes. Consume any gate result registered for this script node (Phase 5
    // cascade engine calls recordGateResult before node completion). If Phase 5 has
    // not stored a result, synthesize a default pass result (always clear the entry).
    const scriptGateResultKey = `${workflowRun.id}:${node.id}`;
    const scriptNodeGateResult: GateResult = pendingGateResults.get(scriptGateResultKey) ?? {
      passed: true,
      nodeType: 'script',
    };
    pendingGateResults.delete(scriptGateResultKey);

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_completed',
        step_name: node.id,
        data: {
          duration_ms: duration,
          type: 'script',
          node_output: output,
          gate_result: scriptNodeGateResult,
        },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'node_completed' },
          'workflow_event_persist_failed'
        );
      });

    emitter.emit({
      type: 'node_completed',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeName: node.id,
      duration,
      gate_result: scriptNodeGateResult,
    });

    return { state: 'completed', output };
  } catch (error) {
    const err = error as Error & { killed?: boolean; code?: number | string; stderr?: string };
    const isTimeout = err.killed === true || (err.message ?? '').includes('timed out');
    const label = `Script node '${node.id}'`;
    // Always run the formatter so logs get sanitized fields regardless of which
    // user-facing branch we end up in -- the timeout message also contains the
    // full `Command failed: bun -e <body>` line and would otherwise leak.
    const formatted = formatSubprocessFailure(err, label);
    let errorMsg: string;
    if (isTimeout) {
      errorMsg = `${label} timed out after ${String(timeout)}ms`;
    } else if (err.message?.includes('ENOENT')) {
      errorMsg = `${label} failed: '${cmd}' executable not found in PATH`;
    } else if (err.message?.includes('EACCES')) {
      errorMsg = `${label} failed: permission denied (check cwd permissions)`;
    } else {
      errorMsg = formatted.userMessage;
    }

    getLog().error(
      { ...formatted.logFields, nodeId: node.id, nodeType: 'script', isTimeout },
      'dag_node_failed'
    );

    // Route through overseer-bridge (parallel to bash failure site) so script-node
    // failures get classified and gate_result is threaded into the emitted and
    // persisted node_failed event.
    // Pre-WO-HARNESS-LAYER1-GATE-RESULT-ALL-FAILURE-SITES-01 this catch block
    // inlined logNodeError + createWorkflowEvent + emitter.emit and omitted gate_result.
    const scriptValidatorOutput = nodeOutputs.get('war-council-validator')?.output ?? undefined;
    const scriptWoIdMatch = workflowRun.user_message
      ? /\bWO-[A-Z0-9-]+/.exec(workflowRun.user_message)
      : null;
    const scriptWoId = scriptWoIdMatch ? scriptWoIdMatch[0] : undefined;
    const exitCode = typeof err.code === 'number' ? err.code : undefined;

    const failResult = await handleNodeFailure(
      { store: deps.store, emitter, log: getLog(), logNodeError },
      workflowRun,
      node,
      {
        errorMsg,
        logDir,
        outputSoFar: '',
        hasOutput: false,
        nodeType: 'script',
        exitCode,
        validatorOutput: scriptValidatorOutput,
        woId: scriptWoId,
        gateResult: { passed: false, nodeType: 'script', exitCode, isTimeout },
        extraEventData: { type: 'script', isTimeout },
      }
    );

    return failResult.output;
  }
}

/**
 * Build SendQueryOptions from resolved provider, model, and config.
 * Uses the same nodeConfig + assistantConfig pattern as resolveNodeProviderAndModel.
 */
function buildLoopNodeOptions(
  node: LoopNode,
  provider: string,
  model: string | undefined,
  config: WorkflowConfig,
  workflowLevelOptions?: WorkflowLevelOptions
): SendQueryOptions {
  const options: SendQueryOptions = {};
  if (model) options.model = model;
  if (config.envVars && Object.keys(config.envVars).length > 0) {
    options.env = config.envVars;
  }
  if (node.systemPrompt !== undefined) options.systemPrompt = node.systemPrompt;
  options.assistantConfig = config.assistants[provider] ?? {};
  // Pass workflow-level options as nodeConfig so providers can apply them
  if (workflowLevelOptions) {
    options.nodeConfig = {
      effort: workflowLevelOptions.effort,
      thinking: workflowLevelOptions.thinking,
      sandbox: workflowLevelOptions.sandbox,
      betas: workflowLevelOptions.betas,
      fallbackModel: workflowLevelOptions.fallbackModel,
    };
  }
  return options;
}

/**
 * Execute a loop node -- runs prompt repeatedly until completion signal or max iterations.
 *
 * Key behaviors:
 * - Returns NodeExecutionResult (not void) -- DAG executor owns workflow lifecycle
 * - Receives upstream node outputs for $nodeId.output substitution
 * - Does not write current_step_index (DAG tracks per-node completion)
 */
async function executeLoopNode(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflowRun: WorkflowRun,
  node: LoopNode,
  workflowProvider: string,
  workflowModel: string | undefined,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  nodeOutputs: Map<string, NodeOutput>,
  config: WorkflowConfig,
  issueContext?: string,
  workflowLevelOptions?: WorkflowLevelOptions
): Promise<NodeExecutionResult> {
  const loop = node.loop;
  const msgContext = { workflowId: workflowRun.id, nodeName: node.id };

  // Resolve AI client -- fail fast with descriptive error
  let aiClient: ReturnType<typeof deps.getAgentProvider>;
  try {
    aiClient = deps.getAgentProvider(workflowProvider);
  } catch (error) {
    const err = error as Error;
    const errorMsg = `Invalid provider '${workflowProvider}' for loop node '${node.id}'. Check workflow YAML or .archon/config.yaml. Original: ${err.message}`;
    getLog().error(
      { err, nodeId: node.id, provider: workflowProvider },
      'loop_node.provider_failed'
    );
    return { state: 'failed', output: '', error: errorMsg };
  }

  // Detect interactive loop resume -- check if workflowRun.metadata has loop gate state for this node
  const rawApproval = workflowRun.metadata?.approval;
  const loopGateMeta = isApprovalContext(rawApproval) ? rawApproval : undefined;
  const isLoopResume = loopGateMeta?.type === 'interactive_loop' && loopGateMeta.nodeId === node.id;
  const startIteration = isLoopResume ? (loopGateMeta.iteration ?? 0) + 1 : 1;
  let currentSessionId: string | undefined = isLoopResume ? loopGateMeta.sessionId : undefined;
  const loopUserInput = isLoopResume
    ? ((workflowRun.metadata?.loop_user_input as string | undefined) ?? '')
    : '';

  let lastIterationOutput = '';
  let loopTotalCostUsd: number | undefined;
  let loopTotalTokens: TokenUsage | undefined;
  let loopFinalStopReason: string | undefined;
  let loopTotalNumTurns: number | undefined;
  // Layer 1 served-model capture, extended to loop nodes
  // (WO-HARNESS-TELEMETRY-DECLARED-MODEL-AND-COST-01). Loop nodes previously
  // never captured servedModelId at all. Tracks the LAST iteration's reported
  // value (mirrors currentSessionId's "last seen wins" semantics) since a loop
  // node's node_completed event represents its final iteration.
  let loopServedModelId: string | null | undefined;
  let loopServedMissingReason: string | undefined;
  const resolvedOptions = buildLoopNodeOptions(
    node,
    workflowProvider,
    workflowModel,
    config,
    workflowLevelOptions
  );

  // Resolve agent persona for loop node (if `agent:` or `persona:` is declared).
  // `persona:` is the human-facing alias for `agent:` -- both resolve identically.
  // Applied to every iteration -- same semantics as prompt/command nodes:
  // persona model overrides the loop-resolved model; persona system prompt is
  // prepended to any node-level systemPrompt.
  // Note: the loop path does NOT call loadContext (wiki + oracle) today;
  // that pre-existing gap is tracked separately and is out of scope for the
  // persona-alias WO (preserve current loop behavior identically).
  const loopAgentRef = node as { agent?: string; persona?: string };
  const loopAgentName = loopAgentRef.agent ?? loopAgentRef.persona;
  if (loopAgentName) {
    const registry = await getAgentRegistry(cwd);
    const persona = resolveAgent(loopAgentName, registry);
    if (persona) {
      // workflowProvider here is already the per-node provider (the outer
      // dispatch resolves node.provider ?? workflowProvider before calling
      // executeLoopNode), so a codex loop node is correctly recognized.
      const personaResolution = resolveAgentPersona(
        persona,
        resolvedOptions.model,
        workflowProvider
      );
      resolvedOptions.model = personaResolution.model;
      resolvedOptions.systemPrompt = resolvedOptions.systemPrompt
        ? `${personaResolution.systemPrompt}\n\n${resolvedOptions.systemPrompt}`
        : personaResolution.systemPrompt;
    }
  }

  // Helper to log event store errors consistently
  const logEventStoreError = (err: Error, iteration: number): void => {
    getLog().error({ err, nodeId: node.id, iteration }, 'loop_node.iteration_event_failed');
  };
  const persistLoopNodeFailed = async (error: string): Promise<void> => {
    await deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_failed',
        step_name: node.id,
        data: {
          error,
          ...(loopTotalTokens ? { tokens: loopTotalTokens } : {}),
          ...(workflowModel !== undefined ? { declared_model_id: workflowModel } : {}),
          ...(resolvedOptions.model !== undefined
            ? { requested_model_id: resolvedOptions.model }
            : {}),
          ...(loopServedModelId !== undefined ? { served_model_id: loopServedModelId } : {}),
          ...(loopServedMissingReason !== undefined
            ? { served_model_missing_reason: loopServedMissingReason }
            : {}),
          ...(typeof loopServedModelId === 'string' && workflowModel !== undefined
            ? { served_model_mismatch: !isDeclaredServedMatch(workflowModel, loopServedModelId) }
            : {}),
          entry_rung: deriveEntryRung(workflowProvider, workflowModel),
          ...(loopTotalTokens ? { frontier_cost_usd: computeFrontierCost(loopTotalTokens) } : {}),
        },
      })
      .catch((evtErr: Error) => {
        getLog().error(
          { err: evtErr, workflowRunId: workflowRun.id, eventType: 'node_failed' },
          'workflow_event_persist_failed'
        );
      });
  };

  // Sticky signal detection: once the completion token appears in any iteration's
  // output it stays true, so a resumed interactive loop or a reset fullOutput on the
  // next iteration cannot "un-detect" a signal the agent already emitted.
  let stickySignalDetected = false;

  for (let i = startIteration; i <= loop.max_iterations; i++) {
    const iterationStart = Date.now();

    // Check for non-running status between iterations. `paused` is tolerated
    // here for the same reason as the streaming check: a sibling approval
    // node in the same topological layer may pause the run while this loop
    // is between iterations -- the loop should continue its own iterations
    // regardless of unrelated pauses elsewhere in the DAG.
    const runStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
    if (!shouldContinueStreamingForStatus(runStatus)) {
      const effectiveStatus = runStatus ?? 'deleted';
      getLog().info(
        { workflowRunId: workflowRun.id, nodeId: node.id, iteration: i, status: effectiveStatus },
        'loop_node.stop_detected'
      );
      await safeSendMessage(
        platform,
        conversationId,
        `Loop node '${node.id}' stopped at iteration ${String(i)} (${effectiveStatus})`,
        msgContext
      );
      return { state: 'failed', output: '', error: `Workflow ${effectiveStatus}` };
    }

    // Emit iteration started
    getWorkflowEventEmitter().emit({
      type: 'loop_iteration_started',
      runId: workflowRun.id,
      nodeId: node.id,
      iteration: i,
      maxIterations: loop.max_iterations,
    });
    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'loop_iteration_started',
        step_name: node.id,
        data: { iteration: i, maxIterations: loop.max_iterations, nodeId: node.id },
      })
      .catch((err: Error) => {
        logEventStoreError(err, i);
      });

    // Session threading
    const needsFreshSession = loop.fresh_context || i === 1;
    const resumeSessionId = needsFreshSession ? undefined : currentSessionId;

    // Stream AI response for this iteration. A wall breach gets one inner retry
    // with a longer wall; it does not consume another loop iteration.
    let fullOutput = ''; // raw, for signal detection
    let cleanOutput = ''; // stripped, for platform display
    let iterationIdleTimedOut = false;
    // Per-iteration deadlines (WO-HARNESS-LOOP-OUTPUT-NEWLINE-AND-ITERATION-TIMEOUT-01):
    // idle is shorter than STEP_IDLE (30m); wall is absolute even if keepalives reset idle.
    const effectiveIdleTimeout = resolveLoopIterationIdleTimeoutMs(node.idle_timeout);
    const effectiveWallTimeout = resolveLoopIterationWallTimeoutMs(node.wall_timeout_ms);
    let iterationAttempt: ProviderAttemptRecord | undefined;
    let iterationAttemptCompleted = false;
    const wallBreaches: { attempt: 1 | 2; elapsedMs: number; wallMs: number }[] = [];

    const emitWallBreach = async (
      attempt: 1 | 2,
      elapsedMs: number,
      wallMs: number
    ): Promise<void> => {
      wallBreaches.push({ attempt, elapsedMs, wallMs });
      const rung = deriveEntryRung(workflowProvider, workflowModel);
      getWorkflowEventEmitter().emit({
        type: 'node_wall_breach',
        runId: workflowRun.id,
        nodeId: node.id,
        iteration: i,
        attempt,
        elapsedMs,
        wallMs,
        rung,
      });
      await deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'node_wall_breach',
          step_name: node.id,
          data: { iteration: i, attempt, elapsedMs, wallMs, rung, nodeId: node.id },
        })
        .catch((evtErr: Error) => {
          logEventStoreError(evtErr, i);
        });
    };

    const failAfterWallBreaches = async (): Promise<NodeExecutionResult> => {
      const first = wallBreaches[0];
      const second = wallBreaches[1];
      const wallError =
        first && second
          ? `Loop '${node.id}' iteration ${String(i)} exceeded wall timeout twice: attempt 1 ${String(first.elapsedMs)}ms/${String(first.wallMs)}ms, attempt 2 ${String(second.elapsedMs)}ms/${String(second.wallMs)}ms`
          : `Loop '${node.id}' iteration ${String(i)} exceeded wall timeout (${String(effectiveWallTimeout)}ms)`;
      const duration = Date.now() - iterationStart;
      getLog().error(
        { nodeId: node.id, iteration: i, timeoutMs: effectiveWallTimeout, wallBreaches },
        'loop_node.iteration_wall_timeout'
      );
      getWorkflowEventEmitter().emit({
        type: 'loop_iteration_failed',
        runId: workflowRun.id,
        nodeId: node.id,
        iteration: i,
        error: wallError,
      });
      await deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'loop_iteration_failed',
          step_name: node.id,
          data: {
            iteration: i,
            error: wallError,
            duration,
            nodeId: node.id,
            wallTimedOut: true,
            wallTimeoutMs: effectiveWallTimeout,
            wallBreaches,
            ...(loopTotalTokens ? { tokens: loopTotalTokens } : {}),
          },
        })
        .catch((evtErr: Error) => {
          logEventStoreError(evtErr, i);
        });
      await persistLoopNodeFailed(`Loop iteration ${i} failed: ${wallError}`);
      return {
        state: 'failed',
        output: fullOutput,
        error: `Loop iteration ${i} failed: ${wallError}`,
        costUsd: loopTotalCostUsd,
        ...(loopTotalTokens ? { tokens: loopTotalTokens } : {}),
      };
    };

    for (const wallAttempt of [1, 2] as const) {
      const attemptWallTimeout =
        wallAttempt === 1 ? effectiveWallTimeout : Math.min(effectiveWallTimeout * 2, 3_600_000);
      const attemptStartedAt = Date.now();
      let iterationWallTimedOut = false;
      const iterationAbortController = new AbortController();
      const wallTimer = setTimeout(() => {
        iterationWallTimedOut = true;
        getLog().warn(
          { nodeId: node.id, iteration: i, attempt: wallAttempt, timeoutMs: attemptWallTimeout },
          'loop_node.wall_timeout_reached'
        );
        iterationAbortController.abort();
      }, attemptWallTimeout);
      iterationAttempt = undefined;
      iterationAttemptCompleted = false;
      iterationIdleTimedOut = false;

      try {
        // Build prompt -- substituteWorkflowVariables throws if $BASE_BRANCH referenced but empty
        // Pass loopUserInput on the first resumed iteration; '' on all others (non-interactive
        // or subsequent iterations) so $LOOP_USER_INPUT substitutes to empty string explicitly.
        // $LOOP_PREV_OUTPUT carries the previous iteration's cleaned output and is empty on
        // the first iteration (no prior output exists). Across an interactive resume, the
        // executor starts a fresh `lastIterationOutput` variable, so the first iteration of
        // the resume also receives an empty $LOOP_PREV_OUTPUT.
        const { prompt: substitutedPrompt } = substituteWorkflowVariables(
          loop.prompt,
          workflowRun.id,
          workflowRun.user_message,
          artifactsDir,
          baseBranch,
          docsDir,
          issueContext,
          i === startIteration ? loopUserInput : '',
          undefined, // rejectionReason
          i === startIteration ? '' : lastIterationOutput
        );
        const finalPrompt = substituteNodeOutputRefs(substitutedPrompt, nodeOutputs);

        const iterationOptions: SendQueryOptions | undefined = {
          ...resolvedOptions,
          abortSignal: iterationAbortController.signal,
        };

        iterationAttempt = await beginProviderAttempt(
          deps,
          workflowRun,
          node,
          workflowProvider,
          resolvedOptions.model,
          workflowModel
        );
        const generator = aiClient.sendQuery(finalPrompt, cwd, resumeSessionId, iterationOptions);
        let lastToolStartedAt: { toolName: string; startedAt: number } | null = null;

        for await (const msg of withIdleTimeout(generator, effectiveIdleTimeout, () => {
          iterationIdleTimedOut = true;
          getLog().warn(
            { nodeId: node.id, iteration: i, timeoutMs: effectiveIdleTimeout },
            'loop_node.idle_timeout_reached'
          );
          iterationAbortController.abort();
        })) {
          if (iterationWallTimedOut) break;
          if (msg.type === 'provider_route') {
            if (!iterationAttempt) throw new Error('provider_route_without_attempt');
            await finishProviderAttempt(deps, iterationAttempt, {
              servedModelId: null,
              outcomeClass: 'availability',
              reasonCode: msg.reasonCode,
            });
            iterationAttemptCompleted = true;
            await persistProviderRouteChange(
              deps,
              workflowRun.id,
              node.id,
              iterationAttempt.attemptId,
              msg
            );
            iterationAttempt = await beginProviderAttempt(
              deps,
              workflowRun,
              node,
              msg.toProvider,
              msg.toModel,
              workflowModel
            );
            iterationAttemptCompleted = false;
          } else if (msg.type === 'assistant') {
            fullOutput += msg.content;
            // Clean the accumulated buffer, not each provider chunk independently.
            // stripCompletionTags() trims its input, so per-chunk cleaning erased
            // newline-only chunks and joined adjacent fields in persisted output and
            // $LOOP_PREV_OUTPUT (anchor: run 42ee6575).
            const previousCleanOutput = cleanOutput;
            cleanOutput = stripCompletionTags(fullOutput, loop.until);
            const cleanedDelta = cleanOutput.startsWith(previousCleanOutput)
              ? cleanOutput.slice(previousCleanOutput.length)
              : '';
            if (platform.getStreamingMode() === 'stream' && cleanedDelta) {
              await safeSendMessage(platform, conversationId, cleanedDelta, msgContext);
            }
            await logAssistant(logDir, workflowRun.id, msg.content);
          } else if (msg.type === 'result') {
            // Emit tool_completed for the last tool in the iteration
            if (lastToolStartedAt) {
              const prevTool = lastToolStartedAt;
              getWorkflowEventEmitter().emit({
                type: 'tool_completed',
                runId: workflowRun.id,
                toolName: prevTool.toolName,
                stepName: node.id,
                durationMs: Date.now() - prevTool.startedAt,
              });
              deps.store
                .createWorkflowEvent({
                  workflow_run_id: workflowRun.id,
                  event_type: 'tool_completed',
                  step_name: node.id,
                  data: {
                    tool_name: prevTool.toolName,
                    duration_ms: Date.now() - prevTool.startedAt,
                  },
                })
                .catch((err: Error) => {
                  logEventStoreError(err, i);
                });
              lastToolStartedAt = null;
            }
            if (msg.sessionId) currentSessionId = msg.sessionId;
            if (msg.cost !== undefined) {
              loopTotalCostUsd = (loopTotalCostUsd ?? 0) + msg.cost;
            }
            if (msg.tokens) {
              const t = msg.tokens;
              if (!loopTotalTokens) loopTotalTokens = { input: 0, output: 0 };
              loopTotalTokens.input += t.input;
              loopTotalTokens.output += t.output;
              if (t.total !== undefined) {
                loopTotalTokens.total = (loopTotalTokens.total ?? 0) + t.total;
              }
            }
            if (msg.stopReason !== undefined) loopFinalStopReason = msg.stopReason;
            if (msg.numTurns !== undefined) {
              loopTotalNumTurns = (loopTotalNumTurns ?? 0) + msg.numTurns;
            }
            if (msg.servedModelId !== undefined) loopServedModelId = msg.servedModelId;
            if (msg.servedModelMissingReason !== undefined) {
              loopServedMissingReason = msg.servedModelMissingReason;
            }
            // Fail the iteration loudly on SDK error results. Previously we broke
            // silently, producing empty output and continuing to the next iteration --
            // which made `error_during_execution` on resumed interactive loops look
            // like a "5-second crash" that kept burning iterations (#1208).
            if (msg.isError) {
              const resourceExhausted = classifyResourceExhaustedSdkResult(msg);
              if (resourceExhausted) {
                getLog().warn(
                  {
                    nodeId: node.id,
                    iteration: i,
                    errorSubtype: msg.errorSubtype,
                    errors: msg.errors,
                    reason: resourceExhausted.reason,
                  },
                  'loop_node.iteration_resource_exhausted'
                );
                throw new ResourceExhaustedPause(resourceExhausted);
              }
              const subtype = msg.errorSubtype ?? 'unknown';
              const errorsDetail = msg.errors?.length ? ` -- ${msg.errors.join('; ')}` : '';
              getLog().error(
                {
                  nodeId: node.id,
                  iteration: i,
                  errorSubtype: subtype,
                  errors: msg.errors,
                  sessionId: msg.sessionId,
                  stopReason: msg.stopReason,
                },
                'loop_node.iteration_sdk_error'
              );
              throw new Error(
                `Loop '${node.id}' iteration ${String(i)} failed: SDK returned ${subtype}${errorsDetail}`
              );
            }
            break; // Result is the "I'm done" signal -- don't wait for subprocess to exit
          } else if (msg.type === 'tool' && msg.toolName) {
            const now = Date.now();

            // Emit tool_completed for the previous tool
            if (lastToolStartedAt) {
              const prevTool = lastToolStartedAt;
              getWorkflowEventEmitter().emit({
                type: 'tool_completed',
                runId: workflowRun.id,
                toolName: prevTool.toolName,
                stepName: node.id,
                durationMs: now - prevTool.startedAt,
              });
              deps.store
                .createWorkflowEvent({
                  workflow_run_id: workflowRun.id,
                  event_type: 'tool_completed',
                  step_name: node.id,
                  data: { tool_name: prevTool.toolName, duration_ms: now - prevTool.startedAt },
                })
                .catch((err: Error) => {
                  logEventStoreError(err, i);
                });
            }
            lastToolStartedAt = { toolName: msg.toolName, startedAt: now };

            // Emit tool_started for the current tool (fire-and-forget)
            getWorkflowEventEmitter().emit({
              type: 'tool_started',
              runId: workflowRun.id,
              toolName: msg.toolName,
              stepName: node.id,
            });

            if (platform.getStreamingMode() === 'stream') {
              const toolMsg = formatToolCall(msg.toolName, msg.toolInput);
              if (toolMsg) {
                await safeSendMessage(platform, conversationId, toolMsg, msgContext, {
                  category: 'tool_call_formatted',
                } as WorkflowMessageMetadata);
              }
              if (platform.sendStructuredEvent) {
                await platform.sendStructuredEvent(conversationId, msg);
              }
            }

            const toolInput: Record<string, unknown> = msg.toolInput
              ? Object.fromEntries(
                  Object.entries(msg.toolInput).map(([k, v]) =>
                    typeof v === 'string' && v.length > 500 ? [k, v.slice(0, 500) + '...'] : [k, v]
                  )
                )
              : {};
            await logTool(logDir, workflowRun.id, msg.toolName, toolInput);

            // Persist tool_called event
            deps.store
              .createWorkflowEvent({
                workflow_run_id: workflowRun.id,
                event_type: 'tool_called',
                step_name: node.id,
                data: { tool_name: msg.toolName, tool_input: toolInput },
              })
              .catch((err: Error) => {
                logEventStoreError(err, i);
              });
          } else if (msg.type === 'tool_result' && platform.sendStructuredEvent) {
            await platform.sendStructuredEvent(conversationId, msg);
          }
          // rate_limit chunks: already log.warn'd in claude.ts; not surfaced to SSE per design
        }
      } catch (error) {
        let failureError: unknown = error;
        if (iterationWallTimedOut) {
          failureError = new Error(
            `Loop '${node.id}' iteration ${String(i)} exceeded wall timeout (${String(attemptWallTimeout)}ms)`
          );
        } else if (error instanceof ResourceExhaustedPause) {
          if (!iterationAttempt) throw error;
          await finishProviderAttempt(deps, iterationAttempt, {
            servedModelId: loopServedModelId ?? null,
            outcomeClass: 'quota',
            reasonCode: 'provider_quota_exhausted',
          });
          iterationAttemptCompleted = true;
          return {
            state: 'failed',
            output: '',
            error: `resource_exhausted: ${error.info.detail}`,
            quotaExhausted: {
              attemptId: iterationAttempt.attemptId,
              attemptNumber: iterationAttempt.attemptNumber,
              attemptStartedAt: iterationAttempt.startedAt,
              provider: workflowProvider,
              info: error.info,
              iteration: i,
            },
          };
        }

        if (iterationAttempt && !iterationAttemptCompleted) {
          const attemptOutcome = iterationWallTimedOut
            ? ({ outcomeClass: 'progress', reasonCode: 'progress_timeout' } as const)
            : isSdkSuccessContradiction((failureError as Error).message)
              ? ({ outcomeClass: 'contradiction', reasonCode: 'sdk_contradiction' } as const)
              : isAvailabilityError((failureError as Error).message)
                ? ({ outcomeClass: 'availability', reasonCode: 'provider_unavailable' } as const)
                : ({ outcomeClass: 'quality', reasonCode: 'execution_failed' } as const);
          await finishProviderAttempt(deps, iterationAttempt, {
            servedModelId: loopServedModelId ?? null,
            ...attemptOutcome,
          });
          iterationAttemptCompleted = true;
        }

        if (iterationWallTimedOut) {
          await emitWallBreach(wallAttempt, Date.now() - attemptStartedAt, attemptWallTimeout);
          if (wallAttempt === 1) {
            fullOutput = '';
            cleanOutput = '';
            continue;
          }
          return await failAfterWallBreaches();
        }

        const err = failureError as Error;
        const duration = Date.now() - iterationStart;
        getLog().error({ err, nodeId: node.id, iteration: i }, 'loop_node.iteration_failed');
        getWorkflowEventEmitter().emit({
          type: 'loop_iteration_failed',
          runId: workflowRun.id,
          nodeId: node.id,
          iteration: i,
          error: err.message,
        });
        deps.store
          .createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'loop_iteration_failed',
            step_name: node.id,
            // Persist aggregate tokens accumulated across iterations BEFORE the
            // failure so per-node token attribution survives loop SDK errors.
            // Mirrors the omit-when-absent contract used on loop completion.
            data: {
              iteration: i,
              error: err.message,
              duration,
              nodeId: node.id,
              ...(loopTotalTokens ? { tokens: loopTotalTokens } : {}),
            },
          })
          .catch((evtErr: Error) => {
            logEventStoreError(evtErr, i);
          });
        await persistLoopNodeFailed(`Loop iteration ${i} failed: ${err.message}`);
        return {
          state: 'failed',
          output: '',
          error: `Loop iteration ${i} failed: ${err.message}`,
          costUsd: loopTotalCostUsd,
          ...(loopTotalTokens ? { tokens: loopTotalTokens } : {}),
        };
      } finally {
        clearTimeout(wallTimer);
      }

      // Wall timeout without a thrown abort: retry once, then fail closed.
      if (iterationWallTimedOut) {
        if (iterationAttempt && !iterationAttemptCompleted) {
          await finishProviderAttempt(deps, iterationAttempt, {
            servedModelId: loopServedModelId ?? null,
            outcomeClass: 'progress',
            reasonCode: 'progress_timeout',
          });
          iterationAttemptCompleted = true;
        }
        await emitWallBreach(wallAttempt, Date.now() - attemptStartedAt, attemptWallTimeout);
        if (wallAttempt === 1) {
          fullOutput = '';
          cleanOutput = '';
          continue;
        }
        return await failAfterWallBreaches();
      }

      break;
    }

    // Wall timeout without a thrown abort: fail closed (do not treat as idle success).
    if (wallBreaches.length >= 2) {
      if (iterationAttempt && !iterationAttemptCompleted) {
        await finishProviderAttempt(deps, iterationAttempt, {
          servedModelId: loopServedModelId ?? null,
          outcomeClass: 'progress',
          reasonCode: 'progress_timeout',
        });
        iterationAttemptCompleted = true;
      }
      return await failAfterWallBreaches();
    }

    // An idle timeout is absence of progress, never proof of successful work.
    if (iterationIdleTimedOut) {
      if (iterationAttempt && !iterationAttemptCompleted) {
        await finishProviderAttempt(deps, iterationAttempt, {
          servedModelId: loopServedModelId ?? null,
          outcomeClass: 'progress',
          reasonCode: 'progress_timeout',
        });
        iterationAttemptCompleted = true;
      }
      const idleError = `Loop '${node.id}' iteration ${String(i)} exceeded idle timeout (${String(effectiveIdleTimeout)}ms)`;
      await safeSendMessage(platform, conversationId, idleError, msgContext);
      await persistLoopNodeFailed(idleError);
      return {
        state: 'failed',
        output: fullOutput,
        error: idleError,
        costUsd: loopTotalCostUsd,
        ...(loopTotalTokens ? { tokens: loopTotalTokens } : {}),
      };
    }

    // Empty assistant output is an iteration failure for AI loops -- same
    // contract as the single-shot AI-node guard in executeNodeInternal. A
    // provider stream that closed cleanly with zero content typically means
    // a silent rejection or interruption; left unchecked, an interactive
    // loop would pause with a blank gate or burn the full max_iterations
    // budget producing nothing. Idle-timeout exits are exempt -- the
    // notification above has already told the user the iteration completed
    // via timeout, and flipping that to a failure would contradict it.
    if (!iterationIdleTimedOut && fullOutput.trim() === '') {
      if (iterationAttempt && !iterationAttemptCompleted) {
        await finishProviderAttempt(deps, iterationAttempt, {
          servedModelId: loopServedModelId ?? null,
          outcomeClass: 'contradiction',
          reasonCode: 'sdk_contradiction',
        });
        iterationAttemptCompleted = true;
      }
      const iterationDuration = Date.now() - iterationStart;
      const emptyError =
        'Loop iteration produced no assistant output. The provider stream closed without yielding content -- likely a silent provider rejection or stream interruption.';
      getLog().error(
        { nodeId: node.id, iteration: i, durationMs: iterationDuration },
        'loop_node.iteration_empty_output'
      );
      getWorkflowEventEmitter().emit({
        type: 'loop_iteration_failed',
        runId: workflowRun.id,
        nodeId: node.id,
        iteration: i,
        error: emptyError,
      });
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'loop_iteration_failed',
          step_name: node.id,
          // Same token-persistence rationale as the SDK-error branch above:
          // empty-output failures still carry accumulated loopTotalTokens.
          data: {
            iteration: i,
            error: emptyError,
            duration: iterationDuration,
            nodeId: node.id,
            ...(loopTotalTokens ? { tokens: loopTotalTokens } : {}),
          },
        })
        .catch((evtErr: Error) => {
          logEventStoreError(evtErr, i);
        });
      await persistLoopNodeFailed(`Loop iteration ${i} failed: ${emptyError}`);
      return {
        state: 'failed',
        output: '',
        error: `Loop iteration ${i} failed: ${emptyError}`,
        costUsd: loopTotalCostUsd,
        ...(loopTotalTokens ? { tokens: loopTotalTokens } : {}),
      };
    }

    if (iterationAttempt && !iterationAttemptCompleted) {
      await finishProviderAttempt(deps, iterationAttempt, {
        servedModelId: loopServedModelId ?? null,
        outcomeClass: 'success',
        reasonCode: 'execution_completed',
      });
      iterationAttemptCompleted = true;
    }

    // Batch mode: send accumulated output
    if (platform.getStreamingMode() === 'batch' && cleanOutput) {
      await safeSendMessage(platform, conversationId, cleanOutput, msgContext);
    }

    lastIterationOutput = cleanOutput || fullOutput;

    // Check LLM completion signal -- the AI decides whether the user approved.
    // For interactive loops, the AI emits the signal when the user explicitly approves
    // (e.g., "approved", "looks good"). The prompt instructs the AI on when to emit it.
    // plan-review uses expanded approval detection (F3) so open models that emit
    // PLAN_REVIEW_PASS=true still complete the loop.
    const signalDetected =
      node.id === PLAN_REVIEW_NODE_ID
        ? containsPlanReviewApproval(fullOutput)
        : detectCompletionSignal(fullOutput, loop.until);
    if (signalDetected) stickySignalDetected = true;

    // Check deterministic bash condition (if configured).
    // `until_file` is a shorthand that expands to a `test -f` check.
    const effectiveUntilBash = loop.until_file
      ? `test -f .archon/${loop.until_file}`
      : loop.until_bash;
    let bashComplete = false;
    if (effectiveUntilBash) {
      try {
        const { prompt: bashPrompt } = substituteWorkflowVariables(
          effectiveUntilBash,
          workflowRun.id,
          workflowRun.user_message,
          artifactsDir,
          baseBranch,
          docsDir,
          issueContext
        );
        const substitutedBash = substituteNodeOutputRefs(
          bashPrompt,
          nodeOutputs,
          true // escapedForBash
        );
        await execFileAsync('bash', ['-c', substitutedBash], { cwd });
        bashComplete = true; // exit 0 = complete
      } catch (e) {
        const bashErr = e as NodeJS.ErrnoException;
        // ENOENT or other system errors are unexpected -- log them
        if (bashErr.code === 'ENOENT') {
          getLog().warn(
            { err: bashErr, nodeId: node.id, iteration: i },
            'loop_node.until_bash_exec_error'
          );
        }
        bashComplete = false; // non-zero exit = not complete
      }
    }

    const duration = Date.now() - iterationStart;
    const planReviewEscalationDetected =
      node.id === PLAN_REVIEW_NODE_ID && containsPlanReviewEscalation(lastIterationOutput);
    const completionDetected =
      !planReviewEscalationDetected && (stickySignalDetected || bashComplete);
    // Debug hints for mashed/flattened open-model output (WO loop-newline).
    // Substring presence is intentional -- not the same as signalDetected.
    const signalHints = {
      planReviewPassPresent: /PLAN_REVIEW_PASS/i.test(fullOutput),
      planReviewPassTruePresent: /PLAN_REVIEW_PASS\s*=\s*true/i.test(fullOutput),
      planReviewApprovedPresent: /PLAN_REVIEW_APPROVED/i.test(fullOutput),
      signalDetected,
      planReviewEscalationDetected,
      idleTimedOut: iterationIdleTimedOut,
      outputHead: fullOutput.slice(0, 240),
      outputTail: fullOutput.length > 240 ? fullOutput.slice(-240) : undefined,
    };

    // Emit iteration completed
    getWorkflowEventEmitter().emit({
      type: 'loop_iteration_completed',
      runId: workflowRun.id,
      nodeId: node.id,
      iteration: i,
      duration,
      completionDetected,
    });
    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'loop_iteration_completed',
        step_name: node.id,
        data: {
          iteration: i,
          duration,
          completionDetected,
          nodeId: node.id,
          signalHints,
        },
      })
      .catch((err: Error) => {
        logEventStoreError(err, i);
      });

    await logNodeComplete(logDir, workflowRun.id, `${node.id}-iteration-${String(i)}`, node.id, {
      durationMs: duration,
    });

    if (planReviewEscalationDetected) {
      const packetPath = await writePlanReviewEscalationPacket(
        artifactsDir,
        workflowRun,
        node.id,
        i,
        loop.max_iterations,
        lastIterationOutput
      ).catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, nodeId: node.id, iteration: i },
          'loop_node.plan_review_escalation_packet_failed'
        );
        return undefined;
      });
      if (packetPath) {
        await deps.store
          .createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'workflow_artifact',
            step_name: node.id,
            data: {
              artifact_type: 'file_created',
              path: packetPath,
              nodeId: node.id,
              reason: 'plan_review_escalation',
            },
          })
          .catch((err: Error) => {
            getLog().error(
              { err, workflowRunId: workflowRun.id, eventType: 'workflow_artifact' },
              'workflow_event_persist_failed'
            );
          });
      }
      const decision =
        extractPlanReviewField(lastIterationOutput, 'SINGLE_DECISION_NEEDED') ??
        'plan-review requested human escalation';
      const errorMsg = `Loop node '${node.id}' escalated at iteration ${String(i)}: ${decision}`;
      await safeSendMessage(platform, conversationId, errorMsg, msgContext);
      await persistLoopNodeFailed(errorMsg);
      return {
        state: 'failed',
        output: lastIterationOutput,
        error: errorMsg,
        costUsd: loopTotalCostUsd,
        ...(loopTotalTokens ? { tokens: loopTotalTokens } : {}),
      };
    }

    // Completion signal detected -- exit the loop.
    // For interactive loops: only honor the signal when the AI had user input to evaluate
    // (i.e., this is a resume iteration with loopUserInput). On the first iteration of a
    // fresh interactive loop, the user hasn't seen anything yet -- always gate first.
    // For non-interactive loops: the AI signals task completion at any point.
    const interactiveFirstRun = loop.interactive && !isLoopResume;
    if (completionDetected && !interactiveFirstRun) {
      await safeSendMessage(
        platform,
        conversationId,
        `Loop node '${node.id}' completed after ${String(i)} iteration${i > 1 ? 's' : ''}`,
        msgContext
      );
      // Write node_completed event so resume logic (getCompletedDagNodeOutputs) knows this
      // node is done. Without this, a resumed DAG would re-enter the loop node.
      await deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'node_completed',
          step_name: node.id,
          data: {
            duration_ms: Date.now() - iterationStart,
            node_output: lastIterationOutput,
            ...(loopTotalCostUsd !== undefined ? { cost_usd: loopTotalCostUsd } : {}),
            ...(loopFinalStopReason ? { stop_reason: loopFinalStopReason } : {}),
            ...(loopTotalNumTurns !== undefined ? { num_turns: loopTotalNumTurns } : {}),
            ...(loopTotalTokens ? { tokens: loopTotalTokens } : {}),
            // Layer 1 tier + counterfactual cost (WO-HARNESS-LAYER1-TIER-AND-COUNTERFACTUAL-COST-01).
            // workflowProvider/workflowModel already carry the per-node-resolved values
            // (caller computes loopProvider = node.provider ?? workflowProvider).
            entry_rung: deriveEntryRung(workflowProvider, workflowModel),
            ...(loopTotalTokens ? { frontier_cost_usd: computeFrontierCost(loopTotalTokens) } : {}),
            // Declared/requested/served model capture, extended to loop nodes
            // (WO-HARNESS-TELEMETRY-DECLARED-MODEL-AND-COST-01). declared =
            // `workflowModel` param (pre-persona, per-node-resolved value the
            // caller computed as loopModel -- see comment above). requested =
            // resolvedOptions.model (post-persona -- overridden above at
            // ~line 2307 when the loop node declares agent:/persona:). served =
            // provider-reported, captured per-iteration; loop nodes never
            // surfaced this before this WO. Same alias-aware compare + omit-
            // when-absent contract as AI nodes.
            ...(workflowModel !== undefined ? { declared_model_id: workflowModel } : {}),
            ...(resolvedOptions.model !== undefined
              ? { requested_model_id: resolvedOptions.model }
              : {}),
            ...(loopServedModelId !== undefined ? { served_model_id: loopServedModelId } : {}),
            ...(loopServedMissingReason !== undefined
              ? { served_model_missing_reason: loopServedMissingReason }
              : {}),
            ...(typeof loopServedModelId === 'string' && workflowModel !== undefined
              ? {
                  served_model_mismatch: !isDeclaredServedMatch(workflowModel, loopServedModelId),
                }
              : {}),
          },
        })
        .catch((err: Error) => {
          getLog().error(
            { err, workflowRunId: workflowRun.id, eventType: 'node_completed' },
            'workflow_event_persist_failed'
          );
        });
      getWorkflowEventEmitter().emit({
        type: 'node_completed',
        runId: workflowRun.id,
        nodeId: node.id,
        nodeName: node.id,
        duration: Date.now() - iterationStart,
        ...(loopTotalCostUsd !== undefined ? { costUsd: loopTotalCostUsd } : {}),
        ...(loopFinalStopReason ? { stopReason: loopFinalStopReason } : {}),
        ...(loopTotalNumTurns !== undefined ? { numTurns: loopTotalNumTurns } : {}),
      });
      return {
        state: 'completed',
        output: lastIterationOutput,
        sessionId: currentSessionId,
        costUsd: loopTotalCostUsd,
        ...(loopTotalTokens ? { tokens: loopTotalTokens } : {}),
        ...(loopTotalTokens ? { frontierCostUsd: computeFrontierCost(loopTotalTokens) } : {}),
        ...(workflowModel !== undefined ? { declaredModelId: workflowModel } : {}),
        ...(resolvedOptions.model !== undefined ? { requestedModelId: resolvedOptions.model } : {}),
        ...(loopServedModelId !== undefined ? { servedModelId: loopServedModelId } : {}),
        ...(typeof loopServedModelId === 'string' && workflowModel !== undefined
          ? { modelMismatch: !isDeclaredServedMatch(workflowModel, loopServedModelId) }
          : {}),
      };
    }

    // Interactive loop gate -- pause after every iteration where the AI did NOT emit the
    // completion signal. The user reviews the AI's output and provides feedback or approval.
    // On approval, the AI will emit the signal in the next iteration, exiting above.
    if (loop.interactive && loop.gate_message) {
      const gateMsg =
        `\u23f8 **Input required** (loop \`${node.id}\`, iteration ${String(i)}): ${loop.gate_message}\n\n` +
        `Run ID: \`${workflowRun.id}\`\n` +
        `Respond: \`/workflow approve ${workflowRun.id} <your feedback>\` | Cancel: \`/workflow reject ${workflowRun.id}\``;
      const gateSent = await safeSendMessage(platform, conversationId, gateMsg, {
        workflowId: workflowRun.id,
        nodeName: node.id,
      });
      if (!gateSent) {
        // Gate message failed to deliver -- do not pause; fail the node so the user
        // sees a clear error rather than a silently orphaned paused run.
        getLog().error(
          { nodeId: node.id, workflowRunId: workflowRun.id, iteration: i },
          'loop_node.gate_message_send_failed'
        );
        return {
          state: 'failed',
          output: lastIterationOutput,
          error: `Loop gate message failed to deliver for node '${node.id}' -- cannot pause safely`,
        };
      }
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'approval_requested',
          step_name: node.id,
          data: { message: loop.gate_message, iteration: i },
        })
        .catch((err: Error) => {
          logEventStoreError(err, i);
        });
      await deps.store.pauseWorkflowRun(workflowRun.id, {
        nodeId: node.id,
        message: loop.gate_message,
        type: 'interactive_loop',
        iteration: i,
        sessionId: currentSessionId,
      });
      getWorkflowEventEmitter().emit({
        type: 'approval_pending',
        runId: workflowRun.id,
        nodeId: node.id,
        message: loop.gate_message,
      });
      // Return completed -- the between-layer status check sees 'paused' and halts cleanly.
      // This mirrors the approval-node pattern, preventing false "DAG nodes failed" warnings
      // in multi-node workflows. Resume correctness relies on the 'paused' DB status, not
      // on the node's output state.
      return {
        state: 'completed',
        output: lastIterationOutput,
        costUsd: loopTotalCostUsd,
        ...(loopTotalTokens ? { tokens: loopTotalTokens } : {}),
      };
    }
  }

  // Max iterations exceeded
  const errorMsg = `Loop node '${node.id}' exceeded max iterations (${String(loop.max_iterations)}) without completion signal '${loop.until}'`;
  getLog().warn(
    { nodeId: node.id, maxIterations: loop.max_iterations, signal: loop.until },
    'loop_node.max_iterations_reached'
  );
  await safeSendMessage(platform, conversationId, errorMsg, msgContext);
  await persistLoopNodeFailed(errorMsg);
  return {
    state: 'failed',
    output: lastIterationOutput,
    error: errorMsg,
    costUsd: loopTotalCostUsd,
    ...(loopTotalTokens ? { tokens: loopTotalTokens } : {}),
  };
}

/**
 * Execute an approval node -- pauses workflow for human review.
 * On rejection resume (when on_reject is configured): runs the on_reject prompt via AI,
 * then re-pauses at the approval gate. After max_attempts rejections, cancels normally.
 */
async function executeApprovalNode(
  node: ApprovalNode,
  workflowRun: WorkflowRun,
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowProvider: string,
  workflowModel: string | undefined,
  cwd: string,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  nodeOutputs: Map<string, NodeOutput>,
  config: WorkflowConfig,
  workflowLevelOptions: WorkflowLevelOptions,
  workflowInteractive: boolean | undefined,
  configuredCommandFolder?: string,
  issueContext?: string
): Promise<NodeOutput> {
  const msgContext = { workflowId: workflowRun.id, nodeName: node.id };

  // Detect rejection resume -- check metadata for rejection_reason set by reject handlers
  const rawApproval = workflowRun.metadata?.approval;
  const approvalMeta = isApprovalContext(rawApproval) ? rawApproval : undefined;
  const rawRejection = workflowRun.metadata?.rejection_reason;
  const rejectionReason =
    approvalMeta?.type === 'approval' &&
    approvalMeta.nodeId === node.id &&
    typeof rawRejection === 'string' &&
    rawRejection !== ''
      ? rawRejection
      : '';

  // On rejection resume with on_reject configured: run the on_reject prompt via AI
  if (rejectionReason !== '' && node.approval.on_reject) {
    const maxAttempts = node.approval.on_reject.max_attempts ?? 3;
    const rejectionCount = (workflowRun.metadata?.rejection_count as number | undefined) ?? 0;

    // Check if max attempts exhausted
    if (rejectionCount >= maxAttempts) {
      const cancelReason = `max_attempts (${String(maxAttempts)}) exhausted`;
      const cancellationSaved = await persistCancellation(
        deps,
        platform,
        conversationId,
        workflowRun,
        node.id,
        cancelReason
      );
      if (!cancellationSaved) return { state: 'completed', output: cancelReason };
      getWorkflowEventEmitter().emit({
        type: 'workflow_cancelled',
        runId: workflowRun.id,
        nodeId: node.id,
        reason: cancelReason,
      });
      const cancelMsg = `[ ] Approval node \`${node.id}\` cancelled after ${String(maxAttempts)} rejections.`;
      await safeSendMessage(platform, conversationId, cancelMsg, msgContext);
      // Terminal state reached: emit 'run_token_totals' rollup event (see token-rollup.ts).
      void emitRunTokenTotals(deps.store, workflowRun.id);
      return { state: 'completed' as const, output: '' };
    }

    // Run the on_reject prompt via AI
    const { prompt: substitutedPrompt } = substituteWorkflowVariables(
      node.approval.on_reject.prompt,
      workflowRun.id,
      workflowRun.user_message ?? '',
      artifactsDir,
      baseBranch,
      docsDir,
      issueContext,
      undefined, // loopUserInput
      rejectionReason
    );

    // Build a synthetic PromptNode to reuse executeNodeInternal.
    // Use a distinct ID so the node_completed event written by executeNodeInternal
    // does not collide with the approval gate's own ID in getCompletedDagNodeOutputs.
    // If we used node.id here, a resumed run would find the event and treat the
    // approval gate as already completed, bypassing the human gate entirely.
    //
    // Note: executeNodeInternal also emits node_started/node_completed WorkflowEmitterEvents
    // with nodeId = `${node.id}:on_reject`. These flow through SSE into the web UI, where
    // WorkflowExecution.tsx builds its nodeMap from all node_* events unconditionally.
    // This means a transient `${node.id}:on_reject` phantom entry may appear in the UI's
    // execution view during an on_reject cycle. This is cosmetic-only -- the approval gate
    // still re-presents correctly and the human gate contract is preserved. A follow-up can
    // filter synthetic `:on_reject` IDs from the UI's nodeMap if needed.
    const syntheticNode: PromptNode = {
      id: `${node.id}:on_reject`,
      prompt: substituteNodeOutputRefs(substitutedPrompt, nodeOutputs),
      ...(node.depends_on ? { depends_on: node.depends_on } : {}),
      ...(node.idle_timeout ? { idle_timeout: node.idle_timeout } : {}),
    };

    const {
      provider,
      options: nodeOptions,
      declaredModelId,
      personaContextState,
    } = await resolveNodeProviderAndModel(
      syntheticNode,
      workflowProvider,
      workflowModel,
      config,
      platform,
      conversationId,
      workflowRun.id,
      cwd,
      workflowLevelOptions
    );

    const output = await executeNodeInternal(
      deps,
      platform,
      conversationId,
      cwd,
      workflowRun,
      syntheticNode,
      provider,
      nodeOptions,
      declaredModelId,
      artifactsDir,
      logDir,
      baseBranch,
      docsDir,
      nodeOutputs,
      undefined, // fresh session
      configuredCommandFolder,
      issueContext,
      personaContextState
    );

    if (output.state === 'failed') {
      return output;
    }
    // Fall through to re-pause at the approval gate
  }

  // Root interactive workflows are dispatched in the operator conversation and must
  // honor their approval nodes even when the process-wide override is unset. The env
  // flag remains an explicit override for callers whose workflow has no root setting.
  const interactive = workflowInteractive === true || process.env.CAULDRON_INTERACTIVE === 'true';
  if (!interactive) {
    getLog().info(
      { workflowRunId: workflowRun.id, nodeId: node.id },
      'approval.gate_bypassed_non_interactive'
    );
    // Non-interactive: treat as auto-approved-as-is. Do not pause, do not capture.
    return { state: 'completed' as const, output: '' };
  }

  // Standard approval gate -- send message and pause.
  // Resolve $nodeId.output[.field] references so the human sees concrete values
  // (parity with prompt/bash/loop/cancel nodes, which all run the same substitution).
  const renderedMessage = substituteNodeOutputRefs(node.approval.message, nodeOutputs);
  const approvalMsg =
    ` **Approval required**: ${renderedMessage}\n\n` +
    `Run ID: \`${workflowRun.id}\`\n` +
    `Approve: \`/workflow approve ${workflowRun.id}\` | Reject: \`/workflow reject ${workflowRun.id}\``;
  // Inline Approve/Reject buttons for platforms that support them (Telegram).
  // The callbackData words ("approve"/"reject") route through the existing
  // natural-language approval handler when tapped; other platforms ignore them.
  await safeSendMessage(platform, conversationId, approvalMsg, msgContext, {
    category: 'workflow_status',
    inlineButtons: [
      { text: '[x] Approve', callbackData: 'approve' },
      { text: '[ ] Reject', callbackData: 'reject' },
    ],
  });

  // Optional: ALSO push the gate to a fixed Telegram chat (mobile approval) regardless of
  // which platform the run is on. Gated by TELEGRAM_APPROVAL_CHAT_ID. Buttons carry the
  // run-scoped command (/workflow approve <id>) so a tap routes to THIS run even from a
  // chat that is not the run's own conversation. Best-effort: never block/fail the gate.
  const tgChat = process.env.TELEGRAM_APPROVAL_CHAT_ID;
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  if (tgChat && tgToken) {
    void (async (): Promise<void> => {
      try {
        await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: tgChat,
            text: `Approval required: ${renderedMessage}\n\nRun ${workflowRun.id}`,
            reply_markup: {
              inline_keyboard: [
                [{ text: '[x] Approve', callback_data: `/workflow approve ${workflowRun.id}` }],
                [{ text: '[ ] Reject', callback_data: `/workflow reject ${workflowRun.id}` }],
              ],
            },
          }),
        });
      } catch (err) {
        getLog().warn({ err, runId: workflowRun.id }, 'approval.telegram_push_failed');
      }
    })();
  }

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'approval_requested',
      step_name: node.id,
      data: { message: renderedMessage },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'approval_requested' },
        'workflow.event_persist_failed'
      );
    });

  await deps.store.pauseWorkflowRun(workflowRun.id, {
    message: renderedMessage,
    nodeId: node.id,
    type: 'approval',
    captureResponse: node.approval.capture_response,
    onRejectPrompt: node.approval.on_reject?.prompt,
    onRejectMaxAttempts: node.approval.on_reject?.max_attempts,
  });

  getWorkflowEventEmitter().emit({
    type: 'approval_pending',
    runId: workflowRun.id,
    nodeId: node.id,
    message: renderedMessage,
  });

  // Return completed -- the between-layer status check will see 'paused' and break.
  // On resume, the approve endpoint writes a real node_completed event with the user's response.
  return { state: 'completed' as const, output: '' };
}

async function executeEvidenceNode(
  deps: WorkflowDeps,
  cwd: string,
  workflowRun: WorkflowRun,
  node: EvidenceNode,
  artifactsDir: string
): Promise<NodeExecutionResult> {
  const startedAt = Date.now();
  await deps.store.createWorkflowEvent({
    workflow_run_id: workflowRun.id,
    event_type: 'node_started',
    step_name: node.id,
    data: { kind: node.evidence.kind, mechanical: true },
  });
  getWorkflowEventEmitter().emit({
    type: 'node_started',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: node.id,
  });

  const evidence = await collectRuntimeEvidence(
    deps.store,
    async (command, args, commandCwd) => {
      const result = await execFileAsync(command, [...args], {
        cwd: commandCwd,
        timeout: 30000,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    },
    {
      runId: workflowRun.id,
      cwd,
      executionState: 'running',
      recoveryState: 'not_needed',
      routeState: 'current',
      requiredGateIds: node.evidence.required_gates,
    }
  );
  const manifest = renderManifestV2(evidence);
  const evidenceDir = join(artifactsDir, 'evidence');
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    join(evidenceDir, 'mechanical-evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
    'utf8'
  );
  await writeFile(join(evidenceDir, 'manifest-v2.txt'), `${manifest}\n`, 'utf8');
  const outcomeUpdated = await deps.store.upsertRunOutcome(
    workflowRun.id,
    evidence.outcome,
    new Date().toISOString()
  );
  if (!outcomeUpdated) {
    throw new Error(`run_outcome_conflict: ${workflowRun.id}`);
  }
  await deps.store.createWorkflowEvent({
    workflow_run_id: workflowRun.id,
    event_type: 'node_completed',
    step_name: node.id,
    data: {
      duration_ms: Date.now() - startedAt,
      node_output: manifest,
      mechanical: true,
      outcome: evidence.outcome,
    },
  });
  getWorkflowEventEmitter().emit({
    type: 'node_completed',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: node.id,
    duration: Date.now() - startedAt,
  });
  return { state: 'completed', output: manifest };
}

/**
 * Execute a complete DAG workflow.
 * Called from executeWorkflow() in executor.ts.
 */
async function executeDagWorkflowInternal(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: {
    name: string;
    nodes: readonly DagNode[];
    inputs?: Record<string, { default: string }>;
    interactive?: boolean;
    // WO-HARNESS-NODE-PROVIDER-FAILOVER-01: workflow-root failover defaults
    // (snake_case YAML field names on WorkflowDefinition).
    failover_provider?: string;
    failover_model?: string;
  } & WorkflowLevelOptions,
  workflowRun: WorkflowRun,
  workflowProvider: string,
  workflowModel: string | undefined,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  config: WorkflowConfig,
  configuredCommandFolder?: string,
  issueContext?: string,
  priorCompletedNodes?: Map<string, string>
): Promise<string | undefined> {
  const dagStartTime = Date.now();

  // Resolve workflow inputs: extract defaults from the `inputs:` section.
  // These are substituted into bash node scripts as ${input.name} before execution.
  const resolvedInputs: Record<string, string> = workflow.inputs
    ? Object.fromEntries(Object.entries(workflow.inputs).map(([k, v]) => [k, v.default]))
    : {};
  const workflowLevelOptions: WorkflowLevelOptions = {
    effort: workflow.effort,
    thinking: workflow.thinking,
    fallbackModel: workflow.fallbackModel,
    betas: workflow.betas,
    sandbox: workflow.sandbox,
    // WO-HARNESS-NODE-PROVIDER-FAILOVER-01: workflow-level failover defaults.
    failoverProvider: workflow.failover_provider,
    failoverModel: workflow.failover_model,
  };
  const layers = buildTopologicalLayers(workflow.nodes);
  const nodeOutputs = new Map<string, NodeOutput>();

  // Pre-populate nodeOutputs from prior run so already-completed nodes are
  // treated as done for trigger-rule and $nodeId.output substitution purposes.
  if (priorCompletedNodes && priorCompletedNodes.size > 0) {
    for (const [nodeId, output] of priorCompletedNodes) {
      nodeOutputs.set(nodeId, { state: 'completed', output });
    }
    getLog().info(
      { workflowRunId: workflowRun.id, priorCompletedCount: priorCompletedNodes.size },
      'dag.workflow_resume_prepopulated'
    );
  }

  getLog().info(
    {
      workflowName: workflow.name,
      nodeCount: workflow.nodes.length,
      layerCount: layers.length,
      hasIssueContext: !!issueContext,
      issueContextLength: issueContext?.length ?? 0,
    },
    'dag_workflow_starting'
  );

  // Session threading: for sequential single-node layers, thread the session forward.
  // For parallel layers (>1 node), always fresh (can't share a session).
  let lastSequentialSessionId: string | undefined;
  // Note: accumulates cost for this invocation only. If this is a resume, nodes skipped
  // from the prior run are not included -- total_cost_usd will reflect resumed-portion cost only.
  // The same resumed-portion semantics apply to totalTokens.
  let totalCostUsd = 0;
  let totalTokens = 0;
  // Layer 1 counterfactual cost accumulator (WO-HARNESS-LAYER1-TIER-AND-COUNTERFACTUAL-COST-01).
  // Sum of frontier_cost_usd across nodes; written to run metadata as total_frontier_cost_usd
  // so the UI can compute savings = total_frontier_cost_usd - total_cost_usd.
  let totalFrontierCostUsd = 0;
  // Per-run declared/requested/served model rollup (WO-HARNESS-TELEMETRY-DECLARED-
  // MODEL-AND-COST-01). Only nodes that reported at least one of the three model
  // fields are included (bash/script/approval/cancel nodes never do). This is the
  // deck's data contract for surfaces 2+3 -- field names are provisional pending
  // the deck-UI WO.
  const nodeModelSummary: {
    node_id: string;
    declared_model_id?: string;
    requested_model_id?: string;
    served_model_id?: string | null;
    mismatch?: boolean;
  }[] = [];
  let modelMismatchCount = 0;
  let runTokenTotalsEmitted = false;
  function emitTerminalRunTokenTotals(): void {
    if (runTokenTotalsEmitted) return;
    runTokenTotalsEmitted = true;
    emitRunTokenTotals(deps.store, workflowRun.id).catch((err: Error) => {
      getLog().warn(
        { err, workflowRunId: workflowRun.id },
        'dag_run_token_totals_unexpected_throw'
      );
    });
  }

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    if (deps.isRunLeaseValid?.() === false) {
      getLog().warn({ workflowRunId: workflowRun.id }, 'dag.run_lease_lost');
      return;
    }
    const layer = layers[layerIdx];
    const isParallelLayer = layer.length > 1;

    if (isParallelLayer) {
      lastSequentialSessionId = undefined; // reset -- parallel nodes can't share sessions
    }

    // Execute all nodes in the layer concurrently
    const layerResults = await Promise.allSettled(
      layer.map(async (node): Promise<{ nodeId: string; output: NodeExecutionResult }> => {
        try {
          // 0. Skip if this node completed successfully in a prior run (resume path)
          if (priorCompletedNodes?.has(node.id)) {
            getLog().info({ nodeId: node.id }, 'dag.node_skipped_prior_success');
            await logNodeSkip(logDir, workflowRun.id, node.id, 'prior_success').catch(
              (err: Error) => {
                getLog().warn({ err, nodeId: node.id }, 'dag.node_skip_log_write_failed');
              }
            );
            deps.store
              .createWorkflowEvent({
                workflow_run_id: workflowRun.id,
                event_type: 'node_skipped_prior_success',
                step_name: node.id,
                data: { reason: 'prior_success' },
              })
              .catch((err: Error) => {
                getLog().error(
                  { err, workflowRunId: workflowRun.id, eventType: 'node_skipped_prior_success' },
                  'workflow_event_persist_failed'
                );
              });
            const emitterPrior = getWorkflowEventEmitter();
            emitterPrior.emit({
              type: 'node_skipped',
              runId: workflowRun.id,
              nodeId: node.id,
              nodeName: node.command ?? node.id,
              reason: 'prior_success',
            });
            // Return the pre-populated output (already in nodeOutputs)
            return {
              nodeId: node.id,
              output: nodeOutputs.get(node.id) ?? { state: 'skipped' as const, output: '' },
            };
          }

          if (hasUnapprovedFailedPlanReviewAncestor(node, workflow.nodes, nodeOutputs)) {
            const reason = 'upstream_plan_review_not_approved';
            getLog().warn({ nodeId: node.id, reason }, 'dag_node_skipped_plan_review_block');
            await logNodeSkip(logDir, workflowRun.id, node.id, reason).catch((err: Error) => {
              getLog().warn({ err, nodeId: node.id }, 'dag.node_skip_log_write_failed');
            });
            deps.store
              .createWorkflowEvent({
                workflow_run_id: workflowRun.id,
                event_type: 'node_skipped',
                step_name: node.id,
                data: { reason, blockedBy: PLAN_REVIEW_NODE_ID },
              })
              .catch((err: Error) => {
                getLog().error(
                  { err, workflowRunId: workflowRun.id, eventType: 'node_skipped' },
                  'workflow_event_persist_failed'
                );
              });
            const emitter = getWorkflowEventEmitter();
            emitter.emit({
              type: 'node_skipped',
              runId: workflowRun.id,
              nodeId: node.id,
              nodeName: node.command ?? node.id,
              reason,
            });
            return {
              nodeId: node.id,
              output: {
                state: 'skipped' as const,
                output: `SKIPPED: ${reason}; blockedBy=${PLAN_REVIEW_NODE_ID}`,
              },
            };
          }

          // 1. Evaluate trigger rule
          const triggerDecision = checkTriggerRule(node, nodeOutputs);
          if (triggerDecision === 'skip') {
            getLog().info({ nodeId: node.id, reason: 'trigger_rule' }, 'dag_node_skipped');
            await logNodeSkip(logDir, workflowRun.id, node.id, 'trigger_rule').catch(
              (err: Error) => {
                getLog().warn({ err, nodeId: node.id }, 'dag.node_skip_log_write_failed');
              }
            );
            deps.store
              .createWorkflowEvent({
                workflow_run_id: workflowRun.id,
                event_type: 'node_skipped',
                step_name: node.id,
                data: { reason: 'trigger_rule' },
              })
              .catch((err: Error) => {
                getLog().error(
                  { err, workflowRunId: workflowRun.id, eventType: 'node_skipped' },
                  'workflow_event_persist_failed'
                );
              });
            const emitter = getWorkflowEventEmitter();
            emitter.emit({
              type: 'node_skipped',
              runId: workflowRun.id,
              nodeId: node.id,
              nodeName: node.command ?? node.id,
              reason: 'trigger_rule',
            });
            return { nodeId: node.id, output: { state: 'skipped' as const, output: '' } };
          }

          // 2. Evaluate when: condition
          if (node.when !== undefined) {
            const { result: conditionPasses, parsed: conditionParsed } = evaluateCondition(
              node.when,
              nodeOutputs
            );
            if (!conditionParsed) {
              const parseErrMsg = `\u26a0\ufe0f Node '${node.id}': unparseable \`when:\` expression "${node.when}" \u2014 node skipped (fail-closed). Check syntax: \`$nodeId.output == 'VALUE'\`, \`$nodeId.output > '5'\`, or compound \`$a.output == 'X' && $b.output != 'Y'\`.`;
              await safeSendMessage(platform, conversationId, parseErrMsg, {
                workflowId: workflowRun.id,
                nodeName: node.id,
              });
              getLog().error(
                { nodeId: node.id, when: node.when },
                'dag_node_skipped_condition_parse_error'
              );
              await logNodeSkip(
                logDir,
                workflowRun.id,
                node.id,
                'when_condition_parse_error'
              ).catch((err: Error) => {
                getLog().warn({ err, nodeId: node.id }, 'dag.node_skip_log_write_failed');
              });
              deps.store
                .createWorkflowEvent({
                  workflow_run_id: workflowRun.id,
                  event_type: 'node_skipped',
                  step_name: node.id,
                  data: { reason: 'when_condition_parse_error', expr: node.when },
                })
                .catch((err: Error) => {
                  getLog().error(
                    { err, workflowRunId: workflowRun.id, eventType: 'node_skipped' },
                    'workflow_event_persist_failed'
                  );
                });
              const emitter = getWorkflowEventEmitter();
              emitter.emit({
                type: 'node_skipped',
                runId: workflowRun.id,
                nodeId: node.id,
                nodeName: node.command ?? node.id,
                reason: 'when_condition_parse_error',
              });
              return { nodeId: node.id, output: { state: 'skipped' as const, output: '' } };
            }
            if (!conditionPasses) {
              getLog().info({ nodeId: node.id, when: node.when }, 'dag_node_skipped_condition');
              await logNodeSkip(logDir, workflowRun.id, node.id, 'when_condition').catch(
                (err: Error) => {
                  getLog().warn({ err, nodeId: node.id }, 'dag.node_skip_log_write_failed');
                }
              );
              deps.store
                .createWorkflowEvent({
                  workflow_run_id: workflowRun.id,
                  event_type: 'node_skipped',
                  step_name: node.id,
                  data: { reason: 'when_condition', expr: node.when },
                })
                .catch((err: Error) => {
                  getLog().error(
                    { err, workflowRunId: workflowRun.id, eventType: 'node_skipped' },
                    'workflow_event_persist_failed'
                  );
                });
              const emitter = getWorkflowEventEmitter();
              emitter.emit({
                type: 'node_skipped',
                runId: workflowRun.id,
                nodeId: node.id,
                nodeName: node.command ?? node.id,
                reason: 'when_condition',
              });
              return {
                nodeId: node.id,
                output: { state: 'skipped' as const, output: '' },
              };
            }
          }

          // 3. Engine-side evidence node -- facts are collected mechanically, never by AI.
          if (isEvidenceNode(node)) {
            const output = await executeEvidenceNode(deps, cwd, workflowRun, node, artifactsDir);
            return { nodeId: node.id, output };
          }

          // 3a. Bash node dispatch -- no AI, no session
          if (isBashNode(node)) {
            const output = await executeBashNode(
              deps,
              platform,
              conversationId,
              cwd,
              workflowRun,
              node,
              artifactsDir,
              logDir,
              baseBranch,
              docsDir,
              nodeOutputs,
              issueContext,
              config.envVars,
              resolvedInputs
            );
            return { nodeId: node.id, output };
          }

          // 3b. Loop node dispatch -- manages its own AI sessions and iteration
          if (isLoopNode(node)) {
            // Resolve per-node provider/model overrides (same logic as other node types).
            // Provider is explicit; model passes through to the SDK. Throw on an
            // unknown provider so the outer catch below emits the standard
            // node_failed event + user-facing message -- the same path
            // resolveNodeProviderAndModel uses for non-loop nodes.
            const loopProvider: string = node.provider ?? workflowProvider;
            if (!isRegisteredProvider(loopProvider)) {
              throw new Error(
                `Node '${node.id}': unknown provider '${loopProvider}'. Registered: ${getRegisteredProviders()
                  .map(p => p.id)
                  .join(', ')}`
              );
            }
            const loopAssistantConfig = config.assistants[loopProvider];
            const loopModel: string | undefined =
              node.model ??
              (loopProvider === workflowProvider
                ? workflowModel
                : (loopAssistantConfig?.model as string | undefined));

            assertProviderCanExecuteNode(loopProvider, node);
            let output = await executeLoopNode(
              deps,
              platform,
              conversationId,
              cwd,
              workflowRun,
              node,
              loopProvider,
              loopModel,
              artifactsDir,
              logDir,
              baseBranch,
              docsDir,
              nodeOutputs,
              config,
              issueContext,
              workflowLevelOptions
            );

            // AVAILABILITY failover for loop nodes (WO-HARNESS-NODE-PROVIDER-FAILOVER-01).
            // Same doctrine as prompt nodes: one sideways re-dispatch on a declared
            // failover provider when the loop fails with an availability-class error.
            // executeLoopNode re-resolves the persona against the failover provider
            // internally (resolveAgentPersona), so an incompatible codex+persona
            // pairing raises InfrastructureClassBlock -- caught here so the failover
            // never makes things worse than the original availability failure.
            const loopQuotaRoute = output.quotaExhausted
              ? selectQuotaExhaustionRoute(loopProvider, node, workflowLevelOptions)
              : null;
            const loopFailoverTarget =
              loopQuotaRoute?.kind === 'failover'
                ? {
                    provider: loopQuotaRoute.provider,
                    model: loopQuotaRoute.model,
                    agent: (node as { failover_agent?: string }).failover_agent,
                  }
                : resolveFailoverTarget(node, workflowLevelOptions);
            const loopFailoverErrorClass = output.quotaExhausted ? 'quota' : 'availability';
            if (
              output.state === 'failed' &&
              output.error !== undefined &&
              loopFailoverTarget !== null &&
              loopFailoverTarget.provider !== loopProvider &&
              isRegisteredProvider(loopFailoverTarget.provider) &&
              (loopQuotaRoute?.kind === 'failover' || isAvailabilityError(output.error))
            ) {
              const loopFailoverModel =
                loopFailoverTarget.model ??
                (config.assistants[loopFailoverTarget.provider]?.model as string | undefined);
              try {
                const loopFailoverNode = buildFailoverNode(node, {
                  ...loopFailoverTarget,
                  model: loopFailoverModel,
                });
                assertProviderCanExecuteNode(loopFailoverTarget.provider, loopFailoverNode);
                emitNodeFailover(
                  deps,
                  workflowRun.id,
                  node.id,
                  { provider: loopProvider, model: loopModel },
                  { provider: loopFailoverTarget.provider, model: loopFailoverModel },
                  loopFailoverErrorClass
                );
                await safeSendMessage(
                  platform,
                  conversationId,
                  `! Loop node \`${node.id}\` hit a ${loopFailoverErrorClass} error on ${loopProvider}; failing over to ${loopFailoverTarget.provider} (one attempt).`,
                  { workflowId: workflowRun.id, nodeName: node.id }
                );
                output = await executeLoopNode(
                  deps,
                  platform,
                  conversationId,
                  cwd,
                  workflowRun,
                  loopFailoverNode as LoopNode,
                  loopFailoverTarget.provider,
                  loopFailoverModel,
                  artifactsDir,
                  logDir,
                  baseBranch,
                  docsDir,
                  nodeOutputs,
                  config,
                  issueContext,
                  workflowLevelOptions
                );
              } catch (loopFailoverErr) {
                const fe = loopFailoverErr as Error;
                getLog().error(
                  { err: fe, nodeId: node.id, failoverProvider: loopFailoverTarget.provider },
                  'dag.node_failover_dispatch_failed'
                );
                await safeSendMessage(
                  platform,
                  conversationId,
                  `! Loop node \`${node.id}\` failover to ${loopFailoverTarget.provider} could not be dispatched: ${fe.message}`,
                  { workflowId: workflowRun.id, nodeName: node.id }
                );
              }
            }

            if (output.quotaExhausted) {
              output = await scheduleDurableProviderWait(
                deps,
                platform,
                conversationId,
                workflowRun,
                node.id,
                output.quotaExhausted
              );
            }

            return { nodeId: node.id, output };
          }

          // 3c. Approval node dispatch -- pauses workflow for human review
          if (isApprovalNode(node)) {
            const output = await executeApprovalNode(
              node,
              workflowRun,
              deps,
              platform,
              conversationId,
              workflowProvider,
              workflowModel,
              cwd,
              artifactsDir,
              logDir,
              baseBranch,
              docsDir,
              nodeOutputs,
              config,
              workflowLevelOptions,
              workflow.interactive,
              configuredCommandFolder,
              issueContext
            );
            return { nodeId: node.id, output };
          }

          // 3d. Cancel node dispatch -- terminates the workflow run
          if (isCancelNode(node)) {
            const reason = substituteNodeOutputRefs(node.cancel, nodeOutputs);
            const cancelMsg = `\u274c **Workflow cancelled** (node \`${node.id}\`): ${reason}`;
            const cancellationSaved = await persistCancellation(
              deps,
              platform,
              conversationId,
              workflowRun,
              node.id,
              reason
            );
            if (!cancellationSaved) {
              return { nodeId: node.id, output: { state: 'completed' as const, output: reason } };
            }
            await safeSendMessage(platform, conversationId, cancelMsg, {
              workflowId: workflowRun.id,
              nodeName: node.id,
            });
            getWorkflowEventEmitter().emit({
              type: 'workflow_cancelled',
              runId: workflowRun.id,
              nodeId: node.id,
              reason,
            });
            // Terminal state reached: emit 'run_token_totals' rollup event (see token-rollup.ts).
            emitTerminalRunTokenTotals();
            // Return completed -- the between-layer status check will see 'cancelled' and break.
            return { nodeId: node.id, output: { state: 'completed' as const, output: reason } };
          }

          // 3e. Script node dispatch -- runs via bun or uv
          if (isScriptNode(node)) {
            const output = await executeScriptNode(
              deps,
              platform,
              conversationId,
              cwd,
              workflowRun,
              node,
              artifactsDir,
              logDir,
              baseBranch,
              docsDir,
              nodeOutputs,
              issueContext,
              config.envVars
            );
            return { nodeId: node.id, output };
          }

          // 4. Resolve per-node provider/model/options
          const {
            provider,
            options: nodeOptions,
            declaredModelId,
            personaContextState,
          } = await resolveNodeProviderAndModel(
            node,
            workflowProvider,
            workflowModel,
            config,
            platform,
            conversationId,
            workflowRun.id,
            cwd,
            workflowLevelOptions
          );
          assertProviderCanExecuteNode(provider, node);

          // 5. Determine session -- parallel or context:fresh -> always fresh
          // Parallel layers always get fresh sessions; explicit 'fresh' context also forces it.
          // 'shared' forces continuation. Default: fresh for parallel, inherited for sequential.
          const isFresh = isParallelLayer || node.context === 'fresh';
          const resumeSessionId = isFresh ? undefined : lastSequentialSessionId;

          // 6. Execute with retry for transient failures
          const retryConfig = getEffectiveNodeRetryConfig(node);
          let output: NodeExecutionResult = {
            state: 'failed',
            output: '',
            error: 'Node did not execute',
          };

          // SDK success-contradiction (isError=true AND errorSubtype='success')
          // earns exactly one extra whole-node re-run, independent of the
          // transient-retry budget (WO-HARNESS-PR-STATUS-TRUTH-AND-AUTOMERGE-01).
          // The transient loop below explicitly excludes the contradiction from
          // its budget (see `isContradiction`), so regardless of the node's
          // on_error setting this outer re-entry is the ONLY thing that retries
          // it -- exactly once. A contradiction whose errors[] text also matches
          // a FATAL pattern (auth/permission/credit-balance) is NOT re-run: the
          // FATAL guard on the outer check below preserves the "FATAL is never
          // retried" invariant.
          let sdkContradictionRetryUsed = false;
          sdkContradictionRetry: for (;;) {
            for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
              output = await executeNodeInternal(
                deps,
                platform,
                conversationId,
                cwd,
                workflowRun,
                node,
                provider,
                nodeOptions,
                declaredModelId,
                artifactsDir,
                logDir,
                baseBranch,
                docsDir,
                nodeOutputs,
                // Always pass the prior session ID -- forkSession:true in executeNodeInternal
                // ensures the source is never mutated, so retries can safely resume from it.
                resumeSessionId,
                configuredCommandFolder,
                issueContext,
                personaContextState
              );

              if (output.state !== 'failed') break;

              // Check if retryable.
              // FATAL errors (auth, permissions, credit balance) are never retried even when on_error:all.
              const isFatal = output.error
                ? classifyError(new Error(output.error)) === 'FATAL'
                : false;
              const isTransient = output.error ? isTransientNodeError(output.error) : false;
              const isResourceExhaustedTimeout = output.error
                ? output.error.startsWith('resource_exhausted_timeout')
                : false;
              const isQuotaExhausted = output.quotaExhausted !== undefined;
              // SDK success-contradictions are NEVER retried by this transient
              // budget -- the outer `sdkContradictionRetry` loop grants them
              // exactly one whole-node re-run. Without this exclusion,
              // on_error:'all' would retry the contradiction maxRetries times
              // here AND trigger the outer re-run, doubling the promised single
              // extra execution to up to 2*(maxRetries+1) node runs.
              const isContradiction = output.error
                ? isSdkSuccessContradiction(output.error)
                : false;
              const shouldRetry =
                !isFatal &&
                !isResourceExhaustedTimeout &&
                !isQuotaExhausted &&
                !isContradiction &&
                (retryConfig.onError === 'all' ||
                  (retryConfig.onError === 'transient' && isTransient));

              if (!shouldRetry || attempt >= retryConfig.maxRetries) break;

              const delayMs = retryConfig.delayMs * Math.pow(2, attempt);
              getLog().warn(
                {
                  nodeId: node.id,
                  attempt: attempt + 1,
                  maxRetries: retryConfig.maxRetries,
                  delayMs,
                  error: output.error,
                },
                'dag_node_transient_retry'
              );

              const errorKind = isTransient ? 'transient error' : 'error';
              await safeSendMessage(
                platform,
                conversationId,
                `! Node \`${node.id}\` failed with ${errorKind} (attempt ${String(attempt + 1)}/${String(retryConfig.maxRetries + 1)}). Retrying in ${String(Math.round(delayMs / 1000))}s...`,
                { workflowId: workflowRun.id, nodeName: node.id }
              );

              await new Promise(resolve => setTimeout(resolve, delayMs));
            }

            if (
              output.state === 'failed' &&
              !sdkContradictionRetryUsed &&
              output.error !== undefined &&
              isSdkSuccessContradiction(output.error) &&
              // FATAL errors (auth/permission/credit-balance) are never retried,
              // even when they arrive dressed as a success-contradiction.
              classifyError(new Error(output.error)) !== 'FATAL'
            ) {
              sdkContradictionRetryUsed = true;
              getLog().warn({ nodeId: node.id }, 'dag.sdk_contradiction_retry');
              await safeSendMessage(
                platform,
                conversationId,
                `! Node \`${node.id}\` hit an SDK success-contradiction (isError + subtype 'success'); retrying once.`,
                { workflowId: workflowRun.id, nodeName: node.id }
              );
              continue sdkContradictionRetry;
            }
            break;
          }

          // AVAILABILITY failover (WO-HARNESS-NODE-PROVIDER-FAILOVER-01): the
          // primary provider (and any transient retries above) is exhausted and
          // the node failed with an availability-class error (429 / timeout /
          // 5xx / connection). If the node (or workflow) declares a failover
          // provider, re-dispatch this ONE node exactly once on it. Auth/billing/
          // other 4xx errors are NOT availability and fall straight through.
          const quotaRoute = output.quotaExhausted
            ? selectQuotaExhaustionRoute(provider, node, workflowLevelOptions)
            : null;
          const failoverTarget =
            quotaRoute?.kind === 'failover'
              ? {
                  provider: quotaRoute.provider,
                  model: quotaRoute.model,
                  agent: (node as { failover_agent?: string }).failover_agent,
                }
              : resolveFailoverTarget(node, workflowLevelOptions);
          const failoverErrorClass = output.quotaExhausted ? 'quota' : 'availability';
          if (
            output.state === 'failed' &&
            output.error !== undefined &&
            failoverTarget !== null &&
            failoverTarget.provider !== provider && // never "failover" to the same provider
            (quotaRoute?.kind === 'failover' || isAvailabilityError(output.error))
          ) {
            try {
              const failoverNode = buildFailoverNode(node, failoverTarget);
              assertProviderCanExecuteNode(failoverTarget.provider, failoverNode);
              // Clone the node with the failover provider/model and re-run the
              // full resolution path. This re-runs persona resolution against the
              // failover provider, so an incompatible pairing (e.g. codex failover
              // + Anthropic-pinned persona) throws InfrastructureClassBlock here
              // -- the same guard a normal dispatch would apply. The failover
              // fields themselves are NOT read into nodeConfig/SDK options.
              // Set `model` explicitly (even to undefined) rather than
              // conditionally spreading it: a bare spread of `...node` would
              // otherwise LEAK the primary provider's `node.model` (e.g. an
              // OpenRouter-format `qwen/qwen3-coder`) into the failover dispatch
              // when `failover_model` is omitted. Clearing it lets
              // resolveNodeProviderAndModel fall back to the failover provider's
              // own assistant-config model (mirrors the loop-node path above).
              const failoverResolved = await resolveNodeProviderAndModel(
                failoverNode,
                workflowProvider,
                workflowModel,
                config,
                platform,
                conversationId,
                workflowRun.id,
                cwd,
                workflowLevelOptions
              );
              emitNodeFailover(
                deps,
                workflowRun.id,
                node.id,
                { provider, model: nodeOptions?.model },
                { provider: failoverResolved.provider, model: failoverResolved.options?.model },
                failoverErrorClass
              );
              await safeSendMessage(
                platform,
                conversationId,
                `! Node \`${node.id}\` hit a ${failoverErrorClass} error on ${provider}; failing over to ${failoverResolved.provider} (one attempt).`,
                { workflowId: workflowRun.id, nodeName: node.id }
              );
              output = await executeNodeInternal(
                deps,
                platform,
                conversationId,
                cwd,
                workflowRun,
                failoverNode as CommandNode | PromptNode,
                failoverResolved.provider,
                failoverResolved.options,
                failoverResolved.declaredModelId,
                artifactsDir,
                logDir,
                baseBranch,
                docsDir,
                nodeOutputs,
                resumeSessionId,
                configuredCommandFolder,
                issueContext,
                failoverResolved.personaContextState
              );
            } catch (failoverErr) {
              // A misconfigured failover (e.g. InfrastructureClassBlock from a
              // codex failover against an Anthropic-pinned persona) must not make
              // things worse than the original availability failure. Keep the
              // original failed `output` and surface the failover-dispatch fault.
              const fe = failoverErr as Error;
              getLog().error(
                { err: fe, nodeId: node.id, failoverProvider: failoverTarget.provider },
                'dag.node_failover_dispatch_failed'
              );
              await safeSendMessage(
                platform,
                conversationId,
                `! Node \`${node.id}\` failover to ${failoverTarget.provider} could not be dispatched: ${fe.message}`,
                { workflowId: workflowRun.id, nodeName: node.id }
              );
            }
          }

          if (output.quotaExhausted) {
            output = await scheduleDurableProviderWait(
              deps,
              platform,
              conversationId,
              workflowRun,
              node.id,
              output.quotaExhausted
            );
          }

          return { nodeId: node.id, output };
        } catch (error) {
          const err = error as Error;
          // Infrastructure-class block: a persona/provider/config fault that no
          // approve/reject decision can fix (e.g. a codex persona declaring an
          // Anthropic model). Label it so an operator is told to fix the
          // substrate rather than treat it as an ordinary node failure. This
          // surfaces at the pre-execution catch, NOT the approval/pause-gate --
          // a throw here never reaches that gate.
          const isInfraBlock = err instanceof InfrastructureClassBlock;
          const failMessage = isInfraBlock
            ? `INFRASTRUCTURE FAULT in node '${node.id}': ${err.message} ` +
              'Resuming will not help -- the fix is a harness/persona/config change, not an ' +
              'approve/reject decision. Reject this run and fix the substrate.'
            : `Node '${node.id}' failed before execution: ${err.message}`;
          getLog().error(
            { err, nodeId: node.id, infraClassBlock: isInfraBlock },
            'dag_node_pre_execution_failed'
          );
          deps.store
            .createWorkflowEvent({
              workflow_run_id: workflowRun.id,
              event_type: 'node_failed',
              step_name: node.id,
              data: { error: failMessage, ...(isInfraBlock ? { infra_class_block: true } : {}) },
            })
            .catch((dbErr: Error) => {
              getLog().error({ err: dbErr, nodeId: node.id }, 'workflow_event_persist_failed');
            });
          getWorkflowEventEmitter().emit({
            type: 'node_failed',
            runId: workflowRun.id,
            nodeId: node.id,
            nodeName: node.command ?? node.id,
            error: failMessage,
          });
          await safeSendMessage(platform, conversationId, failMessage, {
            workflowId: workflowRun.id,
            nodeName: node.id,
          });
          return {
            nodeId: node.id,
            output: { state: 'failed' as const, output: '', error: failMessage },
          };
        }
      })
    );

    // Process layer results -- store all outputs, track failures
    let layerHadFailure = false;
    for (const result of layerResults) {
      if (result.status === 'fulfilled') {
        const { nodeId, output } = result.value;
        if (output.costUsd !== undefined) totalCostUsd += output.costUsd;
        if (output.tokens) {
          totalTokens += output.tokens.total ?? output.tokens.input + output.tokens.output;
        }
        if (output.frontierCostUsd !== undefined) totalFrontierCostUsd += output.frontierCostUsd;
        if (
          output.declaredModelId !== undefined ||
          output.requestedModelId !== undefined ||
          output.servedModelId !== undefined
        ) {
          nodeModelSummary.push({
            node_id: nodeId,
            ...(output.declaredModelId !== undefined
              ? { declared_model_id: output.declaredModelId }
              : {}),
            ...(output.requestedModelId !== undefined
              ? { requested_model_id: output.requestedModelId }
              : {}),
            ...(output.servedModelId !== undefined
              ? { served_model_id: output.servedModelId }
              : {}),
            ...(output.modelMismatch !== undefined ? { mismatch: output.modelMismatch } : {}),
          });
          if (output.modelMismatch === true) modelMismatchCount++;
        }
        nodeOutputs.set(nodeId, output);
        if (output.state === 'completed' && !isParallelLayer && output.sessionId !== undefined) {
          lastSequentialSessionId = output.sessionId;
        }
        if (output.state === 'failed') layerHadFailure = true;
      } else {
        // Should not happen -- all errors are caught in the inner try-catch
        // Handle defensively: log the unexpected rejection
        getLog().error({ err: result.reason as Error, layerIdx }, 'dag_node_unexpected_rejection');
        layerHadFailure = true;
        await safeSendMessage(
          platform,
          conversationId,
          `An unexpected error occurred executing a node in layer ${String(layerIdx)}. Check server logs.`,
          { workflowId: workflowRun.id }
        );
      }
    }

    if (layerHadFailure) {
      getLog().warn({ layerIdx, nodeCount: layer.length }, 'dag_layer_had_failures');
    }

    // Check for non-running status between DAG layers (cancellation, deletion, pause)
    try {
      const dagStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
      if (dagStatus === null || dagStatus !== 'running') {
        const effectiveStatus = dagStatus ?? 'deleted';
        getLog().info(
          {
            workflowRunId: workflowRun.id,
            layerIdx,
            totalLayers: layers.length,
            status: effectiveStatus,
          },
          'dag.stop_detected_between_layers'
        );
        // Paused is intentional (approval gate) -- the approval message was already sent
        if (effectiveStatus !== 'paused') {
          await safeSendMessage(
            platform,
            conversationId,
            `! **Workflow stopped** (${effectiveStatus}): DAG execution stopped after layer ${String(layerIdx + 1)}/${String(layers.length)}`,
            { workflowId: workflowRun.id }
          );
        }
        break;
      }
    } catch (statusErr) {
      // Non-fatal -- status check failure should not crash the workflow
      getLog().warn(
        { err: statusErr as Error, workflowRunId: workflowRun.id },
        'dag.status_check_failed'
      );
    }
  }

  if (deps.isRunLeaseValid?.() === false) {
    getLog().warn({ workflowRunId: workflowRun.id }, 'dag.run_lease_lost_before_terminal');
    return;
  }

  /**
   * Bail out of the final completion/failure write if the run was transitioned
   * externally. Strict `!== 'running'` check is correct here because we don't
   * want to mark a paused run as complete -- the approval gate is still live.
   *
   * Emitter unregister is conditional: terminal states (cancelled / deleted /
   * completed / failed) unregister to release subscription resources, but
   * `paused` keeps the emitter registered so SSE stays connected while the
   * approval gate awaits the user -- crucial for resume observability.
   */
  async function skipIfStatusChanged(logEvent: string): Promise<boolean> {
    const status = await deps.store.getWorkflowRunStatus(workflowRun.id);
    if (status === 'running') return false;
    getLog().info({ workflowRunId: workflowRun.id, status: status ?? 'deleted' }, logEvent);
    if (status !== 'paused') {
      // Terminal state reached: emit 'run_token_totals' rollup event (see token-rollup.ts).
      emitTerminalRunTokenTotals();
      getWorkflowEventEmitter().unregisterRun(workflowRun.id);
    }
    return true;
  }

  // Single-pass: compute node outcome counts and derive success/failure booleans
  const nodeCounts = { completed: 0, failed: 0, skipped: 0, total: workflow.nodes.length };
  for (const o of nodeOutputs.values()) {
    if (o.state === 'completed') nodeCounts.completed++;
    else if (o.state === 'failed') nodeCounts.failed++;
    else if (o.state === 'skipped') nodeCounts.skipped++;
  }
  const anyCompleted = nodeCounts.completed > 0;
  const anyFailed = nodeCounts.failed > 0;

  const pushArtifactPresent = [...nodeOutputs.values()].some(o => hasPushArtifact(o.output));
  const hasMechanicalEvidenceNode = workflow.nodes.some(isEvidenceNode);

  async function makeTerminalOutcome(executionState: 'completed' | 'failed'): Promise<RunOutcome> {
    const existing = await deps.store.getRunOutcome(workflowRun.id);
    const deliverableState =
      existing?.deliverableState ?? (pushArtifactPresent ? 'pushed' : 'none');
    const validationState = existing?.validationState ?? 'not_run';
    const primaryReason: RunOutcome['primaryReason'] =
      executionState === 'failed'
        ? deliverableState === 'pr_ready'
          ? 'execution_failed_pr_ready'
          : 'execution_failed'
        : validationState === 'failed'
          ? 'gate_failed'
          : validationState === 'indeterminate'
            ? 'gate_indeterminate'
            : deliverableState === 'pr_ready'
              ? 'pr_ready'
              : 'execution_completed';
    return {
      executionState,
      deliverableState,
      validationState,
      recoveryState: executionState === 'failed' ? 'recoverable' : 'not_needed',
      routeState: existing?.routeState ?? 'current',
      primaryReason,
      reasonCodes: [...new Set([primaryReason, ...(existing?.reasonCodes ?? [])])],
      evidenceRefs: [...new Set([`run:${workflowRun.id}`, ...(existing?.evidenceRefs ?? [])])],
    };
  }

  async function handleTerminalPersistenceFailure(
    attemptedStatus: 'completed' | 'failed',
    terminalOutcome: RunOutcome,
    error: Error
  ): Promise<void> {
    const failedAt = new Date().toISOString();
    getLog().error(
      { err: error, workflowRunId: workflowRun.id, attemptedStatus },
      'dag_terminal_persist_failed'
    );
    const interruptedOutcome: RunOutcome = {
      ...terminalOutcome,
      executionState: 'interrupted',
      recoveryState: 'recoverable',
      primaryReason: 'status_persist_failed',
      reasonCodes: ['status_persist_failed'],
      evidenceRefs: [...terminalOutcome.evidenceRefs, 'status_persist_failed'],
    };
    let currentStatus: Awaited<ReturnType<IWorkflowStore['getWorkflowRunStatus']>> | undefined;
    try {
      currentStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
    } catch (statusErr) {
      getLog().error(
        { err: statusErr as Error, workflowRunId: workflowRun.id, attemptedStatus },
        'dag_terminal_persist_status_read_failed'
      );
    }
    if (
      currentStatus === 'completed' ||
      currentStatus === 'failed' ||
      currentStatus === 'cancelled' ||
      currentStatus === 'escalated'
    ) {
      getLog().warn(
        { workflowRunId: workflowRun.id, attemptedStatus, currentStatus },
        'dag_terminal_persist_already_terminal'
      );
      return;
    }
    if (currentStatus === 'running') {
      await deps.store
        .updateWorkflowRun(workflowRun.id, {
          status: 'interrupted',
          metadata: {
            terminal_persist_failure: {
              attempted_status: attemptedStatus,
              reason_code: 'status_persist_failed',
              failed_at: failedAt,
            },
          },
        })
        .catch((interruptErr: Error) => {
          getLog().error(
            { err: interruptErr, workflowRunId: workflowRun.id, attemptedStatus },
            'dag_interrupt_status_persist_failed'
          );
        });
      await deps.store
        .upsertRunOutcome(workflowRun.id, interruptedOutcome, failedAt)
        .catch((outcomeErr: Error) => {
          getLog().error(
            { err: outcomeErr, workflowRunId: workflowRun.id, attemptedStatus },
            'dag_interrupt_outcome_persist_failed'
          );
        });
    }
    await deps.store.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'status_persist_failed',
      data: {
        attempted_status: attemptedStatus,
        reason_code: 'status_persist_failed',
      },
    });
    getWorkflowEventEmitter().emit({
      type: 'status_persist_failed',
      runId: workflowRun.id,
      attemptedStatus,
      reason: 'status_persist_failed',
    });
    await safeSendMessage(
      platform,
      conversationId,
      `Warning: workflow terminal state '${attemptedStatus}' could not be saved. The run is recoverable and no terminal success/failure event was published.`,
      { workflowId: workflowRun.id }
    );
  }

  getLog().info(
    { nodeCount: workflow.nodes.length, anyCompleted, anyFailed },
    'dag_workflow_finished'
  );

  if (!anyCompleted) {
    if (await skipIfStatusChanged('dag.skip_fail_status_changed')) return;
    const failMsg =
      `DAG workflow '${workflow.name}' completed with no successful nodes. ` +
      'Check node conditions, trigger rules, and upstream failures.';
    const failedOutcome = await makeTerminalOutcome('failed');
    try {
      await deps.store.failWorkflowRun(workflowRun.id, failMsg, {
        outcome: failedOutcome,
        updatedAt: new Date().toISOString(),
        metadata: { node_counts: nodeCounts, terminal_cause: 'no_successful_nodes' },
        eventData: {
          error: failMsg,
          node_counts: nodeCounts,
          terminal_cause: 'no_successful_nodes',
        },
      });
    } catch (dbErr) {
      await handleTerminalPersistenceFailure('failed', failedOutcome, dbErr as Error);
      return;
    }
    // Terminal state reached: emit 'run_token_totals' rollup event (see token-rollup.ts).
    emitTerminalRunTokenTotals();
    await logWorkflowError(logDir, workflowRun.id, failMsg).catch((logErr: Error) => {
      getLog().error(
        { err: logErr, workflowRunId: workflowRun.id },
        'dag.workflow_error_log_write_failed'
      );
    });
    const emitterForFail = getWorkflowEventEmitter();
    emitterForFail.emit({
      type: 'workflow_failed',
      runId: workflowRun.id,
      workflowName: workflow.name,
      error: failMsg,
    });
    emitterForFail.unregisterRun(workflowRun.id);
    await safeSendMessage(platform, conversationId, `\u274c ${failMsg}`, {
      workflowId: workflowRun.id,
    });
    // DO NOT throw -- outer executor.ts catch would duplicate workflow_failed events
    return;
  }

  if (anyFailed) {
    if (await skipIfStatusChanged('dag.skip_fail_status_changed')) return;

    // Artifact-truth finalization (WO-HARNESS-PR-STATUS-TRUTH-AND-AUTOMERGE-01):
    // if EVERY failed node is a paperwork/tail node AND a real pushed-branch/PR
    // artifact exists among the run's node outputs, then the run's substantive
    // work landed -- only the paperwork could not be filed. Finalize as
    // COMPLETED (degraded) instead of FAILED so the dashboard reflects truth and
    // no green PR is buried under a false-red run. This is the 2026-07-06
    // failure class tracked in bdc-harness#344. If EITHER condition is false
    // (a non-paperwork node failed, or no artifact exists) the run fails exactly
    // as before -- unchanged behavior.
    const failedNodeIds = [...nodeOutputs.entries()]
      .filter(([, o]) => o.state === 'failed')
      .map(([id]) => id);
    const allFailuresArePaperwork = failedNodeIds.every(id => isPaperworkNode(id));
    if (!hasMechanicalEvidenceNode && allFailuresArePaperwork && pushArtifactPresent) {
      getLog().warn(
        { workflowRunId: workflowRun.id, degradedPaperworkNodes: failedNodeIds },
        'dag.workflow_completed_paperwork_degraded'
      );
      const degradedDuration = Date.now() - dagStartTime;
      const degradedOutcome = await makeTerminalOutcome('completed');
      try {
        await deps.store.completeWorkflowRun(
          workflowRun.id,
          {
            node_counts: nodeCounts,
            // Degraded-success signal consumed by the dashboard (Section 5 of the
            // WO): status 'completed' + paperwork_degraded=true, no new enum value.
            paperwork_degraded: true,
            degraded_paperwork_nodes: failedNodeIds,
            ...(totalCostUsd > 0 ? { total_cost_usd: totalCostUsd } : {}),
            ...(totalTokens > 0 ? { total_tokens: totalTokens } : {}),
            ...(totalFrontierCostUsd > 0 ? { total_frontier_cost_usd: totalFrontierCostUsd } : {}),
            ...(nodeModelSummary.length > 0 ? { node_model_summary: nodeModelSummary } : {}),
            ...(modelMismatchCount > 0 ? { model_mismatch_count: modelMismatchCount } : {}),
            terminal_cause: 'paperwork_degraded',
          },
          {
            outcome: degradedOutcome,
            updatedAt: new Date().toISOString(),
            eventData: {
              duration_ms: degradedDuration,
              node_counts: nodeCounts,
              terminal_cause: 'paperwork_degraded',
              paperwork_degraded: true,
              degraded_paperwork_nodes: failedNodeIds,
            },
          }
        );
        // Terminal state reached: emit 'run_token_totals' rollup event.
        emitTerminalRunTokenTotals();
      } catch (dbErr) {
        await handleTerminalPersistenceFailure('completed', degradedOutcome, dbErr as Error);
        return;
      }
      await logWorkflowComplete(logDir, workflowRun.id).catch((logErr: Error) => {
        getLog().error(
          { err: logErr, workflowRunId: workflowRun.id },
          'dag.workflow_complete_log_write_failed'
        );
      });
      const emitterDegraded = getWorkflowEventEmitter();
      emitterDegraded.emit({
        type: 'workflow_completed',
        runId: workflowRun.id,
        workflowName: workflow.name,
        duration: degradedDuration,
      });
      emitterDegraded.unregisterRun(workflowRun.id);
      await safeSendMessage(
        platform,
        conversationId,
        `\u26a0\ufe0f Workflow '${workflow.name}' completed (degraded): the build landed (branch/PR artifact present) but paperwork node(s) failed: ${failedNodeIds.join(', ')}. Run marked completed with paperwork_degraded=true.`,
        { workflowId: workflowRun.id }
      );
      return;
    }

    const failedNodes = [...nodeOutputs.entries()]
      .filter(([, o]) => o.state === 'failed')
      .map(([id, o]) => `'${id}': ${o.state === 'failed' ? o.error : 'unknown'}`)
      .join('; ');
    const failMsg = `DAG workflow '${workflow.name}' completed with failures: ${failedNodes}`;
    const failedOutcome = await makeTerminalOutcome('failed');
    try {
      await deps.store.failWorkflowRun(workflowRun.id, failMsg, {
        outcome: failedOutcome,
        updatedAt: new Date().toISOString(),
        metadata: {
          node_counts: nodeCounts,
          terminal_cause: 'node_failures',
          failed_nodes: failedNodeIds,
        },
        eventData: {
          error: failMsg,
          node_counts: nodeCounts,
          terminal_cause: 'node_failures',
          failed_nodes: failedNodeIds,
        },
      });
    } catch (dbErr) {
      await handleTerminalPersistenceFailure('failed', failedOutcome, dbErr as Error);
      return;
    }
    // Terminal state reached: emit 'run_token_totals' rollup event (see token-rollup.ts).
    emitTerminalRunTokenTotals();
    await logWorkflowError(logDir, workflowRun.id, failMsg).catch((logErr: Error) => {
      getLog().error(
        { err: logErr, workflowRunId: workflowRun.id },
        'dag.workflow_error_log_write_failed'
      );
    });
    const emitterForFail = getWorkflowEventEmitter();
    emitterForFail.emit({
      type: 'workflow_failed',
      runId: workflowRun.id,
      workflowName: workflow.name,
      error: failMsg,
    });
    emitterForFail.unregisterRun(workflowRun.id);
    await safeSendMessage(platform, conversationId, `\u274c ${failMsg}`, {
      workflowId: workflowRun.id,
    });
    // DO NOT throw -- outer executor.ts catch would duplicate workflow_failed events
    return;
  }

  // Check if status was changed externally (e.g. cancelled) before marking complete.
  if (await skipIfStatusChanged('dag.skip_complete_status_changed')) return;

  // Persist terminal facts before publishing any terminal event.
  const duration = Date.now() - dagStartTime;
  const completedOutcome = await makeTerminalOutcome('completed');
  try {
    await deps.store.completeWorkflowRun(
      workflowRun.id,
      {
        node_counts: nodeCounts,
        // totalCostUsd starts at 0; only write metadata when at least one node reported cost
        ...(totalCostUsd > 0 ? { total_cost_usd: totalCostUsd } : {}),
        // totalTokens starts at 0; only write metadata when at least one node reported tokens
        ...(totalTokens > 0 ? { total_tokens: totalTokens } : {}),
        // Layer 1 counterfactual run total (WO-HARNESS-LAYER1-TIER-AND-COUNTERFACTUAL-COST-01).
        // Only write when at least one node reported tokens; UI computes savings as
        // total_frontier_cost_usd - total_cost_usd.
        ...(totalFrontierCostUsd > 0 ? { total_frontier_cost_usd: totalFrontierCostUsd } : {}),
        // Per-run declared/requested/served model rollup
        // (WO-HARNESS-TELEMETRY-DECLARED-MODEL-AND-COST-01). Only written when at
        // least one node reported model telemetry -- deck surfaces 2+3's data
        // contract; field names are provisional pending the deck-UI WO.
        ...(nodeModelSummary.length > 0 ? { node_model_summary: nodeModelSummary } : {}),
        ...(modelMismatchCount > 0 ? { model_mismatch_count: modelMismatchCount } : {}),
      },
      {
        outcome: completedOutcome,
        updatedAt: new Date().toISOString(),
        eventData: {
          duration_ms: duration,
          node_counts: nodeCounts,
          terminal_cause: 'all_nodes_satisfied',
        },
      }
    );
    // Terminal state reached: emit 'run_token_totals' rollup event (see token-rollup.ts).
    emitTerminalRunTokenTotals();
  } catch (dbErr) {
    await handleTerminalPersistenceFailure('completed', completedOutcome, dbErr as Error);
    return;
  }
  await logWorkflowComplete(logDir, workflowRun.id);
  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'workflow_completed',
    runId: workflowRun.id,
    workflowName: workflow.name,
    duration,
  });
  emitter.unregisterRun(workflowRun.id);

  // Return the first terminal node's output (nodes with no dependents) for the parent
  // conversation summary. For the common single-terminal case this is unambiguous; for
  // multi-terminal DAGs the first completed node in definition order is used.
  const allDependencies = new Set(workflow.nodes.flatMap(n => n.depends_on ?? []));
  const terminalOutput = workflow.nodes
    .filter(n => !allDependencies.has(n.id))
    .map(n => nodeOutputs.get(n.id))
    .find(o => o?.state === 'completed' && o.output.trim().length > 0)?.output;

  return terminalOutput;
}

export const executeDagWorkflow: typeof executeDagWorkflowInternal = (...args) => {
  const [deps, , , , , workflowRun] = args;
  const [, ...executionArgs] = args;
  return withRunLease(deps.store, workflowRun.id, isRunLeaseValid =>
    executeDagWorkflowInternal({ ...deps, isRunLeaseValid }, ...executionArgs)
  );
};
interface BunRuntimeResolutionOptions {
  readonly execPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly which?: (name: string) => string | null;
  readonly exists?: (path: string) => boolean;
}

/** Resolve a real Bun CLI, never the compiled Archon executable or a Windows shell shim. */
export function resolveBunRuntimeExecutable(options: BunRuntimeResolutionOptions = {}): string {
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const which = options.which ?? ((name: string): string | null => Bun.which(name));
  const exists = options.exists ?? existsSync;
  const platformPath = platform === 'win32' ? win32Path : posixPath;
  const execName = platformPath.basename(execPath).toLowerCase();
  if (execName === 'bun' || execName === 'bun.exe') return execPath;

  const discovered = which('bun');
  if (!discovered) throw new Error('bun_runtime_executable_unavailable');
  const discoveredName = platformPath.basename(discovered).toLowerCase();
  if (platform !== 'win32' || (discoveredName !== 'bun.cmd' && discoveredName !== 'bun.ps1')) {
    return discovered;
  }

  const npmNative = platformPath.join(
    platformPath.dirname(discovered),
    'node_modules',
    'bun',
    'bin',
    'bun.exe'
  );
  if (exists(npmNative)) return npmNative;
  throw new Error(`bun_runtime_executable_unavailable: shell shim ${discovered}`);
}
