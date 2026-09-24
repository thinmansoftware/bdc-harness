import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CreateAuthenticatedMessageData,
  DispatchSenderContext,
} from '@archon/core/db/dispatch';
import { createLogger, getDefaultWorkflowsPath, getHomeWorkflowsPath } from '@archon/paths';

const log = createLogger('dispatch/duty-officer-deploy-drift');
const API = 'https://api.github.com';
const SHA40 = /^[0-9a-f]{40}$/;
const PR_REF = /\(#(\d+)\)/g;

const DUTY_OFFICER_SENDER: DispatchSenderContext = { kind: 'system', sender: 'dispatch' };

const PROCESS_RUNS = new Map<string, { last_run_at: number }>();
const ALERTED_KEYS = new Set<string>();

export function resetDeployDriftStateForTests(): void {
  PROCESS_RUNS.clear();
  ALERTED_KEYS.clear();
}

export type DeployDriftVerdict =
  | 'in_sync'
  | 'drift_in_grace'
  | 'drift_alerted'
  | 'disabled'
  | 'observation_error';

export interface DeployDriftResult {
  verdict: DeployDriftVerdict;
  reasons: string[];
  running_sha: string | null;
  target_sha: string | null;
  behind_by: number | null;
  last_error: string | null;
  evaluated_at: string;
}

export interface LaneFileMaps {
  baked: Record<string, string>;
  served: Record<string, string>;
}

export interface DeployDriftDeps {
  readBuildSha: () => string;
  fetchImpl: typeof fetch;
  readToken: () => string | null;
  readLaneFiles: () => LaneFileMaps;
  createMessage: (
    context: DispatchSenderContext,
    data: CreateAuthenticatedMessageData
  ) => Promise<unknown>;
  now: () => Date;
  processStartedAt: Date;
}

interface GhCommit {
  commit?: {
    message?: string;
    committer?: { date?: string };
  };
}

interface CompareResponse {
  status?: string;
  ahead_by?: number;
  commits?: GhCommit[];
}

interface DriftEpisode {
  reason: string;
  idempotencyKey: string;
  beyondGrace: boolean;
  behindBy: number | null;
  undeployedPrs: { number: number; title: string }[];
  commitsWithoutPr: number;
  oldestUndeployedAt: string | null;
  differingLanes: string[];
}

function positiveMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function deployRepo(): string {
  return process.env.DUTY_OFFICER_DEPLOY_DRIFT_REPO?.trim() || 'thinmansoftware/bdc-harness';
}

function deployBranch(): string {
  return process.env.DUTY_OFFICER_DEPLOY_DRIFT_BRANCH?.trim() || 'dev';
}

function graceMs(): number {
  return positiveMs('DUTY_OFFICER_DEPLOY_DRIFT_GRACE_MS', 7_200_000);
}

function recipient(): string {
  return process.env.DUTY_OFFICER_DEPLOY_DRIFT_RECIPIENT?.trim() || 'xo';
}

function hashWorkflowDir(dir: string): Record<string, string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const name of names) {
    try {
      const data = readFileSync(join(dir, name));
      out[name] = createHash('sha256').update(data).digest('hex');
    } catch {
      // Directories and unreadable entries are not lane files.
    }
  }
  return out;
}

export function readLaneFiles(): LaneFileMaps {
  return {
    baked: hashWorkflowDir(getDefaultWorkflowsPath()),
    served: hashWorkflowDir(getHomeWorkflowsPath()),
  };
}

function observation(
  lastError: string,
  evaluatedAt: string,
  runningSha: string | null,
  targetSha: string | null
): DeployDriftResult {
  log.error({ lastError }, 'duty_officer_deploy_drift_observation_error');
  return {
    verdict: 'observation_error',
    reasons: [],
    running_sha: runningSha,
    target_sha: targetSha,
    behind_by: null,
    last_error: lastError,
    evaluated_at: evaluatedAt,
  };
}

function clearKeys(prefix: string): void {
  for (const key of ALERTED_KEYS) {
    if (key.startsWith(prefix)) ALERTED_KEYS.delete(key);
  }
}

function clearShaDriftKeys(): void {
  for (const key of ALERTED_KEYS) {
    if (key.startsWith('do-clock:deploy-drift:') && !key.includes(':build-sha-unknown:')) {
      ALERTED_KEYS.delete(key);
    }
  }
}

function subjectOf(commit: GhCommit): string {
  const message = commit.commit?.message ?? '';
  return message.split('\n')[0] ?? '';
}

function lastPrNumber(subject: string): number | null {
  let found: number | null = null;
  for (const match of subject.matchAll(PR_REF)) {
    found = Number(match[1]);
  }
  return found;
}

