import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import type { DagNodeData } from './DagNodeComponent';
import type { WorkflowStepStatus } from '@/lib/types';
import { formatDurationMs, formatIterLabel } from '@/lib/format';
import { formatCostUsd, costColorClass } from '@/lib/cost-utils';
import { getWorkflowStepHelp } from '@/lib/workflow-step-descriptions';
import { StatusIcon } from './StatusIcon';

export interface ExecutionNodeData extends DagNodeData {
  status?: WorkflowStepStatus;
  duration?: number;
  error?: string;
  selected?: boolean;
  currentIteration?: number;
  maxIterations?: number;
  costUsd?: number;
  /** WO-170: STATUS=*_failed line(s) — surfaced in tooltip when status is completed_with_warning. */
  warningStatusLine?: string;
  /** WO-170: matched *_failed patterns. */
  warningPatterns?: string[];
  /** WO-170: true if triggered by load_bearing opt-in, false if always-dangerous pattern. */
  warningLoadBearing?: boolean;
  /** WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: classified error class for the node face
   *  (e.g. "codex 400: model not supported"). Computed by WorkflowDagViewer
   *  via classifyNodeError(data.error); rendered on the face when status is
   *  'failed'. The full raw error stays in the existing tooltip. */
  failureClass?: string;
  /** WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: true when this node is a self-repair
   *  ladder rung or approval gate (isLadderNodeId match). Drives the
   *  HealthTell affordance: greyed/skipped = "brain intact"; running / failed
   *  / awaiting_approval = "self-repair engaged". */
  isRepairOrGate?: boolean;
}

export type ExecutionFlowNode = Node<ExecutionNodeData>;

const STATUS_STYLES: Partial<Record<WorkflowStepStatus, string>> = {
  completed: 'border-l-2 border-success bg-success/5',
  // WO-170: yellow border + tint for exit-0-with-warning state.
  completed_with_warning: 'border-l-2 border-warning bg-warning/5',
  running: 'border-l-2 border-accent-bright bg-accent/5 shadow-[0_0_8px_var(--accent)]',
  failed: 'border-l-2 border-error bg-error/5',
  skipped: 'opacity-50 border-l-2 border-border',
  // WO-MC-SELF-REPAIR-LOOP-VIZ-01 (Gap C): amber pulse glow + tint so a
  // paused approval-gate node is visually distinct from any running node
  // in the same graph. The pulse animation comes from the StatusIcon's
  // animate-pulse on the Lock glyph.
  awaiting_approval: 'border-l-2 border-warning bg-warning/10 shadow-[0_0_8px_var(--warning)]',
};
const DEFAULT_STYLE = 'border-l-2 border-border bg-surface-elevated';

const TYPE_COLORS: Record<string, string> = {
  command: 'text-purple-400',
  prompt: 'text-accent-bright',
  bash: 'text-amber-400',
  loop: 'text-orange-400',
};

const TYPE_LABELS: Record<string, string> = {
  command: 'CMD',
  bash: 'BASH',
  prompt: 'PROMPT',
  loop: 'LOOP',
};

