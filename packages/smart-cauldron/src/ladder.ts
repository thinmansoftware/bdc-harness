/**
 * ladder.ts -- Loads the ordered tier ladder from config/ladder.config.json.
 *
 * The ladder defines which workflow lanes exist and their order (cheapest first).
 * Edit config/ladder.config.json to change tier order or workflow bindings --
 * never hardcode these values in orchestrator source.
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
  const resolved = configPath ?? join(import.meta.dir, '..', 'config', 'ladder.config.json');
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
