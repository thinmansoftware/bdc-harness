import { describe, expect, test } from 'bun:test';
import type { LanePr } from '@archon/core/db/lane-pr-registry';
import {
  resolveRepairOwner,
  runPrRepairOwner,
  type PrRepairOwnerDeps,
  type PrRepairQueuedMessage,
} from './pr-repair-owner';

const WO = 'WO-HARNESS-PR-REPAIR-OWNER-AND-DEDUPE-01';
const NOW = Date.parse('2026-10-21T12:00:00Z');
function pr(number: number): LanePr {
  return {
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    prNumber: number,
    headRef: `feat/repair-${number}`,
    headSha: `sha-${number}`,
    state: 'OPEN',
    reviewDecision: 'CHANGES_REQUESTED',
    createdAt: `2026-10-21T10:0${number}:00Z`,
    runId: `run-${number}`,
    workflowName: 'bdc-feature-development-codex',
  };
}
function message(id: string, body: object): PrRepairQueuedMessage {
  return {
    id,
    body: JSON.stringify(body),
    sender: 'overseer',
    sender_principal_id: 'system:overseer',
    recipient: 'taskmaster',
    resolved_recipient: null,
    status: 'queued',
    addressed_at: null,
    addressed_by: null,
    route_disposition: null,
    acknowledged_at: null,
    acknowledged_by: null,
  };
}
function harness(queued: PrRepairQueuedMessage[], laneByWo: Record<string, LanePr[]> = {}) {
  const acknowledged: string[] = [],
    addressed: Array<[string, string]> = [],
    nudges: Array<{ recipient: string; body: string }> = [],
    closed: number[] = [];
  const deps: PrRepairOwnerDeps = {
    now: () => NOW,
    planEffects: true,
    fetchPr: async (owner, repo, number) => {
      const found = Object.values(laneByWo)
        .flat()
        .find(x => x.owner === owner && x.repo === repo && x.prNumber === number);
      return found
        ? {
            number,
            state: found.state,
            reviewDecision: found.reviewDecision,
            createdAt: found.createdAt,
            headRefName: found.headRef,
            headSha: found.headSha,
            headRepoFullName: `${owner}/${repo}`,
            baseRepoFullName: `${owner}/${repo}`,
            title: WO,
            body: '',
          }
        : null;
    },
    listWosWithMultipleLanePrs: async () => ({ groups: [], unresolved: [] }),
    listLanePrsForWo: async woId => laneByWo[woId] ?? [],
    listQueuedTaskmasterMessages: async () => queued,
    acknowledgeRow: async id => {
      acknowledged.push(id);
    },
    addressRow: async (id, note) => {
      addressed.push([id, note]);
    },
    closePr: async input => {
      closed.push(input.prNumber);
    },
    hasRunningRunForWo: async () => false,
    listOwnerIssues: async () => [
      {
        title: `Build ${WO}`,
        state: 'open',
        labels: ['owner:major-build'],
        ownerLogin: 'captain-ci',
      },
    ],
    resolveRecipient: login => (login === 'captain-ci' ? 'captain-ci' : 'xo'),
    createOwnerNudge: async input => {
      nudges.push(input);
      return { body: input.body };
    },
  };
  return { deps, acknowledged, addressed, nudges, closed };
}

