import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SQLiteError } from 'bun:sqlite';
import type { IDatabase } from '@archon/core';
import {
  acquireWoClaim,
  findActiveWoClaim,
  type AcquireWoClaimResult,
} from '@archon/core/db/cascade-wo-claims';
import { serviceGitHubFetchWithPermissionFallback } from '@archon/core/github/request';
import { resolveServiceGitHubAuth } from '@archon/core/github/service-identity';
import { normalizeRepoSlug } from '@archon/workflows/reliability/run-branch-identity';
import { matchProjectCodebase } from '../dispatch/project-codebase-match';

export type FireAdmissionReason =
  | 'repo_wip_cap'
  | 'target_branch_held'
  | 'target_branch_open'
  | 'target_branch_unreclaimable'
  | 'repo_wip_unavailable'
  | 'repo_wip_changed'
  | 'repo_wip_invalid_cap';

export class FireAdmissionDeferred extends Error {
  constructor(
    readonly reason: FireAdmissionReason,
    readonly details: { repo?: string; branch?: string; active?: number; cap?: number } = {}
  ) {
    super(reason);
    this.name = 'FireAdmissionDeferred';
  }
}

export interface FireAdmissionTarget {
  repo: string;
  /** Reuse of an existing ref needs evidence; a fresh lane's run-scoped ref is allocated later. */
  branch?: string;
}

interface OpenPull {
  number: number;
  draft: boolean;
  branch: string;
  headRepo: string | undefined;
}

interface CodebaseRow {
  id: string;
  name: string;
  repository_url: string | null;
  default_cwd: string;
}

interface WorkRun {
  codebase_id: string | null;
  canonical_remote: string | null;
  head_branch: string | null;
  wo_id: string | null;
  user_message: string;
  is_active: boolean | 0 | 1;
}

type Query = IDatabase['query'];
type GitHubRead = (url: string, signal: AbortSignal) => Promise<Response>;
const git = promisify(execFile);

export function resolveRepoWipCap(value: string | undefined): number {
  if (value === undefined) return 2;
  const cap = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(cap) || cap < 1)
    throw new FireAdmissionDeferred('repo_wip_invalid_cap');
  return cap;
}

function codebaseRepo(row: CodebaseRow | undefined): string | undefined {
  return normalizeRepoSlug(row?.repository_url ?? row?.name);
}

async function releasedCount(query: Query): Promise<string> {
  const result = await query<{ count: number | string }>(
    "SELECT COUNT(*) AS count FROM cascade_wo_claims WHERE state = 'released'"
  );
  const count = result.rows[0]?.count;
  if (count === undefined) throw new Error('released_claim_count_missing');
  return String(count);
}

async function openPulls(repo: string, read: GitHubRead, signal: AbortSignal): Promise<OpenPull[]> {
  const seen = new Map<number, OpenPull>();
  for (let page = 1; page <= 100; page++) {
    const response = await read(
      `https://api.github.com/repos/${repo}/pulls?state=open&sort=created&direction=asc&per_page=100&page=${page}`,
      signal
    );
    if (!response.ok) throw new Error('open_pull_listing_failed');
    const rows: unknown = await response.json();
    if (!Array.isArray(rows) || rows.length > 100) throw new Error('open_pull_listing_invalid');
    for (const pull of rows) {
      const number: unknown = pull?.number;
      const draft: unknown = pull?.draft;
      const branch: unknown = pull?.head?.ref;
      const headRepo = normalizeRepoSlug(pull?.head?.repo?.full_name);
      if (
        typeof number !== 'number' ||
        !Number.isSafeInteger(number) ||
        number < 1 ||
        typeof draft !== 'boolean' ||
        typeof branch !== 'string' ||
        !branch ||
        pull?.state !== 'open' ||
        (pull?.head?.repo !== null && !headRepo) ||
        seen.has(number)
      )
        throw new Error('open_pull_listing_invalid_row');
      seen.set(number, { number, draft, branch, headRepo });
    }
    if (rows.length < 100 && !response.headers.get('link')?.includes('rel="next"'))
      return [...seen.values()];
  }
  throw new Error('open_pull_listing_incomplete');
}

