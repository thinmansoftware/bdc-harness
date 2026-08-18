/**
 * ladder.ts -- Loads the ordered tier ladder from config/ladder.config.json.
 *
 * The ladder defines which workflow lanes exist and their order (cheapest first).
 * Edit config/ladder.config.json to change tier order or workflow bindings --
 * never hardcode these values in orchestrator source.
 *
 * This config file is the CANONICAL LADDER SOR for Smart Cauldron conductor fires.
 * refusedTiers lists dark/retired lanes that must never be selected as live entry.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { LadderTier } from './types.js';

interface RawTier {
  name: string;
  workflowName: string;
  isFrontier: boolean;
  costPerRunUsdEstimate: number | null;
}

interface RawLadderConfig {
  tiers: RawTier[];
  refusedTiers?: string[];
  premiumTiers?: string[];
}

/**
 * Default premium-tier set used when the ladder config does not declare
 * `premiumTiers`. Premium tiers are never fired by an AUTOMATIC climb; the
 * cascade pauses for operator approval instead (WO-HARNESS-FRONTIER-CLIMB-
 * APPROVAL-GATE-01). Default is the frontier (fable) rung.
 */
const DEFAULT_PREMIUM_TIERS: readonly string[] = ['frontier'];

function resolveLadderPath(configPath?: string): string {
  return configPath ?? join(import.meta.dir, '..', 'config', 'ladder.config.json');
}

function readLadderConfig(configPath?: string): RawLadderConfig {
  const resolved = resolveLadderPath(configPath);
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new Error(
      `[smart-cauldron/ladder] Failed to read ladder config at ${resolved}: ${(err as Error).message}`
    );
  }

  let config: RawLadderConfig;
  try {
    config = JSON.parse(raw) as RawLadderConfig;
  } catch (err) {
    throw new Error(
      `[smart-cauldron/ladder] Failed to parse ladder config at ${resolved}: ${(err as Error).message}`
    );
  }

  return config;
}

/**
 * Load the ordered tier ladder from config.
 *
 * @param configPath Optional path override; defaults to config/ladder.config.json
 *                   relative to this file's directory.
 * @returns Ordered array of LadderTier (cheapest first).
 * @throws If config is missing or malformed.
 */
export function loadLadder(configPath?: string): LadderTier[] {
  const config = readLadderConfig(configPath);

  if (!Array.isArray(config.tiers) || config.tiers.length === 0) {
    throw new Error('[smart-cauldron/ladder] ladder config must contain a non-empty "tiers" array');
  }

  for (const tier of config.tiers) {
    if (!tier.name || typeof tier.name !== 'string') {
      throw new Error('[smart-cauldron/ladder] each tier must have a string "name" field');
    }
    if (!tier.workflowName || typeof tier.workflowName !== 'string') {
      throw new Error(
        `[smart-cauldron/ladder] tier "${tier.name}" must have a string "workflowName" field`
      );
    }
    if (typeof tier.isFrontier !== 'boolean') {
      throw new Error(
        `[smart-cauldron/ladder] tier "${tier.name}" must have a boolean "isFrontier" field`
      );
    }
  }

  return config.tiers.map(t => ({
    name: t.name,
    workflowName: t.workflowName,
    isFrontier: t.isFrontier,
    costPerRunUsd: t.costPerRunUsdEstimate ?? null,
  }));
}

/**
 * Load the refused/dark tier names from the canonical ladder SOR.
 *
 * Missing or empty refusedTiers returns [] (backward compatible).
 * Callers must refuse these names as cascade entry even under --entry override.
 *
 * @param configPath Optional path override; defaults to config/ladder.config.json
 *                   relative to this file's directory.
 */
export function loadRefusedTiers(configPath?: string): string[] {
  const config = readLadderConfig(configPath);
  if (!Array.isArray(config.refusedTiers)) {
    return [];
  }
  return config.refusedTiers.filter(
    (name): name is string => typeof name === 'string' && name.length > 0
  );
}

/**
 * Load the premium-tier names from the canonical ladder SOR. Premium tiers are
 * never fired by an AUTOMATIC climb -- the cascade pauses for operator approval
 * instead (WO-HARNESS-FRONTIER-CLIMB-APPROVAL-GATE-01). An explicit --entry
 * override onto a premium tier is a human-typed action and bypasses the gate.
 *
 * When `premiumTiers` is absent from config, the default (['frontier']) is
 * returned so the gate protects the apex rung out of the box. An explicit empty
 * array in config disables the gate entirely (policy choice, honored verbatim).
 *
 * @param configPath Optional path override; defaults to config/ladder.config.json
 *                   relative to this file's directory.
 */
export function loadPremiumTiers(configPath?: string): string[] {
  const config = readLadderConfig(configPath);
  if (!Array.isArray(config.premiumTiers)) {
    return [...DEFAULT_PREMIUM_TIERS];
  }
  return config.premiumTiers.filter(
    (name): name is string => typeof name === 'string' && name.length > 0
  );
}
