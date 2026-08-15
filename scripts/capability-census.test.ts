import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';

import { buildCapabilityCensus, MAX_TIER, renderCapabilityCensus } from './capability-census';

const ENV_KEYS = [
  'OVERSEER_ENABLED',
  'OVERSEER_EMERGENCY_STOP',
  'OVERSEER_DRY_RUN',
  'OVERSEER_ESCALATION_ACTIONS_ENABLED',
  'OVERSEER_REPAIR_ACTIONS_ENABLED',
  'OVERSEER_BRANCH_ACTIONS_ENABLED',
  'OVERSEER_LIFECYCLE_ACTIONS_ENABLED',
  'OVERSEER_MERGE_ACTIONS_ENABLED',
  'TASKMASTER_GH_REPOS',
  'TASKMASTER_INTERVAL_MS',
  'TASKMASTER_DEADMAN_INTERVAL_MS',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('capability census slice 1', () => {
  test('reports the real registries, tiers, owners, and default live flags', () => {
    const census = buildCapabilityCensus();
    expect(census.read_only).toBe(true);
    expect(census.capabilities).toHaveLength(10);
    for (const entry of census.capabilities) {
      expect(entry.capability_id).toMatch(/^(overseer|merge-manager|taskmaster)\./);
      if (entry.tier !== null) {
        expect(entry.tier).toBeGreaterThanOrEqual(0);
        expect(entry.tier).toBeLessThanOrEqual(MAX_TIER);
      }
      expect(['on', 'off', 'deferred']).toContain(entry.live_flag_state);
      expect(entry.owner).toMatch(/^packages\//);
      expect(entry.deferral_expiry).toBeNull();
    }
    expect(census.capabilities.find(row => row.capability_id === 'overseer.merge')).toMatchObject({
      tier: 1,
      live_flag_state: 'off',
      flags: { OVERSEER_MERGE_ACTIONS_ENABLED: false },
    });
    expect(
      census.capabilities.find(row => row.capability_id === 'taskmaster.digest')
    ).toMatchObject({
      tier: null,
      live_flag_state: 'on',
    });
  });

  test('reports enabled, deferred, and killed states without mutating flags', () => {
    process.env.OVERSEER_ENABLED = 'true';
    process.env.OVERSEER_EMERGENCY_STOP = 'false';
    process.env.OVERSEER_MERGE_ACTIONS_ENABLED = 'true';
    process.env.TASKMASTER_INTERVAL_MS = '0';
    expect(buildCapabilityCensus().capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability_id: 'overseer.merge', live_flag_state: 'on' }),
        expect.objectContaining({ capability_id: 'taskmaster.nudge', live_flag_state: 'off' }),
      ])
    );
    process.env.OVERSEER_DRY_RUN = 'true';
    expect(
      buildCapabilityCensus().capabilities.find(row => row.capability_id === 'overseer.merge')
        ?.live_flag_state
    ).toBe('deferred');
  });

  test('matches the checked-in golden artifact against code-defined defaults', async () => {
    const path = join(
      resolve(import.meta.dir, '..'),
      'docs/operations/capability-census-slice1.json'
    );
    const defaults = buildCapabilityCensus({});
    const overseerDefaults = defaults.capabilities.filter(
      row => !row.capability_id.startsWith('taskmaster.')
    );
    expect(overseerDefaults).toHaveLength(6);
    for (const row of overseerDefaults) {
      expect(row).toMatchObject({
        live_flag_state: 'off',
        flags: {
          OVERSEER_ENABLED: false,
          OVERSEER_EMERGENCY_STOP: true,
        },
      });
      const actionFlag = Object.entries(row.flags).find(([key]) =>
        key.endsWith('_ACTIONS_ENABLED')
      );
      expect(actionFlag?.[1]).toBe(false);
    }
    expect(await readFile(path, 'utf8')).toBe(renderCapabilityCensus(defaults));
  });

  test('repository defaults do not inherit ambient process flags', () => {
    process.env.OVERSEER_ENABLED = 'true';
    process.env.OVERSEER_EMERGENCY_STOP = 'false';
    process.env.OVERSEER_MERGE_ACTIONS_ENABLED = 'true';
    expect(
      buildCapabilityCensus({}).capabilities.find(row => row.capability_id === 'overseer.merge')
    ).toMatchObject({ live_flag_state: 'off' });
  });
});
