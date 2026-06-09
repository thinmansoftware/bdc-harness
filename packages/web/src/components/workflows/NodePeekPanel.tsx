/**
 * NodePeekPanel -- side-panel drawer that surfaces per-node activity for a
 * workflow run. Eliminates the need to SSH and tail the JSONL log to know
 * whether a node is making progress or stuck.
 *
 * Sources of data:
 *  - Prompt / command / shell script come from the workflow definition
 *    (workflowDef.workflow.nodes) -- the events table does not persist prompts.
 *  - Output comes from the most recent node_completed event in the events list
 *    -- partial / streaming output is SSE-only and never persisted.
 *  - Event list comes from GET /api/workflows/runs/:runId/nodes/:nodeId/events
 *    (last 5 events, newest first). Re-fetches every 5s while the run is live.
 */
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCircle, Pause, X, XCircle } from 'lucide-react';

import type { DagNode, WorkflowEventResponse } from '@/lib/api';
import { approveWorkflowRun, cancelWorkflowRun, getNodeEvents, rejectWorkflowRun } from '@/lib/api';

/** The graded choice verbs exposed by the approve gate UI. */
export type GradedVerb = 'approve_as_is' | 'approve_with_fix' | 'reject';

/**
 * A single finding row from the gate findings ledger.
 * Unresolved findings are eligible for approve-with-fix checkboxes.
 * TODO(findings-consolidate wiring): populated from the findings-consolidate
 * node output once that output is surfaced into the approval context.
 */
export interface GateFinding {
  id: string;
  label: string;
  resolved: boolean;
}

/**
 * Parse a gate findings ledger from a JSON-encoded approval message.
 * Returns an empty array when the message is not a JSON ledger.
 * The ledger format is { findings: Array<{ id, label, resolved }> }.
 */
