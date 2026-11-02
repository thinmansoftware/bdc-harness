import { describe, expect, test } from 'bun:test';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import {
  runMergeExecutionBridgeOnce,
  type MergeExecutionBridgeOptions,
  type MergeExecutionBridgeStore,
} from '../merge-execution-bridge';
import type { GitHubClientDeps, PullRequestEvidence } from '../types';

const T0 = new Date('2026-10-14T00:00:00.000Z');
const verdict = (id: string, overrides: Partial<OverseerVerdictRow> = {}): OverseerVerdictRow =>
  ({
    id,
    run_id: `run-${id}`,
    wo_id: `WO-${id}`,
    head_sha: 'head',
    proposed_action: 'flag_merge_ready',
    merge_attempts: 0,
    merge_not_before: null,
    merge_last_transient_reason: null,
    ...overrides,
  }) as OverseerVerdictRow;

const green = (overrides: Partial<PullRequestEvidence> = {}): PullRequestEvidence => ({
  exists: true,
  state: 'open',
  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  mergeable: true,
  mergeableState: 'clean',
  changedFilePaths: ['src/code.ts'],
  baseBranch: 'dev',
  headSha: 'head',
  htmlUrl: 'https://github.test/pull/1',
  pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 1 },
  ...overrides,
});

function makeHarness(rows: OverseerVerdictRow[], evidence: () => PullRequestEvidence) {
  let clock = T0;
  const processing = new Set<string>();
  const outcomes: { verdictId: string; mutationSent: boolean; reason: string }[] = [];
  const deferrals: { verdictId: string; reason: string; notBefore: string }[] = [];
  const claims: string[] = [];
  const releases: string[] = [];
  let merges = 0;
  const store: MergeExecutionBridgeStore = {
    listUnactionedVerdicts: async () =>
      rows.filter(
        row =>
          !row.actioned_at && (!row.merge_not_before || row.merge_not_before <= clock.toISOString())
      ),
    claimVerdict: async id => {
      const row = rows.find(item => item.id === id);
      if (!row || row.actioned_at) return false;
      row.actioned_at = clock.toISOString();
      row.action_reason = 'processing';
      processing.add(id);
      claims.push(id);
      return true;
    },
    releaseVerdictClaim: async id => {
      processing.delete(id);
      return true;
    },
    deferVerdictClaim: async (id, reason, notBefore) => {
      const row = rows.find(item => item.id === id);
      if (!row || !processing.has(id)) return false;
      deferrals.push({ verdictId: id, reason, notBefore });
      processing.delete(id);
      row.actioned_at = null;
      row.action_reason = null;
      row.merge_attempts += 1;
      row.merge_not_before = notBefore;
      return true;
    },
    getRunById: async id =>
      ({
        id,
        woId: 'WO-TEST',
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        status: 'completed',
        headBranch: 'feature',
        metadata: {},
      }) as OverseerWatchRun,
    reserveMergeSlot: async () => true,
    releaseMergeSlot: async id => {
      releases.push(id);
    },
    recordOutcome: async input => {
      outcomes.push(input);
      processing.delete(input.verdictId);
    },
  };
  const github: GitHubClientDeps = {
    findPullRequest: async () => evidence(),
    mergePullRequest: async () => {
      merges += 1;
      return { merged: true, mergeSha: 'merged' };
    },
  };
  const options: MergeExecutionBridgeOptions = {
    store,
    github,
    hasQualifiedReview: async () => true,
    now: () => clock,
    retryBaseMinutes: 10,
    retryMaxDelayMinutes: 240,
    retryMaxAttempts: 8,
    readPolicy: () => ({
      service_enabled: true,
      emergency_stop: false,
      legacy_dry_run: false,
      capability_flags: {
        escalation: false,
        repair: false,
        branch: false,
        lifecycle: false,
        merge: true,
      },
    }),
    repoConfig: { 'thinmansoftware/bdc-harness': { baseBranch: 'dev' } },
  };
  return {
    options,
    store,
    github,
    outcomes,
    deferrals,
    claims,
    releases,
    setClock: (value: Date) => (clock = value),
    get merges() {
      return merges;
    },
  };
}

