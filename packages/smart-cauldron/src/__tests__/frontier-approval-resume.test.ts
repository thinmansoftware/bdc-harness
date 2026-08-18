/**
 * frontier-approval-resume.test.ts -- Tests 2 & 3 for the frontier-climb gate.
 * WO-HARNESS-FRONTIER-CLIMB-APPROVAL-GATE-01.
 *
 * Test 2: approve resumes and fires the premium tier EXACTLY ONCE; a second
 *         approve is an idempotent no-op (guarded by the claim file), no 2nd fire.
 * Test 3: reject terminates as needs-human with NO fire; and an explicit
 *         --entry frontier direct fire bypasses the gate and fires immediately.
 *
 * All tests use CascadeDeps injection -- no live API calls.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCascade } from '../cascade.js';
import type { CascadeDeps, RunCascadeOptions } from '../cascade.js';
import {
  readCascadeRecordById,
  claimFrontierResolution,
  resumeFrontierTier,
  rejectFrontierTier,
} from '../frontier-approval.js';
import type { CascadeRunRecord, FireResult, PollResult, GateVerdict } from '../types.js';

const FABLE_WORKFLOW = 'bdc-feature-development-fable';

const tempDirs: string[] = [];
async function makeOutDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sc-frontier-resume-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })));
});

function makeFireOk(runId: string): FireResult {
  return { ok: true, runId, conversationId: 'conv-stub', infraError: null };
}

function makeFailPoll(): PollResult {
  return {
    runId: 'run-stub',
    terminalStatus: 'failed',
    validatorVerdict: 'needs_revision',
    prUrl: null,
    prMergeable: null,
    servedModelId: null,
    rawMetadata: {},
  };
}

function makePassPoll(): PollResult {
  return {
    runId: 'run-stub',
    terminalStatus: 'completed',
    validatorVerdict: 'satisfied',
    prUrl: 'https://github.com/org/repo/pull/9',
    prMergeable: true,
    servedModelId: null,
    rawMetadata: {},
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

/** Produce a real paused (pending-frontier-approval) record on disk. */
async function producePausedRecord(outDir: string, woId: string): Promise<CascadeRunRecord> {
  const deps: CascadeDeps = {
    fire: async opts => makeFireOk(`run-${opts.workflowName}`),
    poll: async () => makeFailPoll(),
    judge: () => makeFailVerdict('validator: needs_revision'),
    escalate: async () => undefined,
    findWoClaim: async () => null,
  };
  const opts: RunCascadeOptions = {
    woId,
    woClass: 'CODE',
    tags: ['mechanical'],
    entryOverride: 'codex',
    token: 'test-token',
    project: 'test-project',
    outDir,
    deps,
  };
  const record = await runCascade(opts);
  expect(record.status).toBe('pending-frontier-approval');
  return record;
}

describe('frontier-approval resume (Test 2: approve fires exactly once)', () => {
  test('approve resumes + fires the premium tier once; second approve is a no-op', async () => {
    const outDir = await makeOutDir();
    const paused = await producePausedRecord(outDir, 'WO-FRONTIER-RESUME-001');

    const firedWorkflows: string[] = [];
    const fireMessages: string[] = [];
    const resumeDeps: CascadeDeps = {
      fire: async opts => {
        firedWorkflows.push(opts.workflowName);
        fireMessages.push(opts.message);
        return makeFireOk(`resume-run-${firedWorkflows.length}`);
      },
      poll: async () => makePassPoll(),
      judge: () => makePassVerdict(),
      escalate: async () => undefined,
      findWoClaim: async () => null,
    };

    // First approve: claim wins, then resume fires the frontier tier once.
    const claim1 = await claimFrontierResolution(paused.cascadeId, 'approved', outDir);
    expect(claim1.claimed).toBe(true);

    const resumed = await resumeFrontierTier(paused, {
      token: 'test-token',
      outDir,
      deps: resumeDeps,
    });

    expect(resumed.status).toBe('won');
    expect(resumed.winningTier).toBe('frontier');
    expect(firedWorkflows).toEqual([FABLE_WORKFLOW]);
    // The resumed fire carried the preserved informed-climb context.
    expect(fireMessages[0]).toContain('Prior tier: claude');
    // A distinct resumed cascadeId (not the paused one).
    expect(resumed.cascadeId).not.toBe(paused.cascadeId);

    // Original paused record annotated with the resolution + back-reference.
    const annotated = await readCascadeRecordById(paused.cascadeId, outDir);
    expect(annotated?.frontierApproval?.resolution).toBe('approved');
    expect(annotated?.frontierApproval?.resumeCascadeId).toBe(resumed.cascadeId);

    // Second approve: claim already taken -> idempotent no-op, NO second fire.
    const claim2 = await claimFrontierResolution(paused.cascadeId, 'approved', outDir);
    expect(claim2.claimed).toBe(false);
    expect(claim2.resolution).toBe('approved');
    expect(firedWorkflows).toEqual([FABLE_WORKFLOW]); // still exactly one fire
  });
});

describe('frontier-approval reject + direct-entry bypass (Test 3)', () => {
  test('reject terminates as needs-human with no fire; blocks a later approve', async () => {
    const outDir = await makeOutDir();
    const paused = await producePausedRecord(outDir, 'WO-FRONTIER-REJECT-001');

    const claim = await claimFrontierResolution(paused.cascadeId, 'rejected', outDir);
    expect(claim.claimed).toBe(true);

    const rejected = await rejectFrontierTier(
      paused,
      'operator: structurally impossible WO',
      outDir
    );
    expect(rejected.status).toBe('frontier-rejected');
    expect(rejected.frontierApproval?.resolution).toBe('rejected');
    expect(rejected.frontierApproval?.rejectReason).toBe('operator: structurally impossible WO');

    // Persisted terminal state.
    const persisted = await readCascadeRecordById(paused.cascadeId, outDir);
    expect(persisted?.status).toBe('frontier-rejected');
    expect(persisted?.frontierApproval?.resolution).toBe('rejected');

    // A later approve cannot flip a decided (rejected) outcome.
    const lateApprove = await claimFrontierResolution(paused.cascadeId, 'approved', outDir);
    expect(lateApprove.claimed).toBe(false);
    expect(lateApprove.resolution).toBe('rejected');
  });

  test('explicit --entry frontier direct fire bypasses the gate and fires immediately', async () => {
    const outDir = await makeOutDir();
    const firedWorkflows: string[] = [];
    const deps: CascadeDeps = {
      fire: async opts => {
        firedWorkflows.push(opts.workflowName);
        return makeFireOk(`direct-run-${firedWorkflows.length}`);
      },
      poll: async () => makePassPoll(),
      judge: () => makePassVerdict(),
      escalate: async () => undefined,
      findWoClaim: async () => null,
    };

    const record = await runCascade({
      woId: 'WO-FRONTIER-DIRECT-001',
      woClass: 'CODE',
      tags: ['mechanical'],
      entryOverride: 'frontier', // human-typed -> bypasses the gate
      token: 'test-token',
      project: 'test-project',
      outDir,
      deps,
    });

    // Fired immediately, no pause.
    expect(record.status).toBe('won');
    expect(record.status).not.toBe('pending-frontier-approval');
    expect(record.frontierApproval).toBeUndefined();
    expect(firedWorkflows).toEqual([FABLE_WORKFLOW]);
  });
});
