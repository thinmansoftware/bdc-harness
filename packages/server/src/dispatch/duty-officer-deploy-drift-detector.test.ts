import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type {
  CreateAuthenticatedMessageData,
  DispatchSenderContext,
} from '@archon/core/db/dispatch';
import {
  resetDeployDriftStateForTests,
  runDeployDriftDetector,
  type DeployDriftDeps,
  type LaneFileMaps,
} from './duty-officer-deploy-drift-detector';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);
const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const GRACE_MS = 7_200_000;

interface StoredMessage {
  idempotency_key: string;
  recipient: string;
  task_type: string;
  body: string;
}

function hoursBefore(hours: number): string {
  return new Date(NOW - hours * 60 * 60 * 1000).toISOString();
}

function commit(subject: string, committerDate: string): unknown {
  return { commit: { message: subject, committer: { date: committerDate } } };
}

function sameLanes(): LaneFileMaps {
  return { baked: { 'lane-a.yaml': 'h1' }, served: { 'lane-a.yaml': 'h1' } };
}

describe('deploy drift detector', () => {
  let nowMs = NOW;
  let store: Map<string, StoredMessage>;
  let createMessage: ReturnType<typeof mock>;
  let fetchImpl: ReturnType<typeof mock>;
  let urls: string[];
  let readBuildSha: ReturnType<typeof mock>;
  let readToken: ReturnType<typeof mock>;
  let readLaneFiles: ReturnType<typeof mock>;
  let lanes: LaneFileMaps;
  let runningSha: string;
  let processStartedAt: Date;
  let compareBody: Record<string, unknown> | null;
  let headSha: string;
  let fetchMode: 'ok' | 'reject' | '403';

  beforeEach(() => {
    resetDeployDriftStateForTests();
    nowMs = NOW;
    store = new Map();
    urls = [];
    lanes = sameLanes();
    runningSha = SHA_A;
    processStartedAt = new Date(NOW);
    compareBody = null;
    headSha = SHA_A;
    fetchMode = 'ok';
    delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_ENABLED;
    delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_REPO;
    delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_BRANCH;
    delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_GRACE_MS;
    delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_INTERVAL_MS;
    delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_TIMEOUT_MS;
    delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_RECIPIENT;
    process.env.DUTY_OFFICER_DEPLOY_DRIFT_GRACE_MS = String(GRACE_MS);
    process.env.DUTY_OFFICER_DEPLOY_DRIFT_INTERVAL_MS = '1';
    createMessage = mock(
      async (_context: DispatchSenderContext, data: CreateAuthenticatedMessageData) => {
        const existing = store.get(data.idempotency_key);
        if (existing) return existing;
        const row: StoredMessage = {
          idempotency_key: data.idempotency_key,
          recipient: data.recipient,
          task_type: data.task_type,
          body: data.body,
        };
        store.set(data.idempotency_key, row);
        return row;
      }
    );
    fetchImpl = mock(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (fetchMode === 'reject') throw new Error('network_down');
      if (fetchMode === '403') return new Response('forbidden', { status: 403 });
      if (url.includes('/compare/')) return Response.json(compareBody ?? {});
      return Response.json({ sha: headSha });
    });
    readBuildSha = mock(() => runningSha);
    readToken = mock(() => 'token');
    readLaneFiles = mock(() => lanes);
  });

  afterEach(() => {
    resetDeployDriftStateForTests();
    delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_ENABLED;
    delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_REPO;
    delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_BRANCH;
    delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_GRACE_MS;
    delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_INTERVAL_MS;
    delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_TIMEOUT_MS;
    delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_RECIPIENT;
  });

  function deps(): DeployDriftDeps {
    return {
      readBuildSha: readBuildSha as DeployDriftDeps['readBuildSha'],
      fetchImpl: fetchImpl as unknown as DeployDriftDeps['fetchImpl'],
      readToken: readToken as DeployDriftDeps['readToken'],
      readLaneFiles: readLaneFiles as DeployDriftDeps['readLaneFiles'],
      createMessage: createMessage as DeployDriftDeps['createMessage'],
      now: () => new Date(nowMs),
      processStartedAt,
    };
  }

  async function run(): Promise<Awaited<ReturnType<typeof runDeployDriftDetector>>> {
    return runDeployDriftDetector(deps(), new AbortController().signal);
  }

  function bodyOf(key?: string): Record<string, unknown> {
    const row = key ? store.get(key) : [...store.values()][0];
    if (!row) throw new Error('missing message');
    return JSON.parse(row.body) as Record<string, unknown>;
  }

  test('in_sync_no_alert', async () => {
    headSha = SHA_A;
    runningSha = SHA_A;
    const result = await run();
    expect(result?.verdict).toBe('in_sync');
    expect(result?.reasons).toEqual([]);
    expect(createMessage).toHaveBeenCalledTimes(0);
    expect(urls.some(url => url.includes('/compare/'))).toBe(false);
  });

  test('drift_within_grace_no_alert', async () => {
    runningSha = SHA_A;
    headSha = SHA_B;
    compareBody = {
      status: 'ahead',
      ahead_by: 2,
      commits: [
        commit('Fix older (#900)', hoursBefore(0.5)),
        commit('Fix newer (#899)', hoursBefore(0.1)),
      ],
    };
    const result = await run();
    expect(result?.verdict).toBe('drift_in_grace');
    expect(result?.reasons).toContain('behind_dev');
    expect(createMessage).toHaveBeenCalledTimes(0);
  });

  test('drift_beyond_grace_exactly_one_alert', async () => {
    runningSha = SHA_A;
    headSha = SHA_B;
    compareBody = {
      status: 'ahead',
      ahead_by: 3,
      commits: [
        commit('Fix x (#901)', hoursBefore(3)),
        commit('Fix y (#902)', hoursBefore(2.5)),
        commit('chore no pr', hoursBefore(1)),
      ],
    };
    const result = await run();
    expect(result?.verdict).toBe('drift_alerted');
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
    const key = `do-clock:deploy-drift:${SHA_A.slice(0, 12)}`;
    const row = store.get(key);
    expect(row?.recipient).toBe('xo');
    expect(row?.task_type).toBe('agent_message');
    const body = bodyOf(key);
    expect(body.reason).toBe('behind_dev');
    expect(body.running_sha).toBe(SHA_A);
    expect(body.target_sha).toBe(SHA_B);
    expect(body.behind_by).toBe(3);
    expect((body.undeployed_prs as { number: number }[]).map(pr => pr.number)).toEqual([901, 902]);
    expect(body.commits_without_pr).toBe(1);
    expect(
      (body.undeployed_prs as unknown[]).length + (body.commits_without_pr as number)
    ).toBe(body.behind_by);
  });

  test('pr_list_cap_still_counts_every_commit', async () => {
    runningSha = SHA_A;
    headSha = SHA_B;
    const commits = [];
    for (let i = 1; i <= 22; i++) {
      commits.push(commit(`Fix ${i} (#${900 + i})`, hoursBefore(3)));
    }
    commits.push(commit('chore no pr a', hoursBefore(2)));
    commits.push(commit('chore no pr b', hoursBefore(1)));
    compareBody = { status: 'ahead', ahead_by: 24, commits };
    const result = await run();
    expect(result?.verdict).toBe('drift_alerted');
    const body = bodyOf();
    const prs = body.undeployed_prs as { number: number }[];
    expect(prs).toHaveLength(20);
    expect(prs.map(pr => pr.number)).toEqual(Array.from({ length: 20 }, (_, i) => 901 + i));
    expect(body.commits_without_pr).toBe(4);
    expect(body.behind_by).toBe(24);
    expect(prs.length + (body.commits_without_pr as number)).toBe(body.behind_by);
  });

  test('repeated_ticks_stay_deduplicated', async () => {
    runningSha = SHA_A;
    headSha = SHA_B;
    compareBody = {
      status: 'ahead',
      ahead_by: 3,
      commits: [
        commit('Fix x (#901)', hoursBefore(3)),
        commit('Fix y (#902)', hoursBefore(2.5)),
        commit('chore no pr', hoursBefore(1)),
      ],
    };
    await run();
    nowMs += 60_000;
    await run();
    nowMs += 60_000;
    await run();
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
    const key = `do-clock:deploy-drift:${SHA_A.slice(0, 12)}`;
    resetDeployDriftStateForTests();
    nowMs += 60_000;
    await run();
    expect(createMessage).toHaveBeenCalledTimes(2);
    const second = createMessage.mock.calls[1] as [
      DispatchSenderContext,
      CreateAuthenticatedMessageData,
    ];
    expect(second[1].idempotency_key).toBe(key);
    expect(store.size).toBe(1);
  });

  test('recovery_then_new_episode', async () => {
    runningSha = SHA_A;
    headSha = SHA_B;
    compareBody = {
      status: 'ahead',
      ahead_by: 1,
      commits: [commit('Fix x (#901)', hoursBefore(3))],
    };
    await run();
    expect(store.size).toBe(1);

    nowMs += 60_000;
    runningSha = SHA_C;
    headSha = SHA_C;
    compareBody = null;
    const recovered = await run();
    expect(recovered?.verdict).toBe('in_sync');
    expect(createMessage).toHaveBeenCalledTimes(1);

    nowMs += 60_000;
    runningSha = SHA_C;
    headSha = SHA_D;
    compareBody = {
      status: 'ahead',
      ahead_by: 1,
      commits: [commit('Fix z (#903)', new Date(nowMs - 3 * 60 * 60 * 1000).toISOString())],
    };
    await run();
    expect(createMessage).toHaveBeenCalledTimes(2);
    const key = `do-clock:deploy-drift:${SHA_C.slice(0, 12)}`;
    expect(store.has(key)).toBe(true);
    expect(store.size).toBe(2);
  });

  test('build_sha_unknown_beyond_grace', async () => {
    runningSha = 'unknown';
    processStartedAt = new Date(NOW - 3 * 60 * 60 * 1000);
    const result = await run();
    expect(result?.verdict).toBe('drift_alerted');
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(store.size).toBe(1);
    expect(bodyOf().reason).toBe('build_sha_unknown');
  });

  test('build_sha_unknown_within_grace', async () => {
    runningSha = 'unknown';
    processStartedAt = new Date(NOW - 10 * 60 * 1000);
    const result = await run();
    expect(result?.verdict).toBe('drift_in_grace');
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(createMessage).toHaveBeenCalledTimes(0);
  });

  test('running_not_on_dev', async () => {
    runningSha = SHA_A;
    headSha = SHA_B;
    processStartedAt = new Date(NOW - 3 * 60 * 60 * 1000);
    compareBody = {
      status: 'diverged',
      ahead_by: 4,
      behind_by: 7,
      commits: [commit('Fix on dev (#910)', hoursBefore(1))],
    };
    const result = await run();
    expect(result?.verdict).toBe('drift_alerted');
    expect(result?.behind_by).toBe(7);
    expect(store.size).toBe(1);
    const body = bodyOf();
    expect(body.reason).toBe('running_not_on_dev');
    expect(body.running_sha).toBe(SHA_A);
    expect(body.target_sha).toBe(SHA_B);
    expect(body.behind_by).toBe(7);
  });

  test('two_episodes_beyond_grace_one_alert_each', async () => {
    runningSha = SHA_A;
    headSha = SHA_B;
    processStartedAt = new Date(NOW - 3 * 60 * 60 * 1000);
    compareBody = {
      status: 'ahead',
      ahead_by: 1,
      commits: [commit('Fix x (#901)', hoursBefore(3))],
    };
    lanes = {
      baked: { 'lane-a.yaml': 'h1' },
      served: { 'lane-a.yaml': 'h9' },
    };
    const result = await run();
    expect(result?.verdict).toBe('drift_alerted');
    expect(result?.reasons).toEqual(['behind_dev', 'served_lane_differs']);
    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(2);
    const keys = [...store.keys()];
    expect(keys.filter(key => key.startsWith('do-clock:deploy-drift:'))).toHaveLength(1);
    expect(keys.filter(key => key.startsWith('do-clock:lane-drift:'))).toHaveLength(1);
    const reasons = [...store.values()].map(row => {
      const parsed = JSON.parse(row.body) as { reason: string };
      return parsed.reason;
    });
    expect(reasons.sort()).toEqual(['behind_dev', 'served_lane_differs']);
    nowMs += 60_000;
    await run();
    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(2);
  });

  test('served_lane_drift', async () => {
    runningSha = SHA_A;
    headSha = SHA_A;
    processStartedAt = new Date(NOW - 3 * 60 * 60 * 1000);
    lanes = {
      baked: { 'lane-a.yaml': 'h1', 'lane-b.yaml': 'h2' },
      served: { 'lane-a.yaml': 'h1', 'lane-b.yaml': 'h9', 'custom.yaml': 'h5' },
    };
    await run();
    nowMs += 60_000;
    await run();
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
    const body = bodyOf();
    expect(body.reason).toBe('served_lane_differs');
    expect(body.differing_lanes).toEqual(['lane-b.yaml']);

    resetDeployDriftStateForTests();
    lanes = {
      baked: { 'lane-a.yaml': 'h1', 'lane-b.yaml': 'h2' },
      served: { 'lane-a.yaml': 'h1', 'lane-b.yaml': 'h2', 'custom.yaml': 'h5' },
    };
    nowMs += 60_000;
    await run();
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
  });

  test('github_error_network_is_observation_error', async () => {
    fetchMode = 'reject';
    runningSha = SHA_A;
    headSha = SHA_B;
    const result = await run();
    expect(result?.verdict).toBe('observation_error');
    expect(result?.last_error).toBe('network_down');
    expect(createMessage).toHaveBeenCalledTimes(0);
  });

  test('github_error_403_is_observation_error', async () => {
    fetchMode = '403';
    runningSha = SHA_A;
    headSha = SHA_B;
    const result = await run();
    expect(result?.verdict).toBe('observation_error');
    expect(result?.last_error).toBe('duty_officer_github_http_403');
    expect(createMessage).toHaveBeenCalledTimes(0);
  });

  test('disabled_by_env', async () => {
    process.env.DUTY_OFFICER_DEPLOY_DRIFT_ENABLED = 'false';
    const result = await run();
    expect(result?.verdict).toBe('disabled');
    expect(readBuildSha).toHaveBeenCalledTimes(0);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(readLaneFiles).toHaveBeenCalledTimes(0);
    expect(createMessage).toHaveBeenCalledTimes(0);
  });
});