describe('merge execution bridge transient retry', () => {
  test('transient mergeable_state_not_clean defers with backoff then merges on a later pass', async () => {
    let ready = false;
    const h = makeHarness([verdict('retry')], () =>
      ready ? green() : green({ mergeable: null, mergeableState: 'unknown' })
    );
    await runMergeExecutionBridgeOnce(h.options);
    expect(h.deferrals[0]).toEqual({
      verdictId: 'retry',
      reason: 'mergeable_state_not_clean',
      notBefore: '2026-10-14T00:10:00.000Z',
    });
    h.setClock(new Date('2026-10-14T00:05:00.000Z'));
    await runMergeExecutionBridgeOnce(h.options);
    expect(h.claims).toHaveLength(1);
    ready = true;
    h.setClock(new Date('2026-10-14T00:11:00.000Z'));
    await runMergeExecutionBridgeOnce(h.options);
    expect(h.merges).toBe(1);
    expect(h.outcomes.map(item => item.reason)).toEqual(['merge_executed']);
  });

  test('spec_only skip stays terminal and is never reclaimed', async () => {
    const h = makeHarness([verdict('docs')], () => green({ changedFilePaths: ['docs/x.md'] }));
    await runMergeExecutionBridgeOnce(h.options);
    await runMergeExecutionBridgeOnce(h.options);
    expect(h.outcomes.map(item => item.reason)).toEqual(['spec_only']);
    expect(h.deferrals).toHaveLength(0);
    expect(h.claims).toHaveLength(1);
    expect(h.merges).toBe(0);
  });

  test('transient skip at the attempt cap records transient_exhausted and stops retrying', async () => {
    const capped = makeHarness([verdict('cap', { merge_attempts: 7 })], () =>
      green({ mergeableState: 'unknown' })
    );
    await runMergeExecutionBridgeOnce(capped.options);
    await runMergeExecutionBridgeOnce(capped.options);
    expect(capped.outcomes.map(item => item.reason)).toEqual([
      'transient_exhausted:mergeable_state_not_clean',
    ]);
    expect(capped.claims).toHaveLength(1);
    const delayed = makeHarness([verdict('delay', { merge_attempts: 6 })], () =>
      green({ mergeableState: 'unknown' })
    );
    await runMergeExecutionBridgeOnce(delayed.options);
    expect(delayed.deferrals[0]?.notBefore).toBe('2026-10-14T04:00:00.000Z');
  });

  test('rate-limit merge failure defers the verdict and ends the pass', async () => {
    const h = makeHarness([verdict('first'), verdict('second')], () => green());
    h.github.mergePullRequest = async () => {
      throw new Error('API rate limit exceeded for user ID 255238497.');
    };
    await runMergeExecutionBridgeOnce(h.options);
    expect(h.releases).toEqual(['first']);
    expect(h.deferrals[0]?.reason).toStartWith('merge_failed:API rate limit');
    expect(h.claims).toEqual(['first']);
    expect(h.outcomes).toHaveLength(0);
  });

  test('repair regressions use strict retry integers and stop after lookup rate limits', async () => {
    const runless = (id: string) =>
      verdict(id, {
        run_id: `pr-discovery:thinmansoftware/bdc-harness#${id === 'first' ? 1 : 2}`,
        wo_id: `gh:thinmansoftware/bdc-harness#${id === 'first' ? 1 : 2}`,
      });
    const h = makeHarness([runless('first'), runless('second')], () => green());
    let lookups = 0;
    h.github.findPullRequest = async () => {
      lookups += 1;
      throw new Error('API rate limit exceeded for user ID 255238497.');
    };
    await runMergeExecutionBridgeOnce(h.options);
    expect(h.deferrals[0]?.reason).toBe('pr_context_fetch_failed');
    expect(h.claims).toEqual(['first']);
    expect(lookups).toBe(1);
    expect(h.outcomes).toHaveLength(0);

    for (const malformed of ['10.5', '10junk']) {
      const previous = process.env.OVERSEER_MERGE_RETRY_BASE_MINUTES;
      process.env.OVERSEER_MERGE_RETRY_BASE_MINUTES = malformed;
      try {
        const malformedHarness = makeHarness([verdict(`malformed-${malformed}`)], () =>
          green({ mergeable: null, mergeableState: 'unknown' })
        );
        malformedHarness.options.retryBaseMinutes = undefined;
        await runMergeExecutionBridgeOnce(malformedHarness.options);
        expect(malformedHarness.deferrals[0]?.notBefore).toBe('2026-10-14T00:10:00.000Z');
      } finally {
        if (previous === undefined) delete process.env.OVERSEER_MERGE_RETRY_BASE_MINUTES;
        else process.env.OVERSEER_MERGE_RETRY_BASE_MINUTES = previous;
      }
    }
  });

  test('production-base and stale-head skips stay terminal', async () => {
    const cases: [string, PullRequestEvidence, Partial<OverseerVerdictRow>][] = [
      ['integration_base_mismatch', green({ baseBranch: 'other' }), {}],
      ['verdict_stale_head', green({ headSha: 'moved' }), {}],
      ['not_mergeable_dirty', green({ mergeable: false, mergeableState: 'dirty' }), {}],
      [
        'head_moved',
        green({ headSha: 'moved' }),
        {
          run_id: 'pr-discovery:thinmansoftware/bdc-harness#1',
          wo_id: 'gh:thinmansoftware/bdc-harness#1',
        },
      ],
      [
        'base_not_allowlisted',
        green({ baseBranch: 'release/x' }),
        {
          run_id: 'pr-discovery:thinmansoftware/bdc-harness#1',
          wo_id: 'gh:thinmansoftware/bdc-harness#1',
        },
      ],
    ];
    for (const [reason, pr, overrides] of cases) {
      const h = makeHarness([verdict(reason, overrides)], () => pr);
      await runMergeExecutionBridgeOnce(h.options);
      await runMergeExecutionBridgeOnce(h.options);
      expect(h.outcomes.map(item => item.reason)).toEqual([reason]);
      expect(h.deferrals).toHaveLength(0);
    }
  });

  test('fetch failure defers as pr_context_fetch_failed and old stores keep terminal behavior', async () => {
    const row = verdict('fetch', {
      run_id: 'pr-discovery:thinmansoftware/bdc-harness#1',
      wo_id: 'gh:thinmansoftware/bdc-harness#1',
    });
    const modern = makeHarness([row], () => green());
    modern.github.findPullRequest = async () => {
      throw new Error('lookup failed');
    };
    await runMergeExecutionBridgeOnce(modern.options);
    expect(modern.deferrals[0]?.reason).toBe('pr_context_fetch_failed');
    expect(modern.outcomes).toHaveLength(0);
    const legacy = makeHarness([verdict('legacy', { run_id: row.run_id, wo_id: row.wo_id })], () =>
      green()
    );
    delete legacy.store.deferVerdictClaim;
    legacy.github.findPullRequest = modern.github.findPullRequest;
    await runMergeExecutionBridgeOnce(legacy.options);
    expect(legacy.outcomes.map(item => item.reason)).toEqual(['pr_context_fetch_failed']);
  });
});
