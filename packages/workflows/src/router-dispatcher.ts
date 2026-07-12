/**
 * Router dispatcher -- Cauldron 2.0 Layer 2 entry-tier resolver.
 *
 * Loads config/router.yaml and resolves a Work Order's task class (and optional
 * woClass tag) to an entry tier + lane name to fire. This is the deterministic
 * ruleset that picks the cheapest plausible starting rung; the per-run cascade
 * (Phase 5) climbs on gate-failure.
 *
 * Pure table lookup. NO provider/model call in the resolve path. Unreachable
 * tiers (e.g. ollama-qwen3 LAN-only from Hetzner) are skipped to the next
 * plausible tier.
 *
 * Anchor: WO-HARNESS-ROUTER-DISPATCHER-LOAD-AND-RESOLVE-01.
 * Source of truth: config/router.yaml (Cauldron 2.0 Tier Router -- v1 STATIC).
 */
import { readFileSync } from 'node:fs';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.router-dispatcher');
  return cachedLog;
}

/**
 * Engines whose endpoints are not reachable from the current runtime host.
 * Tier 1 ollama-qwen3 runs on the BDC LAN box and is unreachable from Hetzner.
 * The dispatcher skips tiers whose only reachable engines fall in this set.
 * Exported for test scenarios (Scenario D).
 */
export const UNREACHABLE_ENGINES: ReadonlySet<string> = new Set(['ollama-qwen3']);

/**
 * Engine key -> lane workflow name. New single-model lanes (Phase 5) extend
 * this table; a null value means no lane is wired yet for that engine
 * (Tier 0 deterministic scripts, Haiku API, Tier 5 fable/opus).
 *
 * glm-5.2 was retired on 2026-07-07 and is intentionally absent. Requests that
 * still resolve to that engine fail safe to no lane instead of firing the
 * removed GLM workflow.
 * Exported for test scenarios (Scenarios B, C).
 */
export const DEFAULT_ENGINE_TO_LANE: Record<string, string | null> = {
  'sonnet-subscription': 'bdc-feature-development',
  'codex-subscription': 'bdc-feature-development-codex',
  'claude-haiku-api': null,
  'qwen3-coder': 'bdc-feature-development-fusion-cx-qwen',
  'deepseek-v4-pro': 'bdc-feature-development-fusion-cx-qwen',
  'deterministic-script': null,
  'fable-session': null,
  'opus-api': null,
};

/** Terminal tier id. Cascade ceiling per router.yaml; never escalate past it. */
const TERMINAL_TIER = '5';

/** Input options for resolveEntryLane. */
export interface ResolveOptions {
  /** Task class key as defined in router.yaml task_classes (e.g. "build-code"). */
  taskClass?: string;
  /** WO Class tag (CODE / INFRA / MIXED). Phase 4: logged only, no routing effect. */
  woClass?: string;
  /** Absolute or worktree-relative path to router.yaml. */
  routerYamlPath: string;
  /**
   * Optional raw YAML override. When provided, routerYamlPath is recorded but
   * not read. Hermetic unit tests use this; production callers do not.
   */
  routerYamlContent?: string;
}

/** Output of resolveEntryLane. */
export interface ResolveResult {
  /** The tier id (string) the dispatcher selected. */
  tier: string;
  /** Lane workflow name to fire, or null when no lane is wired for the engine. */
  laneName: string | null;
  /** Engine key the dispatcher selected within the resolved tier. */
  engineHint?: string;
  /** Tier ids stepped over (typically because of UNREACHABLE_ENGINES). */
  skippedTiers?: string[];
}

/** Shape of a single tier entry inside router.yaml's tiers map. */
interface RouterYamlTier {
  name?: string;
  engines?: string[];
}

/** Shape of a single task class entry inside router.yaml's task_classes map. */
interface RouterYamlTaskClass {
  starting_tier?: string;
  engine_hint?: string;
}

