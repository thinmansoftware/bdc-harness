/**
 * conductor.ts -- Ruleset-driven entry tier selection.
 *
 * v1.0 conductor is a DETERMINISTIC RULESET, not a model call.
 * The ruleset maps WO class + tags to an entry tier name.
 * Rules are evaluated top-down; first match wins.
 *
 * Edit config/ruleset.config.json to change routing without touching this file.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { ConductorRuleset, TierName } from './types.js';

interface RawRule {
  match: { woClass?: string; tags?: string[] };
  entry: string;
}

interface RawRulesetConfig {
  defaultEntry: string;
  rules: RawRule[];
}

/**
 * Load the conductor ruleset from config.
 *
 * @param configPath Optional path override; defaults to config/ruleset.config.json
 *                   relative to this file's directory.
 * @returns ConductorRuleset with defaultEntry + rules array.
 * @throws If config is missing or malformed.
 */
export function loadRuleset(configPath?: string): ConductorRuleset {
  const resolved = configPath ?? join(import.meta.dir, '..', 'config', 'ruleset.config.json');
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new Error(
      `[smart-cauldron/conductor] Failed to read ruleset config at ${resolved}: ${(err as Error).message}`
    );
  }

  let config: RawRulesetConfig;
  try {
    config = JSON.parse(raw) as RawRulesetConfig;
  } catch (err) {
    throw new Error(
      `[smart-cauldron/conductor] Failed to parse ruleset config at ${resolved}: ${(err as Error).message}`
    );
  }

  if (!config.defaultEntry || typeof config.defaultEntry !== 'string') {
    throw new Error('[smart-cauldron/conductor] ruleset config must have a string "defaultEntry"');
  }
  if (!Array.isArray(config.rules)) {
    throw new Error('[smart-cauldron/conductor] ruleset config must have a "rules" array');
  }

  return {
    defaultEntry: config.defaultEntry,
    rules: config.rules.map(r => ({
      match: {
        woClass: r.match.woClass,
        tags: r.match.tags,
      },
      entry: r.entry,
    })),
  };
}

/**
 * Pick the entry tier for a WO based on the conductor ruleset.
 *
 * Pure function: no model calls, no network, no side effects.
 * Rules are evaluated top-down; first rule where ALL specified match conditions
 * hold wins. Tags match if ANY specified tag appears in opts.tags.
 * Falls back to ruleset.defaultEntry when no rule matches.
 *
 * @param opts   WO attributes to match against the ruleset.
 * @param ruleset The loaded conductor ruleset.
 * @returns The name of the entry tier to start with.
 */
export function pickEntryTier(
  opts: { woClass?: string; tags?: string[] },
  ruleset: ConductorRuleset
): TierName {
  for (const rule of ruleset.rules) {
    const matchClass = rule.match.woClass === undefined || rule.match.woClass === opts.woClass;

    const matchTags =
      rule.match.tags === undefined ||
      rule.match.tags.length === 0 ||
      (opts.tags !== undefined && rule.match.tags.some(rt => opts.tags?.includes(rt)));

    if (matchClass && matchTags) {
      return rule.entry;
    }
  }
  return ruleset.defaultEntry;
}