export function parseFindingsFromMessage(message: string): GateFinding[] {
  if (!message.trimStart().startsWith('{')) return [];
  try {
    const obj = JSON.parse(message) as {
      findings?: { id?: unknown; label?: unknown; resolved?: unknown }[];
    };
    if (!Array.isArray(obj.findings)) return [];
    const out: GateFinding[] = [];
    for (const f of obj.findings) {
      if (f === null || typeof f !== 'object') continue;
      const entry = f as { id?: unknown; label?: unknown; resolved?: unknown };
      if (typeof entry.id === 'string' && typeof entry.label === 'string') {
        out.push({ id: entry.id, label: entry.label, resolved: entry.resolved === true });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Filter a findings ledger to only the unresolved rows (eligible for fix). */
export function unresolvedFindings(findings: GateFinding[]): GateFinding[] {
  return findings.filter(f => !f.resolved);
}

/**
 * The disabled predicate for the "Approve with fix" control: there is nothing
 * to fix when no unresolved findings remain (empty ledger OR all resolved).
 */
export function isApproveWithFixDisabled(findings: GateFinding[]): boolean {
  return unresolvedFindings(findings).length === 0;
}

/**
 * Cast nodeDef.approval to the extended shape that includes the optional
 * choices field (present in the Zod schema but not yet in api.generated.d.ts).
 */
interface ApprovalDefExtended {
  message: string;
  capture_response?: boolean;
  on_reject?: { prompt: string; max_attempts?: number };
  choices?: GradedVerb[];
}
import { resolveNodeDisplay } from '@/lib/dag-layout';
import { ensureUtc } from '@/lib/format';
import { classifyNodeError, deriveLucilleHint } from '@/lib/negan-utils';
import type { WorkflowRunStatus, WorkflowStepStatus } from '@/lib/types';
import { useClickOutside } from '@/hooks/useClickOutside';
import { ReplayNode } from './ReplayNode';
import { RunHistorySparkline } from './RunHistorySparkline';

const MAX_BODY_CHARS = 2000;
const EVENT_POLL_MS = 5000;

interface NodePeekPanelProps {
  runId: string;
  nodeId: string;
  nodeDef: DagNode | null;
  nodeStatus: WorkflowStepStatus | undefined;
  isRunning: boolean;
  onClose: () => void;
  /** WO-MC-SELF-REPAIR-LOOP-VIZ-01 (Gap C): run-level status. Used together
   *  with `approval` to decide whether to render the inline Approve/Reject
   *  affordance -- ONLY when run is paused on the selected approval gate. */
  runStatus?: WorkflowRunStatus;
  /** Unresolved approval context (node id + message) recovered from events
   *  by extractApprovalContext, or set by SSE. The buttons render only when
   *  approval.nodeId === this panel's nodeId AND runStatus === 'paused'. */
  approval?: { nodeId: string; message: string };
  /** WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: workflow name, used by
   *  RunHistorySparkline to look up recent runs of the same workflow. */
  workflowName?: string;
  /** WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: from run.metadata.approval -- declared
   *  on_reject prompt; absence means reject halts immediately. Surfaced via
   *  LucilleHint. */
  onRejectPrompt?: string;
  /** WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: from run.metadata.approval -- bounded
   *  re-draft count for the on_reject loop. Surfaced via LucilleHint. */
  onRejectMaxAttempts?: number;
}

/** Truncate a string to MAX_BODY_CHARS with a "show more" affordance. */
function ExpandableBlock({ text }: { text: string }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const tooLong = text.length > MAX_BODY_CHARS;
  const display = expanded || !tooLong ? text : text.slice(0, MAX_BODY_CHARS);
  return (
    <div className="text-xs font-mono text-text-primary whitespace-pre-wrap break-words">
      {display}
      {tooLong && (
        <button
          type="button"
          onClick={(): void => {
            setExpanded(prev => !prev);
          }}
          className="block mt-1 text-[10px] uppercase tracking-wide text-accent hover:text-accent-bright"
        >
          {expanded ? 'Show less' : `Show more (${String(text.length - MAX_BODY_CHARS)} chars)`}
        </button>
      )}
    </div>
  );
}

/** Pick the most recent node_completed event from a newest-first event list. */
function extractLatestOutput(events: WorkflowEventResponse[]): string | null {
  for (const ev of events) {
    if (ev.event_type === 'node_completed' || ev.event_type === 'node_completed_with_warning') {
      const out = ev.data.node_output;
      if (typeof out === 'string') return out;
    }
  }
  return null;
}

export function NodePeekPanel({
  runId,
  nodeId,
  nodeDef,
  nodeStatus,
  isRunning,
  onClose,
  runStatus,
  approval,
  workflowName,
  onRejectPrompt,
  onRejectMaxAttempts,
}: NodePeekPanelProps): React.ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  useClickOutside(panelRef, onClose);
  const queryClient = useQueryClient();
  const [gateBusy, setGateBusy] = useState<null | 'approving' | 'rejecting'>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  // Graded-choice state: which verb the operator picked + which fix ids are checked.
  const [gradedVerb, setGradedVerb] = useState<GradedVerb | null>(null);
  const [checkedFixIds, setCheckedFixIds] = useState<Set<string>>(new Set());
  // WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: Kill -- the real /cancel control distinct
  // from Reject. Reject auto-resumes into on_reject when defined; Kill always
  // takes the run to status=cancelled.
  const cancelMutation = useMutation({
    mutationFn: () => cancelWorkflowRun(runId),
    onSuccess: async () => {
      setGateError(null);
      await queryClient.invalidateQueries({ queryKey: ['workflowRun', runId] });
    },
    onError: (err: unknown) => {
      setGateError(err instanceof Error ? err.message : 'Cancel failed');
    },
  });
  const lucilleHint = useMemo(
    () => deriveLucilleHint(onRejectPrompt, onRejectMaxAttempts),
    [onRejectPrompt, onRejectMaxAttempts]
  );

  // WO-MC-SELF-REPAIR-LOOP-VIZ-01 (Gap C): inline gate affordance is shown
  // ONLY when this panel's node IS the unresolved approval-gate node on a
  // paused run. The discriminator (approval object present + nodeId match +
  // run.status === 'paused' + this node has approval defined in the YAML)
  // distinguishes approval-gate pauses from operator-triggered run_paused,
  // which never emits approval_requested and so never populates `approval`.
  const showInlineGate =
    runStatus === 'paused' && approval?.nodeId === nodeId && nodeDef?.approval != null;

  // Cast to the extended shape to read the optional choices field.
  const approvalDef = nodeDef?.approval != null ? (nodeDef.approval as ApprovalDefExtended) : null;
  // Graded mode: only when the YAML node declares all three verbs or at least two.
  const gradedChoices = approvalDef?.choices ?? null;
  const isGradedMode = showInlineGate && gradedChoices != null && gradedChoices.length >= 2;

  // Parse findings from the approval message for approve-with-fix checkboxes.
  const findings: GateFinding[] = useMemo(
    () => (approval?.message ? parseFindingsFromMessage(approval.message) : []),
    [approval?.message]
  );
  const unresolved = useMemo(() => unresolvedFindings(findings), [findings]);
  const approveWithFixDisabled = isApproveWithFixDisabled(findings);

  const onApprove = async (): Promise<void> => {
    if (gateBusy !== null) return;
    setGateBusy('approving');
    setGateError(null);
    try {
      // Legacy binary path: send the ORIGINAL wire body (no decision_verb).
      // The backend schema applies the approve_as_is default itself, so behavior
      // is identical and the legacy wire shape is preserved unchanged.
      await approveWorkflowRun(runId);
      // Trigger a re-fetch so the run status + events refresh promptly.
      // A transient run.status === 'failed' is expected during auto-resume
      // (api.ts:2672) and must NOT be treated as an error here.
      await queryClient.invalidateQueries({ queryKey: ['workflowRun', runId] });
    } catch (err) {
      setGateError(err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setGateBusy(null);
    }
  };

  const onApproveAsIs = async (): Promise<void> => {
    if (gateBusy !== null) return;
    setGateBusy('approving');
    setGateError(null);
    try {
      await approveWorkflowRun(runId, undefined, { decision_verb: 'approve_as_is' });
      await queryClient.invalidateQueries({ queryKey: ['workflowRun', runId] });
    } catch (err) {
      setGateError(err instanceof Error ? err.message : 'Approve-as-is failed');
    } finally {
      setGateBusy(null);
    }
  };

  const onApproveWithFix = async (): Promise<void> => {
    if (gateBusy !== null) return;
    setGateBusy('approving');
    setGateError(null);
    try {
      await approveWorkflowRun(runId, undefined, {
        decision_verb: 'approve_with_fix',
        authorized_fix_ids: Array.from(checkedFixIds),
      });
      await queryClient.invalidateQueries({ queryKey: ['workflowRun', runId] });
    } catch (err) {
      setGateError(err instanceof Error ? err.message : 'Approve-with-fix failed');
    } finally {
      setGateBusy(null);
    }
  };

  const onReject = async (): Promise<void> => {
    if (gateBusy !== null) return;
    setGateBusy('rejecting');
    setGateError(null);
    try {
      await rejectWorkflowRun(runId);
      await queryClient.invalidateQueries({ queryKey: ['workflowRun', runId] });
    } catch (err) {
      setGateError(err instanceof Error ? err.message : 'Reject failed');
    } finally {
      setGateBusy(null);
    }
  };

  // Live poll while the workflow run as a whole is still running.
  // Stops polling for terminal runs -- react-query refetches still happen on focus.
  const { data: events, isLoading } = useQuery({
    queryKey: ['nodeEvents', runId, nodeId],
    queryFn: () => getNodeEvents(runId, nodeId, 5),
    refetchInterval: isRunning ? EVENT_POLL_MS : false,
    staleTime: 0,
  });

  const display = useMemo(() => (nodeDef ? resolveNodeDisplay(nodeDef) : null), [nodeDef]);
  const promptText = display?.promptText ?? null;
  const bashScript = display?.bashScript ?? null;
  const nodeType = display?.nodeType ?? null;

  const eventList = events ?? [];
  const latestOutput = extractLatestOutput(eventList);
  const hasNotStarted = nodeStatus === undefined || nodeStatus === 'pending';

  // WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: extract the first node_failed event's
  // error so the panel can show the classified FailureReason (matches the
  // failed node face). Newest-first order -- take the most recent failure.
  const failedEventError = useMemo((): string | undefined => {
    for (const ev of eventList) {
      if (ev.event_type !== 'node_failed') continue;
      const raw = ev.data.error;
      if (typeof raw === 'string' && raw.length > 0) return raw;
    }
    return undefined;
  }, [eventList]);
  const failureClass = classifyNodeError(failedEventError);

  // Section ordering (top to bottom): header, prompt/command, output/response, events list.
  return (
    <div
      ref={panelRef}
      role="complementary"
      aria-label={`Node peek for ${nodeId}`}
      className="absolute right-0 top-0 h-full w-80 z-10 bg-surface border-l border-border flex flex-col shadow-lg"
      data-testid="node-detail"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="text-[10px] uppercase tracking-wide text-text-tertiary">
          {nodeType ?? 'node'}
        </span>
        <span className="flex-1 truncate text-xs font-mono font-semibold text-text-primary">
          {nodeId}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-text-tertiary hover:text-text-primary hover:bg-surface-elevated"
          aria-label="Close node peek"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto">
        {/* WO-MC-SELF-REPAIR-LOOP-VIZ-01 (Gap C): inline gate for an
            approval-gate pause. Graded three-choice mode when the YAML node
            declares choices=[]; falls back to binary Approve/Reject otherwise.
            Render BEFORE prompt so it is unmissable. */}
        {showInlineGate && (
          <section
            className="px-3 py-2 border-b border-border bg-warning/5"
            data-testid="inline-approve-gate"
          >
            <div className="flex items-center gap-2 mb-2">
              <Pause className="h-3.5 w-3.5 text-warning shrink-0" />
              <span className="text-[10px] uppercase tracking-wide text-warning font-semibold">
                Awaiting approval
              </span>
            </div>
            {approval?.message && !isGradedMode && (
              <p className="text-xs text-text-secondary mb-2 whitespace-pre-wrap break-words">
                {approval.message}
              </p>
            )}
            {/* WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: LucilleHint -- state the
                consequence of each choice before the operator clicks.
                Reject loops the workflow into its on_reject chain;
                Kill (/cancel) is the actual stop. */}
            {!isGradedMode && (
              <div className="mb-2 space-y-0.5" data-testid="lucille-hint">
                <p className="text-[10px] text-success/80">{lucilleHint.approve}</p>
                <p className="text-[10px] text-error/80">{lucilleHint.reject}</p>
                <p className="text-[10px] text-text-secondary">
                  Kill (/cancel) -&gt; stops the run immediately
                </p>
              </div>
            )}

            {/* GRADED mode: three-choice selector (approve-as-is / approve-with-fix / reject) */}
            {isGradedMode && (
              <div data-testid="graded-choice-panel">
                {/* Verb selector */}
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  {gradedChoices.includes('approve_as_is') && (
                    <button
                      type="button"
                      onClick={(): void => {
                        setGradedVerb(prev => (prev === 'approve_as_is' ? null : 'approve_as_is'));
                        setCheckedFixIds(new Set());
                      }}
                      disabled={gateBusy !== null || cancelMutation.isPending}
                      className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        gradedVerb === 'approve_as_is'
                          ? 'bg-success/15 text-success border-success/50'
                          : 'text-success/90 border-success/30 hover:bg-success/10 hover:text-success'
                      }`}
                      data-testid="choice-approve-as-is"
                    >
                      <CheckCircle className="h-3.5 w-3.5" />
                      Approve as-is
                    </button>
                  )}
                  {gradedChoices.includes('approve_with_fix') && (
                    <button
                      type="button"
                      onClick={(): void => {
                        setGradedVerb(prev =>
                          prev === 'approve_with_fix' ? null : 'approve_with_fix'
                        );
                        setCheckedFixIds(new Set());
                      }}
                      disabled={
                        gateBusy !== null || cancelMutation.isPending || approveWithFixDisabled
                      }
                      className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        gradedVerb === 'approve_with_fix'
                          ? 'bg-warning/15 text-warning border-warning/50'
                          : 'text-warning/90 border-warning/30 hover:bg-warning/10 hover:text-warning'
                      }`}
                      data-testid="choice-approve-with-fix"
                    >
                      Approve with fix
                    </button>
                  )}
                  {gradedChoices.includes('reject') && (
                    <button
                      type="button"
                      onClick={(): void => {
                        setGradedVerb(prev => (prev === 'reject' ? null : 'reject'));
                        setCheckedFixIds(new Set());
                      }}
                      disabled={gateBusy !== null || cancelMutation.isPending}
                      className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        gradedVerb === 'reject'
                          ? 'bg-error/15 text-error border-error/50'
                          : 'text-error/90 border-error/30 hover:bg-error/10 hover:text-error'
                      }`}
                      data-testid="choice-reject"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Reject
                    </button>
                  )}
                </div>

                {/* Per-finding checkboxes for approve-with-fix */}
                {gradedVerb === 'approve_with_fix' && unresolved.length > 0 && (
                  <div className="mb-2 space-y-1" data-testid="fix-findings-list">
                    <p className="text-[10px] text-text-tertiary uppercase tracking-wide mb-1">
                      Authorize fixes for:
                    </p>
                    {unresolved.map(f => (
                      <label
                        key={f.id}
                        className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer"
                        data-testid={`fix-finding-${f.id}`}
                      >
                        <input
                          type="checkbox"
                          checked={checkedFixIds.has(f.id)}
                          onChange={(e): void => {
                            setCheckedFixIds(prev => {
                              const next = new Set(prev);
                              if (e.target.checked) {
                                next.add(f.id);
                              } else {
                                next.delete(f.id);
                              }
                              return next;
                            });
                          }}
                          className="accent-warning"
                        />
                        {f.label}
                      </label>
                    ))}
                  </div>
                )}

                {/* Confirm button for graded choice */}
                {gradedVerb !== null && (
                  <button
                    type="button"
                    onClick={(): void => {
                      if (gradedVerb === 'approve_as_is') void onApproveAsIs();
                      else if (gradedVerb === 'approve_with_fix') void onApproveWithFix();
                      else void onReject();
                    }}
                    disabled={gateBusy !== null || cancelMutation.isPending}
                    className="mt-1 flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-primary bg-surface-elevated border border-border hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    data-testid="graded-confirm-button"
                  >
                    {gateBusy !== null
                      ? 'Working...'
                      : `Confirm: ${gradedVerb === 'approve_as_is' ? 'Approve as-is' : gradedVerb === 'approve_with_fix' ? 'Approve with fix' : 'Reject'}`}
                  </button>
                )}
              </div>
            )}

            {/* BINARY (legacy) mode: plain Approve / Reject buttons */}
            {!isGradedMode && (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={(): void => {
                    void onApprove();
                  }}
                  disabled={gateBusy !== null || cancelMutation.isPending}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-success/90 border border-success/30 hover:bg-success/10 hover:text-success disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  data-testid="inline-approve-button"
                >
                  <CheckCircle className="h-3.5 w-3.5" />
                  {gateBusy === 'approving' ? 'Approving...' : 'Approve'}
                </button>
                <button
                  type="button"
                  onClick={(): void => {
                    void onReject();
                  }}
                  disabled={gateBusy !== null || cancelMutation.isPending}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-error/90 border border-error/30 hover:bg-error/10 hover:text-error disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  data-testid="inline-reject-button"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  {gateBusy === 'rejecting' ? 'Rejecting...' : 'Reject'}
                </button>
                {/* WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: KillButton -- distinct from
                    Reject. Direct /cancel; bypasses the on_reject loop. */}
                <button
                  type="button"
                  onClick={(): void => {
                    cancelMutation.mutate();
                  }}
                  disabled={gateBusy !== null || cancelMutation.isPending}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary border border-border hover:bg-surface-elevated hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  data-testid="inline-kill-button"
                >
                  <Ban className="h-3.5 w-3.5" />
                  {cancelMutation.isPending ? 'Killing...' : 'Kill (/cancel)'}
                </button>
              </div>
            )}
            {gateError !== null && <p className="mt-1 text-[10px] text-error">{gateError}</p>}
          </section>
        )}
        {/* WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: FailureReason -- classified failure
            class on the panel for failed nodes; the raw error follows in the
            block below. Anchor: codex 400 was a bare red box in v0. */}
        {nodeStatus === 'failed' && failureClass !== undefined && (
          <section
            className="px-3 py-2 border-b border-border bg-error/5"
            data-testid="peek-failure-reason"
          >
            <h3 className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">
              Failure class
            </h3>
            <p className="text-xs text-error font-medium">{failureClass}</p>
            {failedEventError !== undefined && (
              <p className="mt-1 text-[10px] text-error/80 whitespace-pre-wrap break-words">
                {failedEventError}
              </p>
            )}
          </section>
        )}
        {/* Prompt / Command / Shell */}
        <section className="px-3 py-2 border-b border-border">
          <h3 className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">
            {nodeType === 'bash' ? 'Shell script' : nodeType === 'command' ? 'Command' : 'Prompt'}
          </h3>
          {nodeType === 'command' ? (
            <div className="text-xs font-mono text-text-primary break-words">
              {display?.label ?? nodeId}
            </div>
          ) : nodeType === 'bash' && bashScript ? (
            <ExpandableBlock text={bashScript} />
          ) : promptText ? (
            <ExpandableBlock text={promptText} />
          ) : (
            <p className="text-xs text-text-tertiary italic">No prompt available.</p>
          )}
        </section>

        {/* Output / Response */}
        <section className="px-3 py-2 border-b border-border">
          <h3 className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">
            {nodeType === 'bash' ? 'Output' : 'Response'}
          </h3>
          {hasNotStarted ? (
            <p className="text-xs text-text-tertiary italic">Node has not started.</p>
          ) : latestOutput !== null ? (
            <ExpandableBlock text={latestOutput} />
          ) : nodeStatus === 'running' ? (
            <p className="text-xs text-text-tertiary italic">
              Running... output will appear when the node completes.
            </p>
          ) : nodeStatus === 'failed' ? (
            <p className="text-xs text-error italic">Node failed without producing output.</p>
          ) : (
            <p className="text-xs text-text-tertiary italic">No output recorded.</p>
          )}
        </section>

        {/* WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: ReplayNode -- "Resume from failed"
            on a failed run. v1 calls /api/workflows/runs/:runId/resume, which
            marks the failed run ready to resume; the next invocation on the
            same path auto-resumes from completed nodes (skipping them). Alt-model
            replay is fast-follow (requires a server-side model override). */}
        {runStatus === 'failed' && <ReplayNode runId={runId} />}

        {/* WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: RunHistorySparkline -- recent
            outcomes for THIS workflow (not this node). Anchor: "fired 5x,
            died HERE 5x" trend signal. Returns null when fewer than 2 runs. */}
        {workflowName && <RunHistorySparkline workflowName={workflowName} />}

        {/* Last events */}
        <section className="px-3 py-2">
          <h3 className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">
            Last events
          </h3>
          {isLoading && eventList.length === 0 ? (
            <p className="text-xs text-text-tertiary italic">Loading events...</p>
          ) : eventList.length === 0 ? (
            <p className="text-xs text-text-tertiary italic">
              {hasNotStarted ? 'Node has not started.' : 'No events recorded.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {eventList.map(ev => {
                const ts = new Date(ensureUtc(ev.created_at)).toLocaleTimeString();
                return (
                  <li
                    key={ev.id}
                    className="flex items-center gap-2 text-[11px] font-mono text-text-secondary"
                  >
                    <span className="text-text-tertiary tabular-nums shrink-0">{ts}</span>
                    <span className="truncate">{ev.event_type}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
