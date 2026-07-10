import { createHash } from 'crypto';
import { ArchonCanaryClient } from './client';
import { loadCanaryManifest } from './manifest';
import { buildCanaryPlan } from './planner';
import { reduceCanaryPlan } from './reducer';
import { createCanaryReport, writeCanaryArtifacts } from './report';
import type { RunCanaryResult } from './types';

export interface RunCanaryOptions {
  readonly level: 0 | 1;
  readonly manifestPath: string;
  readonly apiBase: string;
  readonly token: string;
  readonly outputRoot: string;
  readonly codebaseId: string;
  readonly fetcher?: typeof fetch;
}

function suiteRunId(requestId: string, observedAt: string): string {
  const identity = createHash('sha256')
    .update(`${requestId}\n${observedAt}`)
    .digest('hex')
    .slice(0, 16);
  return `canary-${observedAt.replace(/[^0-9]/g, '').slice(0, 14)}-${identity}`;
}

export async function runCanary(options: RunCanaryOptions): Promise<RunCanaryResult> {
  const manifest = await loadCanaryManifest(options.manifestPath);
  const client = new ArchonCanaryClient(options.apiBase, options.token, options.fetcher);
  const snapshot = await client.getSnapshot(options.codebaseId, manifest.environment.baseBranch);
  const plan = buildCanaryPlan(manifest, snapshot);
  const reduction = reduceCanaryPlan(plan, options.level);
  const report = createCanaryReport(
    suiteRunId(plan.requestId, snapshot.observedAt),
    options.level,
    plan,
    reduction
  );
  const artifactPaths = await writeCanaryArtifacts(options.outputRoot, plan, report);
  return { plan, report, artifactPaths };
}
