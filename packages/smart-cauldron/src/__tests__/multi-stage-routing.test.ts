/**
 * Hermetic coverage for explicit bdc-multi-stage-development supervision.
 * No GitHub, SSH, provider, database, or network access.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { pathToFileURL } from 'url';
import { freezeWorkOrderSource } from '@archon/core/workflows/work-order-source';
import type { ExpectedSpecIdentity } from '@archon/core/workflows/work-order-source';
import { readSpecClass, validateCanonicalStages } from '../canonical-stages.js';
import { parseArgs } from '../cli.js';
import { runCascade } from '../cascade.js';
import type { CascadeDeps, RunCascadeOptions } from '../cascade.js';
import { resumeFrontierTier } from '../frontier-approval.js';
import { loadLadder } from '../ladder.js';
import { TimeoutError } from '../poll.js';
import type {
  CascadeRunRecord,
  FireResult,
  GateVerdict,
  LadderTier,
  PollResult,
} from '../types.js';

const MULTI_STAGE_WORKFLOW = 'bdc-multi-stage-development';
const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const MULTI_STAGE_YAML = join(
  REPO_ROOT,
  '.archon/workflows/defaults/bdc-multi-stage-development.yaml'
);
const CURSOR_YAML = join(
  REPO_ROOT,
  '.archon/workflows/defaults/bdc-feature-development-cursor.yaml'
);

const FEATURE_WORKFLOWS = [
  'bdc-feature-development-cursor',
  'bdc-feature-development-codex',
  'bdc-feature-development-fable',
  'bdc-feature-development',
  'bdc-feature-development-zero-open',
];

function stageBlock(id: string, readiness = 'true'): string {
  return [
    `  - id: ${id}`,
    '    repo: thinmansoftware/bdc-harness',
    '    target_branch: dev',
    '    in_scope_files:',
    '      - packages/smart-cauldron/src/cascade.ts',
    '    verify_commands:',
    '      - bun test',
    '    readiness_bar:',
    `      pr_open: ${readiness}`,
    `      ci_green: ${readiness}`,
    `      diff_review_clean: ${readiness}`,
    `      mergeable: ${readiness}`,
  ].join('\n');
}

function stagesDocument(ids: string[], readiness = 'true'): string {
  return `stages:\n${ids.map(id => stageBlock(id, readiness)).join('\n')}`;
}

function fenced(document: string): string {
  return '```yaml\n' + document + '\n```';
}

function mixedSpec(body: string, classLine = 'WO Class: MIXED'): string {
  return `${classLine}\n\n${body}\n`;
}

const TWO_STAGE_SPEC = mixedSpec(
  `## Canonical stages\n\n${fenced(stagesDocument(['alpha', 'beta']))}`
);
const ONE_STAGE_SPEC = mixedSpec(`## Canonical stages\n\n${fenced(stagesDocument(['only']))}`);

function passVerdict(): GateVerdict {
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

function cancelledVerdict(): GateVerdict {
  return {
    pass: false,
    reason: 'operator cancelled the run',
    cancelled: true,
    validatorVerdict: 'unknown',
    prOpened: false,
    prMergeable: null,
    terminalStatus: 'cancelled',
  };
}

function pollOk(runId: string): PollResult {
  return {
    runId,
    terminalStatus: 'completed',
    validatorVerdict: 'satisfied',
    prUrl: 'https://example.test/pull/1',
    prMergeable: true,
    servedModelId: 'test-model',
    rawMetadata: {},
  };
}

function fireOk(runId: string): FireResult {
  return { ok: true, runId, conversationId: 'conv-test', infraError: null };
}

function expectedFromBytes(spec: string): ExpectedSpecIdentity {
  return {
    specSource: 'github:thinmansoftware/bdc-xo:docs/work-orders/WO-TEST-001.md',
    specRevision: 'c'.repeat(40),
    specHash: `sha256:${createHash('sha256').update(spec).digest('hex')}`,
  };
}

function tier(name: string, workflowName: string, extra: Partial<LadderTier> = {}): LadderTier {
  return {
    name,
    workflowName,
    isFrontier: extra.isFrontier ?? false,
    costPerRunUsd: null,
    ...extra,
  };
}

interface Harness {
  fires: Array<{ workflowName: string; message: string }>;
  polls: number;
  judges: number;
  cancels: string[];
  timeouts: string[];
  locks: number;
  freezes: string[];
  deps: CascadeDeps;
}

function harness(spec: string, overrides: Partial<CascadeDeps> = {}): Harness {
  const state: Harness = {
    fires: [],
    polls: 0,
    judges: 0,
    cancels: [],
    timeouts: [],
    locks: 0,
    freezes: [],
    deps: {},
  };
  const specBytes = Buffer.from(spec);
  state.deps = {
    findWoClaim: async () => null,
    acquireWoLock: async (woId, project, cascadeId) => {
      state.locks += 1;
      return {
        acquired: true,
        path: 'memory-lock',
        record: {
          woId,
          project,
          cascadeId,
          status: 'running',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      };
    },
    releaseWoLock: async () => {},
    createRecord: async record => ({ created: true, path: 'memory-record', record }),
    writeRecord: async () => 'memory-record',
    escalate: async () => undefined,
    specRepair: async () => ({ posted: false, issueRepo: null, issueNumber: null }),
    cancel: async request => {
      state.cancels.push(request.runId);
      return { ok: true };
    },
    fetchNodeTimeouts: async request => {
      state.timeouts.push(request.workflowName);
      return {};
    },
    freezeWorkOrderSource: async (_policy, message) => {
      state.freezes.push(message);
      return {
        woId: 'WO-TEST-001',
        specSource: 'github:thinmansoftware/bdc-xo:docs/work-orders/WO-TEST-001.md',
        specRevision: 'c'.repeat(40),
        specBytes,
      };
    },
    fire: async request => {
      state.fires.push({ workflowName: request.workflowName, message: request.message });
      return fireOk(`run-${String(state.fires.length)}`);
    },
    poll: async () => {
      state.polls += 1;
      return pollOk('run-1');
    },
    judge: () => {
      state.judges += 1;
      return passVerdict();
    },
    ...overrides,
  };
  return state;
}

function options(
  spec: string,
  partial: Partial<RunCascadeOptions> = {},
  depOverrides: Partial<CascadeDeps> = {}
): { opts: RunCascadeOptions; state: Harness } {
  const state = harness(spec, depOverrides);
  const { deps, ...rest } = partial;
  return {
    state,
    opts: {
      woId: 'WO-TEST-001',
      woClass: 'MIXED',
      project: 'bdc-harness',
      token: 'test-token',
      outDir: join(tmpdir(), 'smart-cauldron-multi-stage-unused'),
      workflow: MULTI_STAGE_WORKFLOW,
      ...rest,
      deps: { ...state.deps, ...deps },
    },
  };
}

function decodedExpected(message: string): ExpectedSpecIdentity {
  const encoded = message.split('\n')[0]?.split(' --expected-spec=')[1];
  if (!encoded) throw new Error('fire message missing expected spec');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ExpectedSpecIdentity;
}

describe('explicit multi-stage happy path', () => {
  test('fires one two-stage supervised run and records the fake run id', async () => {
    const { opts, state } = options(TWO_STAGE_SPEC);
    const record = await runCascade(opts);
    expect(record.status).toBe('won');
    expect(state.fires.map(fire => fire.workflowName)).toEqual([MULTI_STAGE_WORKFLOW]);
    expect(state.polls).toBe(1);
    expect(state.judges).toBe(1);
    expect(state.timeouts).toEqual([MULTI_STAGE_WORKFLOW]);
    expect(record.attempts[0]?.runId).toBe('run-1');
    expect(record.attempts[0]?.workflowName).toBe(MULTI_STAGE_WORKFLOW);
    expect(record.request.workflow).toBe(MULTI_STAGE_WORKFLOW);
    expect(decodedExpected(state.fires[0]?.message ?? '')).toEqual(
      expectedFromBytes(TWO_STAGE_SPEC)
    );
    expect(state.fires.some(fire => FEATURE_WORKFLOWS.includes(fire.workflowName))).toBe(false);
    expect(state.cancels).toEqual([]);
  });

  test('accepts a valid N=1 canonical block', async () => {
    const { opts, state } = options(ONE_STAGE_SPEC);
    const record = await runCascade(opts);
    expect(record.status).toBe('won');
    expect(state.fires).toHaveLength(1);
    expect(state.fires[0]?.workflowName).toBe(MULTI_STAGE_WORKFLOW);
    expect(validateCanonicalStages(ONE_STAGE_SPEC).stageIds).toEqual(['only']);
  });

  test('dry-run checks eligibility, records the lane, and does not fire', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(arg => String(arg)).join(' '));
    };
    try {
      const { opts, state } = options(TWO_STAGE_SPEC, { dryRun: true });
      const record = await runCascade(opts);
      expect(record.status).toBe('planned');
      expect(record.request.workflow).toBe(MULTI_STAGE_WORKFLOW);
      expect(state.fires).toHaveLength(0);
      expect(state.locks).toBe(0);
      expect(lines.some(line => line.includes(`workflow=${MULTI_STAGE_WORKFLOW}`))).toBe(true);
    } finally {
      console.log = original;
    }
  });
});

describe('lane binding ownership', () => {
  const ownedWorkflow = 'bdc-multi-stage-development-codex';
  const cursor = tier('cursor', 'bdc-feature-development-cursor');
  const codex = tier('codex', 'bdc-feature-development-codex', {
    laneWorkflows: { [MULTI_STAGE_WORKFLOW]: ownedWorkflow },
  });

  test('routes through the owning tier and records its entry telemetry', async () => {
    const { opts, state } = options(
      TWO_STAGE_SPEC,
      { workflow: ownedWorkflow },
      { tiers: [cursor, codex], refusedTiers: [], premiumTiers: [] }
    );
    const record = await runCascade(opts);
    expect(state.fires.map(fire => fire.workflowName)).toEqual([ownedWorkflow]);
    expect(record.attempts.map(attempt => attempt.tier)).toEqual(['codex']);
    expect(record.telemetry.entryTier).toBe('codex');
    expect(record.request.entryOverride).toBe('codex');
  });

  test('rejects a conflicting explicit entry before provider fire', async () => {
    const { opts, state } = options(
      TWO_STAGE_SPEC,
      { workflow: ownedWorkflow, entryOverride: 'cursor' },
      { tiers: [cursor, codex], refusedTiers: [], premiumTiers: [] }
    );
    await expect(runCascade(opts)).rejects.toThrow(/does not match --entry/);
    expect(state.fires).toHaveLength(0);
    expect(state.locks).toBe(0);
  });

  test('rejects a lane binding owned by a refused tier before admission', async () => {
    const { opts, state } = options(
      TWO_STAGE_SPEC,
      { workflow: ownedWorkflow },
      { tiers: [cursor, codex], refusedTiers: ['codex'], premiumTiers: [] }
    );
    await expect(runCascade(opts)).rejects.toThrow(/Refused dark\/retired entry tier "codex"/);
    expect(state.fires).toHaveLength(0);
    expect(state.locks).toBe(0);
  });

  test('pauses a premium owning tier for approval without auto-firing', async () => {
    const frontier = tier('frontier', 'bdc-feature-development-fable', {
      isFrontier: true,
      laneWorkflows: { [MULTI_STAGE_WORKFLOW]: 'bdc-multi-stage-development-fable' },
    });
    const { opts, state } = options(
      TWO_STAGE_SPEC,
      { workflow: 'bdc-multi-stage-development-fable' },
      { tiers: [cursor, frontier], refusedTiers: [], premiumTiers: ['frontier'] }
    );
    const record = await runCascade(opts);
    expect(record.status).toBe('pending-frontier-approval');
    expect(record.telemetry.entryTier).toBe('frontier');
    expect(record.frontierApproval?.tierName).toBe('frontier');
    expect(record.frontierApproval?.workflowName).toBe('bdc-multi-stage-development-fable');
    expect(state.fires).toHaveLength(0);
  });
});

describe('effective workflow preflight', () => {
  test('checks the explicit lane instead of an unavailable tier default', async () => {
    const seen: Array<{ tier: string; workflowName: string }> = [];
    const unavailable = tier('cursor', 'unavailable');
    const { opts, state } = options(
      TWO_STAGE_SPEC,
      {},
      {
        tiers: [unavailable],
        refusedTiers: [],
        premiumTiers: [],
        preflight: async (selectedTier, workflowName) => {
          seen.push({ tier: selectedTier.name, workflowName });
          if (workflowName === 'unavailable') throw new Error('workflow unavailable');
        },
      }
    );
    const record = await runCascade(opts);
    expect(record.status).toBe('won');
    expect(seen).toEqual([{ tier: 'cursor', workflowName: MULTI_STAGE_WORKFLOW }]);
    expect(state.fires.map(fire => fire.workflowName)).toEqual([MULTI_STAGE_WORKFLOW]);
  });

  test('checks each effective binding across a compatible climb', async () => {
    const initialWorkflow = 'bdc-multi-stage-development-cursor';
    const climbedWorkflow = 'bdc-multi-stage-development-codex';
    const cursor = tier('cursor', 'unavailable-initial', {
      laneWorkflows: { [MULTI_STAGE_WORKFLOW]: initialWorkflow },
    });
    const codex = tier('codex', 'unavailable-climbed', {
      laneWorkflows: { [MULTI_STAGE_WORKFLOW]: climbedWorkflow },
    });
    const seen: Array<{ tier: string; workflowName: string }> = [];
    let polls = 0;
    const { opts, state } = options(
      TWO_STAGE_SPEC,
      { workflow: initialWorkflow },
      {
        tiers: [cursor, codex],
        refusedTiers: [],
        premiumTiers: [],
        preflight: async (selectedTier, workflowName) => {
          seen.push({ tier: selectedTier.name, workflowName });
          if (workflowName.startsWith('unavailable-')) throw new Error('workflow unavailable');
        },
        poll: async () => {
          polls += 1;
          if (polls === 1) throw new TimeoutError('stalled');
          return pollOk('run-2');
        },
      }
    );
    const record = await runCascade(opts);
    expect(record.status).toBe('won');
    expect(state.cancels).toEqual(['run-1']);
    expect(seen).toEqual([
      { tier: 'cursor', workflowName: initialWorkflow },
      { tier: 'codex', workflowName: climbedWorkflow },
    ]);
    expect(record.attempts.map(attempt => attempt.workflowName)).toEqual(
      seen.map(item => item.workflowName)
    );
    expect(state.fires.map(fire => fire.workflowName)).toEqual([initialWorkflow, climbedWorkflow]);
  });
});

describe('invalid spec rejects before provider side effects', () => {
  async function expectZeroFire(spec: string, woClass?: string): Promise<void> {
    const { opts, state } = options(spec, woClass === undefined ? {} : { woClass });
    await expect(runCascade(opts)).rejects.toThrow();
    expect(state.fires).toHaveLength(0);
    expect(state.polls).toBe(0);
    expect(state.judges).toBe(0);
    expect(state.cancels).toHaveLength(0);
    expect(state.locks).toBe(0);
  }

  test('missing stages block fails closed', async () => {
    await expectZeroFire(mixedSpec('No stages are declared here.'));
  });

  test('empty stages list fails closed', async () => {
    await expectZeroFire(mixedSpec(`## Canonical stages\n\n${fenced('stages: []')}`));
  });

  test('malformed stage fields fail closed', async () => {
    const broken = stagesDocument(['alpha']).replace(
      '    verify_commands:\n      - bun test\n',
      ''
    );
    await expectZeroFire(mixedSpec(`## Canonical stages\n\n${fenced(broken)}`));
  });

  test('invalid readiness gate fails closed', async () => {
    await expectZeroFire(
      mixedSpec(`## Canonical stages\n\n${fenced(stagesDocument(['alpha'], 'false'))}`)
    );
  });

  test('ambiguous unmarked blocks fail closed', async () => {
    const spec = mixedSpec(
      `${fenced(stagesDocument(['one']))}\n\n${fenced(stagesDocument(['two']))}`
    );
    await expectZeroFire(spec);
    expect(() => validateCanonicalStages(spec)).toThrow(/marked canonical/);
  });

  test('absent frozen class fails closed and a non-MIXED flag fails before dispatch', async () => {
    await expectZeroFire(
      'This spec has stages but no class.\n\n' + fenced(stagesDocument(['alpha']))
    );
    const { opts, state } = options(TWO_STAGE_SPEC, { woClass: 'CODE' });
    await expect(runCascade(opts)).rejects.toThrow(/MIXED/);
    expect(state.freezes).toHaveLength(0);
    expect(state.fires).toHaveLength(0);
  });

  test('source hash mismatch fails inside freeze verification with zero fires', async () => {
    const spec = TWO_STAGE_SPEC;
    const bytes = Buffer.from(spec);
    let fires = 0;
    const fetcher = (async (url: string) => {
      if (url.includes('/git/ref/')) {
        return new Response(JSON.stringify({ object: { sha: 'a'.repeat(40) } }), { status: 200 });
      }
      return new Response(JSON.stringify({ type: 'file', content: bytes.toString('base64') }), {
        status: 200,
      });
    }) as typeof fetch;
    const { opts } = options(spec, {
      expectedSpec: {
        specSource: 'github:thinmansoftware/bdc-xo:docs/work-orders/WO-TEST-001.md',
        specRevision: 'b'.repeat(40),
        specHash: `sha256:${'d'.repeat(64)}`,
      },
      deps: {
        freezeWorkOrderSource: (policy, message) =>
          freezeWorkOrderSource(policy, message, { fetcher, githubToken: 'test-token' }),
        fire: async () => {
          fires += 1;
          return fireOk('should-not-fire');
        },
      },
    });
    await expect(runCascade(opts)).rejects.toThrow(/authority_conflict/);
    expect(fires).toBe(0);
  });

  test('a supplied expected identity is verified and preserved on the fire', async () => {
    const spec = TWO_STAGE_SPEC;
    const identity = expectedFromBytes(spec);
    const bytes = Buffer.from(spec);
    const seen: string[] = [];
    const fetcher = (async (url: string) => {
      if (url.includes('/git/ref/')) {
        return new Response(JSON.stringify({ object: { sha: identity.specRevision } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ type: 'file', content: bytes.toString('base64') }), {
        status: 200,
      });
    }) as typeof fetch;
    const { opts, state } = options(spec, {
      expectedSpec: identity,
      deps: {
        freezeWorkOrderSource: (policy, message) => {
          seen.push(message);
          return freezeWorkOrderSource(policy, message, { fetcher, githubToken: 'test-token' });
        },
      },
    });
    await runCascade(opts);
    expect(seen[0]).toContain('--expected-spec=');
    expect(decodedExpected(state.fires[0]?.message ?? '')).toEqual(identity);
  });
});

describe('stall and compatible climb', () => {
  const cursor = tier('cursor', 'bdc-feature-development-cursor');
  const codex = tier('codex', 'bdc-feature-development-codex', {
    laneWorkflows: {
      [MULTI_STAGE_WORKFLOW]: 'bdc-multi-stage-development-codex',
    },
  });

  test('timeout cancels the first run and climbs to a distinct stage-aware binding', async () => {
    let polls = 0;
    const { opts, state } = options(
      TWO_STAGE_SPEC,
      { entryOverride: 'cursor' },
      {
        tiers: [cursor, codex],
        refusedTiers: [],
        premiumTiers: [],
        poll: async () => {
          polls += 1;
          if (polls === 1) throw new TimeoutError('stalled');
          return pollOk('run-2');
        },
      }
    );
    const record = await runCascade(opts);
    expect(state.fires.map(fire => fire.workflowName)).toEqual([
      MULTI_STAGE_WORKFLOW,
      'bdc-multi-stage-development-codex',
    ]);
    expect(state.cancels).toEqual(['run-1']);
    expect(record.attempts.map(attempt => attempt.runId)).toEqual(['run-1', 'run-2']);
    expect(
      record.attempts.every(attempt => attempt.workflowName !== 'bdc-feature-development-codex')
    ).toBe(true);
    expect(record.telemetry.climbed).toBe(true);
    expect(decodedExpected(state.fires[1]?.message ?? '').specHash).toBe(
      expectedFromBytes(TWO_STAGE_SPEC).specHash
    );
    expect(state.timeouts).toEqual([MULTI_STAGE_WORKFLOW, 'bdc-multi-stage-development-codex']);
  });

  test('real ladder without a compatible binding blocks after one cancelled fire', async () => {
    const { opts, state } = options(TWO_STAGE_SPEC, {
      deps: {
        poll: async () => {
          throw new TimeoutError('stalled');
        },
      },
    });
    const record = await runCascade(opts);
    expect(state.fires.map(fire => fire.workflowName)).toEqual([MULTI_STAGE_WORKFLOW]);
    expect(state.cancels).toEqual(['run-1']);
    expect(record.status).toBe('blocked');
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]?.gateFailReason).toContain('compatible-escalation-unavailable');
    expect(record.telemetry.climbed).toBe(false);
    expect(record.frontierApproval).toBeUndefined();
    expect(state.fires.some(fire => FEATURE_WORKFLOWS.includes(fire.workflowName))).toBe(false);
  });

  test('an identical next binding is not a climb and does not fire again', async () => {
    const sameNext = tier('codex', 'bdc-feature-development-codex', {
      laneWorkflows: { [MULTI_STAGE_WORKFLOW]: MULTI_STAGE_WORKFLOW },
    });
    const { opts, state } = options(
      TWO_STAGE_SPEC,
      { entryOverride: 'cursor' },
      {
        tiers: [cursor, sameNext],
        refusedTiers: [],
        premiumTiers: [],
        poll: async () => {
          throw new TimeoutError('stalled');
        },
      }
    );
    const record = await runCascade(opts);
    expect(state.fires).toHaveLength(1);
    expect(record.telemetry.climbed).toBe(false);
    expect(record.status).toBe('blocked');
    expect(record.attempts[0]?.gateFailReason).toContain('compatible-escalation-unavailable');
  });

  test.each(FEATURE_WORKFLOWS)('%s binding is not a compatible seat', async featureWorkflow => {
    const featureBinding = tier('codex', 'bdc-feature-development-codex', {
      laneWorkflows: { [MULTI_STAGE_WORKFLOW]: featureWorkflow },
    });
    const { opts, state } = options(
      TWO_STAGE_SPEC,
      { entryOverride: 'cursor' },
      {
        tiers: [cursor, featureBinding],
        refusedTiers: [],
        premiumTiers: [],
        poll: async () => {
          throw new TimeoutError('stalled');
        },
      }
    );
    const record = await runCascade(opts);
    expect(record.status).toBe('blocked');
    expect(state.fires.map(fire => fire.workflowName)).toEqual([MULTI_STAGE_WORKFLOW]);
  });
});

describe('approval, cancellation, and deduplication', () => {
  test('premium compatible timeout pauses without firing and resume keeps the binding', async () => {
    const cursor = tier('cursor', 'bdc-feature-development-cursor');
    const frontier = tier('frontier', 'bdc-feature-development-fable', {
      isFrontier: true,
      laneWorkflows: { [MULTI_STAGE_WORKFLOW]: 'bdc-multi-stage-development-fable' },
    });
    let polls = 0;
    const { opts, state } = options(
      TWO_STAGE_SPEC,
      { entryOverride: 'cursor' },
      {
        tiers: [cursor, frontier],
        refusedTiers: [],
        premiumTiers: ['frontier'],
        poll: async () => {
          polls += 1;
          if (polls === 1) throw new TimeoutError('stalled');
          return pollOk('run-resumed');
        },
      }
    );
    const paused = await runCascade(opts);
    expect(paused.status).toBe('pending-frontier-approval');
    expect(state.cancels).toEqual([]);
    expect(state.fires.map(fire => fire.workflowName)).toEqual([MULTI_STAGE_WORKFLOW]);
    expect(paused.frontierApproval?.workflowName).toBe('bdc-multi-stage-development-fable');
    expect(paused.frontierApproval?.expectedSpec).toEqual(expectedFromBytes(TWO_STAGE_SPEC));

    const resumeDir = await mkdtemp(join(tmpdir(), 'multi-stage-resume-'));
    try {
      const resumed = await resumeFrontierTier(paused, {
        token: 'test-token',
        outDir: resumeDir,
        deps: opts.deps,
      });
      expect(resumed.status).toBe('won');
      expect(state.fires.map(fire => fire.workflowName)).toEqual([
        MULTI_STAGE_WORKFLOW,
        'bdc-multi-stage-development-fable',
      ]);
      expect(decodedExpected(state.fires[1]?.message ?? '')).toEqual(
        expectedFromBytes(TWO_STAGE_SPEC)
      );
      expect(state.fires.some(fire => fire.workflowName === 'bdc-feature-development-fable')).toBe(
        false
      );
    } finally {
      await rm(resumeDir, { recursive: true, force: true });
    }
  });

  test('premium without a compatible binding cancels and does not open a feature packet', async () => {
    const cursor = tier('cursor', 'bdc-feature-development-cursor');
    const frontier = tier('frontier', 'bdc-feature-development-fable', { isFrontier: true });
    const { opts, state } = options(
      TWO_STAGE_SPEC,
      { entryOverride: 'cursor' },
      {
        tiers: [cursor, frontier],
        refusedTiers: [],
        premiumTiers: ['frontier'],
        poll: async () => {
          throw new TimeoutError('stalled');
        },
      }
    );
    const record = await runCascade(opts);
    expect(state.cancels).toEqual(['run-1']);
    expect(record.status).toBe('blocked');
    expect(record.frontierApproval).toBeUndefined();
    expect(state.fires.map(fire => fire.workflowName)).toEqual([MULTI_STAGE_WORKFLOW]);
    expect(record.attempts[0]?.gateFailReason).toContain('compatible-escalation-unavailable');
  });

  test('a cancelled run does not climb', async () => {
    const { opts, state } = options(TWO_STAGE_SPEC, {
      deps: { judge: () => cancelledVerdict() },
    });
    const record = await runCascade(opts);
    expect(record.status).toBe('cancelled');
    expect(state.fires).toHaveLength(1);
    expect(record.telemetry.climbed).toBe(false);
  });

  test('an existing lock refuses before fire', async () => {
    const { opts, state } = options(TWO_STAGE_SPEC, {
      deps: {
        acquireWoLock: async (woId, project, cascadeId) => ({
          acquired: false,
          path: 'memory-lock',
          record: {
            woId,
            project,
            cascadeId: 'other-cascade',
            status: 'running',
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        }),
      },
    });
    const record = await runCascade(opts);
    expect(record.status).toBe('blocked');
    expect(state.fires).toHaveLength(0);
  });

  test('an existing claim refuses before fire', async () => {
    const { opts, state } = options(TWO_STAGE_SPEC, {
      deps: {
        findWoClaim: async () => ({
          number: 9,
          state: 'OPEN',
          title: 'WO-TEST-001 already claimed',
          url: 'https://example.test/pull/9',
          repo: 'thinmansoftware/bdc-harness',
        }),
      },
    });
    const record = await runCascade(opts);
    expect(record.status).toBe('refused');
    expect(record.refusalReason?.reason).toBe('already-satisfied');
    expect(state.fires).toHaveLength(0);
  });

  test('a duplicate dispatch record does not fire again', async () => {
    const existing: CascadeRunRecord = {
      cascadeId: 'dispatch-existing',
      woId: 'WO-TEST-001',
      project: 'bdc-harness',
      request: {
        woClass: 'MIXED',
        tags: [],
        entryOverride: null,
        dryRun: false,
        workflow: MULTI_STAGE_WORKFLOW,
      },
      createdAt: '2026-10-26T00:00:00.000Z',
      status: 'running',
      winningTier: null,
      attempts: [],
      totalCostUsd: null,
      telemetry: { entryTier: 'cursor', climbed: false, climbCount: 0, wonCheap: false },
    };
    const { opts, state } = options(TWO_STAGE_SPEC, {
      dispatchId: 'dispatch-existing',
      deps: {
        createRecord: async () => ({ created: false, path: 'memory-record', record: existing }),
      },
    });
    const record = await runCascade(opts);
    expect(record.cascadeId).toBe('dispatch-existing');
    expect(state.fires).toHaveLength(0);
  });
});

describe('existing routes stay in place', () => {
  test('omitted workflow keeps the selected tier workflow and omits request.workflow', async () => {
    const { opts, state } = options('WO Class: CODE\n', {
      workflow: undefined,
      woClass: 'CODE',
      entryOverride: 'cursor',
    });
    const record = await runCascade(opts);
    expect(record.status).toBe('won');
    expect(state.fires.map(fire => fire.workflowName)).toEqual(['bdc-feature-development-cursor']);
    expect('workflow' in record.request).toBe(false);
    expect(state.freezes).toHaveLength(0);
  });

  test('an explicit feature workflow and a tier alias select that tier', async () => {
    const byWorkflow = options('WO Class: CODE\n', {
      workflow: 'bdc-feature-development-codex',
      woClass: 'CODE',
    });
    const workflowRecord = await runCascade(byWorkflow.opts);
    expect(byWorkflow.state.fires.map(fire => fire.workflowName)).toEqual([
      'bdc-feature-development-codex',
    ]);
    expect(workflowRecord.request.workflow).toBe('bdc-feature-development-codex');
    expect(workflowRecord.request.entryOverride).toBe('codex');

    const byAlias = options('WO Class: CODE\n', { workflow: 'codex', woClass: 'CODE' });
    const aliasRecord = await runCascade(byAlias.opts);
    expect(byAlias.state.fires.map(fire => fire.workflowName)).toEqual([
      'bdc-feature-development-codex',
    ]);
    expect(aliasRecord.request.entryOverride).toBe('codex');
  });

  test('an unknown workflow throws before lock, record, or fire', async () => {
    let locks = 0;
    let fires = 0;
    let records = 0;
    const { opts } = options(TWO_STAGE_SPEC, {
      workflow: 'not-a-real-lane',
      deps: {
        acquireWoLock: async () => {
          locks += 1;
          throw new Error('lock should not be acquired');
        },
        createRecord: async () => {
          records += 1;
          throw new Error('record should not be created');
        },
        fire: async () => {
          fires += 1;
          return fireOk('nope');
        },
      },
    });
    await expect(runCascade(opts)).rejects.toThrow(/Unknown workflow/);
    expect(locks).toBe(0);
    expect(fires).toBe(0);
    expect(records).toBe(0);
  });

  test('CLI help advertises --workflow and omitted parsing leaves it undefined', async () => {
    const explicit = parseArgs([
      'bun',
      'cli.ts',
      'fire',
      'WO-TEST-001',
      '--workflow',
      MULTI_STAGE_WORKFLOW,
      '--dry-run',
    ]);
    expect(explicit.workflow).toBe(MULTI_STAGE_WORKFLOW);
    const omitted = parseArgs(['bun', 'cli.ts', 'fire', 'WO-TEST-001', '--dry-run']);
    expect(omitted.workflow).toBeUndefined();
    const proc = Bun.spawn(
      ['bun', join(REPO_ROOT, 'packages/smart-cauldron/src/cli.ts'), '--help'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const text = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(text).toContain('--workflow');
  });
});

describe('source selection parity', () => {
  test('marked block wins over an earlier example and a single unmarked block is accepted', () => {
    const marked = mixedSpec(
      [
        fenced(stagesDocument(['example-stage'])),
        '',
        '## Canonical stages',
        '',
        fenced(stagesDocument(['real-stage'])),
      ].join('\n')
    );
    expect(validateCanonicalStages(marked).stageIds).toEqual(['real-stage']);
    const single = mixedSpec(fenced(stagesDocument(['solo'])));
    expect(validateCanonicalStages(single).stageIds).toEqual(['solo']);
  });

  test('readSpecClass follows the lane token rule and does not default to CODE', () => {
    expect(readSpecClass('WO Class: MIXED\n')).toBe('MIXED');
    expect(readSpecClass('Class: DOCS\n')).toBe('DOCUMENTATION');
    expect(readSpecClass('Class: CODE extra\n')).toBe('CODE');
    expect(readSpecClass('no class line\n')).toBeNull();
    expect(readSpecClass('WO Class: SOMETHING\n')).toBeNull();
  });

  test('YAML heredoc parser and TypeScript helper agree on fixtures', async () => {
    const yaml = await readFile(MULTI_STAGE_YAML, 'utf8');
    const start = yaml.indexOf('id: parse-stages');
    expect(start).toBeGreaterThan(-1);
    const blocks = [...yaml.slice(start).matchAll(/<<'PYEOF'\n([\s\S]*?)\n[ \t]*PYEOF/g)].map(
      match => dedent(match[1] ?? '')
    );
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const select = blocks[0] ?? '';
    const validate = blocks[1] ?? '';
    const fixtures = [
      TWO_STAGE_SPEC,
      ONE_STAGE_SPEC,
      mixedSpec('nothing here'),
      mixedSpec(`## Canonical stages\n\n${fenced('stages: []')}`),
      mixedSpec(`## Canonical stages\n\n${fenced(stagesDocument(['alpha'], 'false'))}`),
      mixedSpec(`${fenced(stagesDocument(['one']))}\n\n${fenced(stagesDocument(['two']))}`),
      mixedSpec(
        `${fenced(stagesDocument(['example-stage']))}\n\n## Canonical stages\n\n${fenced(stagesDocument(['real-stage']))}`
      ),
      mixedSpec(fenced(stagesDocument(['solo']))),
      mixedSpec(stagesDocument(['unfenced'])),
    ];
    for (const fixture of fixtures) {
      const python = await runPythonParser(select, validate, fixture);
      let typescript: { ok: true; ids: string[] } | { ok: false };
      try {
        typescript = { ok: true, ids: validateCanonicalStages(fixture).stageIds };
      } catch {
        typescript = { ok: false };
      }
      expect(typescript.ok).toBe(python.ok);
      if (typescript.ok && python.ok) expect(typescript.ids).toEqual(python.ids);
    }
  });

  test('bash rst_class tokens match readSpecClass except the CODE default', async () => {
    const yaml = await readFile(CURSOR_YAML, 'utf8');
    const match = yaml.match(/rst_class\(\) \{[\s\S]*?\n      \}/);
    expect(match?.[0]).toBeDefined();
    const samples = ['WO Class: MIXED', 'Class: DOCS', 'Class: INFRA', 'no class line'];
    for (const sample of samples) {
      const proc = Bun.spawn(
        ['bash', '-c', `${match?.[0] ?? ''}\nprintf '%s\\n' "$1" | rst_class`, 'bash', sample],
        {
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      const bashClass = (await new Response(proc.stdout).text()).trim();
      expect(await proc.exited).toBe(0);
      const typescript = readSpecClass(`${sample}\n`);
      if (sample === 'no class line') {
        expect(bashClass).toBe('CODE');
        expect(typescript).toBeNull();
      } else if (sample === 'Class: DOCS') {
        expect(typescript).toBe('DOCUMENTATION');
        expect(bashClass).toBe('DOCUMENTATION');
      } else {
        expect(typescript).toBe(bashClass);
      }
    }
  });

  test('laneWorkflows pass through only when the map has non-empty strings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lane-workflows-'));
    try {
      const configPath = join(dir, 'ladder.json');
      await writeFile(
        configPath,
        JSON.stringify({
          tiers: [
            {
              name: 'cursor',
              workflowName: 'bdc-feature-development-cursor',
              isFrontier: false,
              costPerRunUsdEstimate: null,
              laneWorkflows: { [MULTI_STAGE_WORKFLOW]: 'bdc-multi-stage-development-cursor' },
            },
            {
              name: 'codex',
              workflowName: 'bdc-feature-development-codex',
              isFrontier: false,
              costPerRunUsdEstimate: null,
              laneWorkflows: {},
            },
          ],
        })
      );
      const tiers = loadLadder(configPath);
      expect(tiers[0]?.laneWorkflows).toEqual({
        [MULTI_STAGE_WORKFLOW]: 'bdc-multi-stage-development-cursor',
      });
      expect(tiers[1]?.laneWorkflows).toBeUndefined();
      expect(loadLadder().some(item => item.laneWorkflows !== undefined)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('packaged conductor resolves source freezing without devDependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-stage-prod-smoke-'));
    try {
      const vendor = join(root, 'vendor');
      const packageNames = await readWorkspacePackages();
      const copied = new Map<string, string>();
      const queue = ['@archon/smart-cauldron'];
      while (queue.length > 0) {
        const name = queue.shift();
        if (!name || copied.has(name)) continue;
        const source = packageNames.get(name);
        if (!source) throw new Error(`workspace package missing: ${name}`);
        const dest = join(vendor, name.replace('@', '').replace('/', '-'));
        await cp(source, dest, {
          recursive: true,
          filter: candidate => !candidate.split(sep).includes('node_modules'),
        });
        copied.set(name, dest);
        const manifest = JSON.parse(await readFile(join(dest, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, string>;
        };
        for (const [dep, version] of Object.entries(manifest.dependencies ?? {})) {
          if (version.startsWith('workspace:')) queue.push(dep);
        }
      }
      for (const dest of copied.values()) {
        const manifestPath = join(dest, 'package.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          optionalDependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        };
        delete manifest.devDependencies;
        for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
          const deps = manifest[field];
          if (!deps) continue;
          for (const [dep, version] of Object.entries(deps)) {
            if (!version.startsWith('workspace:')) continue;
            const target = copied.get(dep);
            if (!target) throw new Error(`production workspace dependency was not copied: ${dep}`);
            deps[dep] = `file:${target}`;
          }
        }
        await writeFile(manifestPath, JSON.stringify(manifest));
      }
      const smart = copied.get('@archon/smart-cauldron');
      if (!smart) throw new Error('smart-cauldron was not copied');
      const smartManifest = JSON.parse(await readFile(join(smart, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(smartManifest.devDependencies).toBeUndefined();
      expect(smartManifest.dependencies?.['@archon/core']).toContain('file:');
      const dependencies: Record<string, string> = {};
      for (const [name, dest] of copied) dependencies[name] = `file:${dest}`;
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'multi-stage-prod-smoke',
          private: true,
          type: 'module',
          dependencies,
        })
      );
      const install = Bun.spawn(
        ['bun', 'install', '--offline', '--production', '--ignore-scripts'],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' }
      );
      const installErr = await new Response(install.stderr).text();
      if ((await install.exited) !== 0) {
        throw new Error(`offline production install failed: ${installErr}`);
      }
      const cascadePath = join(smart, 'src', 'cascade.ts');
      const importer = join(root, 'import-smoke.ts');
      await writeFile(
        importer,
        [
          'const cascadePath = process.env.CASCADE_PATH ?? "";',
          'await import(cascadePath);',
          'const resolved = Bun.resolveSync("@archon/core/workflows/work-order-source", cascadePath);',
          'if (!resolved.endsWith("workflows/work-order-source.ts")) {',
          '  throw new Error("resolved " + resolved);',
          '}',
          'console.log(resolved);',
        ].join('\n')
      );
      const imported = Bun.spawn(['bun', importer], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CASCADE_PATH: pathToFileURL(cascadePath).href },
      });
      const output = await new Response(imported.stdout).text();
      const error = await new Response(imported.stderr).text();
      if ((await imported.exited) !== 0) {
        throw new Error(`production import failed: ${error}`);
      }
      expect(output).toContain('workflows/work-order-source.ts');
      expect(output).not.toContain(`${sep}smart-cauldron${sep}node_modules`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});

function dedent(text: string): string {
  const lines = text.split('\n');
  const widths = lines
    .filter(line => line.trim().length > 0)
    .map(line => line.match(/^[ \t]*/)?.[0].length ?? 0);
  const margin = widths.length > 0 ? Math.min(...widths) : 0;
  return lines.map(line => line.slice(margin)).join('\n');
}

