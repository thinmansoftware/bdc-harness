export const CE_GATE_PATH = '.github/workflows/ce-change-scope-gate.yml';
export const CE_GATE_NAME = 'CE Change Scope Gate';

export interface CePullRequest {
  state: string;
  number: number;
  head: { sha: string; ref: string };
  base: { ref: string };
}
export interface CeWorkflowRun {
  id: number;
  path: string;
  event: string;
  head_sha: string;
  head_branch: string;
  run_started_at: string;
  run_attempt: number;
  conclusion: string | null;
  check_suite_id: number;
}
export interface CeCheckRun {
  name: string;
  conclusion: string | null;
  check_suite: { id: number };
}
export interface CeScopeRecheckDeps {
  getPullRequest(owner: string, repo: string, number: number): Promise<CePullRequest>;
  getBranchTip(owner: string, repo: string, branch: string): Promise<string>;
  compare(
    owner: string,
    repo: string,
    base: string,
    head: string
  ): Promise<{
    files?: readonly { filename: string; status: string }[];
    complete?: boolean;
  }>;
  listWorkflowRuns(owner: string, repo: string, head: string): Promise<readonly CeWorkflowRun[]>;
  listCheckRuns(owner: string, repo: string, head: string): Promise<readonly CeCheckRun[]>;
  getApproval(input: {
    repo: string;
    pr_number: number;
    head_sha: string;
    base_sha: string;
  }): Promise<
    | {
        decision: 'allow';
        approval: {
          repo: string;
          pr_number: number;
          head_sha: string;
          base_sha: string;
          target_branch: string;
        };
      }
    | { decision: 'deny'; reason: string }
  >;
  getMetadata(input: { repo: string; pr_number: number; head_sha: string }): Promise<{
    hasOtherBase: boolean;
    newestRevokedAt: string | null;
  }>;
}

export type CeScopeRecheckResult = { ok: true } | { ok: false; reason: string };

export async function ceScopePremergeRecheck(input: {
  owner: string;
  repo: string;
  prNumber: number;
  deps: CeScopeRecheckDeps;
}): Promise<CeScopeRecheckResult> {
  if (`${input.owner}/${input.repo}`.toLowerCase() !== 'thinmansoftware/lspro-react')
    return { ok: true };
  try {
    const pr = await input.deps.getPullRequest(input.owner, input.repo, input.prNumber);
    if (pr.state !== 'open') return { ok: false, reason: 'pr_not_open' };
    if (pr.base.ref !== 'release/ce') return { ok: true };
    const base = await input.deps.getBranchTip(input.owner, input.repo, 'release/ce');
    let comparison;
    try {
      comparison = await input.deps.compare(input.owner, input.repo, base, pr.head.sha);
    } catch {
      return { ok: false, reason: 'compare_truncated' };
    }
    if (!comparison.complete || !comparison.files || comparison.files.length >= 300)
      return { ok: false, reason: 'compare_truncated' };
    const ceFiles = comparison.files.filter(file => file.filename.startsWith('src/components/ce/'));
    const wide =
      ceFiles.length > 10 ||
      comparison.files.some(
        file =>
          file.status === 'removed' &&
          (file.filename.startsWith('src/components/ce/') ||
            file.filename.startsWith('tests/ce-regression/'))
      );
    const identity = {
      repo: `${input.owner}/${input.repo}`,
      pr_number: pr.number,
      head_sha: pr.head.sha,
    };
    const metadata = await input.deps.getMetadata(identity);
    if (wide) {
      let decision;
      try {
        decision = await input.deps.getApproval({ ...identity, base_sha: base });
      } catch {
        return { ok: false, reason: 'approval_error' };
      }
      if (decision.decision === 'deny') {
        if (decision.reason === 'revoked') return { ok: false, reason: 'revoked' };
        return { ok: false, reason: metadata.hasOtherBase ? 'base_moved' : 'approval_missing' };
      }
      const approval = decision.approval;
      if (
        approval.repo !== identity.repo ||
        approval.pr_number !== pr.number ||
        approval.head_sha !== pr.head.sha ||
        approval.base_sha !== base ||
        approval.target_branch !== 'release/ce'
      )
        return { ok: false, reason: 'approval_malformed' };
    }
    const runs = await input.deps.listWorkflowRuns(input.owner, input.repo, pr.head.sha);
    const pinned = runs.filter(run => run.path === CE_GATE_PATH && run.head_branch === pr.head.ref);
    const targetRuns = pinned
      .filter(run => run.event === 'pull_request_target')
      .sort(
        (a, b) => b.run_started_at.localeCompare(a.run_started_at) || b.run_attempt - a.run_attempt
      );
    const selected = targetRuns[0];
    if (!selected && pinned.some(run => run.event !== 'pull_request_target'))
      return { ok: false, reason: 'wrong_gate_event' };
    if (selected?.conclusion !== 'success') return { ok: false, reason: 'gate_not_green' };
    if (metadata.newestRevokedAt && selected.run_started_at <= metadata.newestRevokedAt)
      return { ok: false, reason: 'revoked_after_green' };
    const trustedSuites = new Set(
      runs
        .filter(
          run =>
            run.path === CE_GATE_PATH &&
            (run.event === 'pull_request_target' || run.event === 'pull_request')
        )
        .map(run => run.check_suite_id)
    );
    const checks = await input.deps.listCheckRuns(input.owner, input.repo, pr.head.sha);
    const matching = checks.filter(check => check.name === CE_GATE_NAME);
    if (matching.some(check => !trustedSuites.has(check.check_suite.id)))
      return { ok: false, reason: 'duplicate_gate_check' };
    if (
      !matching.some(
        check => check.check_suite.id === selected.check_suite_id && check.conclusion === 'success'
      )
    )
      return { ok: false, reason: 'gate_not_green' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'approval_error' };
  }
}
