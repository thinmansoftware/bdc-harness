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
import { TimeoutError } from '../poll.js';

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
    token: 'test-token',
    project: 'test-project',
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Auth/project binding guards
// ---------------------------------------------------------------------------

describe('auth/project binding guards', () => {
  test('missing project throws before firing', async () => {
    let fireCalled = false;

    const deps: CascadeDeps = {
      fire: async _opts => {
        fireCalled = true;
        return makeFireOk('should-not-fire');
      },
      poll: async _opts => makePollResult(),
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    await expect(runCascade(baseOpts({ deps, project: undefined }))).rejects.toThrow(
      '--project is required'
    );
    expect(fireCalled).toBe(false);
  });

  test('runCascade passes token to fire/poll/cancel and includes project in fire message', async () => {
    const fireOpts: Array<Parameters<NonNullable<CascadeDeps['fire']>>[0]> = [];
    const pollOpts: Array<Parameters<NonNullable<CascadeDeps['poll']>>[0]> = [];
    const cancelOpts: Array<Parameters<NonNullable<CascadeDeps['cancel']>>[0]> = [];
    let pollCallIndex = 0;

    const deps: CascadeDeps = {
      fire: async opts => {
        fireOpts.push(opts);
        return makeFireOk(`run-${fireOpts.length}`);
      },
      poll: async opts => {
        pollOpts.push(opts);
        pollCallIndex++;
        if (pollCallIndex === 1) {
          throw new TimeoutError('poll timeout');
        }
        return makePollResult();
      },
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
      cancel: async opts => {
        cancelOpts.push(opts);
        return { ok: true, error: null };
      },
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(record.status).toBe('won');
    expect(fireOpts.length).toBe(2);
    expect(pollOpts.length).toBe(2);
    expect(cancelOpts.length).toBe(1);

    expect(fireOpts.every(opts => opts.token === 'test-token')).toBe(true);
    expect(
      fireOpts.every(opts => opts.message.startsWith('WO-TEST-001 --project test-project'))
    ).toBe(true);
    expect(pollOpts.every(opts => opts.token === 'test-token')).toBe(true);
    expect(cancelOpts[0]?.token).toBe('test-token');
    expect(cancelOpts[0]?.runId).toBe('run-1');
  });
});

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
// Test: PROGRESS-TIMEOUT -- cancels and climbs (not infra-error)
// ---------------------------------------------------------------------------

describe('Test: PROGRESS-TIMEOUT climbs (does not stop as infra-error)', () => {
  test('timeout cancels the hung run and climbs to the next tier', async () => {
    const fireCalls: string[] = [];
    const cancelCalls: { runId: string; apiBaseUrl: string }[] = [];
    let pollCallIndex = 0;

    const deps: CascadeDeps = {
      fire: async opts => {
        fireCalls.push(opts.workflowName);
        return makeFireOk(`run-${fireCalls.length}`);
      },
      poll: async _opts => {
        pollCallIndex++;
        if (pollCallIndex === 1) {
          throw new TimeoutError(
            '[smart-cauldron/poll] Run run-1 did not reach terminal state within 1800000ms'
          );
        }
        return makePollResult();
      },
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
      cancel: async opts => {
        cancelCalls.push(opts);
        return { ok: true, error: null };
      },
    };

    const record = await runCascade(baseOpts({ deps }));

    // Cancel was called exactly once, for the hung (tier-0) run
    expect(cancelCalls.length).toBe(1);
    expect(cancelCalls[0]?.runId).toBe('run-1');

    // Recorded as progress-timeout, NOT infra-error -- and the cascade climbed
    expect(record.attempts.length).toBe(2);
    expect(record.attempts[0]?.outcome).toBe('progress-timeout');
    expect(record.attempts[0]?.outcome).not.toBe('infra-error');
    expect(record.attempts[0]?.gateFailReason).toContain('progress-timeout');
    expect(record.attempts[1]?.outcome).toBe('won');

    expect(record.status).toBe('won');
    expect(record.status).not.toBe('infra-alert');
    expect(record.telemetry.climbed).toBe(true);
    expect(record.telemetry.climbCount).toBe(1);

    // Second fire used the next tier's workflowName (same climb semantics as gate-fail)
    const tiers = loadLadder();
    const entryTier = tiers.find(t => t.name === 'glm');
    const nextTier = tiers[tiers.findIndex(t => t.name === 'glm') + 1];
    expect(fireCalls[0]).toBe(entryTier?.workflowName);
    expect(fireCalls[1]).toBe(nextTier?.workflowName);
  });

  test('cancel failure is best-effort -- does not block the climb', async () => {
    let pollCallIndex = 0;
    let fireCount = 0;

    const deps: CascadeDeps = {
      fire: async _opts => {
        fireCount++;
        return makeFireOk(`run-${fireCount}`);
      },
      poll: async _opts => {
        pollCallIndex++;
        if (pollCallIndex === 1) {
          throw new TimeoutError('poll timeout');
        }
        return makePollResult();
      },
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
      cancel: async _opts => ({ ok: false, error: 'HTTP 500: cancel endpoint unavailable' }),
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(fireCount).toBe(2);
    expect(record.status).toBe('won');
    expect(record.attempts[0]?.outcome).toBe('progress-timeout');
  });
});

// ---------------------------------------------------------------------------
// Test: non-timeout poll error still stops as infra-error (regression)
// ---------------------------------------------------------------------------

describe('Test: non-timeout poll error still stops as infra-error', () => {
  test('generic poll error (not TimeoutError) does not climb; infra-alert unchanged', async () => {
    let fireCount = 0;
    let escalateCalled = false;
    let cancelCalled = false;

    const deps: CascadeDeps = {
      fire: async _opts => {
        fireCount++;
        return makeFireOk(`run-${fireCount}`);
      },
      poll: async _opts => {
        throw new Error('network error: ECONNRESET');
      },
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        escalateCalled = true;
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
      cancel: async _opts => {
        cancelCalled = true;
        return { ok: true, error: null };
      },
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(fireCount).toBe(1); // no climb -- stopped after the single tier
    expect(record.status).toBe('infra-alert');
    expect(record.attempts.length).toBe(1);
    expect(record.attempts[0]?.outcome).toBe('infra-error');
    expect(record.attempts[0]?.outcome).not.toBe('progress-timeout');
    expect(escalateCalled).toBe(true);
    expect(cancelCalled).toBe(false); // cancel is only invoked on TimeoutError
  });
});

// ---------------------------------------------------------------------------
// Test: poll timeout default (1800000) + configurable override
// ---------------------------------------------------------------------------

describe('Test: poll timeout default + override', () => {
  test('default pollTimeoutMs passed to poll is 1800000 when not overridden', async () => {
    let observedTimeoutMs: number | undefined;

    const deps: CascadeDeps = {
      fire: async _opts => makeFireOk('run-default-timeout'),
      poll: async opts => {
        observedTimeoutMs = opts.timeoutMs;
        return makePollResult();
      },
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    await runCascade(baseOpts({ deps }));

    expect(observedTimeoutMs).toBe(1_800_000);
    expect(observedTimeoutMs).not.toBe(3_600_000);
  });

  test('pollTimeoutMs override is threaded through to poll', async () => {
    let observedTimeoutMs: number | undefined;

    const deps: CascadeDeps = {
      fire: async _opts => makeFireOk('run-override-timeout'),
      poll: async opts => {
        observedTimeoutMs = opts.timeoutMs;
        return makePollResult();
      },
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    await runCascade(baseOpts({ deps, pollTimeoutMs: 900_000 }));

    expect(observedTimeoutMs).toBe(900_000);
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
