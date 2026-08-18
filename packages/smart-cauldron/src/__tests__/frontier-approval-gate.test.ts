/**
 * frontier-approval-gate.test.ts -- Test 1 for the frontier-climb approval gate.
 * WO-HARNESS-FRONTIER-CLIMB-APPROVAL-GATE-01.
 *
 * An AUTOMATIC climb into a premium tier (default ['frontier']) must PAUSE
 * instead of firing: "then dont waste my usage if it will fail" (John,
 * 2026-08-18). This suite proves:
 *   - climb codex->claude->frontier pauses at the premium boundary (no frontier
 *     fire), persists the full escalation packet, and emits exactly one notice;
 *   - the paused record is durable and re-readable by cascadeId;
 *   - a purely non-premium climb (codex->claude) is unaffected (no pause).
 *
 * All tests use CascadeDeps injection -- no live API calls.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCascade } from '../cascade.js';
import type { CascadeDeps, RunCascadeOptions } from '../cascade.js';
import { readCascadeRecordById } from '../frontier-approval.js';
import type { FireResult, PollResult, GateVerdict } from '../types.js';

const CODEX_WORKFLOW = 'bdc-feature-development-codex';
const CLAUDE_WORKFLOW = 'bdc-feature-development';
const FABLE_WORKFLOW = 'bdc-feature-development-fable';

const tempDirs: string[] = [];
async function makeOutDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sc-frontier-gate-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })));
});

function makeFireOk(runId: string): FireResult {
  return { ok: true, runId, conversationId: 'conv-stub', infraError: null };
}

function makePollResult(overrides?: Partial<PollResult>): PollResult {
  return {
    runId: 'run-stub',
    terminalStatus: 'failed',
    validatorVerdict: 'needs_revision',
    prUrl: null,
    prMergeable: null,
    servedModelId: null,
    rawMetadata: {},
    ...overrides,
  };
}

function makeFailVerdict(reason: string): GateVerdict {
  return {
    pass: false,
    reason,
    cancelled: false,
    validatorVerdict: 'needs_revision',
    prOpened: false,
    prMergeable: null,
    terminalStatus: 'failed',
  };
}

function makePassVerdict(): GateVerdict {
  return {
    pass: true,
    reason: 'all gate conditions passed',
    cancelled: false,
    validatorVerdict: 'satisfied',
    prOpened: true,
    prMergeable: true,
    terminalStatus: 'completed',
  };
}

function baseOpts(partial: Partial<RunCascadeOptions>): RunCascadeOptions {
  return {
    woId: 'WO-FRONTIER-GATE-001',
    woClass: 'CODE',
    tags: ['mechanical'],
    // Enter at codex (non-premium) so the climb is what reaches frontier.
    entryOverride: 'codex',
    token: 'test-token',
    project: 'test-project',
    ...partial,
  };
}

describe('frontier-approval gate (Test 1: auto-climb pauses instead of firing)', () => {
  test('climb codex->claude->frontier pauses; frontier never fires; one notice; packet stored', async () => {
    const outDir = await makeOutDir();
    const firedWorkflows: string[] = [];
    let escalateCalls = 0;

    const deps: CascadeDeps = {
      fire: async opts => {
        firedWorkflows.push(opts.workflowName);
        return makeFireOk(`run-${firedWorkflows.length}`);
      },
      poll: async () => makePollResult(),
      judge: () => makeFailVerdict('validator: needs_revision'),
      escalate: async () => {
        escalateCalls++;
      },
      findWoClaim: async () => null,
    };

    const record = await runCascade(baseOpts({ deps, outDir }));

    // Paused, not fired.
    expect(record.status).toBe('pending-frontier-approval');
    // Only the two non-premium tiers fired; frontier was NOT fired.
    expect(firedWorkflows).toEqual([CODEX_WORKFLOW, CLAUDE_WORKFLOW]);
    expect(firedWorkflows).not.toContain(FABLE_WORKFLOW);
    // Exactly one operator notice for the pause.
    expect(escalateCalls).toBe(1);
    // No frontier attempt was pushed (only codex + claude were attempted).
    expect(record.attempts.length).toBe(2);
    expect(record.attempts.map(a => a.tier)).toEqual(['codex', 'claude']);

    // Full escalation packet preserved.
    const packet = record.frontierApproval;
    expect(packet).toBeDefined();
    expect(packet?.tierName).toBe('frontier');
    expect(packet?.workflowName).toBe(FABLE_WORKFLOW);
    expect(packet?.project).toBe('test-project');
    expect(packet?.woId).toBe('WO-FRONTIER-GATE-001');
    expect(packet?.resolution).toBeNull();
    expect(packet?.notifiedAt).not.toBeNull();
    // priorContext is the informed-climb text from the last failed tier (claude).
    expect(packet?.priorContext).toContain('Prior tier: claude');
    // Secret boundary: no token field is ever persisted in the packet.
    expect(JSON.stringify(packet)).not.toContain('test-token');
  });

  test('paused record is durable and re-readable by cascadeId', async () => {
    const outDir = await makeOutDir();
    const deps: CascadeDeps = {
      fire: async opts => makeFireOk(`run-${opts.workflowName}`),
      poll: async () => makePollResult(),
      judge: () => makeFailVerdict('validator: needs_revision'),
      escalate: async () => undefined,
      findWoClaim: async () => null,
    };

    const record = await runCascade(baseOpts({ deps, outDir }));
    expect(record.status).toBe('pending-frontier-approval');

    const persisted = await readCascadeRecordById(record.cascadeId, outDir);
    expect(persisted).not.toBeNull();
    expect(persisted?.status).toBe('pending-frontier-approval');
    expect(persisted?.frontierApproval?.tierName).toBe('frontier');
    expect(persisted?.frontierApproval?.resolution).toBeNull();
  });

  test('non-premium climb (codex->claude) is unaffected: wins, no pause, no notice', async () => {
    const outDir = await makeOutDir();
    const firedWorkflows: string[] = [];
    let escalateCalls = 0;
    let judgeCall = 0;

    const deps: CascadeDeps = {
      fire: async opts => {
        firedWorkflows.push(opts.workflowName);
        return makeFireOk(`run-${firedWorkflows.length}`);
      },
      poll: async () => makePollResult(),
      judge: () => {
        judgeCall++;
        // codex fails, claude passes -> classic non-premium climb-and-win.
        return judgeCall === 1 ? makeFailVerdict('codex near-miss') : makePassVerdict();
      },
      escalate: async () => {
        escalateCalls++;
      },
      findWoClaim: async () => null,
    };

    const record = await runCascade(baseOpts({ deps, outDir }));

    expect(record.status).toBe('won');
    expect(record.winningTier).toBe('claude');
    expect(record.frontierApproval).toBeUndefined();
    expect(escalateCalls).toBe(0);
    expect(firedWorkflows).toEqual([CODEX_WORKFLOW, CLAUDE_WORKFLOW]);
  });
});
