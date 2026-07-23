import { createLogger } from '@archon/paths';
import {
  insertOverseerAction,
  listRunEventsForOverseer,
  listRunsForOverseerWatch,
} from '@archon/core/db/overseer';
import { runAuthorizedEscalation } from './authorized-escalation';
import { runEscalation } from './escalate';
import {
  createDefaultOperatorCardChannels,
  runDueOperatorCardDeliveries,
  type OperatorCardChannel,
} from './escalation-delivery';
import { permitFromMetadata } from './permit';
import { runReconcileOnce } from './reconcile';
import { watchLoop } from './watch';
import type {
  GitHubClientDeps,
  OverseerActionsDeps,
  OverseerRunStoreDeps,
  PullRequestEvidence,
  WatchedRunRecord,
} from './types.ts';
// M-42 Slice 8: surface integrated action modules (default-off; no live authority).
// Child action internals remain owned by S4-S7; this only registers the module surface.
import { assessRepairRefireCandidate } from './actions/repair-refire';
import { assessBranchRefreshCandidate } from './actions/refresh-rebase';
import { assessLifecycleCandidate } from './actions/lifecycle';
import { assessQualifiedMerge } from './actions/merge-ready';
import { assertOverseerDefaultOff } from './integration-scenarios';
import { createRealGitHubClientDeps } from './adapters/github-real-deps';

/**
 * Integrated S4-S7 assessment surface for Slice 8 wiring.
 * All capabilities remain default-off; these references prove modules load.
 */
export const SLICE8_INTEGRATED_ASSESSORS = Object.freeze({
  repair_refire: assessRepairRefireCandidate,
  refresh_rebase: assessBranchRefreshCandidate,
  lifecycle: assessLifecycleCandidate,
  merge: assessQualifiedMerge,
  assert_default_off: assertOverseerDefaultOff,
});

const log = createLogger('overseer/service');

/**
 * Resolved adapter kind for the watcher. Distinct from env-intent: reflects the
 * adapter that was actually wired when the service started.
 */
export type OverseerWiredAdapterKind = 'fake' | 'real' | 'none';
export type MergeReadyCoordinator = (record: WatchedRunRecord) => Promise<unknown>;

export interface OverseerServiceOptions {
  once?: boolean;
  enabled?: boolean;
  dryRun?: boolean;
  mergeCoordinator?: MergeReadyCoordinator;
  intervalMs?: number;
  signal?: AbortSignal;
  /**
   * When set, the service uses this adapter kind instead of calling createDefaultDeps().
   * Allows the caller (overseer-runtime) to pass fake deps without duplicating logic.
   */
  adapterKind?: OverseerWiredAdapterKind;
  deps?: OverseerRunStoreDeps & OverseerActionsDeps & GitHubClientDeps;
  deliveryEnabled?: boolean;
  deliveryIntervalMs?: number;
  deliveryOwner?: string;
  deliveryChannels?: OperatorCardChannel[];
  deliveryDrain?: () => Promise<unknown>;
  reconcileIntervalMs?: number;
  reconcileRun?: () => Promise<unknown>;
}

export async function runOperatorCardDeliveryScheduler(input: {
  signal?: AbortSignal;
  intervalMs?: number;
  owner: string;
  once?: boolean;
  drain?: () => Promise<unknown>;
  channels?: OperatorCardChannel[];
}): Promise<void> {
  const drain =
    input.drain ??
    ((): Promise<unknown> =>
      runDueOperatorCardDeliveries({
        channels: input.channels ?? createDefaultOperatorCardChannels(),
        owner: input.owner,
      }));
  for (;;) {
    if (input.signal?.aborted) return;
    await drain();
    if (input.once || input.signal?.aborted) return;
    await waitForDeliveryInterval(input.intervalMs ?? 30_000, input.signal);
  }
}

export async function runReconcileScheduler(input: {
  signal?: AbortSignal;
  intervalMs?: number;
  once?: boolean;
  reconcile?: () => Promise<unknown>;
}): Promise<void> {
  const reconcile = input.reconcile ?? ((): Promise<unknown> => runReconcileOnce());
  for (;;) {
    if (input.signal?.aborted) return;
    await reconcile();
    if (input.once || input.signal?.aborted) return;
    await waitForDeliveryInterval(input.intervalMs ?? 30_000, input.signal);
  }
}

