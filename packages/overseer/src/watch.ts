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
      workingPath: run.workingPath,
      metadata: run.metadata,
      action: 'success',
      reason: 'PR is already merged; judging run successful by PR evidence',
      prEvidence,
    };
  }

  // THE MERGE DOOR. Any terminal run whose PR is green, open and mergeable is a
  // merge candidate -- regardless of the run's own status.
  //
  // This used to be gated on `status === 'failed'` alone, because the merge path was
  // built for exactly ONE scenario: the tail-node false-fail (run reports failure, PR
  // is actually fine). That scope assumption was never revisited when Overseer became
  // the merge steward, and it is why Overseer had merged NOTHING, ever -- verified
  // 2026-07-25 against the live event store: 57 overseer_actions, zero merge-class,
  // while 468 terminal runs sat in the watch queue (388 completed, 58 cancelled,
  // 22 escalated, ZERO failed). Every one of them walked past a door marked
  // "failed runs only".
  //
  // The status is not what makes a PR safe to merge -- the PR evidence is. So the
  // gate is isPrMergeReady (exists && open && mergeable && green), applied uniformly.
  // Every downstream guard still applies: merge provenance binds the PR to the run
  // that produced it, Grok judges the diff, and production-effect merges stay held
  // for John.
  //
  // On CANCELLED specifically: the conductor cancels on stall/runaway and then EXITS
  // (it is a CLI process), so work it already pushed has no owner. Anchor: run
  // 3ff3f773 was cancelled having produced a real commit, and the live log shows
  // Overseer reading it and returning action:"ignore". Detection stays with the
  // conductor; salvage belongs to Overseer, the persistent watcher.
  if (isPrMergeReady(prEvidence)) {
    const reason =
      run.status === 'cancelled'
        ? 'cancelled run left a green, mergeable PR -- salvaging orphaned work'
        : `terminal status ${run.status} with a green, mergeable PR -- merge candidate`;
    return {
      runId: run.id,
      woId: run.woId,
      repo: run.repo,
      owner: run.owner,
      status: run.status,
      headBranch: run.headBranch,
      workingPath: run.workingPath,
      metadata: run.metadata,
      errorClass: run.status === 'failed' ? 'tail_node_false_fail' : undefined,
      action: 'merge_ready',
      reason,
      prEvidence,
      decision: { decision: 'merge_ready', reason },
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
      workingPath: run.workingPath,
      metadata: run.metadata,
      // Reached only when the PR is NOT merge-ready (the door above already took
      // every green+mergeable case). A completed run with a green-but-unmergeable PR
      // -- e.g. conflicting, or draft -- is still a success; anything else is noise.
      action: run.status === 'completed' && isPrGreen(prEvidence) ? 'success' : 'ignore',
      reason:
        run.status === 'completed'
          ? `completed run; PR not merge-ready (${prEvidence.exists ? `state=${prEvidence.state} mergeable=${String(prEvidence.mergeable)}` : 'no PR'})`
          : `terminal status ${run.status} with no merge-ready PR`,
      prEvidence,
    };
  }

  // (The former failed-only merge_ready block lived here. It is now redundant: the
  // merge door above handles every terminal status uniformly, including failed runs
  // with green PRs -- the original tail-node false-fail case -- and still tags them
  // errorClass: 'tail_node_false_fail'.)

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
    workingPath: run.workingPath,
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