async function verifyBranch(
  repo: string,
  branch: string,
  cwd: string,
  read: GitHubRead,
  signal: AbortSignal
): Promise<void> {
  const fullRef = `refs/heads/${branch}`;
  await git('git', ['check-ref-format', fullRef], { signal });
  const { stdout } = await git('git', ['-C', cwd, 'worktree', 'list', '--porcelain', '-z'], {
    signal,
  });
  if (stdout.split('\0').includes(`branch ${fullRef}`))
    throw new FireAdmissionDeferred('target_branch_held', { repo, branch });
  const local = await git('git', ['-C', cwd, 'for-each-ref', '--format=%(refname)', fullRef], {
    signal,
  });
  if (local.stdout.split(/\r?\n/).includes(fullRef))
    throw new FireAdmissionDeferred('target_branch_unreclaimable', { repo, branch });
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  const response = await read(
    `https://api.github.com/repos/${repo}/git/matching-refs/heads/${ref}`,
    signal
  );
  if (!response.ok || response.headers.get('link')?.includes('rel="next"'))
    throw new Error('target_ref_read_failed');
  const refs: unknown = await response.json();
  if (!Array.isArray(refs)) throw new Error('target_ref_read_invalid');
  for (const entry of refs as { ref?: unknown }[]) {
    const value = entry?.ref;
    if (typeof value !== 'string' || !value.startsWith(fullRef))
      throw new Error('target_ref_read_invalid');
    if (value === fullRef || value.startsWith(`${fullRef}/`))
      throw new FireAdmissionDeferred('target_branch_unreclaimable', { repo, branch });
  }
}

async function activeWork(
  query: Query,
  repo: string,
  codebases: readonly CodebaseRow[],
  pulls: OpenPull[],
  branch: string | undefined
): Promise<number> {
  const claims = await query<{
    wo_id: string;
    project: string;
    target_repo: string | null;
    target_branch: string | null;
  }>(
    "SELECT wo_id, project, target_repo, target_branch FROM cascade_wo_claims WHERE state = 'active'"
  );
  const claimedWork = new Set<string>();
  for (const claim of claims.rows) {
    const registered = matchProjectCodebase(codebases, claim.project);
    if (
      claim.target_repo
        ? claim.target_repo === repo
        : codebaseRepo(registered) === repo ||
          normalizeRepoSlug(registered?.name) === repo ||
          normalizeRepoSlug(claim.project) === repo ||
          claim.project.trim().toLowerCase() === repo.split('/')[1]
    ) {
      if (branch && claim.target_branch === branch)
        throw new FireAdmissionDeferred('target_branch_held', { repo, branch });
      claimedWork.add(`wo:${claim.wo_id}`);
    }
  }
  const runs = await query<WorkRun>(
    `WITH wo_runs AS (
       SELECT r.codebase_id, r.user_message, a.canonical_remote, a.head_branch, a.wo_id,
         r.status IN ('pending', 'running', 'waiting_provider', 'interrupted', 'orphaned', 'paused')
           AS is_active
       FROM remote_agent_workflow_runs r LEFT JOIN remote_agent_run_authorities a ON a.run_id = r.id
       WHERE a.wo_id IS NOT NULL OR r.user_message LIKE '%WO_ID=%'
     )
     SELECT * FROM wo_runs
     WHERE is_active OR wo_id IN (SELECT wo_id FROM cascade_wo_claims WHERE state = 'active')`
  );
  const activePrBranches = new Set(
    pulls.filter(pull => !pull.draft && pull.headRepo === repo).map(pull => pull.branch)
  );
  const occupied = new Set(claimedWork);
  const coveredWork = new Set<string>();
  for (const run of runs.rows) {
    const registered = codebases.find(row => row.id === run.codebase_id);
    const remote = normalizeRepoSlug(run.canonical_remote);
    if (
      remote
        ? remote !== repo
        : codebaseRepo(registered) !== repo && normalizeRepoSlug(registered?.name) !== repo
    )
      continue;
    if (run.is_active && branch && run.head_branch === branch)
      throw new FireAdmissionDeferred('target_branch_held', { repo, branch });
    const woId = run.wo_id ?? /(?:^|\s)WO_ID=(WO-[A-Z0-9-]+)(?=\s|$)/.exec(run.user_message)?.[1];
    if (!woId) continue;
    const key = `wo:${woId}`;
    // A terminal run can cover a PR for a claim retained in this repository.
    if (run.is_active) occupied.add(key);
    else if (!claimedWork.has(key)) continue;
    if (run.head_branch && !coveredWork.has(key) && activePrBranches.delete(run.head_branch))
      coveredWork.add(key);
  }
  return pulls.filter(pull => !pull.draft).length + occupied.size - coveredWork.size;
}

