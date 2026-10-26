/**
 * cascade-open-pr-guard.test.ts -- WO-HARNESS-PR-REPAIR-OWNER-AND-DEDUPE-01.
 *
 * Test 3:  open_pr_blocks_new_tier
 * Test 11: search_lag_race_registry_blocks_climb
 * Test 14: spec_pr_is_not_a_blocking_claim
 * Test 16: repair_cascade_single_attempt_no_climb
 * Test 17: lookup_failure_fails_closed_on_climb
 * Test 18: repair_admission_exempts_only_the_target_and_spec_pr
 *
 * All injected: no network, no real GitHub, no DB.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import * as registry from '@archon/core/db/lane-pr-registry';
import * as openPrGuard from '../open-pr-guard';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCascade } from '../cascade.js';
import type { CascadeDeps, RunCascadeOptions } from '../cascade.js';
import type { FireResult, PollResult, GateVerdict } from '../types.js';
import {
  findBlockingOpenPrs,
  createDefaultOpenPrGuardLookup,
  createGhLanePrFetcher,
  type OpenPrGuardLookup,
  type BlockingOpenPr,
} from '../open-pr-guard.js';
import { findWoClaim as realFindWoClaim, type WoClaim } from '../already-satisfied.js';

const WO = 'WO-XO-CE-HEALTH-DIGEST-01';
const SPEC_HEAD = 'wo/wo-xo-ce-health-digest-01';

test('production registry fetch errors retry once and refuse the climb', async () => {
  let directReads = 0;
  const execute = (async (_command: string, args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]', stderr: '' };
    directReads += 1;
    throw new Error('github_unavailable');
  }) as typeof import('@archon/git').execFileAsync;
  const spy = spyOn(registry, 'listLanePrsForWo').mockImplementation(async (_woId, options) => {
    await options.fetchPr('thinmansoftware', 'bdc-xo', 55);
    return [];
  });
  try {
    let failure: unknown;
    try {
      await findBlockingOpenPrs({
        woId: WO,
        project: 'bdc-xo',
        attemptRunIds: ['run'],
        lookup: createDefaultOpenPrGuardLookup(createGhLanePrFetcher(execute), execute),
        retryDelayMs: 0,
        sleep: async () => {},
      });
    } catch (error) {
      failure = error;
    }
    expect((failure as Error)?.message).toBe('github_unavailable');
    expect(directReads).toBe(2);
  } finally {
    spy.mockRestore();
  }
});

const testOutRoot = join(tmpdir(), `oguard-${randomUUID()}`);
// Record and lock writes are injected below; this path is an identity only.

function fireOk(runId: string): FireResult {
  return { ok: true, runId, conversationId: 'c', infraError: null };
}
function pollResult(): PollResult {
  return {
    runId: 'r',
    terminalStatus: 'failed',
    validatorVerdict: 'needs_revision',
    prUrl: null,
    prMergeable: null,
    servedModelId: null,
    rawMetadata: {},
  };
}
function failVerdict(): GateVerdict {
  return {
    pass: false,
    reason: 'no PR opened',
    cancelled: false,
    validatorVerdict: 'needs_revision',
    prOpened: false,
    prMergeable: null,
    terminalStatus: 'failed',
  };
}
function passVerdict(): GateVerdict {
  return {
    pass: true,
    reason: 'ok',
    cancelled: false,
    validatorVerdict: 'satisfied',
    prOpened: true,
    prMergeable: true,
    terminalStatus: 'completed',
  };
}

function baseOpts(partial: Partial<RunCascadeOptions> = {}): RunCascadeOptions {
  const { deps, ...options } = partial;
  return {
    woId: WO,
    woClass: 'CODE',
    tags: ['mechanical'],
    outDir: join(testOutRoot, randomUUID()),
    token: 'test-token',
    project: 'bdc-xo',
    apiBaseUrl: 'http://archon.test',
    ...options,
    deps: {
      fetchNodeTimeouts: async () => ({}),
      cancel: async () => {
        throw new Error('unexpected fixture cancellation');
      },
      findWoClaim: async () => null,
      acquireWoLock: async (woId, project, cascadeId) => ({
        acquired: true,
        path: 'in-memory',
        record: {
          woId,
          project,
          cascadeId,
          status: 'running',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      }),
      releaseWoLock: async () => {},
      findBlockingOpenPrs: async () => [],
      writeRecord: async () => '/tmp/rec.json',
      escalate: async () => {},
      ...deps,
    },
  };
}

function blockingPr(prNumber: number, headRef = `feat/x-${prNumber}`): BlockingOpenPr {
  return {
    owner: 'thinmansoftware',
    repo: 'bdc-xo',
    prNumber,
    headRef,
    prUrl: `https://github.com/thinmansoftware/bdc-xo/pull/${prNumber}`,
  };
}

describe('open-PR climb guard', () => {
  for (const mode of ['missing-token', 'hermetic'] as const) {
    test(`production default refuses unknown blockers under ${mode} instead of climbing`, async () => {
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      const previous = process.env.SMART_CAULDRON_HERMETIC;
      if (mode === 'hermetic') process.env.SMART_CAULDRON_HERMETIC = '1';
      else delete process.env.SMART_CAULDRON_HERMETIC;
      let lookups = 0,
        fires = 0;
      const lookupSpy = spyOn(openPrGuard, 'createDefaultOpenPrGuardLookup').mockReturnValue({
        searchOpenPrs: async () => {
          lookups++;
          throw new Error('fixture_read_unavailable');
        },
        registryAttributedPrs: async () => [],
        readPr: async () => null,
      });
      try {
        const options = baseOpts({
          entryOverride: 'codex',
          allowClaimed: true,
          deps: {
            fire: async () => fireOk(`run-${++fires}`),
            poll: async () => pollResult(),
            judge: () => failVerdict(),
          },
        });
        delete options.deps!.findBlockingOpenPrs;
        const result = await runCascade(options);
        expect(result.refusalReason?.reason).toBe('open-pr-lookup-failed');
        expect(fires).toBe(1);
        expect(lookups).toBe(2);
      } finally {
        lookupSpy.mockRestore();
        if (previous === undefined) delete process.env.SMART_CAULDRON_HERMETIC;
        else process.env.SMART_CAULDRON_HERMETIC = previous;
      }
    });
  }

  test('Test 3: open_pr_blocks_new_tier (runs even under allowClaimed)', async () => {
    const fires: string[] = [];
    const record = await runCascade(
      baseOpts({
        entryOverride: 'codex',
        allowClaimed: true,
        deps: {
          fire: async opts => {
            fires.push(opts.workflowName);
            return fireOk(`run-${fires.length}`);
          },
          poll: async () => pollResult(),
          judge: () => failVerdict(),
          // registry attributes OPEN #3171 to attempt 1; search found nothing.
          findBlockingOpenPrs: async () => [blockingPr(3171)],
        },
      })
    );
    expect(fires.length).toBe(1); // no climb to claude
    expect(record.status).toBe('refused');
    expect(record.refusalReason?.reason).toBe('open-pr-exists');
    expect(record.refusalReason?.prNumber).toBe(3171);
  });

  test('Test 11: search_lag_race_registry_blocks_climb', async () => {
    const fires: string[] = [];
    // Real guard bound with a fake lookup: search lags ([]), registry catches #9.
    const lookup: OpenPrGuardLookup = {
      searchOpenPrs: async () => [],
      registryAttributedPrs: async () => [
        { owner: 'thinmansoftware', repo: 'bdc-xo', prNumber: 9 },
      ],
      readPr: async () => ({ state: 'OPEN', headRef: 'feat/x-9', url: 'u/9' }),
    };
    const record = await runCascade(
      baseOpts({
        entryOverride: 'codex',
        deps: {
          findWoClaim: async () => null, // search-index lag: no claim
          fire: async opts => {
            fires.push(opts.workflowName);
            return fireOk(`run-${fires.length}`);
          },
          poll: async () => pollResult(),
          judge: () => failVerdict(),
          findBlockingOpenPrs: input =>
            findBlockingOpenPrs({ ...input, lookup, retryDelayMs: 0, sleep: async () => {} }),
        },
      })
    );
    expect(fires.length).toBe(1);
    expect(record.status).toBe('refused');
    expect(record.refusalReason?.reason).toBe('open-pr-exists');
    expect(record.refusalReason?.prNumber).toBe(9);
  });

  test('Test 14: spec_pr_is_not_a_blocking_claim', async () => {
    const lookup: OpenPrGuardLookup = {
      searchOpenPrs: async () => [
        {
          owner: 'thinmansoftware',
          repo: 'bdc-xo',
          prNumber: 100,
          state: 'OPEN',
          headRef: SPEC_HEAD,
          url: 'u/100',
          title: `Spec PR for ${WO}`,
          body: WO,
        },
      ],
      registryAttributedPrs: async () => [],
      readPr: async () => null,
    };
    const blocking = await findBlockingOpenPrs({
      woId: WO,
      project: 'bdc-xo',
      attemptRunIds: [],
      lookup,
      retryDelayMs: 0,
      sleep: async () => {},
    });
    expect(blocking).toHaveLength(0);
  });

  test('Test 16: repair_cascade_single_attempt_no_climb', async () => {
    const fires: string[] = [];
    let seenExclude: number | undefined;
    const record = await runCascade(
      baseOpts({
        entryOverride: 'codex',
        repair: { prNumber: 3172, headRef: 'feat/x-3172', attemptId: 'row-abc-12345678' },
        deps: {
          fire: async opts => {
            fires.push(opts.workflowName);
            return fireOk(`run-${fires.length}`);
          },
          poll: async () => pollResult(),
          judge: () => failVerdict(),
          findBlockingOpenPrs: async input => {
            seenExclude = input.excludePrNumber;
            return []; // target excluded -> no self-refusal
          },
        },
      })
    );
    expect(fires.length).toBe(1);
    expect(record.attempts.length).toBe(1);
    expect(record.telemetry.climbCount).toBe(0);
    expect(record.status).not.toBe('refused');
    expect(seenExclude).toBe(3172);
  });

  test('Test 17: lookup_failure_fails_closed_on_climb', async () => {
    // (a) the guard retries exactly once, then throws.
    let searchCalls = 0;
    const throwingLookup: OpenPrGuardLookup = {
      searchOpenPrs: async () => {
        searchCalls += 1;
        throw new Error('gh exploded');
      },
      registryAttributedPrs: async () => [],
      readPr: async () => null,
    };
    await expect(
      findBlockingOpenPrs({
        woId: WO,
        project: 'bdc-xo',
        attemptRunIds: [],
        lookup: throwingLookup,
        retryDelayMs: 0,
        sleep: async () => {},
      })
    ).rejects.toThrow('gh exploded');
    expect(searchCalls).toBe(2); // one retry

    // (b) the cascade maps that throw to a fail-closed refusal, no climb.
    const fires: string[] = [];
    const record = await runCascade(
      baseOpts({
        entryOverride: 'codex',
        deps: {
          fire: async opts => {
            fires.push(opts.workflowName);
            return fireOk(`run-${fires.length}`);
          },
          poll: async () => pollResult(),
          judge: () => failVerdict(),
          findBlockingOpenPrs: input =>
            findBlockingOpenPrs({
              ...input,
              lookup: throwingLookup,
              retryDelayMs: 0,
              sleep: async () => {},
            }),
        },
      })
    );
    expect(fires.length).toBe(1);
    expect(record.status).toBe('refused');
    expect(record.refusalReason?.reason).toBe('open-pr-lookup-failed');
  });

  describe('Test 18: repair_admission_exempts_only_the_target_and_spec_pr', () => {
    const specClaim: WoClaim = {
      number: 1,
      state: 'MERGED',
      title: `spec ${WO}`,
      url: 'u/spec',
      repo: 'thinmansoftware/bdc-xo',
      headRefName: SPEC_HEAD,
    };
    const target: WoClaim = {
      number: 3172,
      state: 'OPEN',
      title: WO,
      url: 'u/3172',
      repo: 'thinmansoftware/bdc-xo',
      headRefName: 'feat/wo-xo-ce-health-digest-01-3172',
    };
    const open3171: WoClaim = {
      number: 3171,
      state: 'OPEN',
      title: WO,
      url: 'u/3171',
      repo: 'thinmansoftware/bdc-xo',
      headRefName: 'feat/wo-xo-ce-health-digest-01-3171',
    };
    const mergedImpl: WoClaim = {
      number: 3000,
      state: 'MERGED',
      title: WO,
      url: 'u/3000',
      repo: 'thinmansoftware/bdc-xo',
      headRefName: 'feat/wo-xo-ce-health-digest-01-impl',
    };
    const sets = {
      a: [target, specClaim],
      b: [target, specClaim, open3171],
      c: [target, specClaim, mergedImpl],
    };

    function claimDep(claims: WoClaim[]): NonNullable<CascadeDeps['findWoClaim']> {
      return (woId, project, ignore) =>
        realFindWoClaim({ woId, project, ignore, lookup: async () => claims });
    }

    async function run(
      set: WoClaim[],
      repair: boolean
    ): Promise<Awaited<ReturnType<typeof runCascade>>> {
      const fires: string[] = [];
      const record = await runCascade(
        baseOpts({
          entryOverride: 'codex',
          ...(repair
            ? {
                repair: {
                  prNumber: 3172,
                  headRef: target.headRefName!,
                  attemptId: 'row-xyz-12345678',
                },
              }
            : {}),
          deps: {
            findWoClaim: claimDep(set),
            fire: async opts => {
              fires.push(opts.workflowName);
              return fireOk(`run-${fires.length}`);
            },
            poll: async () => pollResult(),
            judge: () => passVerdict(),
          },
        })
      );
      (record as { _fires?: number })._fires = fires.length;
      return record;
    }

    test('(a) repair admits and fires once; non-repair refuses', async () => {
      const repair = await run(sets.a, true);
      expect(repair.status).not.toBe('refused');
      expect((repair as { _fires?: number })._fires).toBe(1);

      const nonRepair = await run(sets.a, false);
      expect(nonRepair.status).toBe('refused');
      expect((nonRepair as { _fires?: number })._fires).toBe(0);
    });

    test('(b) repair refuses naming the other open lane PR #3171', async () => {
      const repair = await run(sets.b, true);
      expect(repair.status).toBe('refused');
      expect(repair.refusalReason?.prNumber).toBe(3171);

      const nonRepair = await run(sets.b, false);
      expect(nonRepair.status).toBe('refused');
    });

    test('(c) repair refuses naming the merged implementation PR', async () => {
      const repair = await run(sets.c, true);
      expect(repair.status).toBe('refused');
      expect(repair.refusalReason?.prNumber).toBe(3000);

      const nonRepair = await run(sets.c, false);
      expect(nonRepair.status).toBe('refused');
    });
  });
});