/** Top-level shape of router.yaml as we consume it. */
interface RouterYamlConfig {
  tiers?: Record<string, RouterYamlTier>;
  task_classes?: Record<string, RouterYamlTaskClass>;
  defaults?: {
    fallback_tier?: string;
  };
}

/**
 * Parse the router.yaml using Bun's native YAML parser. Falls back to a thrown
 * error if Bun.YAML is not present in the runtime (which is a setup bug; this
 * package targets Bun).
 */
function parseRouterYaml(raw: string): RouterYamlConfig {
  // Bun runtime exposes Bun.YAML; declare narrowly to avoid global pollution.
  const bunGlobal = (globalThis as { Bun?: { YAML?: { parse(input: string): unknown } } }).Bun;
  if (!bunGlobal?.YAML || typeof bunGlobal.YAML.parse !== 'function') {
    throw new Error(
      'router-dispatcher: Bun.YAML.parse not available; this module requires the Bun runtime.'
    );
  }
  const parsed = bunGlobal.YAML.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('router-dispatcher: router.yaml did not parse to an object.');
  }
  return parsed as RouterYamlConfig;
}

/**
 * Walk the tier ladder from startingTier upward, returning the first tier whose
 * engines array contains at least one engine NOT in UNREACHABLE_ENGINES. Tiers
 * are walked in ascending numeric order of their string keys. Returns the
 * starting tier itself when it has a reachable engine.
 *
 * If walking reaches TERMINAL_TIER and TERMINAL_TIER has no reachable engine,
 * fall back DOWN to the highest non-terminal tier that DOES have a reachable
 * engine (per spec: Tier 4 is terminal -- do not escalate past it).
 */
function walkLadderForReachable(
  startingTier: string,
  tiers: Record<string, RouterYamlTier>,
  skipped: string[]
): { tier: string; engine: string } | null {
  const orderedKeys = Object.keys(tiers).sort((a, b) => Number(a) - Number(b));
  const startIdx = orderedKeys.indexOf(startingTier);
  if (startIdx < 0) {
    return null;
  }

  // Forward walk: startingTier upward.
  for (let i = startIdx; i < orderedKeys.length; i++) {
    const tierKey = orderedKeys[i];
    const engines = tiers[tierKey]?.engines ?? [];
    const reachable = engines.find(e => !UNREACHABLE_ENGINES.has(e));
    if (reachable !== undefined) {
      return { tier: tierKey, engine: reachable };
    }
    skipped.push(tierKey);
  }

  // Forward walk exhausted -- we crossed the terminal tier without finding a
  // reachable engine. Walk DOWN from just-below TERMINAL_TIER looking for the
  // highest tier with a reachable engine. This honors "Tier 4 is terminal" by
  // refusing to escalate past it and falling back to the cheapest viable lane.
  // skipped[] is left as-is so callers can still observe the climbed-then-fell
  // path.
  const terminalIdx = orderedKeys.indexOf(TERMINAL_TIER);
  const downStart = terminalIdx > 0 ? terminalIdx - 1 : orderedKeys.length - 1;
  for (let i = downStart; i >= 0; i--) {
    const tierKey = orderedKeys[i];
    const engines = tiers[tierKey]?.engines ?? [];
    const reachable = engines.find(e => !UNREACHABLE_ENGINES.has(e));
    if (reachable !== undefined) {
      return { tier: tierKey, engine: reachable };
    }
  }

  return null;
}

/**
 * Resolve a WO's task class to the entry tier + lane name. Deterministic table
 * lookup against config/router.yaml. NO model/provider call.
 *
 * Algorithm:
 *   1. Load + parse router.yaml.
 *   2. task_classes[taskClass] -> { starting_tier, engine_hint? }.
 *      Unknown / missing class -> defaults.fallback_tier (typically "2").
 *   3. Walk tier ladder from starting_tier, skipping tiers whose engines are
 *      all UNREACHABLE_ENGINES (e.g. ollama-qwen3 LAN-only).
 *   4. If engine_hint is set AND the hint engine is reachable AND present in
 *      the resolved tier's engines array, prefer hint over the tier's first
 *      reachable engine.
 *   5. Map resolved engine -> lane via DEFAULT_ENGINE_TO_LANE; null when no
 *      lane wired yet.
 *   6. Log dispatcher.resolve_completed with full context.
 *
 * woClass is logged but does NOT affect tier selection in Phase 4. It is
 * passed through for downstream Phase 5 cascade logic.
 */