/** Serialize new claims across the two automated fire paths, even on different processes. */
export async function acquireAdmittedWoClaim(input: {
  db: IDatabase;
  env: Record<string, string | undefined>;
  target: FireAdmissionTarget;
  project: string;
  woId: string;
  cascadeId: string;
  holder: string;
  now: string;
  readGitHub?: GitHubRead;
}): Promise<AcquireWoClaimResult> {
  const cap = resolveRepoWipCap(input.env.CAULDRON_FIRE_REPO_WIP_CAP);
  const repo = normalizeRepoSlug(input.target.repo);
  const branch = input.target.branch;
  const { db } = input;
  const details = { repo, branch, cap };
  try {
    const current = await findActiveWoClaim(input.woId, db);
    if (current) return { acquired: current.cascade_id === input.cascadeId, claim: current };
    if (!repo?.includes('/')) throw new Error('fire_target_repo_invalid');
    const codebases = (
      await db.query<CodebaseRow>(
        'SELECT id, name, repository_url, default_cwd FROM remote_agent_codebases'
      )
    ).rows;
    const codebase = matchProjectCodebase(codebases, input.project);
    if (!codebase || (codebaseRepo(codebase) !== repo && normalizeRepoSlug(codebase.name) !== repo))
      throw new Error('fire_target_repo_unbound');
    const identity = resolveServiceGitHubAuth('taskmaster', input.env);
    const read: GitHubRead =
      input.readGitHub ??
      ((url, signal): Promise<Response> => {
        if (identity.kind === 'none') throw new Error('fire_github_auth_missing');
        return serviceGitHubFetchWithPermissionFallback({
          service: 'taskmaster',
          identity,
          url,
          init: { signal, redirect: 'error' },
        });
      });
    const releasedBefore = await releasedCount(db.query.bind(db));
    const admit = (): Promise<AcquireWoClaimResult> =>
      db.withTransaction(async query => {
        if (db.dialect === 'postgres')
          await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
            `cauldron-wip:${repo}`,
          ]);
        const existing = await findActiveWoClaim(input.woId, { query });
        if (existing) return { acquired: existing.cascade_id === input.cascadeId, claim: existing };
        const signal = AbortSignal.timeout(10_000);
        const pulls = await openPulls(repo, read, signal);
        if (branch) {
          if (pulls.some(pull => pull.headRepo === repo && pull.branch === branch))
            throw new FireAdmissionDeferred('target_branch_open', details);
          await verifyBranch(repo, branch, codebase.default_cwd, read, signal);
        }
        const active = await activeWork(query, repo, codebases, pulls, branch);
        if (releasedBefore !== (await releasedCount(query)))
          throw new FireAdmissionDeferred('repo_wip_changed', details);
        if (active >= cap) throw new FireAdmissionDeferred('repo_wip_cap', { ...details, active });
        return acquireWoClaim({ ...input, targetRepo: repo, targetBranch: branch }, { query });
      });
    try {
      return await admit();
    } catch (error) {
      // SQLite's first claim read pins a WAL snapshot without a write lock. If
      // another writer wins, SQLite rejects the upgrade. Retry once from a new
      // transaction so the claim check and GitHub evidence are both refreshed.
      if (
        db.dialect !== 'sqlite' ||
        !(error instanceof SQLiteError) ||
        !error.code?.startsWith('SQLITE_BUSY')
      )
        throw error;
      return await admit();
    }
  } catch (error) {
    if (error instanceof FireAdmissionDeferred) throw error;
    throw new FireAdmissionDeferred('repo_wip_unavailable', details);
  }
}
