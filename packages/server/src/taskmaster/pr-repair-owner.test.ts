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
import { Database } from 'bun:sqlite';
import {
  listWosWithMultipleLanePrs,
  type LanePr,
  type LanePrGithubInfo,
  type LanePrRegistryDb,
  type WoWithMultipleLanePrs,
} from '@archon/core/db/lane-pr-registry';
import {
  buildSupersededComment,
  resolvePrRepairDedupeWindowHours,
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
  queued?: Array<Pick<PrRepairQueuedMessage, 'id' | 'body'> & Partial<PrRepairQueuedMessage>>;
  running?: Set<string>;
  cascadeId?: string;
}

function makeDeps(config: HarnessConfig): { deps: PrRepairOwnerDeps; rec: Recorder } {
  const rec: Recorder = { closed: [], fired: [], acknowledged: [], addressed: [] };
  // Queued rows carry a local addressed flag so a re-read excludes them, exactly
  // as listMessages(status:'queued') would once addressed_by is set.
  const messages = (config.queued ?? []).map(m => ({
    sender: 'overseer',
    sender_principal_id: 'system:overseer',
    recipient: 'taskmaster',
    resolved_recipient: null,
    status: 'queued' as const,
    addressed_at: null,
    addressed_by: null,
    route_disposition: null,
    acknowledged_at: null,
    acknowledged_by: null,
    ...m,
    addressed: false,
  }));
  const laneByWo = config.laneByWo ?? {};
  const activeWos = config.running ?? new Set<string>();
  let cascadeSeq = 0;

  const deps: PrRepairOwnerDeps = {
    now: () => NOW,
    canApplyEffect: async () => true,
    fetchPr: async (owner, repo, number) => {
      const pr = [
        ...Object.values(laneByWo).flat(),
        ...(config.dupeWos ?? []).flatMap(entry => entry.prs),
      ].find(value => value.owner === owner && value.repo === repo && value.prNumber === number);
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
    listWosWithMultipleLanePrs: async () => ({
      groups: config.dupeWos ?? [],
      unresolved: [],
    }),
    listLanePrsForWo: async woId => laneByWo[woId] ?? [],
    listQueuedTaskmasterMessages: async () =>
      messages.filter(m => !m.addressed).map(m => ({ ...m })),
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
    hasRunningRunForWo: async woId => activeWos.has(woId),
    fireRepairCascade: async opts => {
      cascadeSeq += 1;
      const cascadeId = config.cascadeId ?? `casc-${cascadeSeq}`;
      rec.fired.push(opts);
      activeWos.add(opts.woId);
      opts.onAdmission?.({ cascadeId, status: 'running' });
      return { cascadeId, status: 'won' as const };
    },
    resolveEntryTier: () => undefined,
  };
  return { deps, rec };
}

function makeRegistryDb(): { db: LanePrRegistryDb; sqlite: Database } {
  const sqlite = new Database(':memory:');
  sqlite.run(
    `CREATE TABLE remote_agent_workflow_runs (
       id TEXT PRIMARY KEY,
       workflow_name TEXT,
       status TEXT,
       started_at TEXT,
       completed_at TEXT,
       user_message TEXT
     )`
  );
  sqlite.run(
    `CREATE TABLE remote_agent_workflow_events (
       id TEXT PRIMARY KEY,
       workflow_run_id TEXT,
       event_type TEXT,
       step_index INTEGER,
       step_name TEXT,
       data TEXT,
       created_at TEXT
     )`
  );
  const db: LanePrRegistryDb = {
    async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
      const translated = sql.replace(/\$\d+/g, '?');
      const rows = sqlite.query(translated).all(...(params as never[])) as T[];
      return { rows, rowCount: rows.length };
    },
  };
  return { db, sqlite };
}

let registryEventSeq = 0;

