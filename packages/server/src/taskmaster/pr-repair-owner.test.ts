/**
 * Tests for the PR repair owner (WO-HARNESS-PR-REPAIR-OWNER-AND-DEDUPE-01).
 *
 * Covers Test 1 (fires one repair on the same branch), Test 4 (duplicates
 * collapse to one survivor), Test 5 (human PRs untouched), Test 6 (cap
 * exhaustion posts one digest item), Test 12 (approved non-survivor never
 * closed), Test 13 (stale head addressed not fired), Test 15 (idempotent tick
 * twice). Every external effect is an injected fake -- no network, no real
 * GitHub writes.
 */
import { describe, expect, test } from 'bun:test';
import type { LanePr, WoWithMultipleLanePrs } from '@archon/core/db/lane-pr-registry';
import {
  buildSupersededComment,
  planDedupe,
  runPrRepairOwner,
  type PrRepairOwnerDeps,
  type PrRepairQueuedMessage,
} from './pr-repair-owner';

const NOW = Date.parse('2026-10-14T03:00:00Z');

function lanePr(over: Partial<LanePr> & { prNumber: number }): LanePr {
  return {
    owner: 'thinmansoftware',
    repo: 'bdc-xo',
    headRef: `feat/wo-xo-ce-health-digest-01-thread-${over.prNumber}`,
    headSha: `sha-${over.prNumber}`,
    state: 'OPEN',
    reviewDecision: 'CHANGES_REQUESTED',
    createdAt: '2026-10-14T01:50:00Z',
    runId: `run-${over.prNumber}`,
    workflowName: 'bdc-feature-development',
    ...over,
  };
}

function candidateBody(over: {
  owner?: string;
  repo?: string;
  prNumber: number;
  headSha: string;
  woId: string;
  headRef: string;
  verdictBody?: string;
}): string {
  return JSON.stringify({
    kind: 'overseer_remediation_candidate',
    owner: over.owner ?? 'thinmansoftware',
    repo: over.repo ?? 'bdc-xo',
    prNumber: over.prNumber,
    headSha: over.headSha,
    attempt: 1,
    maxAttempts: 2,
    findingClasses: ['lane_repair'],
    verdictBody: over.verdictBody ?? 'Fix the broken thing.',
    woId: over.woId,
    headRef: over.headRef,
    owningLane: 'bluedevilcollectibles',
  });
}

function exhaustedBody(over: {
  owner?: string;
  repo: string;
  prNumber: number;
  woId: string;
  reason: string;
}): string {
  return JSON.stringify({
    kind: 'overseer_remediation_exhausted',
    owner: over.owner ?? 'thinmansoftware',
    repo: over.repo,
    prNumber: over.prNumber,
    headSha: 'sha-exhausted',
    woId: over.woId,
    reason: over.reason,
  });
}

interface Recorder {
  closed: Array<{ prNumber: number; comment: string }>;
  fired: Array<Parameters<PrRepairOwnerDeps['fireRepairCascade']>[0]>;
  acknowledged: string[];
  addressed: Array<{ id: string; note: string }>;
}

interface HarnessConfig {
  dupeWos?: WoWithMultipleLanePrs[];
  laneByWo?: Record<string, LanePr[]>;
  queued?: PrRepairQueuedMessage[];
  running?: Set<string>;
  cascadeId?: string;
}

