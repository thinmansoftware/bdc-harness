/**
 * ladder-routing.test.ts -- Live ladder SOR + routing/refuse coverage.
 *
 * WO-HARNESS-TIER-LADDER-UNIFY-01 done-when #4:
 *   1. mechanical CODE enters zero (live ruleset)
 *   2. INFRA / money route stronger (claude)
 *   3. --entry override wins over ruleset
 *   4. dark lane (glm / refusedTiers) is hard-refused
 */

import { describe, test, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadLadder, loadRefusedTiers } from '../ladder.js';
import { loadRuleset, pickEntryTier } from '../conductor.js';
import { runCascade } from '../cascade.js';
import type { CascadeDeps } from '../cascade.js';
import { parse } from 'yaml';
import { readFile } from 'fs/promises';
import { selectQuotaExhaustionRoute } from '../../../workflows/src/node-failover.js';
import { dagNodeSchema } from '../../../workflows/src/schemas/dag-node.js';

test('bounded same-provider targets cannot route quota to another provider', () => {
  for (const failover_provider of [undefined, 'codex']) {
    const node = dagNodeSchema.parse({
      id: 'implement',
      prompt: 'Build',
      provider: 'codex',
      ...(failover_provider ? { failover_provider } : {}),
    });
    expect(selectQuotaExhaustionRoute('codex', node, {})).toEqual({ kind: 'wait' });
    expect(selectQuotaExhaustionRoute('codex', node, { failoverProvider: 'codex' })).toEqual({
      kind: 'wait',
    });
  }
});

test('actual availability executor dispatches only declared targets and never an implicit successor', async () => {
  // Reuse the existing hermetic DAG/provider fixture in its required isolated
  // process, rather than copy its store, provider and executor scaffolding.
  const fixture = new URL('../../../workflows/src/node-failover.test.ts', import.meta.url);
  const child = Bun.spawn(
    [
      process.execPath,
      'test',
      fixture.pathname.replace(/^\/(.:\/)/, '$1'),
      '--test-name-pattern',
      'Scenario 1: availability error|Scenario 4e: no failover fields',
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, SMART_CAULDRON_HERMETIC: '1' },
    }
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, stdout + stderr).toBe(0);
  expect(stdout + stderr).toContain('2 pass');
  expect(stdout + stderr).toContain('Scenario 1: availability error');
  expect(stdout + stderr).toContain('Scenario 4e: no failover fields');
});

test('current parsed Codex-only lane keeps effective providers and global ladder unchanged', async () => {
  const path = new URL(
    '../../../../.archon/workflows/defaults/bdc-feature-development-codex-only.yaml',
    import.meta.url
  );
  const workflow = parse(await readFile(path, 'utf8'));
  expect(workflow.provider).toBe('codex');
  expect(workflow.name).toBe('bdc-feature-development-codex-only');
  const prompts = workflow.nodes.filter(
    (node: Record<string, unknown>) => node.prompt || node.loop
  );
  expect(prompts.length).toBeGreaterThan(0);
  for (const node of workflow.nodes) {
    expect(node.provider ?? workflow.provider).toBe('codex');
    if (node.failover_provider !== undefined) expect(node.failover_provider).toBe('codex');
  }
  expect(loadLadder().find(tier => tier.name === 'codex')?.workflowName).toBe(
    'bdc-feature-development-codex'
  );
});