function seedLanePair(
  sqlite: Database,
  input: { runId: string; woId: string; repo: string; older: number; newer: number }
): void {
  sqlite.run(
    `INSERT INTO remote_agent_workflow_runs
       (id, workflow_name, status, started_at, completed_at, user_message)
     VALUES (?, 'bdc-feature-development', 'completed', ?, ?, ?)`,
    [
      input.runId,
      '2026-10-14T01:00:00Z',
      '2026-10-14T02:00:00Z',
      `WO_ID=${input.woId} --project ${input.repo}`,
    ]
  );
  const cite = (stepName: string, prNumber: number): void => {
    registryEventSeq += 1;
    sqlite.run(
      `INSERT INTO remote_agent_workflow_events
         (id, workflow_run_id, event_type, step_index, step_name, data, created_at)
       VALUES (?, ?, 'node_completed', 0, ?, ?, '2026-10-14T01:00:00Z')`,
      [
        `evt-${registryEventSeq}`,
        input.runId,
        stepName,
        JSON.stringify({
          output: `opened https://github.com/thinmansoftware/${input.repo}/pull/${prNumber}`,
        }),
      ]
    );
  };
  cite('implement', input.older);
  cite('open-pr-if-needed', input.newer);
}

function registryPr(
  owner: string,
  repo: string,
  prNumber: number,
  woId: string
): LanePrGithubInfo | null {
  if (owner !== 'thinmansoftware') return null;
  if (repo !== 'bdc-xo' && repo !== 'shopops') return null;
  const createdAt =
    prNumber === 202 || prNumber === 101 ? '2026-10-14T01:40:00Z' : '2026-10-14T01:10:00Z';
  return {
    number: prNumber,
    state: 'OPEN',
    reviewDecision: 'CHANGES_REQUESTED',
    createdAt,
    headRefName: `feat/${woId.toLowerCase()}-thread-${prNumber}`,
    headSha: `sha-${prNumber}`,
    headRepoFullName: `${owner}/${repo}`,
    baseRepoFullName: `${owner}/${repo}`,
    title: `Implement ${woId}`,
    body: `Closes ${woId}.`,
  };
}

