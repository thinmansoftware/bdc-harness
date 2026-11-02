import { createHash } from 'crypto';
import { pickEntryTier } from '@archon/smart-cauldron/conductor';
import type { ConductorRuleset } from '@archon/smart-cauldron/types';
import type { CanaryManifest, CanaryPlan, CanarySnapshot } from './types';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)])
    );
  }
  return value;
}

function requestIdentity(manifest: CanaryManifest, snapshot: CanarySnapshot): string {
  const snapshotFacts = {
    codebase: snapshot.codebase,
    revisions: snapshot.revisions,
    drain: {
      mode: snapshot.drain.mode,
      drained: snapshot.drain.drained,
      activeLeaseCount: snapshot.drain.activeLeaseCount,
      activeRunCount: snapshot.drain.activeRunCount,
      activeRunIds: snapshot.drain.activeRunIds,
    },
    workflows: snapshot.workflows,
    providers: snapshot.providers,
    loaderErrors: snapshot.loaderErrors,
    ladder: snapshot.ladder,
    ruleset: snapshot.ruleset,
  };
  const canonical = JSON.stringify(stableValue({ manifest, snapshot: snapshotFacts }));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function buildCanaryPlan(manifest: CanaryManifest, snapshot: CanarySnapshot): CanaryPlan {
  const directRoutes = [...manifest.lanes]
    .sort((left, right) => left.order - right.order)
    .map(lane => ({
      lane: lane.name,
      matches: snapshot.workflows.filter(workflow => workflow.name === lane.name),
    }));
  const conductorRoutes = manifest.conductorProbes.map(probe => {
    const ruleset: ConductorRuleset = {
      defaultEntry: snapshot.ruleset.defaultEntry,
      rules: snapshot.ruleset.rules.map(rule => ({
        match: {
          ...(rule.match.woClass === undefined ? {} : { woClass: rule.match.woClass }),
          ...(rule.match.tags === undefined ? {} : { tags: [...rule.match.tags] }),
        },
        entry: rule.entry,
      })),
    };
    const tier = pickEntryTier(
      {
        ...(probe.woClass === undefined ? {} : { woClass: probe.woClass }),
        tags: [...probe.tags],
      },
      ruleset
    );
    const binding = snapshot.ladder.tiers.find(item => item.name === tier);
    return {
      probeId: probe.id,
      expectedTier: probe.expectedTier,
      expectedWorkflow: probe.expectedWorkflow,
      tier,
      workflowName: binding?.workflowName ?? null,
    };
  });
  return deepFreeze(
    structuredClone({
      requestId: requestIdentity(manifest, snapshot),
      manifest,
      snapshot,
      directRoutes,
      conductorRoutes,
    })
  );
}