export async function resolveEntryLane(opts: ResolveOptions): Promise<ResolveResult> {
  const log = getLog();

  const raw =
    opts.routerYamlContent !== undefined
      ? opts.routerYamlContent
      : readFileSync(opts.routerYamlPath, 'utf8');
  const config = parseRouterYaml(raw);

  const tiers = config.tiers ?? {};
  const taskClasses = config.task_classes ?? {};
  const fallbackTier = config.defaults?.fallback_tier ?? '2';

  const classKey = (opts.taskClass ?? '').trim();
  const classEntry = classKey ? taskClasses[classKey] : undefined;
  const startingTier = classEntry?.starting_tier ?? fallbackTier;
  const engineHintFromClass = classEntry?.engine_hint;

  const skippedTiers: string[] = [];
  const walked = walkLadderForReachable(startingTier, tiers, skippedTiers);

  if (!walked) {
    // No tier in the ladder has a reachable engine -- a configuration / runtime
    // bug. Surface clearly rather than silently returning a synthetic value.
    const err = new Error(
      `router-dispatcher: no reachable tier found starting from "${startingTier}" (all engines unreachable).`
    );
    log.error(
      { taskClass: classKey, woClass: opts.woClass, startingTier, skippedTiers },
      'dispatcher.resolve_failed'
    );
    throw err;
  }

  const { tier: resolvedTier } = walked;
  let { engine: resolvedEngine } = walked;

  // Apply engine_hint within the resolved tier if it is present, reachable,
  // and offered by that tier.
  if (engineHintFromClass && !UNREACHABLE_ENGINES.has(engineHintFromClass)) {
    const tierEngines = tiers[resolvedTier]?.engines ?? [];
    if (tierEngines.includes(engineHintFromClass)) {
      resolvedEngine = engineHintFromClass;
    }
  }

  const laneName =
    resolvedEngine in DEFAULT_ENGINE_TO_LANE ? DEFAULT_ENGINE_TO_LANE[resolvedEngine] : null;

  const result: ResolveResult = {
    tier: resolvedTier,
    laneName,
    engineHint: resolvedEngine,
    skippedTiers,
  };

  log.info(
    {
      taskClass: classKey,
      woClass: opts.woClass,
      startingTier,
      resolvedTier,
      laneName,
      engineHint: resolvedEngine,
      skippedTiers,
    },
    'dispatcher.resolve_completed'
  );

  return result;
}

/**
 * Pure 3-way precedence wrapper for Layer 2 lane selection.
 *
 * Precedence (highest to lowest):
 *   1. workflowName provided -- return it immediately; no resolveEntryLane call.
 *   2. taskClass provided -- call resolveEntryLane; return laneName when non-null.
 *   3. Neither resolved -- return undefined.
 *
 * Exists alongside resolveExecutorLane (executor.ts) so tests can exercise the
 * precedence logic without importing the heavier executor module and its mocks.
 *
 * WO-HARNESS-LAYER2-DISPATCHER-FIRES-RESOLVED-LANE-01.
 */
export async function pickLane(opts: {
  workflowName?: string;
  taskClass?: string;
  routerYamlPath: string;
  routerYamlContent?: string;
}): Promise<string | undefined> {
  if (opts.workflowName !== undefined) {
    return opts.workflowName;
  }
  if (opts.taskClass) {
    const result = await resolveEntryLane({
      taskClass: opts.taskClass,
      routerYamlPath: opts.routerYamlPath,
      routerYamlContent: opts.routerYamlContent,
    });
    if (result.laneName !== null) {
      return result.laneName;
    }
  }
  return undefined;
}