describe('repair owner routing', () => {
  test('unresolved candidate remains queued until its exact line is in the persisted digest', async () => {
    const target = pr(1120);
    const row = message('unresolved-candidate', {
      kind: 'overseer_remediation_candidate',
      owner: target.owner,
      repo: target.repo,
      prNumber: target.prNumber,
      headSha: target.headSha,
      woId: WO,
      headRef: target.headRef,
      findingClasses: ['lane_repair'],
      verdictBody: 'Fix it.',
    });
    const h = harness([row], { [WO]: [target] });
    h.deps.listOwnerIssues = async () => [];
    const result = await runPrRepairOwner(h.deps);
    expect(result.digestItems).toHaveLength(1);
    expect(h.acknowledged).toEqual([]);
    expect(h.addressed).toEqual([]);
    await result.commitDigestLines(
      'A previously persisted digest without this notice.',
      new Set([result.effects[0].proposal.idempotencyKey])
    );
    expect(h.addressed).toEqual([]);
    await result.commitDigestLines(
      result.digestItems[0],
      new Set([result.effects[0].proposal.idempotencyKey])
    );
    expect(h.acknowledged).toEqual(['unresolved-candidate']);
    expect(h.addressed).toEqual([['unresolved-candidate', 'owner_unresolved']]);
  });

  test('an identical persisted line cannot consume an unadmitted sibling row', async () => {
    const body = {
      kind: 'overseer_remediation_exhausted',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 8,
      headSha: 'head',
      woId: null,
      reason: 'outside_cauldron',
    };
    const h = harness([message('admitted', body), message('withheld', body)]);
    const result = await runPrRepairOwner(h.deps);
    expect(result.digestItems[0]).toBe(result.digestItems[1]);
    const admitted = result.effects.find(effect => effect.sourceRowId === 'admitted')!;
    await result.commitDigestLines(
      result.digestItems[0],
      new Set([admitted.proposal.idempotencyKey])
    );
    expect(h.addressed).toEqual([['admitted', 'digested']]);
  });

  test('non-consuming diagnostic lines all use the same digest-item admission seam', async () => {
    const first = { ...pr(1), reviewDecision: 'APPROVED' as const };
    const second = { ...pr(2), reviewDecision: 'APPROVED' as const };
    const invalid = message('invalid-ack', {
      kind: 'overseer_remediation_candidate',
      owner: first.owner,
      repo: first.repo,
      prNumber: 1,
      headSha: first.headSha,
      headRef: first.headRef,
      woId: WO,
      findingClasses: ['lane_repair'],
      verdictBody: 'Fix it.',
    });
    invalid.acknowledged_by = 'foreign';
    invalid.acknowledged_at = new Date(NOW).toISOString();
    const h = harness([invalid], { [WO]: [first, second] });
    h.deps.listWosWithMultipleLanePrs = async () => ({
      groups: [{ woId: WO, prs: [first, second] }],
      unresolved: [],
    });
    const result = await runPrRepairOwner(h.deps);
    expect(result.digestItems).toHaveLength(2);
    expect(
      result.effects
        .filter(effect => effect.kind === 'digest_item')
        .map(effect => effect.digestLine)
    ).toEqual(result.digestItems);
    await result.commitDigestLines(
      result.digestItems.join('\n'),
      new Set(result.effects.map(effect => effect.proposal.idempotencyKey))
    );
    expect(h.acknowledged).toEqual([]);
  });

  test('deferred successful closure reports its actual completed count', async () => {
    const older = pr(1),
      newer = pr(2);
    const h = harness([], { [WO]: [older, newer] });
    h.deps.listWosWithMultipleLanePrs = async () => ({
      groups: [{ woId: WO, prs: [older, newer] }],
      unresolved: [],
    });
    const result = await runPrRepairOwner(h.deps);
    expect(result.closedPrs).toBe(0);
    await result.effects.find(effect => effect.kind === 'dedupe_close')!.apply();
    expect(h.closed).toEqual([1]);
    expect(result.closedPrs).toBe(1);
  });

  for (const change of [
    'victim-approved',
    'survivor-closed',
    'victim-head',
    'victim-branch',
    'survivor-head',
    'missing-victim',
  ] as const) {
    test(`deferred close rechecks ${change} immediately before its effect`, async () => {
      const older = pr(1),
        newer = pr(2);
      const h = harness([], { [WO]: [older, newer] });
      h.deps.listWosWithMultipleLanePrs = async () => ({
        groups: [{ woId: WO, prs: [older, newer] }],
        unresolved: [],
      });
      const fetchPr = h.deps.fetchPr;
      let changed = false;
      h.deps.fetchPr = async (owner, repo, number) => {
        const live = await fetchPr(owner, repo, number);
        if (!changed || !live) return live;
        if (number === 1 && change === 'victim-approved')
          return { ...live, reviewDecision: 'APPROVED' };
        if (number === 2 && change === 'survivor-closed') return { ...live, state: 'CLOSED' };
        if (number === 1 && change === 'victim-head') return { ...live, headSha: 'new-head' };
        if (number === 1 && change === 'victim-branch')
          return { ...live, headRefName: 'other-branch' };
        if (number === 2 && change === 'survivor-head') return { ...live, headSha: 'new-head' };
        if (number === 1 && change === 'missing-victim') return null;
        return live;
      };
      const result = await runPrRepairOwner(h.deps);
      const effect = result.effects.find(value => value.kind === 'dedupe_close');
      expect(effect).toBeDefined();
      changed = true;
      expect(await effect!.apply()).toEqual({ applied: false });
      expect(h.closed).toEqual([]);
      expect(result.closedPrs).toBe(0);
    });
  }

  test('interim_cauldron_built_candidate_routes_to_owner_never_fires', async () => {
    const target = pr(1120),
      row = message('candidate-1', {
        kind: 'overseer_remediation_candidate',
        owner: target.owner,
        repo: target.repo,
        prNumber: target.prNumber,
        headSha: target.headSha,
        woId: WO,
        headRef: target.headRef,
        findingClasses: ['lane_repair'],
        verdictBody: 'Fix it.',
      });
    const h = harness([row], { [WO]: [target] }),
      result = await runPrRepairOwner(h.deps);
    expect(result.repairsFired).toBe(0);
    expect(result.effects).toHaveLength(1);
    await result.effects[0].apply();
    expect(h.nudges[0].recipient).toBe('major-build');
    expect(h.nudges[0].body).toContain('cauldron_repair_pending');
    expect(h.addressed).toEqual([['candidate-1', 'routed_to_owner:major-build']]);
  });
  test('overseer_handoff_of_cauldron_pr_routes_to_owner', async () => {
    const row = message('handoff-1', {
      kind: 'overseer_remediation_exhausted',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 1120,
      prUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/1120',
      headSha: 'abc',
      headRef: 'feat/x',
      woId: WO,
      owningLane: 'lane',
      buildLine: 'cauldron',
      reason: 'non_auto_finding',
      lastVerdictSummary: 'Needs design work.',
    });
    const h = harness([row]),
      result = await runPrRepairOwner(h.deps);
    await result.effects[0].apply();
    expect(h.nudges).toHaveLength(1);
    expect(h.addressed).toEqual([['handoff-1', 'routed_to_owner:major-build']]);
  });
  test('outside_cauldron_handoff_routes_to_owner_not_xo', async () => {
    const a = message('outside-1', {
      kind: 'overseer_remediation_exhausted',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 8,
      headSha: 'a',
      woId: WO,
      buildLine: 'outside',
      reason: 'outside_cauldron',
    });
    const b = message('outside-2', {
      kind: 'overseer_remediation_exhausted',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 9,
      headSha: 'b',
      woId: null,
      buildLine: 'outside',
      reason: 'outside_cauldron',
    });
    const h = harness([a, b]),
      result = await runPrRepairOwner(h.deps);
    expect(result.digestItems[0]).toContain('repair_owner_unresolved:no_wo');
    expect(result.effects.map(x => x.kind)).toEqual(['owner_nudge', 'digest_item']);
    await result.effects[0].apply();
    expect(h.nudges.every(x => x.recipient !== 'xo' && x.recipient !== 'operator')).toBe(true);
  });
  test('owner label wins and forbidden assignee mappings are unresolved', async () => {
    expect(await resolveRepairOwner(WO, harness([]).deps)).toBe('major-build');
    const h = harness([]);
    h.deps.listOwnerIssues = async () => [
      { title: WO, state: 'open', labels: [], ownerLogin: 'unknown' },
    ];
    expect(await resolveRepairOwner(WO, h.deps)).toBeNull();
  });
  test('fetch_failure_one_wo_does_not_block_other_wo_or_exhaustion', async () => {
    const h = harness(
      [
        message('notice', {
          kind: 'overseer_remediation_exhausted',
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
          prNumber: 4,
          woId: WO,
          reason: 'attempt_cap',
        }),
      ],
      { [WO]: [pr(1), pr(2)] }
    );
    h.deps.listWosWithMultipleLanePrs = async () => ({
      groups: [{ woId: WO, prs: [pr(1), pr(2)] }],
      unresolved: [
        {
          woId: 'WO-BAD-LOOKUP-01',
          owner: 'thinmansoftware',
          repo: 'bdc-xo',
          prNumber: 1,
          error: 'github_transient_failure',
        },
      ],
    });
    const result = await runPrRepairOwner(h.deps);
    expect(result.effects.filter(x => x.kind === 'dedupe_close')).toHaveLength(1);
    expect(result.effects.some(x => x.kind === 'owner_nudge')).toBe(true);
  });
});
