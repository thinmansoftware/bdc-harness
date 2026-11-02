import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { reduceMultiStageLifecycle } from './multi-stage-lifecycle';
import type { StageLifecycleArtifact, StageLifecycleDescriptor } from './multi-stage-lifecycle';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function stage(id: string): StageLifecycleDescriptor {
  return {
    stageId: id,
    branchName: `archon/WO-TEST/${id}`,
    repo: 'owner/repo',
    targetBranch: 'main',
    baseSha: id.repeat(40).slice(0, 40),
  };
}

function pass(descriptor: StageLifecycleDescriptor): StageLifecycleArtifact {
  return {
    stageId: descriptor.stageId,
    status: 'PASS',
    authority: { ...descriptor },
    attempts: [
      {
        attemptNumber: 1,
        startedAt: '2026-07-09T12:00:00.000Z',
        completedAt: '2026-07-09T12:05:00.000Z',
        result: 'passed',
      },
    ],
    evidence: {
      prUrl: `https://github.com/owner/repo/pull/${descriptor.stageId.length}`,
      exactFiles: [`src/${descriptor.stageId}.ts`],
      verifyResult: 'tests passed',
      reviewResult: 'clean',
    },
    blockingReason: null,
  };
}

describe('reduceMultiStageLifecycle', () => {
  test('N=1 passes through the same authoritative reducer', () => {
    const descriptor = stage('a');
    const manifest = reduceMultiStageLifecycle([descriptor], [pass(descriptor)]);

    expect(manifest.overallStatus).toBe('PASS');
    expect(manifest.parentProjection).toBe('completed');
    expect(manifest.stages[0]?.outcome.deliverableState).toBe('pr_ready');
  });

  test('a blocked predecessor blocks the parent and preserves its earlier successful PR', () => {
    const first = stage('a');
    const second = stage('b');
    const blocked: StageLifecycleArtifact = {
      ...pass(second),
      status: 'BLOCKED',
      blockingReason: 'ci_red: required check failed',
      evidence: { ...pass(second).evidence, prUrl: null },
    };
    const manifest = reduceMultiStageLifecycle([first, second, stage('c')], [pass(first), blocked]);

    expect(manifest.overallStatus).toBe('BLOCKED');
    expect(manifest.parentProjection).toBe('failed');
    expect(manifest.stages[0]?.evidence.prUrl).toContain('/pull/');
    expect(manifest.stages[2]?.status).toBe('NOT_RUN');
  });

  test('rejects execution evidence for a stage after its predecessor blocked', () => {
    const first = stage('a');
    const second = stage('b');
    const blocked = { ...pass(first), status: 'BLOCKED' as const, blockingReason: 'verify_failed' };

    expect(() => reduceMultiStageLifecycle([first, second], [blocked, pass(second)])).toThrow(
      'after blocked predecessor'
    );
  });

  test('N=4 fixture requires exact authority on every successful stage', () => {
    const stages = ['a', 'b', 'c', 'd'].map(stage);
    const manifest = reduceMultiStageLifecycle(stages, stages.map(pass));
    expect(manifest.stages).toHaveLength(4);
    expect(manifest.parentProjection).toBe('completed');

    const wrong = pass(stages[2]!);
    wrong.authority = { ...wrong.authority, baseSha: 'f'.repeat(40) };
    expect(() =>
      reduceMultiStageLifecycle(stages, [pass(stages[0]!), pass(stages[1]!), wrong])
    ).toThrow('authority mismatch');
  });

  test('a fresh process reconstructs the parent outcome from durable artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-stage-lifecycle-'));
    tempDirs.push(dir);
    const descriptor = stage('a');
    const stagesPath = join(dir, 'stages.json');
    const outputPath = join(dir, 'manifest.json');
    await writeFile(stagesPath, JSON.stringify([descriptor]), 'utf8');
    await writeFile(join(dir, 'stage-a-done.json'), JSON.stringify(pass(descriptor)), 'utf8');

    const subprocess = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'multi-stage-lifecycle.ts'),
        stagesPath,
        dir,
        outputPath,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const exitCode = await subprocess.exited;
    const stderr = await new Response(subprocess.stderr).text();

    expect(exitCode, stderr).toBe(0);
    const manifest = JSON.parse(await readFile(outputPath, 'utf8')) as {
      overallStatus: string;
      parentProjection: string;
    };
    expect(manifest.overallStatus).toBe('PASS');
    expect(manifest.parentProjection).toBe('completed');
  });
});
