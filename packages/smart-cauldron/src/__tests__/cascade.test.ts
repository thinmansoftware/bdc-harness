/**
 * cascade.test.ts -- Test scenarios 2-6 for Smart Cauldron v1.0 cascade orchestrator.
 *
 * All tests use CascadeDeps injection -- no live API calls.
 * Fire, poll, judge, escalate, and writeRecord are all stubbed.
 *
 * Test 2: CLIMB-ON-GATE-FAIL -- gate fails on tier 0, passes on tier 1
 * Test 3: WIN-CHEAP -- gate passes on entry tier (no climb)
 * Test 4: INFRA-ERROR vs GATE-FAIL -- infra error triggers alert, not climb
 * Test 5: FRONTIER-STOP -- frontier gate-fail -> BLOCKED + alert, no infinite loop
 * Test 6: WRAPPER -- cascade does not touch DAG/workflow internals
 */

import { describe, test, expect } from 'bun:test';
import { runCascade } from '../cascade.js';
import type { CascadeDeps, RunCascadeOptions } from '../cascade.js';
import type { FireResult, PollResult, GateVerdict, CascadeRunRecord } from '../types.js';
import { loadLadder } from '../ladder.js';
import { loadRuleset } from '../conductor.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** A PollResult that trivially exists (used when only the gate stub matters) */
function makePollResult(overrides?: Partial<PollResult>): PollResult {
  return {
    runId: 'run-stub',
    terminalStatus: 'completed',
    validatorVerdict: 'satisfied',
    prUrl: 'https://github.com/org/repo/pull/1',
    prMergeable: true,
    servedModelId: null,
    rawMetadata: {},
    ...overrides,
  };
}

function makeFireOk(runId: string, conversationId = 'conv-stub'): FireResult {
  return { ok: true, runId, conversationId, infraError: null };
}

function makeFireError(infraError: string, conversationId = 'conv-stub'): FireResult {
  return { ok: false, runId: null, conversationId, infraError };
}

function makePassVerdict(): GateVerdict {
  return {
    pass: true,
    reason: 'all gate conditions passed',
    validatorVerdict: 'satisfied',
    prOpened: true,
    prMergeable: true,
    terminalStatus: 'completed',
  };
}

function makeFailVerdict(reason: string): GateVerdict {
  return {
    pass: false,
    reason,
    validatorVerdict: 'needs_revision',
    prOpened: false,
    prMergeable: null,
    terminalStatus: 'failed',
  };
}

/** Build a minimal 2-tier stub ladder (for frontier test) */
const TWO_TIER_STUB = [
  { name: 'cheap', workflowName: 'bdc-test-cheap', isFrontier: false, costPerRunUsd: 0.001 },
  { name: 'frontier', workflowName: 'bdc-test-frontier', isFrontier: true, costPerRunUsd: null },
];

