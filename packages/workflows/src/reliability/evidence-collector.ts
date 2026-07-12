import { reduceRunOutcome } from './outcome-reducer';
import type { IWorkflowStore, WorkflowEventRecord } from '../store';
import type {
  ExecutionState,
  RecoveryState,
  RouteState,
  RunAuthorityRecord,
  RunOutcome,
  ValidationState,
} from './types';

export type GitChangeStatus = 'A' | 'M' | 'D' | 'R';

export interface GitChangeEvidence {
  readonly status: GitChangeStatus;
  readonly path: string;
  readonly previousPath?: string;
}

export interface GitEvidence {
  readonly headSha: string;
  readonly headBranch: string;
  readonly originRemote: string;
  readonly mergeBaseSha: string;
  readonly behindBy: number;
  readonly changes: readonly GitChangeEvidence[];
}

export interface RequiredCheckEvidence {
  readonly name: string;
  readonly state: 'passed' | 'failed' | 'indeterminate';
}

export interface PullRequestEvidence {
  readonly url: string;
  readonly number: number;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly draft: boolean;
  readonly baseRef: string;
  readonly headRef: string;
  readonly headSha: string;
  // M-26: the merge commit oid, present only when state is MERGED. Required to
  // gate a recovered transition on live merged-PR evidence.
  readonly mergeSha: string | null;
  readonly files: readonly string[];
  readonly requiredChecks: readonly RequiredCheckEvidence[];
}

export interface GateEvidence {
  readonly id: string;
  readonly required: boolean;
  readonly state: ValidationState;
  readonly evidence?: string;
}

export interface MechanicalEvidenceInput {
  readonly authority: RunAuthorityRecord;
  readonly executionState: ExecutionState;
  readonly recoveryState: RecoveryState;
  readonly routeState: RouteState;
  readonly git: GitEvidence;
  readonly pullRequest: PullRequestEvidence | null;
  readonly gates: readonly GateEvidence[];
  readonly verifiedNoop?: boolean;
}

export interface CollectedMechanicalEvidence extends MechanicalEvidenceInput {
  readonly scopeValid: boolean;
  readonly pullRequestReady: boolean;
  readonly outcome: RunOutcome;
}

export interface EvidenceCommandResult {
  readonly stdout: string;
  readonly stderr?: string;
}

export type EvidenceCommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string
) => Promise<EvidenceCommandResult>;

export interface RuntimeEvidenceRequest {
  readonly runId: string;
  readonly cwd: string;
  readonly executionState: ExecutionState;
  readonly recoveryState: RecoveryState;
  readonly routeState: RouteState;
  readonly requiredGateIds: readonly string[];
}

function normalizedPaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map(path => path.trim()).filter(Boolean))].sort();
}

function pathsEqual(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = normalizedPaths(left);
  const normalizedRight = normalizedPaths(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function normalizedRemote(remote: string): string {
  return remote
    .trim()
    .replace(/\/?\.git$/i, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function requiredGateState(gates: readonly GateEvidence[]): ValidationState {
  const required = gates.filter(gate => gate.required);
  if (required.length === 0) return 'not_run';
  if (required.some(gate => gate.state === 'failed')) return 'failed';
  if (required.some(gate => gate.state === 'indeterminate' || gate.state === 'not_run')) {
    return 'indeterminate';
  }
  return 'passed';
}

export function repositoryFromRemote(remote: string): string {
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote.trim());
  if (!match?.[1]) throw new Error('scope_authority_missing: GitHub canonicalRemote');
  return match[1];
}

function pullRequestIdentityMatches(
  pullRequest: PullRequestEvidence,
  canonicalRemote: string
): boolean {
  try {
    const expectedRepository = repositoryFromRemote(canonicalRemote).toLowerCase();
    const url = new URL(pullRequest.url);
    const match = /^\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url.pathname);
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'github.com' &&
      match?.[1]?.toLowerCase() === expectedRepository &&
      Number(match[2]) === pullRequest.number
    );
  } catch {
    return false;
  }
}

export function parseGitNameStatus(output: string): readonly GitChangeEvidence[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const fields = line.split('\t');
      const rawStatus = fields[0] ?? '';
      const status = rawStatus[0] as GitChangeStatus | undefined;
      if (!status || !['A', 'M', 'D', 'R'].includes(status)) {
        throw new Error(`gate_scope_mismatch: unsupported git status ${rawStatus}`);
      }
      if (status === 'R') {
        const previousPath = fields[1];
        const path = fields[2];
        if (!previousPath || !path) throw new Error('gate_scope_mismatch: invalid rename');
        return { status, previousPath, path };
      }
      const path = fields[1];
      if (!path) throw new Error(`gate_scope_mismatch: missing path for ${rawStatus}`);
      return { status, path };
    });
}

