import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import { projectRunOutcome, reduceRunOutcome } from './outcome-reducer';
import type { RunOutcome, RunOutcomeProjection } from './types';

export interface StageLifecycleDescriptor {
  stageId: string;
  branchName: string;
  repo: string;
  targetBranch: string;
  baseSha: string;
}

export interface StageLifecycleArtifact {
  stageId: string;
  status: 'PASS' | 'BLOCKED';
  authority: StageLifecycleDescriptor;
  attempts: {
    attemptNumber: number;
    startedAt: string;
    completedAt: string;
    result: 'passed' | 'blocked';
  }[];
  evidence: {
    prUrl: string | null;
    exactFiles: string[];
    verifyResult: string;
    reviewResult: string;
  };
  blockingReason: string | null;
}

export interface StageLifecycleRow {
  stageId: string;
  status: 'PASS' | 'BLOCKED' | 'NOT_RUN';
  authority: StageLifecycleDescriptor;
  attempts: StageLifecycleArtifact['attempts'];
  evidence: StageLifecycleArtifact['evidence'];
  blockingReason: string | null;
  outcome: RunOutcome;
}

export interface MultiStageLifecycleManifest {
  overallStatus: 'PASS' | 'BLOCKED';
  parentProjection: RunOutcomeProjection;
  parentOutcome: RunOutcome;
  stages: StageLifecycleRow[];
}

function authorityMatches(
  descriptor: StageLifecycleDescriptor,
  authority: StageLifecycleDescriptor
): boolean {
  return (
    descriptor.stageId === authority.stageId &&
    descriptor.branchName === authority.branchName &&
    descriptor.repo === authority.repo &&
    descriptor.targetBranch === authority.targetBranch &&
    descriptor.baseSha === authority.baseSha
  );
}

function stageOutcome(
  status: StageLifecycleRow['status'],
  evidence: StageLifecycleArtifact['evidence'],
  stageId: string
): RunOutcome {
  return reduceRunOutcome({
    executionState: status === 'PASS' ? 'completed' : status === 'BLOCKED' ? 'failed' : 'cancelled',
    deliverable: evidence.prUrl
      ? { pullRequest: { open: true, ready: status === 'PASS' } }
      : { worktreeChanges: status === 'BLOCKED' },
    validation: {
      required: true,
      state: status === 'PASS' ? 'passed' : status === 'BLOCKED' ? 'failed' : 'not_run',
      ...(status === 'BLOCKED' ? { reasonCode: 'gate_failed' as const } : {}),
    },
    recoveryState: 'not_needed',
    routeState: 'current',
    requirements: { deliverable: 'pr_ready' },
    evidenceRefs: [`stage://${stageId}`],
  });
}

