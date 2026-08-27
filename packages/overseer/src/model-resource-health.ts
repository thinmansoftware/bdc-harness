/**
 * Judge model-resource tracking. Live verification on 2026-08-27 found no
 * machine-readable quota/credit command in the installed `grok` CLI, and no
 * directly installed `codex` CLI (`bunx` is used by the judge). Consequently
 * both providers currently use spawn-outcome inference; provider quota probes
 * can be added here if either CLI exposes a supported endpoint later.
 */
import {
  getRecentUsageSamples,
  recordUsageSample,
  upsertHealthSample,
  type TmHealthState,
  type TmUsageSample,
} from '@archon/core/db/taskmaster';
import { createMessage } from '@archon/core/db/dispatch';

export const BINARY_TO_PROVIDER = { grok: 'xai', codex: 'codex' } as const;
export const MODEL_RESOURCE_FAILURE_THRESHOLD = 3;
const WINDOW_KIND = 'judge_spawn_outcome';
const SAMPLE_LIMIT = 100;
const HEALTH_TTL_MS = 24 * 60 * 60 * 1000;

export interface ModelResourceHealth {
  provider: string;
  state: TmHealthState;
  consecutiveFailures: number;
  recentFailureRate: number;
  lastSuccessAt: string | null;
  sampleCount: number;
}

export interface ModelResourceHealthDeps {
  getSamples?: typeof getRecentUsageSamples;
  recordSample?: typeof recordUsageSample;
  upsertHealth?: typeof upsertHealthSample;
  sendSignal?: typeof createMessage;
  now?: () => Date;
}

function providerForBinary(binary: string): string {
  return BINARY_TO_PROVIDER[binary as keyof typeof BINARY_TO_PROVIDER] ?? binary;
}

function outcomeOf(sample: TmUsageSample): 'success' | 'failure' | null {
  if (!sample.value_json) return null;
  try {
    const value = JSON.parse(sample.value_json) as { outcome?: unknown };
    return value.outcome === 'success' || value.outcome === 'failure' ? value.outcome : null;
  } catch {
    return null;
  }
}

export async function getModelResourceHealth(
  provider: string,
  deps: ModelResourceHealthDeps = {}
): Promise<ModelResourceHealth> {
  const samples = await (deps.getSamples ?? getRecentUsageSamples)(
    provider,
    WINDOW_KIND,
    SAMPLE_LIMIT
  );
  const outcomes = samples.map(sample => ({ sample, outcome: outcomeOf(sample) }));
  const known = outcomes.filter(item => item.outcome !== null);
  let consecutiveFailures = 0;
  for (const item of known) {
    if (item.outcome !== 'failure') break;
    consecutiveFailures += 1;
  }
  const lastSuccessAt = known.find(item => item.outcome === 'success')?.sample.observed_at ?? null;
  const failureCount = known.filter(item => item.outcome === 'failure').length;
  const state: TmHealthState =
    known.length === 0
      ? 'unknown'
      : consecutiveFailures >= MODEL_RESOURCE_FAILURE_THRESHOLD
        ? 'degraded'
        : 'healthy';
  const health = {
    provider,
    state,
    consecutiveFailures,
    recentFailureRate: known.length === 0 ? 0 : failureCount / known.length,
    lastSuccessAt,
    sampleCount: known.length,
  };
  const currentTime =
    deps.now ??
    function currentTime(): Date {
      return new Date();
    };
  const now = currentTime();
  await (deps.upsertHealth ?? upsertHealthSample)({
    provider,
    state,
    expires_at: new Date(now.getTime() + HEALTH_TTL_MS).toISOString(),
    evidence: JSON.stringify(health),
  });

  if (state === 'degraded') {
    const episode = known.slice(0, consecutiveFailures).at(-1)?.sample.id ?? 'unknown';
    await (deps.sendSignal ?? createMessage)({
      correlation_id: `model-resource:${provider}:${episode}`,
      idempotency_key: `model-resource-degraded:${provider}:${episode}`,
      task_type: 'agent_message',
      sender: 'taskmaster',
      recipient: 'operator',
      priority: 'blocker',
      body: `Model resource ${provider} is degraded after ${consecutiveFailures} consecutive judge spawn failures; last success: ${lastSuccessAt ?? 'none recorded'}.`,
    });
  }
  return health;
}

export async function recordSpawnOutcome(
  binary: string,
  result: { exitCode: number; timedOut: boolean },
  site: string,
  deps: ModelResourceHealthDeps = {}
): Promise<ModelResourceHealth> {
  const provider = providerForBinary(binary);
  const outcome = !result.timedOut && result.exitCode === 0 ? 'success' : 'failure';
  await (deps.recordSample ?? recordUsageSample)({
    provider,
    window_kind: WINDOW_KIND,
    source: site,
    value_json: JSON.stringify({ exitCode: result.exitCode, timedOut: result.timedOut, outcome }),
    confidence: 'high',
    is_unknown: false,
  });
  return getModelResourceHealth(provider, deps);
}