async function waitForDeliveryInterval(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>(resolve => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}

function envEnabled(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

async function handleRecord(
  record: WatchedRunRecord,
  deps: OverseerActionsDeps & GitHubClientDeps,
  dryRun: boolean,
  actor: string,
  mergeCoordinator?: MergeReadyCoordinator
): Promise<void> {
  if (record.action === 'success' || record.action === 'ignore') {
    log.info(
      {
        runId: record.runId,
        woId: record.woId,
        action: record.action,
        class: record.errorClass ?? 'none',
        reason: record.reason,
      },
      'overseer.decision_completed'
    );
    return;
  }

  // Dry-run gates MUTATION only (merge_ready is the sole mutating path today).
  // Escalation is notification/audit, never a repo or production mutation --
  // it must run regardless of dry-run, or the operator is never told Overseer
  // is stuck. Root-caused 2026-07-18: prior code gated escalation here too,
  // which is why zero escalation.json receipts were ever written in production
  // despite Overseer correctly classifying and deciding to escalate every time.
  if (dryRun && record.action === 'merge_ready') {
    log.info(
      {
        runId: record.runId,
        woId: record.woId,
        action: 'dry_run',
        class: record.errorClass ?? 'none',
        reason: record.reason,
        dryRun: true,
      },
      'overseer.decision_dry_run'
    );
    return;
  }

  if (record.action === 'merge_ready') {
    if (!mergeCoordinator) {
      await deps.insertOverseerAction({
        runId: record.runId,
        woId: record.woId,
        class: record.errorClass ?? 'tail_node_false_fail',
        action: 'merge_denied',
        result: 'qualified_merge_coordinator_missing',
      });
      log.info(
        { runId: record.runId, woId: record.woId, action: 'merge_denied' },
        'overseer.merge_ready_coordinator_missing'
      );
      return;
    }
    await mergeCoordinator(record);
    return;
  }

  if (!record.decision || !record.errorClass) {
    log.info(
      {
        runId: record.runId,
        woId: record.woId,
        action: 'skipped',
        class: 'none',
        reason: record.reason,
      },
      'overseer.decision_skipped'
    );
    return;
  }
  if (record.errorClass === 'tail_node_false_fail') {
    throw new Error('operator_card_non_actionable_error_class');
  }

  const escalation = await runAuthorizedEscalation(record.runId, {
    permit: permitFromMetadata(record.metadata),
    actor,
  });
  let operatorCardId: string | null = null;
  if (escalation.accepted) {
    if (!record.lastEvent?.id || !record.lastEvent.created_at) {
      throw new Error('operator_card_source_event_identity_missing');
    }
    const card = await runEscalation(
      record.runId,
      record.decision,
      {
        ...(record.decision.escalationContext ?? {}),
        errorClass: record.errorClass,
        woId: record.woId,
        repository: `${record.owner}/${record.repo}`,
        branch: record.headBranch ?? null,
        prUrl: record.prEvidence?.htmlUrl ?? null,
        prNumber: record.prEvidence?.pr?.number ?? null,
        checks: record.prEvidence?.checks ?? {},
        mergeability:
          record.prEvidence?.mergeable === null
            ? 'unknown'
            : String(record.prEvidence?.mergeable ?? 'unknown'),
      },
      {
        sourceEventId: record.lastEvent.id,
        eventType: record.lastEvent.event_type,
        stepName: record.lastEvent.step_name ?? 'unknown',
        eventCreatedAt: record.lastEvent.created_at,
      }
    );
    operatorCardId = card.card_id;
  }
  await deps.insertOverseerAction({
    runId: record.runId,
    woId: record.woId,
    class: record.errorClass,
    action: escalation.accepted ? 'fake_escalation_attempt' : 'escalation_denied',
    result: operatorCardId
      ? `${escalation.reason}:operator_card:${operatorCardId}`
      : escalation.reason,
  });
  log.info(
    {
      runId: record.runId,
      woId: record.woId,
      action: escalation.accepted ? 'fake_escalation_attempt' : 'escalation_denied',
      class: record.errorClass,
      reason: record.reason,
    },
    'overseer.escalation_completed'
  );
}

export async function runOverseerService(options: OverseerServiceOptions = {}): Promise<void> {
  const enabled = options.enabled ?? envEnabled(process.env.OVERSEER_ENABLED);
  if (!enabled) return;

  const dryRun = options.dryRun ?? envEnabled(process.env.OVERSEER_DRY_RUN);
  const adapterKind = options.adapterKind ?? resolveRequestedAdapterKind();
  if (adapterKind === 'none') {
    throw new Error('overseer_adapter_missing');
  }
  if (adapterKind === 'real' && (!options.deps || !options.mergeCoordinator)) {
    throw new Error('overseer_real_adapter_requires_qualified_coordinator');
  }
  const deps = options.deps ?? resolveDefaultDeps();
  const coupledAbort = new AbortController();
  const abortFromParent = (): void => {
    coupledAbort.abort();
  };
  options.signal?.addEventListener('abort', abortFromParent, { once: true });
  if (options.signal?.aborted) coupledAbort.abort();
  const watcher = watchLoop(
    deps,
    record => handleRecord(record, deps, dryRun, 'overseer-service', options.mergeCoordinator),
    {
      intervalMs: options.intervalMs,
      once: options.once,
      signal: coupledAbort.signal,
    }
  );
  const tasks: Promise<void>[] = [watcher];
  if (options.deliveryEnabled) {
    const delivery = runOperatorCardDeliveryScheduler({
      signal: coupledAbort.signal,
      intervalMs: options.deliveryIntervalMs,
      owner: options.deliveryOwner ?? `overseer-delivery-${process.pid}`,
      once: options.once,
      channels: options.deliveryChannels,
      drain: options.deliveryDrain,
    });
    tasks.push(delivery);
  }
  const reconcile = runReconcileScheduler({
    signal: coupledAbort.signal,
    intervalMs: options.reconcileIntervalMs,
    once: options.once,
    reconcile: options.reconcileRun,
  });
  tasks.push(reconcile);
  const abortOnFailure = async (task: Promise<void>): Promise<void> => {
    try {
      await task;
    } catch (error) {
      coupledAbort.abort();
      throw error;
    }
  };
  try {
    await Promise.all(tasks.map(task => abortOnFailure(task)));
  } finally {
    coupledAbort.abort();
    await Promise.allSettled(tasks);
    options.signal?.removeEventListener('abort', abortFromParent);
  }
}

/**
 * Resolve default deps based on the caller-requested adapterKind (or env if unset).
 * When fake mode is requested: wires stub findPullRequest/mergePullRequest so no live
 * Octokit is constructed and no real GitHub network call can be made.
 */
export function resolveDefaultDeps(
  realGitHubDepsFactory: () => GitHubClientDeps = createRealGitHubClientDeps
): OverseerRunStoreDeps & OverseerActionsDeps & GitHubClientDeps {
  const storeAndActions = {
    listRunsForWatch: listRunsForOverseerWatch,
    listRunEvents: listRunEventsForOverseer,
    insertOverseerAction: async (record: {
      runId: string;
      woId: string;
      class: string;
      action: string;
      result: string;
    }): Promise<void> => {
      await insertOverseerAction(record);
    },
  };

  const requestedAdapterKind = resolveRequestedAdapterKind();
  if (requestedAdapterKind === 'fake') {
    log.info('overseer_service.using_fake_github_adapter');
    const fakePr: PullRequestEvidence = {
      exists: false,
      state: 'missing',
      checks: { total: 0, passed: 0, failed: 0, pending: 0 },
      mergeable: null,
    };
    return {
      ...storeAndActions,
      findPullRequest: async (): Promise<PullRequestEvidence> => {
        log.info('overseer_service.fake_find_pull_request_noop');
        return fakePr;
      },
      mergePullRequest: async (): Promise<{ merged: boolean; message?: string }> => {
        throw new Error('overseer_slice1_direct_merge_unreachable');
      },
    };
  }

  return {
    ...storeAndActions,
    ...realGitHubDepsFactory(),
  };
}

function resolveRequestedAdapterKind(): OverseerWiredAdapterKind {
  return envEnabled(process.env.OVERSEER_USE_FAKE_GITHUB_ADAPTER) ? 'fake' : 'real';
}

if (import.meta.main) {
  runOverseerService({ once: process.argv.includes('--once') }).catch(err => {
    console.error('[overseer/service] fatal:', err);
    process.exitCode = 1;
  });
}
