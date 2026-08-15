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

describe('live ladder SOR', () => {
  test('canonical ladder name order is zero -> qwen -> codex -> claude -> frontier', () => {
    const names = loadLadder().map(t => t.name);
    expect(names).toEqual(['zero', 'qwen', 'codex', 'claude', 'frontier']);
  });

  test('refusedTiers includes glm (dark lane)', () => {
    const refused = loadRefusedTiers();
    expect(Array.isArray(refused)).toBe(true);
    expect(refused).toContain('glm');
  });
});

describe('live ruleset routing', () => {
  test('mechanical CODE enters zero', () => {
    const ruleset = loadRuleset();
    const entry = pickEntryTier({ woClass: 'CODE', tags: ['mechanical'] }, ruleset);
    expect(entry).toBe('zero');
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
