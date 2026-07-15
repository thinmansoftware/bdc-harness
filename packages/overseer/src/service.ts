import { createLogger } from '@archon/paths';
import {
  insertOverseerAction,
  listRunEventsForOverseer,
  listRunsForOverseerWatch,
} from '@archon/core/db/overseer';
import {
  appendOverseerCapabilityEvent,
  listOverseerCapabilityEvents,
} from '@archon/core/db/overseer-capabilities';
import type { ErrorClass } from './classify.ts';
import { runAuthorizedEscalation } from './authorized-escalation';
import {
  createFakeGitHubAdapter,
  type FakeGitHubAdapter,
  type FakeGitHubMutationRequest,
} from './adapters/fake-github';
import { readOverseerActionPolicyFromEnv } from './action-policy';
import { permitFromMetadata } from './permit';
import { watchLoop } from './watch';
import type {
  GitHubClientDeps,
  OverseerActionsDeps,
  OverseerRunStoreDeps,
  PullRequestEvidence,
  WatchedRunRecord,
} from './types.ts';

const log = createLogger('overseer/service');

/**
 * Resolved adapter kind for the watcher. Distinct from env-intent: reflects the
 * adapter that was actually wired when the service started.
 */
export type OverseerWiredAdapterKind = 'fake' | 'real' | 'none';

export interface OverseerServiceOptions {
  once?: boolean;
  enabled?: boolean;
  dryRun?: boolean;
  mergeJudge?: 'off' | 'grok';
  intervalMs?: number;
  signal?: AbortSignal;
  /**
   * When set, the service uses this adapter kind instead of calling createDefaultDeps().
   * Allows the caller (overseer-runtime) to pass fake deps without duplicating logic.
   */
  adapterKind?: OverseerWiredAdapterKind;
  deps?: OverseerRunStoreDeps & OverseerActionsDeps & GitHubClientDeps;
  fakeGitHubAdapter?: FakeGitHubAdapter;
}

function envEnabled(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

async function handleRecord(
  record: WatchedRunRecord,
  deps: OverseerActionsDeps & GitHubClientDeps,
  adapter: FakeGitHubAdapter,
  dryRun: boolean,
  actor: string
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

  if (dryRun) {
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
    const permit = permitFromMetadata(record.metadata);
    const result = permit
      ? await adapter.attemptMutation(mutationRequestFromPermit(permit), {
          requested_capability: 'merge',
          permit,
          actor,
          correlation_id: record.runId,
        })
      : null;
    const action = result?.accepted ? 'fake_merge_attempt' : 'merge_denied';
    const reason = result?.reason ?? 'permit_missing';
    await deps.insertOverseerAction({
      runId: record.runId,
      woId: record.woId,
      class: record.errorClass ?? 'tail_node_false_fail',
      action,
      result: reason,
    });
    log.info(
      {
        runId: record.runId,
        woId: record.woId,
        action,
        class: record.errorClass ?? 'none',
        reason,
      },
      'overseer.merge_ready_handled'
    );
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

  const escalation = await runAuthorizedEscalation(
    record.runId,
    record.decision,
    {
      errorClass: record.errorClass as ErrorClass,
      nodeId: record.lastEvent?.step_name ?? undefined,
      woId: record.woId,
      validatorOutput:
        typeof record.lastEvent?.data.validatorOutput === 'string'
          ? record.lastEvent.data.validatorOutput
          : undefined,
      repo: record.repo,
      prEvidence: record.prEvidence,
    },
    { permit: permitFromMetadata(record.metadata), actor }
  );
  await deps.insertOverseerAction({
    runId: record.runId,
    woId: record.woId,
    class: record.errorClass,
    action: escalation.executed ? 'escalate' : 'escalation_denied',
    result: escalation.reason,
  });
  log.info(
    {
      runId: record.runId,
      woId: record.woId,
      action: escalation.executed ? 'escalate' : 'escalation_denied',
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
  if (adapterKind !== 'fake') {
    throw new Error(`overseer_slice1_real_adapter_forbidden:${adapterKind}`);
  }
  const deps = options.deps ?? resolveDefaultDeps();
  const adapter = options.fakeGitHubAdapter ?? createDefaultFakeGitHubAdapter();
  await watchLoop(deps, record => handleRecord(record, deps, adapter, dryRun, 'overseer-service'), {
    intervalMs: options.intervalMs,
    once: options.once,
    signal: options.signal,
  });
}

/**
 * Resolve default deps based on the caller-requested adapterKind (or env if unset).
 * When fake mode is requested: wires stub findPullRequest/mergePullRequest so no live
 * Octokit is constructed and no real GitHub network call can be made.
 */
function resolveDefaultDeps(): OverseerRunStoreDeps & OverseerActionsDeps & GitHubClientDeps {
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

function resolveRequestedAdapterKind(): OverseerWiredAdapterKind {
  return envEnabled(process.env.OVERSEER_USE_FAKE_GITHUB_ADAPTER) ? 'fake' : 'none';
}

function fixtureRepositories(): string[] {
  return (process.env.OVERSEER_FAKE_GITHUB_REPOSITORIES ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function createDefaultFakeGitHubAdapter(): FakeGitHubAdapter {
  const claimed = new Set<string>();
  return createFakeGitHubAdapter({
    allowed_repositories: fixtureRepositories(),
    authorization_deps: {
      getPolicy: async () => readOverseerActionPolicyFromEnv(),
    },
    consume_execution: async executionId => {
      if (claimed.has(executionId)) return false;
      const events = await listOverseerCapabilityEvents();
      if (
        events.some(
          event =>
            event.event_type === 'adapter_attempt' &&
            event.execution_id === executionId &&
            event.details.accepted === true
        )
      ) {
        return false;
      }
      claimed.add(executionId);
      return true;
    },
    record_attempt: appendOverseerCapabilityEvent,
  });
}

function mutationRequestFromPermit(permit: FakeGitHubMutationRequest): FakeGitHubMutationRequest {
  return {
    permit_id: permit.permit_id,
    repository: permit.repository,
    pr_number: permit.pr_number,
    head_sha: permit.head_sha,
    base_branch: permit.base_branch,
    base_sha: permit.base_sha,
    snapshot_id: permit.snapshot_id,
    proposal_id: permit.proposal_id,
    execution_id: permit.execution_id,
    action_kind: permit.action_kind,
  };
}

if (import.meta.main) {
  runOverseerService({ once: process.argv.includes('--once') }).catch(err => {
    console.error('[overseer/service] fatal:', err);
    process.exitCode = 1;
  });
}