/** Build base options pointing to the real config (entry defaults to "glm") */
function baseOpts(partial: Partial<RunCascadeOptions> = {}): RunCascadeOptions {
  return {
    woId: 'WO-TEST-001',
    woClass: 'CODE',
    tags: ['mechanical'],
    outDir: '/tmp/smart-cauldron-test-runs',
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Test 2: CLIMB-ON-GATE-FAIL
// ---------------------------------------------------------------------------

describe('Test 2: CLIMB-ON-GATE-FAIL', () => {
  test('gate fails on tier 0, cascades to tier 1 which passes; record reflects climb', async () => {
    const fireCalls: string[] = [];
    let fireCallIndex = 0;
    const fireIds = ['run-1', 'run-2'];

    const deps: CascadeDeps = {
      fire: async opts => {
        fireCalls.push(opts.workflowName);
        const id = fireIds[fireCallIndex++] ?? 'run-x';
        return makeFireOk(id);
      },
      poll: async _opts => makePollResult(),
      judge: _poll => {
        // First call fails, second passes
        if (fireCalls.length === 1) return makeFailVerdict('validator verdict: needs_revision');
        return makePassVerdict();
      },
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => {
        return `/tmp/cascade-record-${record.cascadeId}.json`;
      },
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(record.attempts.length).toBe(2);
    expect(record.attempts[0]?.outcome).toBe('gate-failed');
    expect(record.attempts[1]?.outcome).toBe('won');
    expect(record.status).toBe('won');
    expect(record.telemetry.climbed).toBe(true);
    expect(record.telemetry.climbCount).toBe(1);
    expect(record.telemetry.wonCheap).toBe(false);

    // Second fire used the next tier's workflowName
    const tiers = loadLadder();
    const entryTier = tiers.find(t => t.name === 'glm');
    const nextTier = tiers[tiers.findIndex(t => t.name === 'glm') + 1];
    expect(fireCalls[0]).toBe(entryTier?.workflowName);
    expect(fireCalls[1]).toBe(nextTier?.workflowName);
  });
});

// ---------------------------------------------------------------------------
// Test 3: WIN-CHEAP
// ---------------------------------------------------------------------------

describe('Test 3: WIN-CHEAP', () => {
  test('entry tier passes gate; no second fire; wonCheap=true', async () => {
    let fireCount = 0;

    const deps: CascadeDeps = {
      fire: async _opts => {
        fireCount++;
        return makeFireOk('run-cheap');
      },
      poll: async _opts => makePollResult(),
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(fireCount).toBe(1);
    expect(record.status).toBe('won');
    expect(record.telemetry.wonCheap).toBe(true);
    expect(record.telemetry.climbed).toBe(false);
    expect(record.telemetry.climbCount).toBe(0);
    expect(record.winningTier).toBe('glm');
    expect(record.attempts.length).toBe(1);
    expect(record.attempts[0]?.outcome).toBe('won');
  });
});

// ---------------------------------------------------------------------------
// Test 4: INFRA-ERROR vs GATE-FAIL
// ---------------------------------------------------------------------------

describe('Test 4: INFRA-ERROR vs GATE-FAIL', () => {
  test('401 fire error -> infra-alert status; poll NOT called; escalate called; outcome != gate-failed', async () => {
    let pollCalled = false;
    let escalateCalled = false;

    const deps: CascadeDeps = {
      fire: async _opts => makeFireError('HTTP 401: Unauthorized'),
      poll: async _opts => {
        pollCalled = true;
        return makePollResult();
      },
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        escalateCalled = true;
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(record.status).toBe('infra-alert');
    expect(record.attempts.length).toBe(1);
    expect(record.attempts[0]?.outcome).toBe('infra-error');
    expect(record.attempts[0]?.outcome).not.toBe('gate-failed');
    expect(pollCalled).toBe(false);
    expect(escalateCalled).toBe(true);
  });

  test('network error (ECONNREFUSED) -> infra-alert; not gate-failed', async () => {
    let escalateCalled = false;

    const deps: CascadeDeps = {
      fire: async _opts =>
        makeFireError(
          '[smart-cauldron/fire] network error on POST: connect ECONNREFUSED 127.0.0.1:3090'
        ),
      poll: async _opts => makePollResult(),
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        escalateCalled = true;
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(record.status).toBe('infra-alert');
    expect(record.attempts[0]?.outcome).toBe('infra-error');
    expect(escalateCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 5: FRONTIER-STOP
// ---------------------------------------------------------------------------

describe('Test 5: FRONTIER-STOP', () => {
  test('frontier gate-fail -> BLOCKED + escalate; no third fire', async () => {
    let fireCount = 0;
    let escalateCalled = false;

    const deps: CascadeDeps = {
      fire: async _opts => {
        fireCount++;
        return makeFireOk(`run-${fireCount}`);
      },
      poll: async _opts => makePollResult({ terminalStatus: 'failed' }),
      judge: _poll => makeFailVerdict('terminal status: failed'),
      escalate: async _ctx => {
        escalateCalled = true;
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    // Use a 2-tier stub ladder so frontier is at index 1 and we don't run 4 real tiers
    // Override the ladder in the cascade by injecting inline config via entryOverride + patching
    // We can't directly inject the ladder, so use the entry override to start at the first tier
    // and rely on the real ladder (glm -> codex -> claude -> frontier).
    // For the frontier-stop test, we want to run exactly 2 attempts and stop at frontier.
    // The real ladder has 4 tiers, so we need a custom approach.
    //
    // Since loadLadder() reads from config, we use entryOverride='claude' to start at
    // the second-to-last tier (claude), so frontier is immediately next.
    // Then we verify exactly 2 fires happen (claude + frontier) and the loop terminates.

    const record = await runCascade(
      baseOpts({
        deps,
        entryOverride: 'claude',
      })
    );

    // Should have tried claude and frontier (2 attempts), then stopped
    expect(record.status).toBe('blocked');
    expect(escalateCalled).toBe(true);
    expect(fireCount).toBe(2); // claude + frontier only
    expect(record.attempts.every(a => a.outcome === 'gate-failed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 6: WRAPPER -- does NOT touch DAG executor
// ---------------------------------------------------------------------------

describe('Test 6: WRAPPER -- cascade does not touch @archon/workflows', () => {
  test('stubbed fire dep is called; cascade returns a CascadeRunRecord; no DAG executor referenced', async () => {
    let stubFireCalled = false;

    const deps: CascadeDeps = {
      fire: async _opts => {
        stubFireCalled = true;
        return makeFireOk('run-wrapper-test');
      },
      poll: async _opts => makePollResult(),
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(stubFireCalled).toBe(true);
    expect(record).not.toBeNull();
    expect(typeof record.cascadeId).toBe('string');
    expect(record.cascadeId.length).toBeGreaterThan(0);
    expect(typeof record.woId).toBe('string');
    expect(Array.isArray(record.attempts)).toBe(true);

    // Primary assertion (the grep stop-condition is the REAL check):
    // verify the cascadeRunRecord shape is correct (not a DAG node result)
    expect('status' in record).toBe(true);
    expect('telemetry' in record).toBe(true);
    expect('attempts' in record).toBe(true);
  });

  test('dry-run returns a record without calling fire', async () => {
    let fireCalledInDryRun = false;

    const deps: CascadeDeps = {
      fire: async _opts => {
        fireCalledInDryRun = true;
        return makeFireOk('should-not-happen');
      },
      poll: async _opts => makePollResult(),
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade(baseOpts({ deps, dryRun: true }));

    expect(fireCalledInDryRun).toBe(false);
    expect(record.woId).toBe('WO-TEST-001');
  });
});

// ---------------------------------------------------------------------------
// Verify loadLadder and loadRuleset read real config (smoke tests)
// ---------------------------------------------------------------------------

describe('config file smoke tests', () => {
  test('loadLadder returns ordered tiers from config file', () => {
    const tiers = loadLadder();
    expect(tiers.length).toBeGreaterThan(0);
    expect(tiers[0]?.name).toBeDefined();
    // First tier should be glm (cheapest)
    expect(tiers[0]?.name).toBe('glm');
    // Last tier should be frontier
    expect(tiers[tiers.length - 1]?.isFrontier).toBe(true);
  });

  test('loadRuleset returns ruleset with defaultEntry and rules', () => {
    const ruleset = loadRuleset();
    expect(ruleset.defaultEntry).toBe('glm');
    expect(Array.isArray(ruleset.rules)).toBe(true);
    expect(ruleset.rules.length).toBeGreaterThan(0);
  });
});
