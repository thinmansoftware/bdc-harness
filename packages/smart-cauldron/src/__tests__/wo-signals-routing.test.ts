/**
 * wo-signals-routing.test.ts -- WO-HARNESS-CONDUCTOR-RISK-ROUTING-01.
 *
 * A supervised fire with no -Tags routed an inventory WO (migrations + roles)
 * to the zero tier, which ladder.config.json says must stay off money/auth/
 * infra work. The conductor now reads the WO (labels, Rung classification,
 * spec body) and adds risk tags before the ruleset runs. These tests pin:
 *   - risky untagged CODE WOs route to a NON-zero tier
 *   - clean CODE WOs still route to zero (the 2026-11-02 floor is intact)
 *   - a spec `entry_tier:` pin is honored, a premium pin is not
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCascade } from '../cascade.js';
import type { CascadeDeps } from '../cascade.js';
import {
  EMPTY_WO_SIGNALS,
  mergeWoSignals,
  parseWoSpecSignals,
  resolveWoSignals,
  riskTagsFromLabels,
} from '../wo-signals.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const INVENTORY_SPEC = `# WO-SHOPOPS-INVENTORY-SLICE-01

WO Class: CODE
Rung classification: uncertain

## 1. Objective
Add the inventory_items table and its supabase/migrations file, create the
warehouse_staff role, and enable RLS with a policy per tenant.
`;

const CLEAN_SPEC = `# WO-XO-DOC-TYPO-01

WO Class: CODE
Rung classification: mechanical

## 1. Objective
Fix three typos in docs/runbooks/cauldron.md.
`;

/** Dry-run the cascade with a stubbed spec reader; returns the picked entry tier. */
async function entryFor(opts: {
  woId: string;
  spec: string | null;
  tags?: string[];
  labels?: string[];
  woClass?: string;
  entryOverride?: string;
  onRead?: () => void;
}): Promise<{ entry: string; requestEntryOverride: string | null }> {
  const outDir = await mkdtemp(join(tmpdir(), 'sc-wo-signals-'));
  tempDirs.push(outDir);
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const deps: CascadeDeps = {
      readWoSpec: async () => {
        opts.onRead?.();
        return opts.spec;
      },
      writeRecord: async (record, _dir) => join(outDir, `${record.cascadeId}.json`),
      createRecord: async (record, _dir) => ({
        created: true,
        path: join(outDir, `${record.cascadeId}.json`),
        record,
      }),
    };
    const record = await runCascade({
      woId: opts.woId,
      woClass: opts.woClass ?? 'CODE',
      tags: opts.tags,
      labels: opts.labels,
      entryOverride: opts.entryOverride,
      dryRun: true,
      outDir,
      project: 'test-project',
      deps,
    });
    return {
      entry: record.telemetry.entryTier,
      requestEntryOverride: record.request.entryOverride,
    };
  } finally {
    log.mockRestore();
  }
}

describe('risky untagged CODE WOs leave the zero tier', () => {
  test('migrations + roles + RLS (the inventory WO shape) enters cursor, not zero', async () => {
    const result = await entryFor({ woId: 'WO-RISK-INVENTORY-01', spec: INVENTORY_SPEC });
    expect(result.entry).toBe('cursor');
    expect(result.entry).not.toBe('zero');
  });

  test('money/billing spec enters cursor', async () => {
    const spec =
      '# WO\n\nWO Class: CODE\n\nRefund the customer through Stripe when the charge fails.\n';
    const result = await entryFor({ woId: 'WO-RISK-MONEY-01', spec });
    expect(result.entry).toBe('cursor');
  });

  test('auth spec enters cursor', async () => {
    const spec = '# WO\n\nWO Class: CODE\n\nRotate the JWT signing path for portal login.\n';
    const result = await entryFor({ woId: 'WO-RISK-AUTH-01', spec });
    expect(result.entry).toBe('cursor');
  });

  test('a billing/auth/infra Rung classification alone keeps the WO off zero', async () => {
    const spec =
      '# WO\n\nWO Class: CODE\nRung classification: billing/auth/infra\n\nReword one label.\n';
    const result = await entryFor({ woId: 'WO-RISK-RUNG-01', spec });
    expect(result.entry).toBe('cursor');
  });

  test('a risk label keeps an otherwise clean WO off zero', async () => {
    const result = await entryFor({
      woId: 'WO-RISK-LABEL-01',
      spec: CLEAN_SPEC,
      labels: ['wo', 'risk:billing'],
    });
    expect(result.entry).toBe('cursor');
  });

  test('caller-supplied mechanical tag does not outrank a detected migration risk', async () => {
    const result = await entryFor({
      woId: 'WO-RISK-MECH-MIGRATION-01',
      spec: INVENTORY_SPEC,
      tags: ['mechanical'],
    });
    expect(result.entry).toBe('cursor');
  });
});

describe('clean WOs and unreadable specs keep the zero floor', () => {
  test('a clean mechanical CODE spec still enters zero', async () => {
    const result = await entryFor({ woId: 'WO-CLEAN-01', spec: CLEAN_SPEC });
    expect(result.entry).toBe('zero');
  });

  test('an unfilled Rung template line does not make a clean WO look risky', async () => {
    const spec =
      '# WO\n\nWO Class: CODE\nRung classification: mechanical | feature/net-new | billing/auth/infra | uncertain\n\nFix a typo.\n';
    const result = await entryFor({ woId: 'WO-CLEAN-TEMPLATE-01', spec });
    expect(result.entry).toBe('zero');
  });

  test('an unreadable spec falls back to the ruleset pick (plain CODE -> zero)', async () => {
    const result = await entryFor({ woId: 'WO-UNREADABLE-01', spec: null });
    expect(result.entry).toBe('zero');
  });
});