describe('review repair regressions', () => {
  for (const [name, metadata] of [
    ['wrong sender', { sender: 'claude', sender_principal_id: 'session:claude' }],
    ['spoofed principal', { sender_principal_id: 'spoof:overseer' }],
    ['wrong routing', { resolved_recipient: 'operator' }],
    ['missing principal', { sender_principal_id: undefined }],
    [
      'stale acknowledgment',
      { acknowledged_by: 'taskmaster', acknowledged_at: '2026-10-14T01:59:59Z' },
    ],
    [
      'future acknowledgment',
      { acknowledged_by: 'taskmaster', acknowledged_at: '2026-10-14T03:00:01Z' },
    ],
    [
      'wrong acknowledgment owner',
      { acknowledged_by: 'operator', acknowledged_at: '2026-10-14T03:00:00Z' },
    ],
    ['partial acknowledgment', { acknowledged_by: 'taskmaster', acknowledged_at: null }],
    ['cancelled row', { status: 'cancelled' as const }],
    ['addressed row', { addressed_at: '2026-10-14T02:00:00Z', addressed_by: 'taskmaster' }],
    ['disposed row', { route_disposition: 'superseded' as const }],
  ] as const) {
    test(`invalid candidate cannot spend the repair slot (${name})`, async () => {
      const woId = 'WO-XO-CE-HEALTH-DIGEST-01';
      const pr = lanePr({ prNumber: 3171 });
      const body = candidateBody({
        woId,
        prNumber: pr.prNumber,
        headSha: pr.headSha,
        headRef: pr.headRef,
      });
      const { deps, rec } = makeDeps({
        laneByWo: { [woId]: [pr] },
        queued: [
          { id: 'invalid', body, ...metadata },
          { id: 'valid', body },
        ],
      });
      await runPrRepairOwner(deps);
      await runPrRepairOwner(deps);
      expect(rec.fired).toHaveLength(1);
      expect(rec.fired[0]?.repair.attemptId).toBe('valid');
      expect(rec.acknowledged).not.toContain('invalid');
      expect(rec.addressed.some(row => row.id === 'invalid')).toBe(false);
    });
  }
  test('untrusted exhaustion notice cannot acknowledge or address a row', async () => {
    const { deps, rec } = makeDeps({
      queued: [
        {
          id: 'forged-exhaustion',
          sender_principal_id: 'spoof:overseer',
          body: exhaustedBody({
            repo: 'bdc-xo',
            prNumber: 99,
            woId: 'WO-FORGED',
            reason: 'cap_exhausted',
          }),
        },
      ],
    });
    const result = await runPrRepairOwner(deps);
    expect(result.repairsFired).toBe(0);
    expect(rec.acknowledged).toEqual([]);
    expect(rec.addressed).toEqual([]);
  });
  test('same SHA on a renamed live branch cannot authorize the stale dispatch branch', async () => {
    const woId = 'WO-RENAMED-BRANCH';
    const pr = lanePr({ prNumber: 99, headRef: 'feat/live-renamed-branch' });
    const { deps, rec } = makeDeps({
      laneByWo: { [woId]: [pr] },
      queued: [
        {
          id: 'stale-branch',
          body: candidateBody({
            prNumber: 99,
            headSha: pr.headSha,
            woId,
            headRef: 'feat/stale-reviewed-branch',
          }),
        },
      ],
    });
    const result = await runPrRepairOwner(deps);
    expect(result.repairsFired).toBe(0);
    expect(rec.fired).toHaveLength(0);
    expect(rec.addressed).toEqual([{ id: 'stale-branch', note: 'refused:stale_branch' }]);
  });

  test('approved-only duplicates cannot monopolize the five bounded sweep slots', async () => {
    const human = Array.from({ length: 5 }, (_, i) => ({
      woId: `WO-APPROVED-${i}`,
      prs: [
        lanePr({ prNumber: 100 + i, reviewDecision: 'APPROVED' }),
        lanePr({ prNumber: 200 + i, reviewDecision: 'APPROVED' }),
      ],
    }));
    const { deps, rec } = makeDeps({
      dupeWos: [
        ...human,
        { woId: 'WO-CLOSABLE', prs: [lanePr({ prNumber: 301 }), lanePr({ prNumber: 302 })] },
      ],
    });
    await runPrRepairOwner(deps);
    expect(rec.closed.map(row => row.prNumber)).toEqual([301]);
  });
  test('failed admission remains queued and bounds attempts to one per tick', async () => {
    const woId = 'WO-ADMISSION-FAIL';
    const pr = lanePr({ prNumber: 99 });
    const body = candidateBody({ woId, prNumber: 99, headSha: pr.headSha, headRef: pr.headRef });
    const { deps, rec } = makeDeps({
      laneByWo: { [woId]: [pr] },
      queued: [
        { id: 'one', body },
        { id: 'two', body },
      ],
    });
    let calls = 0;
    deps.fireRepairCascade = async () => {
      calls++;
      throw new Error('temporary_admission_failure');
    };
    const result = await runPrRepairOwner(deps);
    expect(calls).toBe(1);
    expect(result.repairsFired).toBe(0);
    expect(rec.addressed).toHaveLength(0);
    expect(result.digestItems.join(' ')).toContain('repair_admission_failed');
  });
  test('a failed candidate-specific close cannot admit a repair over another open PR', async () => {
    const woId = 'WO-CLOSE-FAIL';
    const prs = [lanePr({ prNumber: 1 }), lanePr({ prNumber: 2 })];
    const { deps, rec } = makeDeps({
      laneByWo: { [woId]: prs },
      queued: [
        {
          id: 'held',
          body: candidateBody({
            woId,
            prNumber: 2,
            headSha: prs[1].headSha,
            headRef: prs[1].headRef,
          }),
        },
      ],
    });
    deps.closePr = async () => {
      throw new Error('close_failed');
    };
    const result = await runPrRepairOwner(deps);
    expect(rec.fired).toHaveLength(0);
    expect(rec.addressed).toHaveLength(0);
    expect(result.digestItems.join(' ')).toContain('repair_waiting_for_dedupe');
  });

  test('candidate-specific dedupe runs even when the WO was absent from the bounded sweep', async () => {
    const woId = 'WO-OUTSIDE-SWEEP';
    const prs = [lanePr({ prNumber: 1 }), lanePr({ prNumber: 2 })];
    const { deps, rec } = makeDeps({
      laneByWo: { [woId]: prs },
      queued: [
        {
          id: 'repair-survivor',
          body: candidateBody({
            woId,
            prNumber: 2,
            headSha: prs[1].headSha,
            headRef: prs[1].headRef,
          }),
        },
      ],
    });
    await runPrRepairOwner(deps);
    expect(rec.closed.map(row => row.prNumber)).toEqual([1]);
    expect(rec.fired).toHaveLength(1);
    expect(prs.filter(pr => pr.state === 'OPEN').map(pr => pr.prNumber)).toEqual([2]);
  });
  for (const status of ['refused', 'blocked', 'planned'] as const) {
    test(`unstarted ${status} cascade never consumes the repair candidate`, async () => {
      const woId = 'WO-UNSTARTED';
      const pr = lanePr({ prNumber: 99 });
      const { deps, rec } = makeDeps({
        laneByWo: { [woId]: [pr] },
        queued: [
          {
            id: 'recoverable',
            body: candidateBody({
              woId,
              prNumber: 99,
              headSha: pr.headSha,
              headRef: pr.headRef,
            }),
          },
        ],
      });
      let attempts = 0;
      deps.fireRepairCascade = async opts => {
        attempts++;
        const result = { cascadeId: 'unstarted', status };
        if (status === 'blocked') opts.onAdmission?.(result);
        return result;
      };
      const first = await runPrRepairOwner(deps);
      const second = await runPrRepairOwner(deps);
      expect(first.repairsFired + second.repairsFired).toBe(0);
      expect(rec.addressed).toHaveLength(0);
      expect(attempts).toBe(2);
    });
  }

  for (const changed of ['victim_approved', 'survivor_closed', 'paused_during_reads']) {
    test(`close revalidates current eligibility: ${changed}`, async () => {
      const prs = [lanePr({ prNumber: 1 }), lanePr({ prNumber: 2 })];
      const { deps, rec } = makeDeps({
        dupeWos: [{ woId: 'WO-RACE', prs }],
        laneByWo: { 'WO-RACE': prs },
      });
      const fetcher = deps.fetchPr;
      let running = true;
      Object.assign(deps, { canApplyEffect: async () => running });
      deps.fetchPr = async (owner, repo, number) => {
        const current = await fetcher(owner, repo, number);
        if (!current) return current;
        if (changed === 'paused_during_reads') running = false;
        if (changed === 'victim_approved' && number === 1)
          return { ...current, reviewDecision: 'APPROVED' };
        if (changed === 'survivor_closed' && number === 2) return { ...current, state: 'CLOSED' };
        return current;
      };
      await runPrRepairOwner(deps);
      expect(rec.closed).toHaveLength(0);
    });
  }
  test('pause after acknowledgement prevents cascade admission', async () => {
    const woId = 'WO-PAUSE';
    const pr = lanePr({ prNumber: 99 });
    const { deps, rec } = makeDeps({
      laneByWo: { [woId]: [pr] },
      queued: [
        {
          id: 'row-pause',
          body: candidateBody({
            woId,
            prNumber: 99,
            headSha: pr.headSha,
            headRef: pr.headRef,
          }),
        },
      ],
    });
    let running = true;
    Object.assign(deps, { canApplyEffect: async () => running });
    const acknowledge = deps.acknowledgeRow;
    deps.acknowledgeRow = async id => {
      await acknowledge(id);
      running = false;
    };
    await runPrRepairOwner(deps);
    expect(rec.fired).toHaveLength(0);
    expect(rec.addressed).toHaveLength(0);
  });

  test('historical closed duplicates do not consume the five actionable WO slots', async () => {
    const historical = Array.from({ length: 5 }, (_, i) => ({
      woId: `WO-CLOSED-${i}`,
      prs: [lanePr({ prNumber: 100 + i, state: 'CLOSED' }), lanePr({ prNumber: 200 + i })],
    }));
    const { deps, rec } = makeDeps({
      dupeWos: [
        ...historical,
        {
          woId: 'WO-ACTIVE',
          prs: [lanePr({ prNumber: 301 }), lanePr({ prNumber: 302 })],
        },
      ],
    });
    await runPrRepairOwner(deps);
    expect(rec.closed.map(row => row.prNumber)).toEqual([301]);
  });

  test('non-object JSON never poisons subsequent repair and exhausted messages', async () => {
    const woId = 'WO-GOOD';
    const pr = lanePr({ prNumber: 401 });
    const { deps, rec } = makeDeps({
      laneByWo: { [woId]: [pr] },
      queued: [
        ...['null', 'true', '1', '[]', '"text"'].map((body, i) => ({ id: `bad-${i}`, body })),
        {
          id: 'valid',
          body: candidateBody({ prNumber: 401, headSha: pr.headSha, headRef: pr.headRef, woId }),
        },
        {
          id: 'exhausted',
          body: exhaustedBody({ repo: 'bdc-xo', prNumber: 402, woId, reason: 'cap' }),
        },
      ],
    });
    const result = await runPrRepairOwner(deps);
    expect(rec.fired).toHaveLength(1);
    expect(result.exhaustedRowIds).toEqual(['exhausted']);
    expect(result.digestItems).toHaveLength(1);
  });

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
    // Admission is not authority consumption; only the authority transaction addresses it.
    expect(rec.addressed).toHaveLength(0);
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

    // Second tick: the admitted run is pending/running and the swept PRs are
    // CLOSED. The owner cannot refire while authority binding is in flight.
    await runPrRepairOwner(deps);
    expect(rec.fired).toHaveLength(1);
    expect(rec.closed).toHaveLength(2);
  });

  test('fetch_failure_one_wo_does_not_block_other_wo_or_exhaustion', async () => {
    const woA = 'WO-HARNESS-FETCH-FAIL-A-01';
    const woB = 'WO-HARNESS-FETCH-FAIL-B-01';
    const exhaustedWo = 'WO-SHOPOPS-STRIPE-ORPHANED-INVOICE-ATTRIBUTION-01';
    const { db, sqlite } = makeRegistryDb();
    seedLanePair(sqlite, {
      runId: 'run-a',
      woId: woA,
      repo: 'bdc-xo',
      older: 102,
      newer: 101,
    });
    seedLanePair(sqlite, {
      runId: 'run-b',
      woId: woB,
      repo: 'shopops',
      older: 201,
      newer: 202,
    });
    const { deps, rec } = makeDeps({
      queued: [
        {
          id: 'ex-iso',
          body: exhaustedBody({
            repo: 'shopops',
            prNumber: 873,
            woId: exhaustedWo,
            reason: 'attempt_cap',
          }),
        },
      ],
    });
    deps.fetchPr = async (owner, repo, prNumber) => {
      if (owner === 'thinmansoftware' && repo === 'bdc-xo' && prNumber === 101) {
        throw new Error('github_transient_failure');
      }
      return registryPr(owner, repo, prNumber, repo === 'shopops' ? woB : woA);
    };
    deps.listWosWithMultipleLanePrs = opts => listWosWithMultipleLanePrs({ ...opts, db });

    try {
      const result = await runPrRepairOwner(deps);
      expect(rec.closed).toEqual([
        expect.objectContaining({
          prNumber: 201,
          comment: expect.stringContaining('Superseded by #202'),
        }),
      ]);
      expect(rec.closed.some(close => close.prNumber === 101 || close.prNumber === 102)).toBe(
        false
      );
      expect(result.digestItems).toEqual([
        `thinmansoftware/shopops#873 ${exhaustedWo} attempt_cap`,
      ]);
      await result.commitExhausted();
      expect(rec.addressed).toEqual([{ id: 'ex-iso', note: 'digested' }]);
    } finally {
      sqlite.close();
    }
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

test('dedupe window accepts positive hours and rejects invalid configuration', () => {
  for (const raw of [undefined, '', '0', '-1', 'bad', 'Infinity']) {
    expect(resolvePrRepairDedupeWindowHours(raw)).toBe(168);
  }
  expect(resolvePrRepairDedupeWindowHours('24')).toBe(24);
  expect(resolvePrRepairDedupeWindowHours('12.5')).toBe(12.5);
});