export function gateEvidenceFromEvents(
  gateId: string,
  events: readonly WorkflowEventRecord[]
): GateEvidence {
  const event = [...events]
    .reverse()
    .find(candidate => candidate.step_name === gateId && candidate.event_type.startsWith('node_'));
  if (!event || event.event_type === 'node_skipped') {
    return { id: gateId, required: true, state: 'indeterminate' };
  }
  if (event.event_type === 'node_failed') {
    return { id: gateId, required: true, state: 'failed' };
  }
  const gateResult = event.data.gate_result;
  if (typeof gateResult === 'object' && gateResult !== null) {
    const record = gateResult as Record<string, unknown>;
    if (record.outcome === 'fail' || record.passed === false) {
      return { id: gateId, required: true, state: 'failed' };
    }
    if (record.outcome !== 'pass' && record.passed !== true) {
      return { id: gateId, required: true, state: 'indeterminate' };
    }
  }
  const nodeOutput = event.data.node_output;
  if (
    typeof nodeOutput === 'string' &&
    /"status"\s*:\s*"BLOCKED"|NEEDS_REVISION|VALIDATION:\s*(?:FAIL|BLOCKED)/i.test(nodeOutput)
  ) {
    return { id: gateId, required: true, state: 'failed', evidence: nodeOutput };
  }
  return {
    id: gateId,
    required: true,
    state: 'passed',
    ...(typeof nodeOutput === 'string' && nodeOutput.trim()
      ? { evidence: nodeOutput.trim().slice(0, 500) }
      : {}),
  };
}

export function parsePullRequest(json: string): PullRequestEvidence | null {
  if (!json.trim()) return null;
  const value = JSON.parse(json) as Record<string, unknown>;
  if (typeof value.url !== 'string' || typeof value.number !== 'number') return null;
  const files = Array.isArray(value.files)
    ? value.files
        .map(file =>
          typeof file === 'object' && file !== null ? (file as Record<string, unknown>).path : null
        )
        .filter((path): path is string => typeof path === 'string')
    : [];
  const rollup = Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup : [];
  const requiredChecks = rollup.map((check, index): RequiredCheckEvidence => {
    const record =
      typeof check === 'object' && check !== null ? (check as Record<string, unknown>) : {};
    const conclusion = stringField(
      record.conclusion ?? record.state ?? record.status
    ).toUpperCase();
    const state = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)
      ? 'passed'
      : ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(conclusion)
        ? 'failed'
        : 'indeterminate';
    const name = stringField(record.name ?? record.context) || `check-${String(index + 1)}`;
    return { name, state };
  });
  const mergeCommit =
    typeof value.mergeCommit === 'object' && value.mergeCommit !== null
      ? (value.mergeCommit as Record<string, unknown>)
      : null;
  const mergeShaRaw = mergeCommit ? stringField(mergeCommit.oid) : '';
  return {
    url: value.url,
    number: value.number,
    state: value.state === 'MERGED' || value.state === 'CLOSED' ? value.state : 'OPEN',
    draft: value.isDraft === true,
    baseRef: stringField(value.baseRefName),
    headRef: stringField(value.headRefName),
    headSha: stringField(value.headRefOid),
    mergeSha: mergeShaRaw === '' ? null : mergeShaRaw,
    files,
    requiredChecks,
  };
}

export async function collectRuntimeEvidence(
  store: Pick<IWorkflowStore, 'getRunAuthority' | 'listWorkflowEvents'>,
  run: EvidenceCommandRunner,
  request: RuntimeEvidenceRequest
): Promise<CollectedMechanicalEvidence> {
  const authority = await store.getRunAuthority(request.runId);
  if (!authority) throw new Error('scope_authority_missing: persisted run authority');
  const git = async (args: readonly string[]): Promise<string> =>
    (await run('git', ['-C', request.cwd, ...args], request.cwd)).stdout.trim();
  const headSha = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
  const headBranch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const originRemote = await git(['remote', 'get-url', 'origin']);
  const mergeBaseSha = await git(['merge-base', authority.baseSha, headSha]);
  const behindRaw = await git([
    'rev-list',
    '--count',
    `${headSha}..refs/remotes/origin/${authority.baseBranch}`,
  ]);
  if (!/^\d+$/.test(behindRaw)) throw new Error('gate_scope_mismatch: invalid behind count');
  const changes = parseGitNameStatus(
    await git(['diff', '--name-status', `${authority.runScopeSha}..${headSha}`])
  );
  const repository = repositoryFromRemote(authority.canonicalRemote);
  let pullRequest: PullRequestEvidence | null = null;
  try {
    const result = await run(
      'gh',
      [
        'pr',
        'view',
        authority.headBranch,
        '--repo',
        repository,
        '--json',
        'url,number,state,isDraft,baseRefName,headRefName,headRefOid,mergeCommit,files,statusCheckRollup',
      ],
      request.cwd
    );
    pullRequest = parsePullRequest(result.stdout);
  } catch {
    pullRequest = null;
  }
  const events = await store.listWorkflowEvents(request.runId);
  const gates = request.requiredGateIds.map(id => gateEvidenceFromEvents(id, events));
  return collectMechanicalEvidence({
    authority,
    executionState: request.executionState,
    recoveryState: request.recoveryState,
    routeState: request.routeState,
    git: {
      headSha,
      headBranch,
      originRemote,
      mergeBaseSha,
      behindBy: Number.parseInt(behindRaw, 10),
      changes,
    },
    pullRequest,
    gates,
  });
}