describe('entry pin', () => {
  test('a spec entry_tier pin sets the entry tier and records it as the override', async () => {
    const spec = `${INVENTORY_SPEC}\nentry_tier: codex\n`;
    const result = await entryFor({ woId: 'WO-PIN-CODEX-01', spec });
    expect(result.entry).toBe('codex');
    expect(result.requestEntryOverride).toBe('codex');
  });

  test('pinning a clean WO to a stronger tier works too', async () => {
    const spec = `${CLEAN_SPEC}\nEntry tier: cursor\n`;
    const result = await entryFor({ woId: 'WO-PIN-CURSOR-01', spec });
    expect(result.entry).toBe('cursor');
  });

  test('a risky spec cannot pin itself below the risk floor (entry_tier: zero is ignored)', async () => {
    const spec = `${INVENTORY_SPEC}\nentry_tier: zero\n`;
    const result = await entryFor({ woId: 'WO-PIN-ZERO-RISKY-01', spec });
    expect(result.entry).toBe('cursor');
    expect(result.requestEntryOverride).toBeNull();
  });

  test('caller risk tags also set the floor: --tags auth with a clean spec pinning zero enters cursor', async () => {
    const spec = `${CLEAN_SPEC}\nentry_tier: zero\n`;
    const result = await entryFor({ woId: 'WO-PIN-ZERO-TAGGED-01', spec, tags: ['auth'] });
    expect(result.entry).toBe('cursor');
    expect(result.requestEntryOverride).toBeNull();
  });

  test('the class sets the floor: an INFRA WO cannot pin itself to zero', async () => {
    const spec = `${CLEAN_SPEC}\nentry_tier: zero\n`;
    const result = await entryFor({ woId: 'WO-PIN-ZERO-INFRA-01', spec, woClass: 'INFRA' });
    expect(result.entry).toBe('cursor');
    expect(result.requestEntryOverride).toBeNull();
  });

  test('a clean spec may still pin zero explicitly', async () => {
    const spec = `${CLEAN_SPEC}\nentry_tier: zero\n`;
    const result = await entryFor({ woId: 'WO-PIN-ZERO-CLEAN-01', spec });
    expect(result.entry).toBe('zero');
  });

  test('a spec cannot pin the premium frontier tier (needs operator approval)', async () => {
    const spec = `${CLEAN_SPEC}\nentry_tier: frontier\n`;
    const result = await entryFor({ woId: 'WO-PIN-FRONTIER-01', spec });
    expect(result.entry).not.toBe('frontier');
    expect(result.entry).toBe('zero');
  });

  test('an unknown pinned tier name is ignored', async () => {
    const spec = `${CLEAN_SPEC}\nentry_tier: not-a-tier\n`;
    const result = await entryFor({ woId: 'WO-PIN-UNKNOWN-01', spec });
    expect(result.entry).toBe('zero');
    expect(result.requestEntryOverride).toBeNull();
  });

  test('an explicit caller --entry wins over a spec pin and the spec is never read', async () => {
    let reads = 0;
    const spec = `${CLEAN_SPEC}\nentry_tier: cursor\n`;
    const result = await entryFor({
      woId: 'WO-PIN-CALLER-WINS-01',
      spec,
      entryOverride: 'codex',
      onRead: () => {
        reads += 1;
      },
    });
    expect(result.entry).toBe('codex');
    expect(reads).toBe(0);
  });
});

describe('wo-signals parsing', () => {
  test('parseWoSpecSignals reads rung, pin and risk reasons', () => {
    const signals = parseWoSpecSignals(`${INVENTORY_SPEC}\nentry_tier: cursor\n`);
    expect(signals.specRead).toBe(true);
    expect(signals.entryPin).toBe('cursor');
    expect(signals.rungClassification).toBe('uncertain');
    expect([...signals.riskTags].sort()).toEqual(['auth', 'migration']);
    expect(signals.reasons.some(r => r.includes('migration'))).toBe(true);
  });

  test('a clean spec yields no risk tags', () => {
    const signals = parseWoSpecSignals(CLEAN_SPEC);
    expect(signals.riskTags).toEqual([]);
    expect(signals.entryPin).toBeNull();
  });

  test('riskTagsFromLabels maps money, auth and migration labels', () => {
    expect(riskTagsFromLabels(['wo', 'prio:P1'])).toEqual([]);
    expect(riskTagsFromLabels(['risk:billing'])).toEqual(['money']);
    expect(riskTagsFromLabels(['area:auth', 'migration'])).toEqual(['auth', 'migration']);
  });

  test('mergeWoSignals unions label and spec tags', () => {
    const merged = mergeWoSignals(['risk:billing'], parseWoSpecSignals(INVENTORY_SPEC));
    expect([...merged.riskTags].sort()).toEqual(['auth', 'migration', 'money']);
  });

  test('resolveWoSignals never throws when the reader throws', async () => {
    const signals = await resolveWoSignals({
      woId: 'WO-X',
      readSpec: async () => {
        throw new Error('network down');
      },
    });
    expect(signals).toEqual({ ...EMPTY_WO_SIGNALS });
  });
});