function ExecutionDagNodeRender({ data }: NodeProps<ExecutionFlowNode>): React.ReactElement {
  const style = (data.status && STATUS_STYLES[data.status]) ?? DEFAULT_STYLE;
  const typeLabel = TYPE_LABELS[data.nodeType] ?? 'PROMPT';
  const help = getWorkflowStepHelp({
    nodeId: data.id,
    label: data.label,
    nodeType: data.nodeType,
    agentPersona: data.agentPersona,
  });
  // WO-170: build a tooltip body when the node completed with a warning. Native
  // title attribute is sufficient for v1 — keeps the change minimal and
  // accessible to keyboard / screen-reader users.
  const isWarning = data.status === 'completed_with_warning';
  // WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: HealthTell — the greyed pause-gate / repair
  // node on a healthy run is itself the "brain intact" signal; when it lights
  // (running, failed, or awaiting_approval), the self-repair lane is engaged.
  const healthTellEngaged =
    data.isRepairOrGate === true &&
    (data.status === 'running' || data.status === 'failed' || data.status === 'awaiting_approval');
  const healthTellIntact = data.isRepairOrGate === true && data.status === 'skipped';
  return (
    <div
      className={`group relative rounded-lg border border-border px-3 py-2 min-w-[140px] transition-all duration-300 ${style}${data.selected ? ' ring-2 ring-accent-bright' : ''}`}
      aria-label={`${help.title}. ${help.body}`}
    >
      <Handle type="target" position={Position.Top} className="!bg-border !w-2 !h-2" />
      <div className="flex items-center gap-2">
        <StatusIcon status={data.status ?? 'pending'} />
        <span
          className={`text-[10px] font-medium ${TYPE_COLORS[data.nodeType] ?? 'text-text-tertiary'}`}
        >
          {typeLabel}
        </span>
        <span className="text-[10px] text-text-tertiary">·</span>
        <span className="text-xs font-medium text-text-primary truncate max-w-[100px]">
          {data.label}
        </span>
        {data.agentPersona && (
          <>
            <span className="text-[10px] text-text-tertiary">·</span>
            <span className="text-[10px] text-text-tertiary italic truncate max-w-[80px]">
              {data.agentPersona}
            </span>
          </>
        )}
        {data.currentIteration !== undefined && data.maxIterations !== undefined && (
          <>
            <span className="text-[10px] text-text-tertiary">·</span>
            <span className="text-[10px] text-text-tertiary shrink-0">
              {formatIterLabel(data.currentIteration, data.maxIterations, data.status)}
            </span>
          </>
        )}
        {data.duration !== undefined && (
          <span className="text-[10px] text-text-tertiary ml-auto shrink-0">
            {formatDurationMs(data.duration)}
          </span>
        )}
        {data.costUsd !== undefined && (
          <span className={`text-[10px] shrink-0 ${costColorClass(data.costUsd)}`}>
            {formatCostUsd(data.costUsd)}
          </span>
        )}
        <span
          className="ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-[10px] font-semibold text-text-tertiary"
          aria-hidden="true"
        >
          ?
        </span>
      </div>
      {/* WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: FailureReason — classified error CLASS
          shown on the face when a node failed. Not a bare red box: the operator
          and the agent can scan the failure mode at a glance. Full raw error
          remains in the hover tooltip and in NodePeekPanel. */}
      {data.status === 'failed' && data.failureClass !== undefined && (
        <div
          className="text-[10px] text-error mt-1 truncate font-medium"
          data-testid="failure-reason-class"
        >
          {data.failureClass}
        </div>
      )}
      {data.error && (
        <div className="text-[10px] text-error mt-1 truncate">{data.error.slice(0, 60)}</div>
      )}
      {/* WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: HealthTell engaged — small amber dot
          when a self-repair rung or pause-gate has lit up. The "brain intact"
          tell is the absence of this dot (greyed/skipped repair nodes); we
          render the engaged signal explicitly so it is hard to miss. */}
      {healthTellEngaged && (
        <div
          className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warning shadow-[0_0_4px_var(--warning)]"
          title="self-repair engaged"
          data-testid="health-tell-engaged"
          aria-label="self-repair engaged"
        />
      )}
      {isWarning && data.warningPatterns && data.warningPatterns.length > 0 && (
        <div className="text-[10px] text-warning mt-1 truncate">
          {data.warningPatterns.join(', ')}
        </div>
      )}
      <div
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden w-72 -translate-x-1/2 rounded-lg border border-border bg-surface px-3 py-2 text-left shadow-xl group-hover:block group-focus-within:block"
      >
        <div className="text-[11px] font-semibold uppercase tracking-wide text-text-primary">
          {help.title}
        </div>
        <p className="mt-1 text-[11px] leading-5 text-text-secondary">{help.body}</p>
        {data.agentPersona && (
          <p className="mt-2 border-t border-border pt-2 text-[10px] text-text-tertiary">
            Persona: {data.agentPersona}
          </p>
        )}
        {isWarning && data.warningStatusLine && (
          <p className="mt-2 border-t border-border pt-2 text-[10px] leading-4 text-warning">
            Silent failure detected: {data.warningStatusLine}
          </p>
        )}
        {/* WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: HealthTell — explicit "brain intact"
            micro-label on a skipped repair / gate node (the deliberate health
            signal preserved from the proof-fire baseline). */}
        {healthTellIntact && (
          <p
            className="mt-2 border-t border-border pt-2 text-[10px] leading-4 text-success"
            data-testid="health-tell-intact"
          >
            brain intact (self-repair lane not needed)
          </p>
        )}
        {/* WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: full raw error in the tooltip for
            failed nodes — the FailureReason class on the face is the brain;
            this is the body. */}
        {data.status === 'failed' && data.error && (
          <p
            className="mt-2 border-t border-border pt-2 text-[10px] leading-4 text-error whitespace-pre-wrap break-words"
            data-testid="failure-reason-raw"
          >
            {data.error}
          </p>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-border !w-2 !h-2" />
    </div>
  );
}

export const executionDagNode = memo(ExecutionDagNodeRender);