function makeDeps(config: HarnessConfig): { deps: PrRepairOwnerDeps; rec: Recorder } {
  const rec: Recorder = { closed: [], fired: [], acknowledged: [], addressed: [] };
  // Queued rows carry a local addressed flag so a re-read excludes them, exactly
  // as listMessages(status:'queued') would once addressed_by is set.
  const messages = (config.queued ?? []).map(m => ({ ...m, addressed: false }));
  const laneByWo = config.laneByWo ?? {};
  let cascadeSeq = 0;

  const deps: PrRepairOwnerDeps = {
    now: () => NOW,
    fetchPr: async (owner, repo, number) => {
      const pr = Object.values(laneByWo)
        .flat()
        .find(value => value.owner === owner && value.repo === repo && value.prNumber === number);
      return pr
        ? {
            number: pr.prNumber,
            state: pr.state,
            reviewDecision: pr.reviewDecision,
            createdAt: pr.createdAt,
            headRefName: pr.headRef,
            headSha: pr.headSha,
            headRepoFullName: `${owner}/${repo}`,
            baseRepoFullName: `${owner}/${repo}`,
            title: '',
            body: '',
          }
        : null;
    },
    listWosWithMultipleLanePrs: async () => config.dupeWos ?? [],
    listLanePrsForWo: async woId => laneByWo[woId] ?? [],
    listQueuedTaskmasterMessages: async () =>
      messages.filter(m => !m.addressed).map(m => ({ id: m.id, body: m.body })),
    acknowledgeRow: async id => {
      rec.acknowledged.push(id);
    },
    addressRow: async (id, note) => {
      rec.addressed.push({ id, note });
      const m = messages.find(x => x.id === id);
      if (m) m.addressed = true;
    },
    closePr: async input => {
      rec.closed.push({ prNumber: input.prNumber, comment: input.comment });
      // Closing flips the PR CLOSED in every lane set so a second sweep skips it.
      for (const prs of Object.values(laneByWo)) {
        for (const pr of prs) if (pr.prNumber === input.prNumber) pr.state = 'CLOSED';
      }
      for (const entry of config.dupeWos ?? []) {
        for (const pr of entry.prs) if (pr.prNumber === input.prNumber) pr.state = 'CLOSED';
      }
    },
    hasRunningRunForWo: async woId => (config.running ?? new Set()).has(woId),
    fireRepairCascade: async opts => {
      cascadeSeq += 1;
      const cascadeId = config.cascadeId ?? `casc-${cascadeSeq}`;
      rec.fired.push(opts);
      opts.onAdmission?.({ cascadeId });
      return { cascadeId };
    },
    resolveEntryTier: () => undefined,
  };
  return { deps, rec };
}

describe('review repair regressions', () => {
  test('sweep groups a shared WO by repository before closing duplicates', async () => {
    const woId = 'WO-MULTI-REPO';
    const { deps, rec } = makeDeps({
      dupeWos: [
        {
          woId,
          prs: [
            lanePr({ prNumber: 1, repo: 'first' }),
            lanePr({ prNumber: 2, repo: 'second' }),
            lanePr({ prNumber: 3, repo: 'first' }),
          ],
        },
      ],
    });
    await runPrRepairOwner(deps);
    expect(rec.closed.map(row => row.prNumber)).toEqual([1]);
  });

  for (const approvedDuringRead of [false, true]) {
    test(`obsolete rejection never repairs an approved head (late=${approvedDuringRead})`, async () => {
      const woId = 'WO-APPROVED';
      const pr = lanePr({
        prNumber: 5,
        reviewDecision: approvedDuringRead ? 'CHANGES_REQUESTED' : 'APPROVED',
      });
      const { deps, rec } = makeDeps({
        laneByWo: { [woId]: [pr] },
        queued: [
          {
            id: 'obsolete',
            body: candidateBody({
              woId,
              prNumber: 5,
              headRef: pr.headRef,
              headSha: pr.headSha,
            }),
          },
        ],
      });
      const fetch = deps.fetchPr;
      deps.fetchPr = async (...args) => {
        const current = await fetch(...args);
        return current ? { ...current, reviewDecision: 'APPROVED' } : null;
      };
      await runPrRepairOwner(deps);
      expect(rec.fired).toHaveLength(0);
      expect(rec.acknowledged).toEqual(['obsolete']);
      expect(rec.addressed[0]?.note).toContain('refused:');
    });
  }
});

describe('planDedupe', () => {
  test('survivor is newest OPEN when none approved', () => {
    const plan = planDedupe([
      lanePr({ prNumber: 3170, createdAt: '2026-10-14T01:50:02Z' }),
      lanePr({ prNumber: 3171, createdAt: '2026-10-14T01:59:02Z' }),
      lanePr({ prNumber: 3172, createdAt: '2026-10-14T02:27:34Z' }),
    ]);
    expect(plan.survivor?.prNumber).toBe(3172);
    expect(plan.toClose.map(p => p.prNumber).sort()).toEqual([3170, 3171]);
    expect(plan.approvedNonSurvivors).toHaveLength(0);
  });

  test('CLOSED and MERGED PRs are never survivors or victims', () => {
    const plan = planDedupe([
      lanePr({ prNumber: 10, state: 'CLOSED' }),
      lanePr({ prNumber: 11, state: 'OPEN', createdAt: '2026-10-14T02:00:00Z' }),
      lanePr({ prNumber: 12, state: 'MERGED' }),
    ]);
    expect(plan.survivor?.prNumber).toBe(11);
    expect(plan.toClose).toHaveLength(0);
  });
});

