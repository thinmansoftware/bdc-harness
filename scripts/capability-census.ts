#!/usr/bin/env bun
/** Read-only capability census generator. This module never starts a service or opens a DB. */
import { readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';

// Root scripts are not workspace-package consumers, so Bun does not link @archon/* here.
import { OVERSEER_CAPABILITIES } from '../packages/core/src/db/overseer-capabilities';
import { MERGE_MANAGER_IDENTITY } from '../packages/overseer/src/merge-manager';
// No package subpath exports exist for these static registries either.
import { MAX_TIER, requiredTierForAction } from '../packages/overseer/src/tier-map';
import {
  TM_ALLOWED_ACTION_TYPES,
  TM_ALLOWED_RECIPIENTS,
} from '../packages/server/src/taskmaster/guard';

const OUTPUT_PATH = join(
  resolve(import.meta.dir, '..'),
  'docs/operations/capability-census-slice1.json'
);

export type LiveFlagState = 'on' | 'off' | 'deferred';

export interface CapabilityCensusEntry {
  capability_id: string;
  tier: number | null;
  live_flag_state: LiveFlagState;
  owner: string;
  deferral_expiry: string | null;
  flags: Readonly<Record<string, string | boolean | null>>;
}

export interface CapabilityCensus {
  schema_version: 'capability-census-slice1-v1';
  read_only: true;
  capabilities: CapabilityCensusEntry[];
}

const OVERSEER_ACTIONS: Readonly<Record<(typeof OVERSEER_CAPABILITIES)[number], string>> = {
  escalation: 'escalate_with_evidence',
  repair: 'repair_refire',
  branch: 'branch_refresh',
  lifecycle: 'lifecycle',
  merge: 'merge',
};

function envTrue(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function overseerState(
  env: Readonly<Record<string, string | undefined>>,
  capabilityEnabled: boolean
): LiveFlagState {
  const serviceEnabled = envTrue(env.OVERSEER_ENABLED);
  const emergencyStop = !['0', 'false', 'no'].includes(env.OVERSEER_EMERGENCY_STOP ?? '');
  const dryRun = envTrue(env.OVERSEER_DRY_RUN);
  if (!capabilityEnabled || !serviceEnabled) return 'off';
  return emergencyStop || dryRun ? 'deferred' : 'on';
}

function overseerFlags(
  capability: (typeof OVERSEER_CAPABILITIES)[number],
  env: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, boolean>> {
  const capabilityFlag = `OVERSEER_${capability.toUpperCase()}_ACTIONS_ENABLED`;
  return {
    OVERSEER_ENABLED: envTrue(env.OVERSEER_ENABLED),
    OVERSEER_EMERGENCY_STOP: !['0', 'false', 'no'].includes(env.OVERSEER_EMERGENCY_STOP ?? ''),
    OVERSEER_DRY_RUN: envTrue(env.OVERSEER_DRY_RUN),
    [capabilityFlag]: envTrue(env[capabilityFlag]),
  };
}

export function buildCapabilityCensus(
  env: Readonly<Record<string, string | undefined>> = process.env
): CapabilityCensus {
  const overseer = OVERSEER_CAPABILITIES.map(capability => {
    const flags = overseerFlags(capability, env);
    const capabilityFlag = `OVERSEER_${capability.toUpperCase()}_ACTIONS_ENABLED`;
    return {
      capability_id: `overseer.${capability}`,
      tier: requiredTierForAction(OVERSEER_ACTIONS[capability]),
      live_flag_state: overseerState(env, flags[capabilityFlag] ?? false),
      owner: 'packages/overseer',
      deferral_expiry: null,
      flags,
    } satisfies CapabilityCensusEntry;
  });

  const mergeFlags = overseerFlags('merge', env);
  const mergeManager: CapabilityCensusEntry = {
    capability_id: `merge-manager.${MERGE_MANAGER_IDENTITY}`,
    tier: requiredTierForAction('merge'),
    live_flag_state: overseerState(env, mergeFlags.OVERSEER_MERGE_ACTIONS_ENABLED ?? false),
    owner: 'packages/overseer',
    deferral_expiry: null,
    flags: mergeFlags,
  };

  const taskmasterEnabled = env.TASKMASTER_INTERVAL_MS !== '0';
  const taskmaster = TM_ALLOWED_ACTION_TYPES.map(action => ({
    capability_id: `taskmaster.${action}`,
    tier: null,
    live_flag_state: taskmasterEnabled ? ('on' as const) : ('off' as const),
    owner: 'packages/server/src/taskmaster',
    deferral_expiry: null,
    flags: {
      TASKMASTER_INTERVAL_MS: env.TASKMASTER_INTERVAL_MS ?? null,
      TASKMASTER_DEADMAN_INTERVAL_MS: env.TASKMASTER_DEADMAN_INTERVAL_MS ?? null,
      TASKMASTER_GH_REPOS: env.TASKMASTER_GH_REPOS ?? null,
      allowed_recipients: TM_ALLOWED_RECIPIENTS.join(','),
    },
  }));

  return {
    schema_version: 'capability-census-slice1-v1',
    read_only: true,
    capabilities: [...overseer, mergeManager, ...taskmaster],
  };
}

export function renderCapabilityCensus(census: CapabilityCensus): string {
  return `${JSON.stringify(census, null, 2)}\n`;
}

async function main(): Promise<void> {
  // The checked-in artifact records code-defined defaults, never ambient shell state.
  const rendered = renderCapabilityCensus(buildCapabilityCensus({}));
  if (process.argv.includes('--check')) {
    const current = await readFile(OUTPUT_PATH, 'utf8').catch(() => '');
    if (current !== rendered) {
      console.error('Capability census is stale; run bun run generate:capability-census');
      process.exitCode = 1;
      return;
    }
    console.log('Capability census is up to date (read-only; no enablement).');
    return;
  }
  await writeFile(OUTPUT_PATH, rendered);
  console.log(`Generated ${OUTPUT_PATH} (read-only; no enablement).`);
}

if (import.meta.main) await main();

export { MAX_TIER };
