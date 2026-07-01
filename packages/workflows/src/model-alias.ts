/**
 * model-alias.ts -- Alias-aware declared-vs-served model comparison.
 * WO-HARNESS-TELEMETRY-DECLARED-MODEL-AND-COST-01
 *
 * The bug this closes: served_model_mismatch was computed via strict string
 * equality (declared 'sonnet' !== served 'claude-sonnet-5' -> false positive
 * mismatch on EVERY aliased call). A red integrity flag that cries wolf on
 * every normal alias resolution trains humans to ignore it, which un-builds
 * the whole integrity check. isDeclaredServedMatch() resolves alias families
 * (loaded from config/model-aliases.config.json -- never hardcoded here) so
 * alias resolution is NOT a mismatch, while a genuine silent substitution
 * (declared glm-5.2, served claude-sonnet-5) still IS.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

interface RawAliasConfig {
  families: Record<string, string[]>;
}

let cachedFamilies: Record<string, string[]> | undefined;
let cachedConfigPath: string | undefined;

/**
 * Load the alias family map from config.
 *
 * @param configPath Optional path override; defaults to
 *                   config/model-aliases.config.json relative to this file's directory.
 * @throws If config is missing or malformed.
 */
function loadAliasFamilies(configPath?: string): Record<string, string[]> {
  const resolved = configPath ?? join(import.meta.dir, '..', 'config', 'model-aliases.config.json');
  // Cache per resolved path -- the config is read frequently (once per node
  // telemetry event) and does not change at runtime.
  if (cachedFamilies && cachedConfigPath === resolved) return cachedFamilies;

  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new Error(
      `[workflows/model-alias] Failed to read alias config at ${resolved}: ${(err as Error).message}`
    );
  }

  let config: RawAliasConfig;
  try {
    config = JSON.parse(raw) as RawAliasConfig;
  } catch (err) {
    throw new Error(
      `[workflows/model-alias] Failed to parse alias config at ${resolved}: ${(err as Error).message}`
    );
  }

  if (typeof config.families !== 'object' || config.families === null) {
    throw new Error('[workflows/model-alias] alias config must contain a "families" object');
  }
  for (const [alias, family] of Object.entries(config.families)) {
    if (!Array.isArray(family) || family.some(m => typeof m !== 'string')) {
      throw new Error(
        `[workflows/model-alias] alias family "${alias}" must be an array of strings`
      );
    }
  }

  cachedFamilies = config.families;
  cachedConfigPath = resolved;
  return cachedFamilies;
}

/**
 * Determine whether a served model ID is consistent with a declared model ID,
 * accounting for known alias families (e.g. declared 'sonnet' served
 * 'claude-sonnet-5' is a match). Any declared value not present as an alias
 * key in the config compares as an exact-id passthrough.
 *
 * When either value is missing (undefined/null), there is no meaningful
 * comparison to make -- returns true (no mismatch) rather than fabricating a
 * false positive. Callers should generally gate on both values being defined
 * strings before treating a false return as a real integrity finding (see
 * dag-executor.ts's `typeof served === 'string' && declared !== undefined` guard).
 *
 * @param configPath Optional alias config path override, for testability.
 */
export function isDeclaredServedMatch(
  declared: string | undefined,
  served: string | null | undefined,
  configPath?: string
): boolean {
  if (declared === undefined || served === undefined || served === null) {
    return true;
  }
  if (declared === served) return true;

  const families = loadAliasFamilies(configPath);

  const declaredFamily = families[declared];
  if (declaredFamily?.includes(served)) return true;

  // Symmetric check: declared may itself be an exact family member while
  // served is (unusually) an alias name.
  const servedFamily = families[served];
  if (servedFamily?.includes(declared)) return true;

  return false;
}

/** Reset the internal config cache. Exported for tests only. */
export function resetAliasCacheForTests(): void {
  cachedFamilies = undefined;
  cachedConfigPath = undefined;
}