async function readWorkspacePackages(): Promise<Map<string, string>> {
  const packagesDir = join(REPO_ROOT, 'packages');
  const names = new Map<string, string>();
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (manifest.name) names.set(manifest.name, dir);
    } catch {
      // Not every directory is a package.
    }
  }
  return names;
}

async function runPythonParser(
  select: string,
  validate: string,
  spec: string
): Promise<{ ok: true; ids: string[] } | { ok: false }> {
  const dir = await mkdtemp(join(tmpdir(), 'stage-parity-'));
  try {
    const specFile = join(dir, 'spec.md');
    const yamlOut = join(dir, 'stages.yaml');
    const jsonOut = join(dir, 'stages.json');
    await writeFile(specFile, spec);
    await writeFile(join(dir, 'select.py'), select);
    await writeFile(join(dir, 'validate.py'), validate);
    const selected = Bun.spawn(['python3', join(dir, 'select.py'), specFile, yamlOut], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await new Response(selected.stdout).text();
    await new Response(selected.stderr).text();
    if ((await selected.exited) !== 0) return { ok: false };
    const validated = Bun.spawn(['python3', join(dir, 'validate.py'), yamlOut, jsonOut], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await new Response(validated.stdout).text();
    await new Response(validated.stderr).text();
    if ((await validated.exited) !== 0) return { ok: false };
    const stages = JSON.parse(await readFile(jsonOut, 'utf8')) as Array<{ id?: unknown }>;
    return { ok: true, ids: stages.map(stage => String(stage.id)) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