export function reduceMultiStageLifecycle(
  descriptors: readonly StageLifecycleDescriptor[],
  artifacts: readonly StageLifecycleArtifact[]
): MultiStageLifecycleManifest {
  if (descriptors.length === 0)
    throw new Error('multi-stage lifecycle requires at least one stage');
  const byStage = new Map<string, StageLifecycleArtifact>();
  for (const artifact of artifacts) {
    if (byStage.has(artifact.stageId)) {
      throw new Error(`duplicate lifecycle artifact for stage ${artifact.stageId}`);
    }
    byStage.set(artifact.stageId, artifact);
  }

  const rows: StageLifecycleRow[] = [];
  let predecessorBlocked = false;
  for (const descriptor of descriptors) {
    const artifact = byStage.get(descriptor.stageId);
    if (predecessorBlocked) {
      if (artifact) {
        throw new Error(
          `stage ${descriptor.stageId} has execution evidence after blocked predecessor`
        );
      }
      const evidence = { prUrl: null, exactFiles: [], verifyResult: '', reviewResult: '' };
      rows.push({
        stageId: descriptor.stageId,
        status: 'NOT_RUN',
        authority: descriptor,
        attempts: [],
        evidence,
        blockingReason: 'blocked_predecessor',
        outcome: stageOutcome('NOT_RUN', evidence, descriptor.stageId),
      });
      continue;
    }
    if (!artifact) throw new Error(`missing lifecycle artifact for stage ${descriptor.stageId}`);
    if (!authorityMatches(descriptor, artifact.authority)) {
      throw new Error(`authority mismatch for stage ${descriptor.stageId}`);
    }
    if (artifact.attempts.length === 0) {
      throw new Error(`stage ${descriptor.stageId} has no persisted attempts`);
    }
    if (artifact.status === 'PASS') {
      if (
        !artifact.evidence.prUrl ||
        artifact.evidence.exactFiles.length === 0 ||
        !artifact.evidence.verifyResult ||
        !artifact.evidence.reviewResult ||
        artifact.blockingReason
      ) {
        throw new Error(`stage ${descriptor.stageId} PASS evidence is incomplete`);
      }
    } else {
      if (!artifact.blockingReason) {
        throw new Error(`stage ${descriptor.stageId} BLOCKED outcome lacks a reason`);
      }
      predecessorBlocked = true;
    }
    rows.push({
      ...artifact,
      outcome: stageOutcome(artifact.status, artifact.evidence, descriptor.stageId),
    });
  }

  const parentEvidence = {
    executionState: 'completed' as const,
    deliverable: rows.every(row => row.status === 'PASS')
      ? { pullRequest: { open: true, ready: true } }
      : {},
    validation: {
      required: true,
      state: rows.every(row => row.status === 'PASS') ? ('passed' as const) : ('failed' as const),
    },
    recoveryState: 'not_needed' as const,
    routeState: 'current' as const,
    requirements: { deliverable: 'pr_ready' as const },
    requiredStages: rows.map(row => ({
      stageId: row.stageId,
      required: true,
      executionState: row.outcome.executionState,
      validationState: row.outcome.validationState,
      deliverableState: row.outcome.deliverableState,
    })),
    evidenceRefs: rows.map(row => `stage://${row.stageId}`),
  };
  const parentOutcome = reduceRunOutcome(parentEvidence);
  const parentProjection = projectRunOutcome(parentOutcome, parentEvidence);
  return {
    overallStatus: parentProjection === 'completed' ? 'PASS' : 'BLOCKED',
    parentProjection,
    parentOutcome,
    stages: rows,
  };
}

async function runCli(): Promise<void> {
  const [stagesPath, artifactsDir, outputPath] = process.argv.slice(2);
  if (!stagesPath || !artifactsDir || !outputPath) {
    throw new Error('usage: multi-stage-lifecycle.ts <stages.json> <artifacts-dir> <output.json>');
  }
  const descriptors = JSON.parse(await readFile(stagesPath, 'utf8')) as StageLifecycleDescriptor[];
  const artifacts: StageLifecycleArtifact[] = [];
  for (const descriptor of descriptors) {
    const donePath = join(artifactsDir, `stage-${descriptor.stageId}-done.json`);
    const blockedPath = join(artifactsDir, `stage-${descriptor.stageId}-blocked.json`);
    let artifactText: string | null = null;
    try {
      artifactText = await readFile(donePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      const blockedText = await readFile(blockedPath, 'utf8');
      if (artifactText)
        throw new Error(`stage ${descriptor.stageId} has both PASS and BLOCKED artifacts`);
      artifactText = blockedText;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (artifactText) artifacts.push(JSON.parse(artifactText) as StageLifecycleArtifact);
  }
  const manifest = reduceMultiStageLifecycle(descriptors, artifacts);
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`MANIFEST=${outputPath}\n`);
  process.stdout.write(`OVERALL_STATUS=${manifest.overallStatus}\n`);
  process.stdout.write(`PARENT_PROJECTION=${manifest.parentProjection}\n`);
}

if (import.meta.main) {
  await runCli();
}
