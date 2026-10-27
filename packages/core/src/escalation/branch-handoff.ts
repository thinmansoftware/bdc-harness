/**
 * Escalation branch handoff (WO-HARNESS-ESCALATION-BRANCH-HANDOFF-01).
 *
 * Detach terminal predecessor repair branches so the next tier can check
 * them out, and carry only the push head that predecessor run recorded
 * against its own run id, repository, and branch. Remote observations and
 * reflogs never authorize a head. Directories are never deleted.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { extractWoId, type EscalationLinkerStore } from './escalation-linker';

export type { EscalationLinkerStore };

const SHA_RE = /^[0-9a-f]{40}$/;

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(['running', 'pending', 'paused']);

const TERMINAL_HANDOFF_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'escalated',
  'cancelled',
]);

export const REPAIR_HEAD_RULE =
  'Repair-head rule: accept the live remote head only when it equals the pinned head or the pushed_head of an ESCALATION_HANDOFF line whose run, repository, and branch match that predecessor evidence; otherwise fail closed with unexplained_head_change. remote_head never authorizes a head.';

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Replaceable Git invocation. Arguments are passed to `git` without a shell. */
export type GitRunner = (args: readonly string[]) => Promise<GitRunResult>;

export interface ListPredecessorRunsOptions {
  excludeRunId?: string;
}

export interface HandoffRecord {
  runId: string;
  repository: string;
  branch: string;
  localHead: string;
  evidenceRunId: string | null;
  pushedHead: string | null;
  remoteHead: string | null;
}

export type BranchHandoffSkipReason =
  | 'run_active'
  | 'not_terminal'
  | 'path_missing'
  | 'not_a_worktree'
  | 'git_failed'
  | 'already_detached'
  | 'engine_branch'
  | 'branch_out_of_scope';

export interface SkippedBranchHandoff {
  runId: string;
  reason: BranchHandoffSkipReason;
}

export interface ReleaseBranchHoldsResult {
  records: HandoffRecord[];
  skipped: SkippedBranchHandoff[];
}

export interface ReleaseBranchHoldsOptions {
  gitRunner?: GitRunner;
}

export interface PushEvidence {
  runId: string;
  repository: string;
  branch: string;
  pushedHead: string;
  recordedAt: string;
}

export interface RecordPushEvidenceInput {
  runId: string;
  repository: string;
  branch: string;
  pushedHead: string;
  cwd?: string;
  now?: Date;
  gitRunner?: GitRunner;
}

export type HandoffHeadDecision =
  | 'live_matches_pin'
  | 'live_matches_handoff'
  | 'unexplained_head_change';

export interface HandoffHeadPreconditionInput {
  pinnedHead: string | null;
  liveHead: string | null;
  expectedRepository: string;
  expectedBranch: string;
  records: HandoffRecord[];
}

export interface HandoffHeadPreconditionResult {
  ok: boolean;
  reason: HandoffHeadDecision;
  pinnedHead: string | null;
  liveHead: string | null;
  records: HandoffRecord[];
}

interface BoundPushHead {
  pushedHead: string | null;
  evidenceRunId: string | null;
}

function isFullSha(value: string | null | undefined): value is string {
  return typeof value === 'string' && SHA_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripTrailingSlashAndGit(value: string): string {
  let out = value;
  while (out.endsWith('/')) {
    out = out.slice(0, -1);
  }
  if (out.length >= 4 && out.slice(-4).toLowerCase() === '.git') {
    out = out.slice(0, -4);
  }
  while (out.endsWith('/')) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Normalize a Git origin to a stable identity.
 * SSH and HTTPS forms become `https://host/owner/repo` with userinfo removed.
 * Local paths, including bare repos, become an absolute path without a
 * trailing slash or `.git` suffix. Case of local paths is preserved.
 */
export function normalizeOriginUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.includes('://')) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    const protocol = url.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'ssh:') {
      const host = url.hostname.toLowerCase();
      const path = stripTrailingSlashAndGit(url.pathname.toLowerCase()).replace(/^\/+/, '');
      if (host.length === 0 || path.length === 0) return null;
      return `https://${host}/${path}`;
    }
    if (protocol === 'file:') {
      let pathname = url.pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return null;
      }
      const local = stripTrailingSlashAndGit(resolve(pathname));
      if (local.length === 0 || local === '/') return null;
      return local;
    }
    return null;
  }

  const scp = /^([^@\s/]+)@([^:\s/]+):(.+)$/.exec(trimmed);
  if (scp) {
    const host = (scp[2] ?? '').toLowerCase();
    const path = stripTrailingSlashAndGit((scp[3] ?? '').replace(/^\/+/, '')).toLowerCase();
    if (host.length === 0 || path.length === 0) return null;
    return `https://${host}/${path}`;
  }

  const local = stripTrailingSlashAndGit(resolve(trimmed));
  if (local.length === 0 || local === '/') return null;
  return local;
}