describe('runPrRepairOwner', () => {
  test('Test 1: changes_requested_fires_one_repair_on_same_branch', async () => {
    const woId = 'WO-XO-CE-HEALTH-DIGEST-01';
    const pr = lanePr({
      prNumber: 3171,
      headRef: 'feat/wo-xo-ce-health-digest-01-thread-f7a2e0ec',
      headSha: 'head-3171',
      createdAt: '2026-10-14T01:59:02Z',
    });
    const { deps, rec } = makeDeps({
      laneByWo: { [woId]: [pr] },
      queued: [
        {
          id: 'row-1',
          body: candidateBody({
            prNumber: 3171,
            headSha: 'head-3171',
            woId,
            headRef: pr.headRef,
            verdictBody: 'Reviewer said: fix the null deref.',
          }),
        },
      ],
    });

    const result = await runPrRepairOwner(deps);

    expect(rec.fired).toHaveLength(1);
    expect(result.repairsFired).toBe(1);
    const fire = rec.fired[0];
    expect(fire.repair.prNumber).toBe(3171);
    expect(fire.repair.headRef).toBe(pr.headRef);
    expect(fire.repair.attemptId).toBe('row-1');
    expect(fire.initialPriorContext).toBe('Reviewer said: fix the null deref.');
    expect(fire.project).toBe('bdc-xo');
    expect(fire.woId).toBe(woId);
    expect(rec.acknowledged).toContain('row-1');
    expect(rec.addressed).toEqual([{ id: 'row-1', note: 'fired:casc-1' }]);
  });

  test('Test 4: duplicate_prs_collapse_to_one_survivor', async () => {
    const woId = 'WO-XO-CE-HEALTH-DIGEST-01';
    const prs = [
      lanePr({ prNumber: 3170, createdAt: '2026-10-14T01:50:02Z' }),
      lanePr({ prNumber: 3171, createdAt: '2026-10-14T01:59:02Z' }),
      lanePr({ prNumber: 3172, createdAt: '2026-10-14T02:27:34Z' }),
    ];
    const { deps, rec } = makeDeps({ dupeWos: [{ woId, prs }] });

    const result = await runPrRepairOwner(deps);

    expect(result.closedPrs).toBe(2);
    expect(rec.closed.map(c => c.prNumber).sort()).toEqual([3170, 3171]);
    for (const close of rec.closed) {
      expect(close.comment).toContain('Superseded by #3172');
      expect(close.comment).toContain('branch kept');
      expect(close.comment).not.toContain('delete');
    }
    // No candidates queued -> no repair, no digest line.
    expect(rec.fired).toHaveLength(0);
    expect(result.digestItems).toHaveLength(0);
  });

  test('Test 5: human_prs_untouched', async () => {
    const woId = 'WO-XO-CE-HEALTH-DIGEST-01';
    // No PR is lane-created: listLanePrsForWo returns [] and there are no dupe WOs.
    const { deps, rec } = makeDeps({
      laneByWo: { [woId]: [] },
      queued: [
        {
          id: 'row-human',
          body: candidateBody({
            prNumber: 999,
            headSha: 'whatever',
            woId,
            headRef: 'feat/human-typed-branch',
          }),
        },
      ],
    });

    const result = await runPrRepairOwner(deps);

    expect(rec.closed).toHaveLength(0);
    expect(rec.fired).toHaveLength(0);
    expect(result.repairsFired).toBe(0);
    expect(rec.addressed).toEqual([{ id: 'row-human', note: 'refused:not_lane_created' }]);
  });

  test('Test 6: cap_exhaustion_posts_one_digest_item', async () => {
    const woId = 'WO-SHOPOPS-STRIPE-ORPHANED-INVOICE-ATTRIBUTION-01';
    const { deps, rec } = makeDeps({
      queued: [
        {
          id: 'ex-1',
          body: exhaustedBody({ repo: 'shopops', prNumber: 873, woId, reason: 'attempt_cap' }),
        },
      ],
    });

    const first = await runPrRepairOwner(deps);
    expect(first.digestItems).toEqual([`thinmansoftware/shopops#873 ${woId} attempt_cap`]);
    expect(first.exhaustedRowIds).toEqual(['ex-1']);
    expect(rec.fired).toHaveLength(0);

    // The digest is sent by the caller; THEN the exhausted row is addressed.
    await first.commitExhausted();
    expect(rec.addressed).toEqual([{ id: 'ex-1', note: 'digested' }]);

    // A second tick on the same day: the row is addressed, so no second line.
    const second = await runPrRepairOwner(deps);
    expect(second.digestItems).toHaveLength(0);
    expect(second.exhaustedRowIds).toHaveLength(0);
  });

  test('Test 12: approved_non_survivor_never_closed', async () => {
    const woId = 'WO-XO-CE-HEALTH-DIGEST-01';
    const prs = [
      lanePr({ prNumber: 40, reviewDecision: 'APPROVED', createdAt: '2026-10-14T01:00:00Z' }),
      lanePr({ prNumber: 41, reviewDecision: 'APPROVED', createdAt: '2026-10-14T02:00:00Z' }),
    ];
    const { deps, rec } = makeDeps({ dupeWos: [{ woId, prs }] });

    const result = await runPrRepairOwner(deps);

    expect(rec.closed).toHaveLength(0);
    expect(result.closedPrs).toBe(0);
    expect(result.digestItems).toHaveLength(1);
    const item = result.digestItems[0];
    expect(item).toContain('dedupe_needs_human');
    expect(item).toContain('#40');
    expect(item).toContain('#41');
  });

  test('Test 13: stale_head_candidate_addressed_not_fired', async () => {
    const woId = 'WO-XO-CE-HEALTH-DIGEST-01';
    const pr = lanePr({ prNumber: 3171, headSha: 'live-head-ZZZ' });
    const { deps, rec } = makeDeps({
      laneByWo: { [woId]: [pr] },
      queued: [
        {
          id: 'row-stale',
          body: candidateBody({
            prNumber: 3171,
            headSha: 'stale-head-AAA',
            woId,
            headRef: pr.headRef,
          }),
        },
      ],
    });

    const result = await runPrRepairOwner(deps);

    expect(rec.fired).toHaveLength(0);
    expect(result.repairsFired).toBe(0);
    expect(rec.addressed).toEqual([{ id: 'row-stale', note: 'refused:stale_head' }]);
  });

  test('refuses a non-survivor repair candidate (superseded)', async () => {
    const woId = 'WO-XO-CE-HEALTH-DIGEST-01';
    const prs = [
      lanePr({ prNumber: 3171, headSha: 'head-3171', createdAt: '2026-10-14T01:59:02Z' }),
      lanePr({ prNumber: 3172, headSha: 'head-3172', createdAt: '2026-10-14T02:27:34Z' }),
    ];
    const { deps, rec } = makeDeps({
      laneByWo: { [woId]: prs },
      queued: [
        {
          id: 'row-old',
          body: candidateBody({
            prNumber: 3171,
            headSha: 'head-3171',
            woId,
            headRef: prs[0].headRef,
          }),
        },
      ],
    });

    await runPrRepairOwner(deps);

    expect(rec.fired).toHaveLength(0);
    expect(rec.addressed).toEqual([{ id: 'row-old', note: 'refused:superseded_by_#3172' }]);
  });

  test('resolves the candidate by full repo slug, not PR number alone (cross-repo)', async () => {
    const woId = 'WO-XO-CE-HEALTH-DIGEST-01';
    // Two lane PRs share PR number 3171 across different repos. The candidate
    // targets the shopops one; matching prNumber alone would pick bdc-xo and
    // repair the wrong PR.
    const wrongRepoPr = lanePr({
      owner: 'thinmansoftware',
      repo: 'bdc-xo',
      prNumber: 3171,
      headSha: 'head-xo-3171',
    });
    const targetPr = lanePr({
      owner: 'thinmansoftware',
      repo: 'shopops',
      prNumber: 3171,
      headRef: 'feat/wo-xo-ce-health-digest-01-shopops',
      headSha: 'head-shopops-3171',
    });
    const { deps, rec } = makeDeps({
      laneByWo: { [woId]: [wrongRepoPr, targetPr] },
      queued: [
        {
          id: 'row-xrepo',
          body: candidateBody({
            owner: 'thinmansoftware',
            repo: 'shopops',
            prNumber: 3171,
            headSha: 'head-shopops-3171',
            woId,
            headRef: targetPr.headRef,
          }),
        },
      ],
    });

    const result = await runPrRepairOwner(deps);

    expect(result.repairsFired).toBe(1);
    expect(rec.fired).toHaveLength(1);
    const fire = rec.fired[0];
    expect(fire.project).toBe('shopops');
    expect(fire.repair.headRef).toBe(targetPr.headRef);
  });

  test('refuses a candidate whose PR number matches only a different repo', async () => {
    const woId = 'WO-XO-CE-HEALTH-DIGEST-01';
    // The only lane PR with number 3171 lives in bdc-xo; the candidate claims
    // shopops. No same-repo match exists -> refused as not lane-created.
    const otherRepoPr = lanePr({
      owner: 'thinmansoftware',
      repo: 'bdc-xo',
      prNumber: 3171,
      headSha: 'head-xo-3171',
    });
    const { deps, rec } = makeDeps({
      laneByWo: { [woId]: [otherRepoPr] },
      queued: [
        {
          id: 'row-xrepo-miss',
          body: candidateBody({
            owner: 'thinmansoftware',
            repo: 'shopops',
            prNumber: 3171,
            headSha: 'head-shopops-3171',
            woId,
            headRef: 'feat/wo-xo-ce-health-digest-01-shopops',
          }),
        },
      ],
    });

    await runPrRepairOwner(deps);

    expect(rec.fired).toHaveLength(0);
    expect(rec.addressed).toEqual([{ id: 'row-xrepo-miss', note: 'refused:not_lane_created' }]);
  });

  test('skips a repair while a run for the WO is still running (row stays queued)', async () => {
    const woId = 'WO-XO-CE-HEALTH-DIGEST-01';
    const pr = lanePr({ prNumber: 3171, headSha: 'head-3171' });
    const { deps, rec } = makeDeps({
      laneByWo: { [woId]: [pr] },
      running: new Set([woId]),
      queued: [
        {
          id: 'row-run',
          body: candidateBody({
            prNumber: 3171,
            headSha: 'head-3171',
            woId,
            headRef: pr.headRef,
          }),
        },
      ],
    });

    await runPrRepairOwner(deps);

    expect(rec.fired).toHaveLength(0);
    expect(rec.acknowledged).toHaveLength(0);
    expect(rec.addressed).toHaveLength(0);
  });

  test('Test 15: idempotent_tick_twice', async () => {
    const woId = 'WO-XO-CE-HEALTH-DIGEST-01';
    const repairPr = lanePr({
      prNumber: 3180,
      headSha: 'head-3180',
      workflowName: 'bdc-feature-development',
    });
    const dupePrs = [
      lanePr({ prNumber: 3170, createdAt: '2026-10-14T01:50:02Z' }),
      lanePr({ prNumber: 3171, createdAt: '2026-10-14T01:59:02Z' }),
      lanePr({ prNumber: 3172, createdAt: '2026-10-14T02:27:34Z' }),
    ];
    const { deps, rec } = makeDeps({
      dupeWos: [{ woId: 'WO-DUP-01', prs: dupePrs }],
      laneByWo: { [woId]: [repairPr] },
      queued: [
        {
          id: 'row-1',
          body: candidateBody({
            prNumber: 3180,
            headSha: 'head-3180',
            woId,
            headRef: repairPr.headRef,
          }),
        },
      ],
    });

    await runPrRepairOwner(deps);
    expect(rec.fired).toHaveLength(1);
    expect(rec.closed).toHaveLength(2);

    // Second tick: the repaired row is addressed (excluded) and the swept PRs
    // are CLOSED, so no further effects.
    await runPrRepairOwner(deps);
    expect(rec.fired).toHaveLength(1);
    expect(rec.closed).toHaveLength(2);
  });
});

describe('buildSupersededComment', () => {
  test('is the exact runbook-pointing text', () => {
    expect(buildSupersededComment(3172, 'WO-XO-CE-HEALTH-DIGEST-01')).toBe(
      'Superseded by #3172 (lane PR dedupe for WO-XO-CE-HEALTH-DIGEST-01). ' +
        'Closed automatically by the PR repair owner; branch kept. ' +
        'Runbook: docs/operations/pr-repair-owner.md'
    );
  });
});