function laneKey(runningSha: string, differing: { name: string; served: string }[]): string {
  const payload = differing
    .map(item => `${item.name}=${item.served}`)
    .sort()
    .join('\n');
  const digest = createHash('sha256').update(payload).digest('hex').slice(0, 12);
  return `do-clock:lane-drift:${runningSha.slice(0, 12)}:${digest}`;
}

function differingLanes(maps: LaneFileMaps): { name: string; served: string }[] {
  const found: { name: string; served: string }[] = [];
  for (const name of Object.keys(maps.baked)) {
    if (!(name in maps.served)) continue;
    if (maps.baked[name] !== maps.served[name]) {
      found.push({ name, served: maps.served[name] });
    }
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

async function githubGet<T>(
  deps: DeployDriftDeps,
  token: string,
  path: string,
  signal: AbortSignal
): Promise<T> {
  const response = await deps.fetchImpl(`${API}${path}`, {
    method: 'GET',
    signal,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'bdc-harness-deploy-drift-detector',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`duty_officer_github_http_${response.status}`);
  }
  return (await response.json()) as T;
}

function nextStep(): string {
  return 'Rebuild archon-app-1 through the proven rebuild path with scripts/container/build-app-image.sh. This detector does not rebuild.';
}

export async function runDeployDriftDetector(
  deps: DeployDriftDeps,
  signal: AbortSignal
): Promise<DeployDriftResult | null> {
  if (process.env.DUTY_OFFICER_DEPLOY_DRIFT_ENABLED === 'false') {
    return {
      verdict: 'disabled',
      reasons: [],
      running_sha: null,
      target_sha: null,
      behind_by: null,
      last_error: null,
      evaluated_at: new Date().toISOString(),
    };
  }

  const now = deps.now();
  const evaluatedAt = now.toISOString();
  const interval = positiveMs('DUTY_OFFICER_DEPLOY_DRIFT_INTERVAL_MS', 1_800_000);
  const stateKey = 'duty-officer-clock:deploy-drift';
  const previous = PROCESS_RUNS.get(stateKey);
  if (previous !== undefined && now.getTime() - previous.last_run_at < interval) {
    log.info('duty_officer_deploy_drift_skipped_throttle');
    return null;
  }
  PROCESS_RUNS.set(stateKey, { last_run_at: now.getTime() });

  const grace = graceMs();
  let runningSha: string | null = null;
  let targetSha: string | null = null;

  try {
    signal.throwIfAborted();
    runningSha = deps.readBuildSha();
    const lanes = deps.readLaneFiles();
    const repo = deployRepo();
    const branch = deployBranch();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      return observation('duty_officer_deploy_drift_repo_invalid', evaluatedAt, runningSha, null);
    }

    const shaKnown = SHA40.test(runningSha);
    const episodes: DriftEpisode[] = [];
    let behindBy: number | null = null;

    if (!shaKnown) {
      const age = now.getTime() - deps.processStartedAt.getTime();
      episodes.push({
        reason: 'build_sha_unknown',
        idempotencyKey: `do-clock:deploy-drift:build-sha-unknown:${deps.processStartedAt.toISOString()}`,
        beyondGrace: age > grace,
        behindBy: null,
        undeployedPrs: [],
        commitsWithoutPr: 0,
        oldestUndeployedAt: null,
        differingLanes: [],
      });
    } else {
      const token = deps.readToken();
      if (!token) {
        return observation('duty_officer_github_token_missing', evaluatedAt, runningSha, null);
      }
      const head = await githubGet<{ sha?: string }>(
        deps,
        token,
        `/repos/${repo}/commits/${encodeURIComponent(branch)}`,
        signal
      );
      if (!head.sha || !SHA40.test(head.sha)) {
        return observation('duty_officer_github_head_invalid', evaluatedAt, runningSha, null);
      }
      targetSha = head.sha;
      if (runningSha !== targetSha) {
        const compare = await githubGet<CompareResponse>(
          deps,
          token,
          `/repos/${repo}/compare/${runningSha}...${targetSha}`,
          signal
        );
        const status = compare.status ?? '';
        if (
          status !== 'ahead' &&
          status !== 'behind' &&
          status !== 'diverged' &&
          status !== 'identical'
        ) {
          return observation(
            'duty_officer_github_compare_status_invalid',
            evaluatedAt,
            runningSha,
            targetSha
          );
        }
        if (status === 'ahead' || status === 'behind' || status === 'diverged') {
          const reason = status === 'ahead' ? 'behind_dev' : 'running_not_on_dev';
          const commits = compare.commits ?? [];
          const undeployedPrs: { number: number; title: string }[] = [];
          let commitsWithoutPr = 0;
          let oldestMs: number | null = null;
          for (const commit of commits) {
            const title = subjectOf(commit);
            const number = lastPrNumber(title);
            if (number === null) commitsWithoutPr += 1;
            else if (undeployedPrs.length < 20) undeployedPrs.push({ number, title });
            const date = commit.commit?.committer?.date;
            const parsed = date ? Date.parse(date) : Number.NaN;
            if (Number.isFinite(parsed) && (oldestMs === null || parsed < oldestMs))
              oldestMs = parsed;
          }
          behindBy = typeof compare.ahead_by === 'number' ? compare.ahead_by : commits.length;
          let beyondGrace = false;
          let oldestUndeployedAt: string | null = null;
          if (reason === 'behind_dev') {
            if (oldestMs === null) {
              return observation(
                'duty_officer_deploy_drift_oldest_commit_missing',
                evaluatedAt,
                runningSha,
                targetSha
              );
            }
            oldestUndeployedAt = new Date(oldestMs).toISOString();
            beyondGrace = now.getTime() - oldestMs > grace;
          } else {
            beyondGrace = now.getTime() - deps.processStartedAt.getTime() > grace;
          }
          episodes.push({
            reason,
            idempotencyKey: `do-clock:deploy-drift:${runningSha.slice(0, 12)}`,
            beyondGrace,
            behindBy,
            undeployedPrs,
            commitsWithoutPr,
            oldestUndeployedAt,
            differingLanes: [],
          });
        }
      }
    }

    const drifted = differingLanes(lanes);
    if (drifted.length > 0) {
      const age = now.getTime() - deps.processStartedAt.getTime();
      episodes.push({
        reason: 'served_lane_differs',
        idempotencyKey: laneKey(runningSha, drifted),
        beyondGrace: age > grace,
        behindBy: null,
        undeployedPrs: [],
        commitsWithoutPr: 0,
        oldestUndeployedAt: null,
        differingLanes: drifted.map(item => item.name),
      });
    }

    const shaDrift = episodes.some(
      episode => episode.reason === 'behind_dev' || episode.reason === 'running_not_on_dev'
    );
    const unknown = episodes.some(episode => episode.reason === 'build_sha_unknown');
    if (!shaDrift) clearShaDriftKeys();
    if (!unknown) clearKeys('do-clock:deploy-drift:build-sha-unknown:');
    if (drifted.length === 0) clearKeys('do-clock:lane-drift:');

    let alerted = false;
    for (const episode of episodes) {
      if (!episode.beyondGrace) continue;
      alerted = true;
      if (ALERTED_KEYS.has(episode.idempotencyKey)) continue;
      const body = {
        kind: 'deploy_drift',
        reason: episode.reason,
        running_sha: runningSha,
        target_sha: targetSha,
        target_branch: branch,
        behind_by: episode.reason === 'served_lane_differs' ? (behindBy ?? 0) : episode.behindBy,
        undeployed_prs: episode.undeployedPrs,
        commits_without_pr: episode.commitsWithoutPr,
        oldest_undeployed_at: episode.oldestUndeployedAt,
        differing_lanes: episode.differingLanes,
        grace_ms: grace,
        detected_at: evaluatedAt,
        next_step: nextStep(),
      };
      await deps.createMessage(DUTY_OFFICER_SENDER, {
        correlation_id: episode.idempotencyKey,
        idempotency_key: episode.idempotencyKey,
        task_type: 'agent_message',
        recipient: recipient(),
        priority: 'normal',
        body: JSON.stringify(body),
      });
      ALERTED_KEYS.add(episode.idempotencyKey);
    }

    const reasons = episodes.map(episode => episode.reason);
    if (reasons.length === 0) {
      return {
        verdict: 'in_sync',
        reasons: [],
        running_sha: runningSha,
        target_sha: targetSha ?? runningSha,
        behind_by: 0,
        last_error: null,
        evaluated_at: evaluatedAt,
      };
    }
    const anyBeyond = episodes.some(episode => episode.beyondGrace);
    return {
      verdict: anyBeyond || alerted ? 'drift_alerted' : 'drift_in_grace',
      reasons,
      running_sha: runningSha,
      target_sha: targetSha,
      behind_by: behindBy,
      last_error: null,
      evaluated_at: evaluatedAt,
    };
  } catch (error) {
    if (
      signal.aborted &&
      signal.reason instanceof Error &&
      signal.reason.message.includes('timeout')
    ) {
      return observation(signal.reason.message, evaluatedAt, runningSha, targetSha);
    }
    const message = error instanceof Error ? error.message : String(error);
    return observation(message, evaluatedAt, runningSha, targetSha);
  }
}