export function collectMechanicalEvidence(
  input: MechanicalEvidenceInput
): CollectedMechanicalEvidence {
  const diffPaths = input.git.changes.map(change => change.path);
  const pullRequest = input.pullRequest;
  const scopeValid =
    input.git.mergeBaseSha === input.authority.baseSha &&
    input.git.headBranch === input.authority.headBranch &&
    normalizedRemote(input.git.originRemote) ===
      normalizedRemote(input.authority.canonicalRemote) &&
    (pullRequest === null ||
      (pullRequest.baseRef === input.authority.baseBranch &&
        pullRequest.headRef === input.authority.headBranch &&
        pullRequest.headSha === input.git.headSha &&
        pullRequestIdentityMatches(pullRequest, input.authority.canonicalRemote) &&
        pathsEqual(pullRequest.files, diffPaths)));
  const requiredChecksPassed =
    pullRequest?.requiredChecks.every(check => check.state === 'passed') ?? false;
  const pullRequestReady =
    pullRequest !== null &&
    scopeValid &&
    pullRequest.state === 'OPEN' &&
    !pullRequest.draft &&
    requiredChecksPassed;
  const gateState = requiredGateState(input.gates);
  const validationState: ValidationState = !scopeValid ? 'failed' : gateState;
  const validationReason = !scopeValid
    ? 'gate_scope_mismatch'
    : validationState === 'failed'
      ? 'gate_failed'
      : validationState === 'indeterminate'
        ? 'gate_indeterminate'
        : validationState === 'not_run'
          ? 'gate_not_run'
          : undefined;
  const evidenceRefs = [
    `authority:${input.authority.runId}`,
    `git:${input.git.mergeBaseSha}...${input.git.headSha}`,
    ...(pullRequest ? [`pr:${String(pullRequest.number)}`] : []),
    ...input.gates.map(gate => `gate:${gate.id}:${gate.state}`),
  ];
  const outcome = reduceRunOutcome({
    executionState: input.executionState,
    deliverable: {
      worktreeChanges: input.git.changes.length > 0,
      commitSha: input.git.headSha,
      pushed: pullRequest !== null,
      pullRequest: pullRequest
        ? { open: pullRequest.state === 'OPEN', ready: pullRequestReady }
        : undefined,
    },
    validation: {
      required: true,
      state: validationState,
      ...(validationReason ? { reasonCode: validationReason } : {}),
    },
    recoveryState: input.recoveryState,
    routeState: input.routeState,
    requirements: { deliverable: 'pr_ready' },
    verifiedNoop: input.verifiedNoop,
    evidenceRefs,
  });

  return { ...input, scopeValid, pullRequestReady, outcome };
}

function listOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

function manifestLineValue(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function renderManifestV2(evidence: CollectedMechanicalEvidence): string {
  const created = evidence.git.changes
    .filter(change => change.status === 'A')
    .map(change => change.path);
  const modified = evidence.git.changes
    .filter(change => change.status !== 'A')
    .map(change => (change.status === 'D' ? `${change.path} (deleted)` : change.path));
  const validationLabel =
    evidence.outcome.validationState === 'passed'
      ? 'PASS'
      : evidence.outcome.validationState === 'failed'
        ? 'FAIL'
        : evidence.outcome.validationState.toUpperCase();
  const runtimeEvidence = evidence.gates
    .filter(gate => gate.required && gate.evidence)
    .map(gate => `${gate.id}=${manifestLineValue(gate.evidence ?? '')}`);

  return [
    `WO: ${evidence.authority.woId}`,
    `Builder: Smart Cauldron (${evidence.authority.workflowName})`,
    `Files created: ${listOrNone(created)}`,
    `Files modified: ${listOrNone(modified)}`,
    'Tests: N/A (required gates are reported separately)',
    `PRs: ${evidence.pullRequest && evidence.scopeValid ? evidence.pullRequest.url : `N/A (${evidence.outcome.deliverableState})`}`,
    `Merge ancestors: ${evidence.git.mergeBaseSha}...${evidence.git.headSha} (behind_by=${String(evidence.git.behindBy)})`,
    'Grep assertions: N/A (no declared mechanical assertions)',
    `Runtime verification: ${runtimeEvidence.length > 0 ? runtimeEvidence.join('; ') : 'N/A (no runtime gate evidence)'}`,
    `VALIDATION: ${validationLabel}`,
    `OUTCOME: execution=${evidence.outcome.executionState}; deliverable=${evidence.outcome.deliverableState}; validation=${evidence.outcome.validationState}; recovery=${evidence.outcome.recoveryState}; route=${evidence.outcome.routeState}; reason=${evidence.outcome.primaryReason}`,
  ].join('\n');
}