describe('live ladder SOR', () => {
  // 'cursor' inserted below codex by WO-HARNESS-CURSOR-BUILD-SEAT-01; flipped
  // LIVE 2026-09-29 (removed from refusedTiers).
  test('canonical ladder name order is zero -> qwen -> cursor -> codex -> claude -> frontier', () => {
    const names = loadLadder().map(t => t.name);
    expect(names).toEqual(['zero', 'qwen', 'cursor', 'codex', 'claude', 'frontier']);
  });

  test('refusedTiers includes glm (dark lane)', () => {
    const refused = loadRefusedTiers();
    expect(Array.isArray(refused)).toBe(true);
    expect(refused).toContain('glm');
  });

  // M-20260929h: cursor and zero are live; qwen and glm stay refused. zero is
  // first in the ladder, so it is the entry floor.
  test('cursor and zero are live, glm/qwen stay refused, zero is the entry floor', () => {
    const refused = loadRefusedTiers();
    expect(refused).not.toContain('cursor');
    expect(refused).not.toContain('zero');
    expect(refused).toContain('qwen');
    expect(refused).toContain('glm');
    expect([...refused].sort()).toEqual(['glm', 'qwen']);
    const firstLive = loadLadder().find(t => !refused.includes(t.name));
    expect(firstLive?.name).toBe('zero');
  });
});

describe('live ruleset routing', () => {
  test('mechanical CODE enters zero', () => {
    const ruleset = loadRuleset();
    const entry = pickEntryTier({ woClass: 'CODE', tags: ['mechanical'] }, ruleset);
    expect(entry).toBe('zero');
  });

  test('plain CODE and no-match default enter cursor (2026-09-29 default lane)', () => {
    const ruleset = loadRuleset();
    expect(pickEntryTier({ woClass: 'CODE' }, ruleset)).toBe('cursor');
    expect(pickEntryTier({ woClass: 'CODE', tags: ['docs'] }, ruleset)).toBe('cursor');
    expect(ruleset.defaultEntry).toBe('cursor');
  });

  test('feature-tagged CODE still enters codex', () => {
    const ruleset = loadRuleset();
    expect(pickEntryTier({ woClass: 'CODE', tags: ['feature'] }, ruleset)).toBe('codex');
  });

  test('INFRA routes stronger (claude)', () => {
    const ruleset = loadRuleset();
    expect(pickEntryTier({ woClass: 'INFRA' }, ruleset)).toBe('claude');
  });

  test('money tag routes stronger (claude)', () => {
    const ruleset = loadRuleset();
    expect(pickEntryTier({ tags: ['money'] }, ruleset)).toBe('claude');
    expect(pickEntryTier({ tags: ['billing'] }, ruleset)).toBe('claude');
  });
});

describe('cascade entry override and refuse', () => {
  test('--entry override wins over ruleset (dry-run selects claude)', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'sc-ladder-override-'));
    try {
      let fireCalled = false;
      const deps: CascadeDeps = {
        fire: async () => {
          fireCalled = true;
          return { ok: false, runId: null, conversationId: null, infraError: 'should-not-fire' };
        },
        writeRecord: async (record, _dir) => join(outDir, `${record.cascadeId}.json`),
        createRecord: async (record, _dir) => ({
          created: true,
          path: join(outDir, `${record.cascadeId}.json`),
          record,
        }),
      };

      // mechanical CODE would pick zero; explicit entryOverride must win.
      const record = await runCascade({
        woId: 'WO-LADDER-ENTRY-OVERRIDE',
        woClass: 'CODE',
        tags: ['mechanical'],
        entryOverride: 'claude',
        dryRun: true,
        outDir,
        project: 'test-project',
        deps,
      });

      expect(fireCalled).toBe(false);
      expect(record.status).toBe('planned');
      expect(record.telemetry.entryTier).toBe('claude');
      expect(record.request.entryOverride).toBe('claude');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test('dark lane glm is refused and does not fire', async () => {
    let fireCalled = false;
    const deps: CascadeDeps = {
      fire: async () => {
        fireCalled = true;
        return { ok: false, runId: null, conversationId: null, infraError: 'should-not-fire' };
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    await expect(
      runCascade({
        woId: 'WO-LADDER-DARK-REFUSE',
        woClass: 'CODE',
        tags: ['mechanical'],
        entryOverride: 'glm',
        dryRun: true,
        outDir: '/tmp/smart-cauldron-dark-refuse',
        project: 'test-project',
        deps,
      })
    ).rejects.toThrow(/Refused dark\/retired|refusedTiers|dark\/retired/i);

    expect(fireCalled).toBe(false);
  });
});
