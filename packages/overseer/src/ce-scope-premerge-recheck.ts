import { getDatabase } from '@archon/core/db/connection';
import { getScopeApprovalDecision } from '@archon/core/db/board-scope-approvals';

const GATE_PATH = '.github/workflows/ce-change-scope-gate.yml';
const GATE_NAME = 'CE Change Scope Gate';

export type CeScopeRefusalReason =
  | 'pr_not_open'
  | 'head_moved'
  | 'base_moved'
  | 'compare_failed'
  | 'compare_truncated'
  | 'approval_missing'
  | 'pr_mismatch'
  | 'revoked'
  | 'approval_malformed'
  | 'approval_error'
  | 'duplicate_gate_check'
  | 'wrong_gate_event'
  | 'gate_not_green'
  | 'revoked_after_green';
export type CeScopeRecheckResult = { ok: true } | { ok: false; reason: CeScopeRefusalReason };

export interface CeScopeGitHub {
  getPull(
    repo: string,
    pr: number
  ): Promise<{ state: string; head: { sha: string; ref: string }; base: { ref: string } }>;
  getBranchTip(repo: string, branch: string): Promise<string>;
  compare(
    repo: string,
    base: string,
    head: string,
    page: number
  ): Promise<{
    files: readonly { filename: string; status: string }[];
    truncated?: boolean;
    hasNext?: boolean;
  }>;
  listWorkflowRuns(
    repo: string,
    head: string,
    event: 'pull_request_target' | 'pull_request',
    page: number
  ): Promise<{
    runs: readonly {
      id: number;
      check_suite_id: number;
      path: string;
      event: string;
      head_branch: string;
      run_started_at: string;
      run_attempt: number;
      conclusion: string | null;
    }[];
    hasNext?: boolean;
  }>;
  listCheckRuns(
    repo: string,
    head: string,
    page: number
  ): Promise<{
    checks: readonly { name: string; conclusion: string | null; check_suite: { id: number } }[];
    hasNext?: boolean;
  }>;
}

export interface CeScopePremergeInput {
  repo: string;
  pr_number: number;
  expected_head_sha?: string;
}
export interface CeScopePremergeDeps {
  github?: CeScopeGitHub;
  decision?: typeof getScopeApprovalDecision;
  newestRevocation?: (repo: string, pr: number) => Promise<string | null>;
}

async function request(path: string) {
  const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (!token) throw new Error('github_credential_unavailable');
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) throw new Error(`github_${response.status}`);
  return response.json() as Promise<any>;
}

const defaultGitHub: CeScopeGitHub = {
  getPull: (repo, pr) => request(`repos/${repo}/pulls/${pr}`),
  getBranchTip: async (repo, branch) =>
    (await request(`repos/${repo}/branches/${encodeURIComponent(branch)}`)).commit.sha,
  compare: async (repo, base, head, page) => {
    const data = await request(`repos/${repo}/compare/${base}...${head}?per_page=100&page=${page}`);
    return {
      files: data.files ?? [],
      // GitHub caps the compare response's files array at 300. It is not a
      // pageable file collection (pagination applies to commits), so reaching
      // the cap can never be treated as a complete scope calculation.
      truncated: (data.files?.length ?? 0) >= 300,
      hasNext: false,
    };
  },
  listWorkflowRuns: async (repo, head, event, page) => {
    const data = await request(
      `repos/${repo}/actions/runs?head_sha=${head}&event=${event}&per_page=100&page=${page}`
    );
    return { runs: data.workflow_runs ?? [], hasNext: (data.workflow_runs?.length ?? 0) === 100 };
  },
  listCheckRuns: async (repo, head, page) => {
    const data = await request(
      `repos/${repo}/commits/${head}/check-runs?check_name=${encodeURIComponent(GATE_NAME)}&filter=all&per_page=100&page=${page}`
    );
    return { checks: data.check_runs ?? [], hasNext: (data.check_runs?.length ?? 0) === 100 };
  },
};

async function newestRevocation(repo: string, pr: number): Promise<string | null> {
  const db = getDatabase();
  const detailsText = db.dialect === 'sqlite' ? 'details' : 'details::text';
  const row = (
    await db.query<{ created_at: string }>(
      `SELECT created_at FROM board_audit_events WHERE event_type='ce_scope_approval_revoked'
     AND ${detailsText} LIKE $1 ORDER BY created_at DESC LIMIT 1`,
      [`%"repo":"${repo}"%"pr_number":${pr}%`]
    )
  ).rows[0];
  return row?.created_at ?? null;
}

