import { Octokit } from '@octokit/rest';
import { createLogger } from '@archon/paths';
import {
  insertOverseerAction,
  listRunEventsForOverseer,
  listRunsForOverseerWatch,
} from '@archon/core/db/overseer';
import type { ErrorClass } from './classify.ts';
import { runEscalation } from './escalate';
import { handleMergeReady } from './actions/merge-ready';
import { judgeWithGrok } from './judge-second-opinion';
import { watchLoop } from './watch';
import type {
  GitHubClientDeps,
  GrokJudgeDeps,
  OverseerActionsDeps,
  OverseerRunStoreDeps,
  PullRequestEvidence,
  WatchedRunRecord,
} from './types.ts';

const log = createLogger('overseer/service');

export interface OverseerServiceOptions {
  once?: boolean;
  enabled?: boolean;
  dryRun?: boolean;
  mergeJudge?: 'off' | 'grok';
  intervalMs?: number;
  deps?: OverseerRunStoreDeps & OverseerActionsDeps & GitHubClientDeps & Partial<GrokJudgeDeps>;
}

function envEnabled(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function envMergeJudge(value: string | undefined): 'off' | 'grok' {
  return value === 'grok' ? 'grok' : 'off';
}

async function handleRecord(
  record: WatchedRunRecord,
  deps: OverseerActionsDeps & GitHubClientDeps & Partial<GrokJudgeDeps>,
  dryRun: boolean,
  mergeJudge: 'off' | 'grok'
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
    const result = await handleMergeReady(record, deps, { mergeJudge });
    log.info(
      {
        runId: record.runId,
        woId: record.woId,
        action: result.action,
        class: record.errorClass ?? 'none',
        reason: record.reason,
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

  await runEscalation(record.runId, record.decision, {
    errorClass: record.errorClass as ErrorClass,
    nodeId: record.lastEvent?.step_name ?? undefined,
    woId: record.woId,
    validatorOutput:
      typeof record.lastEvent?.data.validatorOutput === 'string'
        ? record.lastEvent.data.validatorOutput
        : undefined,
    repo: record.repo,
    prEvidence: record.prEvidence,
  });
  await deps.insertOverseerAction({
    runId: record.runId,
    woId: record.woId,
    class: record.errorClass,
    action: 'escalate',
    result: record.reason,
  });
  log.info(
    {
      runId: record.runId,
      woId: record.woId,
      action: 'escalate',
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
  const mergeJudge = options.mergeJudge ?? envMergeJudge(process.env.OVERSEER_MERGE_JUDGE);
  const deps = options.deps ?? createDefaultDeps();
  await watchLoop(deps, record => handleRecord(record, deps, dryRun, mergeJudge), {
    intervalMs: options.intervalMs,
    once: options.once,
  });
}

function createDefaultDeps(): OverseerRunStoreDeps &
  OverseerActionsDeps &
  GitHubClientDeps &
  Partial<GrokJudgeDeps> {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const octokit = new Octokit(token ? { auth: token } : {});
  return {
    listRunsForWatch: listRunsForOverseerWatch,
    listRunEvents: listRunEventsForOverseer,
    insertOverseerAction: async (record): Promise<void> => {
      await insertOverseerAction(record);
    },
    findPullRequest: input => findPullRequest(octokit, input),
    mergePullRequest: async (input): Promise<{ merged: boolean; message?: string }> => {
      const response = await octokit.pulls.merge({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.number,
        commit_title: input.commitTitle,
      });
      return {
        merged: response.data.merged,
        message: response.data.message,
      };
    },
    judgeSecondOpinion: judgeWithGrok,
  };
}

async function findPullRequest(
  octokit: Octokit,
  input: { owner: string; repo: string; headBranch?: string; woId?: string }
): Promise<PullRequestEvidence> {
  const candidates = await octokit.pulls.list({
    owner: input.owner,
    repo: input.repo,
    state: 'all',
    per_page: 30,
    head: input.headBranch ? `${input.owner}:${input.headBranch}` : undefined,
  });
  const pr =
    candidates.data.find(candidate => {
      if (input.headBranch && candidate.head.ref === input.headBranch) return true;
      return Boolean(
        input.woId &&
        (candidate.title.includes(input.woId) || candidate.head.ref.includes(input.woId))
      );
    }) ?? null;

  if (!pr) {
    return {
      exists: false,
      state: 'missing',
      checks: { total: 0, passed: 0, failed: 0, pending: 0 },
      mergeable: null,
    };
  }

  const details = await octokit.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: pr.number,
  });
  const checks = await octokit.checks.listForRef({
    owner: input.owner,
    repo: input.repo,
    ref: pr.head.sha,
  });
  const runs = checks.data.check_runs;
  const failed = runs.filter(run =>
    ['failure', 'cancelled', 'timed_out', 'action_required'].includes(String(run.conclusion))
  ).length;
  const passed = runs.filter(
    run =>
      run.conclusion === 'success' || run.conclusion === 'neutral' || run.conclusion === 'skipped'
  ).length;
  const pending = runs.length - failed - passed;
  return {
    exists: true,
    state: details.data.merged ? 'merged' : details.data.state,
    checks: { total: runs.length, passed, failed, pending },
    mergeable: details.data.mergeable,
    pr: { owner: input.owner, repo: input.repo, number: pr.number },
    prTitle: details.data.title,
    filesChangedCount: details.data.changed_files,
    diffStat: `+${details.data.additions} -${details.data.deletions}`,
    htmlUrl: pr.html_url,
  };
}

if (import.meta.main) {
  runOverseerService({ once: process.argv.includes('--once') }).catch(err => {
    console.error('[overseer/service] fatal:', err);
    process.exitCode = 1;
  });
}
