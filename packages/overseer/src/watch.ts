import type { WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import { classifyError } from './classify';
import { decide } from './decide';
import { isPrMergeReady, isPrGreen, judgePullRequest } from './judge-pr';
import type {
  GitHubClientDeps,
  OverseerRunRecord,
  OverseerRunStoreDeps,
  OverseerWorkflowEvent,
  WatchedRunRecord,
} from './types.ts';

export const DEFAULT_WATCH_INTERVAL_MS = 60_000;

/**
 * M-42 Slice 8 integration marker: single-watcher ownership for the
 * integrated candidate. Runtime still starts at most one watcher task.
 */
export const SLICE8_WATCHER_OWNERSHIP = 'single_watcher_fail_closed' as const;

function isTerminalStatus(status: string): status is WorkflowRunStatus {
  return (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(status);
}

function newestEvent(events: OverseerWorkflowEvent[]): OverseerWorkflowEvent | undefined {
  return [...events].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')).at(-1);
}

function failedNodeIds(event: OverseerWorkflowEvent | undefined): string[] {
  const failedNodes = event?.data.failed_nodes;
  return Array.isArray(failedNodes)
    ? failedNodes.filter((nodeId): nodeId is string => typeof nodeId === 'string')
    : [];
}

export function selectFailureEvent(
  events: OverseerWorkflowEvent[]
): OverseerWorkflowEvent | undefined {
  const nodeFailedEvents = events.filter(event => event.event_type === 'node_failed');
  const workflowFailedEvent = newestEvent(
    events.filter(event => event.event_type === 'workflow_failed')
  );

  if (nodeFailedEvents.length > 0) {
    const [authoritativeFailedNode] = failedNodeIds(workflowFailedEvent);
    if (authoritativeFailedNode) {
      const matchingEvent = nodeFailedEvents.find(
        event => event.step_name === authoritativeFailedNode
      );
      if (matchingEvent) return matchingEvent;
    }
    return newestEvent(nodeFailedEvents);
  }

  if (workflowFailedEvent) return workflowFailedEvent;

  return newestEvent(events);
}

function eventMessage(event: OverseerWorkflowEvent | undefined): string {
  if (!event) return '';
  const data = event.data;
  const candidates = [data.error, data.message, data.stderr, data.output, data.reason];
  const found = candidates.find(value => typeof value === 'string');
  return typeof found === 'string' ? found : JSON.stringify(data);
}

async function assessRun(
  run: OverseerRunRecord,
  deps: OverseerRunStoreDeps & GitHubClientDeps
): Promise<WatchedRunRecord> {
  const prEvidence = await judgePullRequest(run, deps);

  if (prEvidence.state === 'merged') {
    return {
      runId: run.id,
      woId: run.woId,
      repo: run.repo,
      owner: run.owner,
      status: run.status,
      headBranch: run.headBranch,
      metadata: run.metadata,
      action: 'success',
      reason: 'PR is already merged; judging run successful by PR evidence',
      prEvidence,
    };
  }

  // A CANCELLED run is not nothing. The conductor cancels a run when it stalls or
  // hits the runaway ceiling, then exits -- so any work the run had already pushed
  // is left with no owner. Before 2026-07-25 this branch returned `ignore` with
  // "does not require failure handling", and the commit died in its worktree.
  //
  // Anchor: run 3ff3f773 (WO-HARNESS-DISPATCH-SYNC-BEFORE-RESOLVE-01) was cancelled
  // on a progress-timeout having produced a real commit; the live container log shows
  // Overseer reading it and returning action:"ignore". Salvage is precisely Overseer's
  // job -- it is the persistent watcher, while the conductor is a CLI process that has
  // already exited by then.
  //
  // Detection stays with the conductor (it is already polling and holds tier/attempt
  // context). Overseer picks the run up at the terminal-state boundary. Clean handoff,
  // no duplicated polling, no race.
  if (run.status === 'cancelled' && isPrMergeReady(prEvidence)) {
    return {
      runId: run.id,
      woId: run.woId,
      repo: run.repo,
      owner: run.owner,
      status: run.status,
      headBranch: run.headBranch,
      metadata: run.metadata,
      errorClass: 'tail_node_false_fail',
      action: 'merge_ready',
      reason: 'cancelled run left a green, mergeable PR -- salvaging orphaned work',
      prEvidence,
      decision: {
        decision: 'merge_ready',
        reason: 'cancelled run left a green, mergeable PR -- salvaging orphaned work',
      },
    };
  }

  if (run.status !== 'failed') {
    return {
      runId: run.id,
      woId: run.woId,
      repo: run.repo,
      owner: run.owner,
      status: run.status,
      headBranch: run.headBranch,
      metadata: run.metadata,
      action: run.status === 'completed' && isPrGreen(prEvidence) ? 'success' : 'ignore',
      reason: `terminal status ${run.status} does not require failure handling`,
      prEvidence,
    };
  }

  if (isPrMergeReady(prEvidence)) {
    return {
      runId: run.id,
      woId: run.woId,
      repo: run.repo,
      owner: run.owner,
      status: run.status,
      headBranch: run.headBranch,
      metadata: run.metadata,
      errorClass: 'tail_node_false_fail',
      action: 'merge_ready',
      reason: 'failed run has green, mergeable PR evidence',
      prEvidence,
      decision: { decision: 'merge_ready', reason: 'failed run has green, mergeable PR evidence' },
    };
  }

  const events = await deps.listRunEvents(run.id);
  const lastEvent = selectFailureEvent(events);
  const errorClass = classifyError({
    message: eventMessage(lastEvent),
    nodeId: lastEvent?.step_name ?? undefined,
    exitCode: typeof lastEvent?.data.exitCode === 'number' ? lastEvent.data.exitCode : undefined,
  });
  const decision = decide({
    errorClass,
    attempt: 1,
    nodeId: lastEvent?.step_name ?? undefined,
    woId: run.woId,
  });

  return {
    runId: run.id,
    woId: run.woId,
    repo: run.repo,
    owner: run.owner,
    status: run.status,
    headBranch: run.headBranch,
    metadata: run.metadata,
    errorClass,
    action: 'escalate',
    reason: decision.reason,
    prEvidence,
    decision,
    lastEvent,
  };
}

export async function watchOnce(
  deps: OverseerRunStoreDeps & GitHubClientDeps
): Promise<WatchedRunRecord[]> {
  const runs = await deps.listRunsForWatch();
  const terminalRuns = runs.filter(run => isTerminalStatus(run.status));
  const outcomes: WatchedRunRecord[] = [];
  for (const run of terminalRuns) {
    outcomes.push(await assessRun(run, deps));
  }
  return outcomes;
}

export async function watchLoop(
  deps: OverseerRunStoreDeps & GitHubClientDeps,
  onRecord: (record: WatchedRunRecord) => Promise<void>,
  options: { intervalMs?: number; once?: boolean; signal?: AbortSignal } = {}
): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  for (;;) {
    if (options.signal?.aborted) return;
    const records = await watchOnce(deps);
    for (const record of records) {
      if (options.signal?.aborted) return;
      await onRecord(record);
    }
    if (options.once) return;
    await new Promise<void>(resolve => {
      const signal = options.signal;
      let settled = false;
      const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer.id);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        finish();
      };
      timer.id = setTimeout(finish, intervalMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      // Close the narrow race where the signal aborts between the loop's
      // pre-check and listener registration.
      if (signal?.aborted) onAbort();
    });
    if (options.signal?.aborted) return;
  }
}