export async function recheckCeScopeBeforeMerge(
  input: CeScopePremergeInput,
  deps: CeScopePremergeDeps = {}
): Promise<CeScopeRecheckResult> {
  const gh = deps.github ?? defaultGitHub;
  let pr: Awaited<ReturnType<CeScopeGitHub['getPull']>>;
  let base: string;
  try {
    pr = await gh.getPull(input.repo, input.pr_number);
    if (pr.state !== 'open' || pr.base.ref !== 'release/ce')
      return { ok: false, reason: 'pr_not_open' };
    if (input.expected_head_sha && pr.head.sha !== input.expected_head_sha)
      return { ok: false, reason: 'head_moved' };
    base = await gh.getBranchTip(input.repo, 'release/ce');
  } catch {
    return { ok: false, reason: 'compare_failed' };
  }

  const files: { filename: string; status: string }[] = [];
  try {
    for (let page = 1; page <= 100; page++) {
      const result = await gh.compare(input.repo, base, pr.head.sha, page);
      if (result.truncated) return { ok: false, reason: 'compare_truncated' };
      files.push(...result.files);
      if (!result.hasNext) break;
      if (page === 100) return { ok: false, reason: 'compare_truncated' };
    }
  } catch {
    return { ok: false, reason: 'compare_failed' };
  }
  const ceFiles = files.filter(file => file.filename.startsWith('src/components/ce/'));
  const wide =
    ceFiles.length > 10 ||
    files.some(
      file =>
        file.status === 'removed' &&
        (file.filename.startsWith('src/components/ce/') ||
          file.filename.startsWith('tests/ce-regression/'))
    );
  if (wide) {
    try {
      const decision = await (deps.decision ?? getScopeApprovalDecision)({
        repo: input.repo,
        pr_number: input.pr_number,
        head_sha: pr.head.sha,
        base_sha: base,
      });
      if (decision.decision === 'deny') {
        if (decision.reason === 'revoked') return { ok: false, reason: 'revoked' };
        if (decision.reason === 'malformed' || decision.reason === 'empty_conditions')
          return { ok: false, reason: 'approval_malformed' };
        return { ok: false, reason: decision.other_base ? 'base_moved' : 'approval_missing' };
      }
      const a = decision.approval;
      if (a.repo !== input.repo || a.pr_number !== input.pr_number || a.head_sha !== pr.head.sha)
        return { ok: false, reason: 'pr_mismatch' };
      if (a.base_sha !== base) return { ok: false, reason: 'base_moved' };
      if (
        a.target_branch !== 'release/ce'
      )
        return { ok: false, reason: 'approval_malformed' };
    } catch {
      return { ok: false, reason: 'approval_error' };
    }
  }

  const targetRuns: any[] = [];
  const legacyRuns: any[] = [];
  try {
    for (const event of ['pull_request_target', 'pull_request'] as const) {
      for (let page = 1; page <= 100; page++) {
        const result = await gh.listWorkflowRuns(input.repo, pr.head.sha, event, page);
        const selected = result.runs.filter(
          run =>
            run.path === GATE_PATH &&
            run.event === event &&
            run.head_branch === pr.head.ref
        );
        (event === 'pull_request_target' ? targetRuns : legacyRuns).push(...selected);
        if (!result.hasNext) break;
      }
    }
  } catch {
    return { ok: false, reason: 'gate_not_green' };
  }
  if (!targetRuns.length)
    return { ok: false, reason: legacyRuns.length ? 'wrong_gate_event' : 'gate_not_green' };
  // The API may return multiple attempts for one run. Only that run's latest
  // attempt is authoritative; an earlier green attempt must not bridge a red
  // rerun of the same workflow run.
  const latestTargetAttempts = [...targetRuns.reduce((byId, run) => {
    const prior = byId.get(run.id);
    if (!prior || run.run_attempt > prior.run_attempt) byId.set(run.id, run);
    return byId;
  }, new Map<number, (typeof targetRuns)[number]>()).values()];
  latestTargetAttempts.sort(
    (a, b) => b.run_started_at.localeCompare(a.run_started_at) || b.run_attempt - a.run_attempt
  );
  const selected = latestTargetAttempts[0];
  if (selected.conclusion !== 'success') return { ok: false, reason: 'gate_not_green' };
  const allowedSuites = new Set<number>([
    ...targetRuns.map(run => run.check_suite_id),
    ...legacyRuns.map(run => run.check_suite_id),
  ]);
  try {
    for (let page = 1; page <= 100; page++) {
      const result = await gh.listCheckRuns(input.repo, pr.head.sha, page);
      if (
        result.checks.some(
          check => check.name === GATE_NAME && !allowedSuites.has(check.check_suite.id)
        )
      )
        return { ok: false, reason: 'duplicate_gate_check' };
      if (!result.hasNext) break;
    }
  } catch {
    return { ok: false, reason: 'duplicate_gate_check' };
  }
  const revokedAt = await (deps.newestRevocation ?? newestRevocation)(input.repo, input.pr_number);
  if (revokedAt && revokedAt >= selected.run_started_at)
    return { ok: false, reason: 'revoked_after_green' };
  return { ok: true };
}