function defaultGitRunner(args: readonly string[]): Promise<GitRunResult> {
  return new Promise((resolveResult): void => {
    execFile(
      'git',
      [...args],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 20_000 },
      (error, stdout, stderr): void => {
        const out = typeof stdout === 'string' ? stdout : '';
        const errText = typeof stderr === 'string' ? stderr : '';
        if (error) {
          const exitCode =
            typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : 1;
          resolveResult({
            stdout: out,
            stderr: errText.length > 0 ? errText : error.message,
            code: exitCode,
          });
          return;
        }
        resolveResult({ stdout: out, stderr: errText, code: 0 });
      }
    );
  });
}

async function runGit(
  runner: GitRunner,
  workingPath: string,
  args: readonly string[]
): Promise<GitRunResult> {
  try {
    const result = await runner(['-C', workingPath, ...args]);
    return {
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      code: typeof result.code === 'number' ? result.code : 1,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'git command failed';
    return { stdout: '', stderr: message, code: 1 };
  }
}

function skip(
  skipped: SkippedBranchHandoff[],
  runId: string,
  reason: BranchHandoffSkipReason
): void {
  skipped.push({ runId, reason });
}

function classifyBranch(branch: string): BranchHandoffSkipReason | null {
  if (branch === 'HEAD') return 'already_detached';
  if (branch.startsWith('archon/')) return 'engine_branch';
  if (branch.startsWith('feat/') || branch.startsWith('fix/') || branch.startsWith('wip/')) {
    return null;
  }
  return 'branch_out_of_scope';
}

/**
 * Same-WO terminal predecessors. Does not query when the message has no WO id,
 * and does not admit completed or active rows even if a store returns them.
 */
export async function listPredecessorRuns(
  userMessage: string | null | undefined,
  store: EscalationLinkerStore,
  options?: ListPredecessorRunsOptions
): Promise<WorkflowRun[]> {
  const woId = extractWoId(userMessage);
  if (woId === null) return [];

  const runs = await store.listWorkflowRuns({
    status: ['failed', 'escalated', 'cancelled'],
    limit: 200,
    includeArchived: true,
  });

  const excludeRunId = options?.excludeRunId;
  const matched: WorkflowRun[] = [];
  for (const run of runs) {
    if (!run || !TERMINAL_HANDOFF_STATUSES.has(run.status)) continue;
    if (excludeRunId !== undefined && run.id === excludeRunId) continue;
    if (extractWoId(run.user_message) === woId) matched.push(run);
  }
  return matched;
}

/**
 * pushedHead comes only from this run's own metadata.push_evidence, and only
 * when that evidence is bound to the same run, repository, and branch.
 * remoteHead is never copied into pushedHead.
 */
function boundPushedHead(run: WorkflowRun, repository: string, branch: string): BoundPushHead {
  const none: BoundPushHead = { pushedHead: null, evidenceRunId: null };
  if (!isRecord(run.metadata)) return none;
  const raw: unknown = run.metadata.push_evidence;
  if (!isRecord(raw)) return none;

  const evidenceRunId = typeof raw.runId === 'string' ? raw.runId : null;
  const evidenceRepository =
    typeof raw.repository === 'string' ? normalizeOriginUrl(raw.repository) : null;
  const evidenceBranch = typeof raw.branch === 'string' ? raw.branch : null;
  const evidenceHead = typeof raw.pushedHead === 'string' ? raw.pushedHead : null;

  if (
    evidenceRunId === run.id &&
    evidenceRepository !== null &&
    evidenceRepository === repository &&
    evidenceBranch === branch &&
    isFullSha(evidenceHead)
  ) {
    return { pushedHead: evidenceHead, evidenceRunId };
  }
  return none;
}

function firstRemoteSha(stdout: string): string | null {
  const field = stdout.trim().split(/\s+/)[0] ?? '';
  return isFullSha(field) ? field : null;
}

/**
 * Detach eligible terminal repair branches. Never throws. Never deletes a
 * worktree directory or file, and never reads a reflog.
 */
export async function releasePredecessorBranchHolds(
  runs: readonly WorkflowRun[],
  options?: ReleaseBranchHoldsOptions
): Promise<ReleaseBranchHoldsResult> {
  const runner = options?.gitRunner ?? defaultGitRunner;
  const records: HandoffRecord[] = [];
  const skipped: SkippedBranchHandoff[] = [];

  for (const run of runs) {
    const runId = run && typeof run.id === 'string' ? run.id : 'unknown';
    try {
      if (!run || typeof run.status !== 'string') {
        skip(skipped, runId, 'not_terminal');
        continue;
      }
      if (ACTIVE_RUN_STATUSES.has(run.status)) {
        skip(skipped, run.id, 'run_active');
        continue;
      }
      if (!TERMINAL_HANDOFF_STATUSES.has(run.status)) {
        skip(skipped, run.id, 'not_terminal');
        continue;
      }

      const workingPath = run.working_path;
      if (typeof workingPath !== 'string' || workingPath.trim().length === 0) {
        skip(skipped, run.id, 'path_missing');
        continue;
      }
      let pathExists = false;
      try {
        pathExists = existsSync(workingPath);
      } catch {
        pathExists = false;
      }
      if (!pathExists) {
        skip(skipped, run.id, 'path_missing');
        continue;
      }

      const inside = await runGit(runner, workingPath, ['rev-parse', '--is-inside-work-tree']);
      if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
        skip(skipped, run.id, 'not_a_worktree');
        continue;
      }

      const nameResult = await runGit(runner, workingPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (nameResult.code !== 0) {
        skip(skipped, run.id, 'git_failed');
        continue;
      }
      const branch = nameResult.stdout.trim();
      if (branch.length === 0) {
        skip(skipped, run.id, 'git_failed');
        continue;
      }
      const branchSkip = classifyBranch(branch);
      if (branchSkip !== null) {
        skip(skipped, run.id, branchSkip);
        continue;
      }

      const headResult = await runGit(runner, workingPath, ['rev-parse', 'HEAD']);
      if (headResult.code !== 0) {
        skip(skipped, run.id, 'git_failed');
        continue;
      }
      const localHead = headResult.stdout.trim();
      if (!isFullSha(localHead)) {
        skip(skipped, run.id, 'git_failed');
        continue;
      }

      const originResult = await runGit(runner, workingPath, ['remote', 'get-url', 'origin']);
      if (originResult.code !== 0) {
        skip(skipped, run.id, 'git_failed');
        continue;
      }
      const repository = normalizeOriginUrl(originResult.stdout.trim());
      if (repository === null) {
        skip(skipped, run.id, 'git_failed');
        continue;
      }

      // ls-remote is an observation only. Failure leaves remoteHead null and
      // does not block detachment. It is never a source of pushedHead.
      let remoteHead: string | null = null;
      const remoteResult = await runGit(runner, workingPath, [
        'ls-remote',
        'origin',
        `refs/heads/${branch}`,
      ]);
      if (remoteResult.code === 0) {
        remoteHead = firstRemoteSha(remoteResult.stdout);
      }

      const bound = boundPushedHead(run, repository, branch);
      const detachResult = await runGit(runner, workingPath, ['checkout', '--detach']);
      if (detachResult.code !== 0) {
        skip(skipped, run.id, 'git_failed');
        continue;
      }

      records.push({
        runId: run.id,
        repository,
        branch,
        localHead,
        evidenceRunId: bound.evidenceRunId,
        pushedHead: bound.pushedHead,
        remoteHead,
      });
    } catch {
      skip(skipped, runId, 'git_failed');
    }
  }

  return { records, skipped };
}

export function formatHandoffLines(records: readonly HandoffRecord[]): string {
  if (records.length === 0) return '';
  const lines = records.map((record): string => {
    const pushed = record.pushedHead ?? 'none';
    const evidence = record.evidenceRunId ?? 'none';
    const remote = record.remoteHead ?? 'none';
    return `ESCALATION_HANDOFF run=${record.runId} repository=${record.repository} branch=${record.branch} pushed_head=${pushed} evidence_run=${evidence} local_head=${record.localHead} remote_head=${remote}`;
  });
  return `${lines.join('\n')}\n${REPAIR_HEAD_RULE}`;
}

/**
 * Record this run's push head into its own metadata. The caller supplies the
 * sha it just pushed; the sha is stored only when it matches `git rev-parse HEAD`.
 * The metadata patch is only the push_evidence object so a shallow JSON merge
 * keeps sibling keys.
 */
export async function recordPushEvidence(
  store: EscalationLinkerStore,
  input: RecordPushEvidenceInput
): Promise<PushEvidence> {
  if (!isFullSha(input.pushedHead)) {
    throw new Error('push_evidence_rejected: pushedHead is not 40 lowercase hex characters');
  }
  const repository = normalizeOriginUrl(input.repository);
  if (repository === null) {
    throw new Error('push_evidence_rejected: repository cannot be normalized');
  }
  const branch = input.branch.trim();
  if (branch.length === 0) {
    throw new Error('push_evidence_rejected: branch is empty');
  }

  const cwd = input.cwd ?? process.cwd();
  const runner = input.gitRunner ?? defaultGitRunner;
  const headResult = await runGit(runner, cwd, ['rev-parse', 'HEAD']);
  const head = headResult.code === 0 ? headResult.stdout.trim() : '';
  if (head !== input.pushedHead) {
    throw new Error('push_evidence_rejected: pushedHead differs from git rev-parse HEAD');
  }

  const evidence: PushEvidence = {
    runId: input.runId,
    repository,
    branch,
    pushedHead: input.pushedHead,
    recordedAt: (input.now ?? new Date()).toISOString(),
  };
  await store.updateWorkflowRun(input.runId, {
    metadata: { push_evidence: evidence },
  });
  return evidence;
}

/**
 * Accept the live head when it equals the pin, or when it equals a handoff
 * record's own bound pushedHead. remoteHead, short shas, and evidence bound
 * to another run, repository, or branch fail closed.
 */
export function evaluateHandoffHeadPrecondition(
  input: HandoffHeadPreconditionInput
): HandoffHeadPreconditionResult {
  const pinnedHead = input.pinnedHead;
  const liveHead = input.liveHead;
  const records = input.records;
  const base = { pinnedHead, liveHead, records };

  if (isFullSha(pinnedHead) && isFullSha(liveHead) && pinnedHead === liveHead) {
    return { ok: true, reason: 'live_matches_pin', ...base };
  }

  const expectedRepository = normalizeOriginUrl(input.expectedRepository);
  if (isFullSha(liveHead) && expectedRepository !== null) {
    for (const record of records) {
      const recordRepository = normalizeOriginUrl(record.repository);
      if (
        record.pushedHead === liveHead &&
        isFullSha(record.pushedHead) &&
        record.evidenceRunId !== null &&
        record.evidenceRunId === record.runId &&
        recordRepository !== null &&
        recordRepository === expectedRepository &&
        record.branch === input.expectedBranch
      ) {
        return { ok: true, reason: 'live_matches_handoff', ...base };
      }
    }
  }

  return { ok: false, reason: 'unexplained_head_change', ...base };
}
