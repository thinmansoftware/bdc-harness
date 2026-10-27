import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { WorkflowEventRecord } from '../store';
import {
  collectRuntimeEvidence,
  renderManifestV2,
  type EvidenceCommandRunner,
  type RuntimeEvidenceRequest,
} from './evidence-collector';
import type { RunAuthorityRecord } from './types';

const ORIGIN_URL = 'https://github.com/thinmansoftware/bdc-harness.git';
const REPAIR_BRANCH = 'repair/pr-1280';
const FRESH_BRANCH = 'feature/fresh';
const SCOPE_MISMATCH =
  'gate_scope_mismatch: run scope is not an ancestor of the base-lane merge-base';
const GIT_IDENTITY = [
  '-c',
  'user.email=repair-scope@example.com',
  '-c',
  'user.name=Repair Scope Test',
] as const;

function authorityRecord(
  cwd: string,
  headBranch: string,
  baseSha: string,
  runScopeSha: string
): RunAuthorityRecord {
  return {
    runId: 'run-repair-scope',
    dispatchId: 'dispatch-repair-scope',
    woId: 'WO-HARNESS-REPAIR-SCOPE-AFTER-DEV-MERGE-01',
    specSource:
      'github:thinmansoftware/bdc-xo:docs/work-orders/WO-HARNESS-REPAIR-SCOPE-AFTER-DEV-MERGE-01.md',
    specRevision: '1'.repeat(40),
    specHash: `sha256:${'2'.repeat(64)}`,
    workflowName: 'bdc-feature-development',
    codebaseId: 'codebase-bdc-harness',
    canonicalRemote: ORIGIN_URL,
    baseBranch: 'dev',
    baseSha,
    runScopeSha,
    headBranch,
    worktreePath: cwd,
    workflowRevision: `sha256:${'4'.repeat(64)}`,
    bundleRevision: `sha256:${'5'.repeat(64)}`,
    engineRevision: `sha256:${'6'.repeat(64)}`,
    runtimeImageRevision: null,
    createdAt: '2026-10-27T00:00:00.000Z',
  };
}

function runtimeRequest(authority: RunAuthorityRecord): RuntimeEvidenceRequest {
  return {
    runId: authority.runId,
    cwd: authority.worktreePath,
    executionState: 'completed',
    recoveryState: 'not_needed',
    routeState: 'current',
    requiredGateIds: [],
  };
}

function workflowEvent(
  authority: RunAuthorityRecord,
  stepName: string,
  eventType: string,
  nodeOutput: string,
  id: string
): WorkflowEventRecord {
  return {
    id,
    workflow_run_id: authority.runId,
    event_type: eventType,
    step_index: 1,
    step_name: stepName,
    data: { node_output: nodeOutput },
    created_at: '2026-10-27T00:00:00.000Z',
  };
}

function repairOutput(pullNumber: number, leaseSha: string): string {
  return `REPAIR_TARGET=#${String(pullNumber)}\nREPAIR_TARGET_LEASE_SHA=${leaseSha}\n`;
}

async function spawnGit(args: readonly string[]): Promise<string> {
  const subprocess = Bun.spawn(['git', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(subprocess.stdout).text();
  const stderr = await new Response(subprocess.stderr).text();
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git exited ${String(exitCode)}`);
  }
  return stdout;
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return (await spawnGit(['-C', cwd, ...args])).trim();
}

const commandRunner: EvidenceCommandRunner = async (command, args) => {
  if (command === 'gh') {
    throw new Error('gh lookup is disabled');
  }
  if (command !== 'git') {
    throw new Error(`unexpected command ${command}`);
  }
  return { stdout: await spawnGit(args) };
};

async function commitFile(
  cwd: string,
  path: string,
  contents: string,
  message: string
): Promise<string> {
  await writeFile(join(cwd, path), contents);
  await runGit(cwd, ['add', '--', path]);
  await runGit(cwd, [...GIT_IDENTITY, 'commit', '-m', message]);
  return runGit(cwd, ['rev-parse', 'HEAD']);
}

async function withRepo(body: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'repair-scope-'));
  try {
    await runGit(cwd, ['init', '-b', 'dev']);
    await runGit(cwd, ['remote', 'add', 'origin', ORIGIN_URL]);
    await body(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

interface BehindDevRepo {
  readonly d1: string;
  readonly d2: string;
  readonly p1: string;
  readonly p2: string;
}

async function buildBehindDevRepo(cwd: string): Promise<BehindDevRepo> {
  const d1 = await commitFile(cwd, 'd1.txt', 'd1\n', 'D1');
  const d2 = await commitFile(cwd, 'd2.txt', 'd2\n', 'D2');
  await runGit(cwd, ['checkout', '-b', REPAIR_BRANCH, d1]);
  const p1 = await commitFile(cwd, 'p1.txt', 'p1\n', 'P1');
  const p2 = await commitFile(cwd, 'p2.txt', 'p2\n', 'P2');
  await runGit(cwd, ['update-ref', 'refs/remotes/origin/dev', d2]);
  return { d1, d2, p1, p2 };
}

async function expectScopeMismatch(pending: Promise<unknown>): Promise<void> {
  const error = await pending.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) {
    throw new Error('expected an Error');
  }
  expect(error.message).toBe(SCOPE_MISMATCH);
}

describe('repair scope re-anchor', () => {
  it('repair run behind dev passes with re-anchored scope', async () => {
    await withRepo(async cwd => {
      const repo = await buildBehindDevRepo(cwd);
      const authority = authorityRecord(cwd, REPAIR_BRANCH, repo.d2, repo.d2);
      const decoyLease = 'b'.repeat(40);
      const evidence = await collectRuntimeEvidence(
        {
          getRunAuthority: async () => authority,
          listWorkflowEvents: async () => [
            workflowEvent(
              authority,
              'checkout-repair-target',
              'node_completed',
              `REPAIR_TARGET=#1\nREPAIR_TARGET_LEASE_SHA=${decoyLease}\n${repairOutput(1280, repo.p1)}`,
              'event-repair'
            ),
          ],
        },
        commandRunner,
        runtimeRequest(authority)
      );
      const manifest = renderManifestV2(evidence);
      const changedPaths = evidence.git.changes.map(change => change.path).sort();

      expect(evidence.git.mergeBaseSha).toBe(repo.d1);
      expect(evidence.repairScopeReanchored).toBe(true);
      expect(evidence.repairLeaseSha).toBe(repo.p1);
      expect(evidence.repairPullNumber).toBe(1280);
      expect(evidence.acceptAdvancedBase).toBeFalsy();
      expect(evidence.scopeValid).toBe(true);
      expect(changedPaths).toEqual(['p1.txt', 'p2.txt']);
      expect(changedPaths).not.toContain('d2.txt');
      const lines = manifest.split('\n');
      const mergeIndex = lines.findIndex(line => line.startsWith('Merge ancestors:'));
      expect(lines[mergeIndex + 1]).toBe(
        `Scope: repair re-anchored to lease ${repo.p1} (PR #1280)`
      );
      expect(manifest).not.toContain('d2.txt');
    });
  });

  it('stale or rewritten repair evidence is still refused', async () => {
    await withRepo(async cwd => {
      const repo = await buildBehindDevRepo(cwd);
      await runGit(cwd, ['checkout', '-B', REPAIR_BRANCH, repo.d1]);
      await commitFile(cwd, 'rewritten.txt', 'rewritten\n', 'rewritten');
      const authority = authorityRecord(cwd, REPAIR_BRANCH, repo.d2, repo.d2);
      await expectScopeMismatch(
        collectRuntimeEvidence(
          {
            getRunAuthority: async () => authority,
            listWorkflowEvents: async () => [
              workflowEvent(
                authority,
                'checkout-repair-target',
                'node_completed',
                repairOutput(1280, repo.p1),
                'event-repair'
              ),
            ],
          },
          commandRunner,
          runtimeRequest(authority)
        )
      );
    });
  });

  it('no repair event means the #1273 refusal is unchanged', async () => {
    await withRepo(async cwd => {
      const repo = await buildBehindDevRepo(cwd);
      const authority = authorityRecord(cwd, REPAIR_BRANCH, repo.d2, repo.d2);
      const request = runtimeRequest(authority);
      const unrelated = workflowEvent(
        authority,
        'implement',
        'node_completed',
        repairOutput(1280, repo.p1),
        'event-implement'
      );
      const noneTarget = workflowEvent(
        authority,
        'checkout-repair-target',
        'node_completed',
        `REPAIR_TARGET=none\nREPAIR_TARGET_LEASE_SHA=${repo.p1}\n`,
        'event-none'
      );
      const malformedLease = workflowEvent(
        authority,
        'checkout-repair-target',
        'node_completed',
        `REPAIR_TARGET=#1280\nREPAIR_TARGET_LEASE_SHA=${repo.p1.slice(0, 39)}\n`,
        'event-malformed'
      );

      await expectScopeMismatch(
        collectRuntimeEvidence(
          {
            getRunAuthority: async () => authority,
            listWorkflowEvents: async () => [unrelated],
          },
          commandRunner,
          request
        )
      );
      await expectScopeMismatch(
        collectRuntimeEvidence(
          {
            getRunAuthority: async () => authority,
            listWorkflowEvents: async () => [noneTarget],
          },
          commandRunner,
          request
        )
      );
      await expectScopeMismatch(
        collectRuntimeEvidence(
          {
            getRunAuthority: async () => authority,
            listWorkflowEvents: async () => [malformedLease],
          },
          commandRunner,
          request
        )
      );
    });
  });

  it('superseded-target-none-refuses', async () => {
    await withRepo(async cwd => {
      const repo = await buildBehindDevRepo(cwd);
      const authority = authorityRecord(cwd, REPAIR_BRANCH, repo.d2, repo.d2);
      await expectScopeMismatch(
        collectRuntimeEvidence(
          {
            getRunAuthority: async () => authority,
            listWorkflowEvents: async () => [
              workflowEvent(
                authority,
                'checkout-repair-target',
                'node_completed',
                `${repairOutput(1280, repo.p1)}REPAIR_TARGET=none\n`,
                'event-superseded-none'
              ),
            ],
          },
          commandRunner,
          runtimeRequest(authority)
        )
      );
    });
  });

  it('superseded-malformed-lease-refuses', async () => {
    await withRepo(async cwd => {
      const repo = await buildBehindDevRepo(cwd);
      const authority = authorityRecord(cwd, REPAIR_BRANCH, repo.d2, repo.d2);
      await expectScopeMismatch(
        collectRuntimeEvidence(
          {
            getRunAuthority: async () => authority,
            listWorkflowEvents: async () => [
              workflowEvent(
                authority,
                'checkout-repair-target',
                'node_completed',
                `${repairOutput(1280, repo.p1)}REPAIR_TARGET_LEASE_SHA=${repo.p1.slice(0, 39)}\n`,
                'event-superseded-lease'
              ),
            ],
          },
          commandRunner,
          runtimeRequest(authority)
        )
      );
    });
  });

  it('repair run that already merged current dev passes without re-anchor', async () => {
    await withRepo(async cwd => {
      const d1 = await commitFile(cwd, 'd1.txt', 'd1\n', 'D1');
      const d2 = await commitFile(cwd, 'd2.txt', 'd2\n', 'D2');
      await runGit(cwd, ['checkout', '-b', REPAIR_BRANCH, d1]);
      const p1 = await commitFile(cwd, 'p1.txt', 'p1\n', 'P1');
      await runGit(cwd, [...GIT_IDENTITY, 'merge', d2, '-m', 'merge dev']);
      await runGit(cwd, ['update-ref', 'refs/remotes/origin/dev', d2]);
      const authority = authorityRecord(cwd, REPAIR_BRANCH, d2, d2);
      const evidence = await collectRuntimeEvidence(
        {
          getRunAuthority: async () => authority,
          listWorkflowEvents: async () => [
            workflowEvent(
              authority,
              'checkout-repair-target',
              'node_completed',
              repairOutput(1280, p1),
              'event-repair'
            ),
          ],
        },
        commandRunner,
        runtimeRequest(authority)
      );

      expect(evidence.git.mergeBaseSha).toBe(d2);
      expect(evidence.repairScopeReanchored).toBeFalsy();
      expect(evidence.acceptAdvancedBase).toBeFalsy();
      expect(evidence.scopeValid).toBe(true);
      expect(renderManifestV2(evidence)).not.toContain('Scope: repair re-anchored');
    });
  });

  it('fresh build run is unchanged', async () => {
    await withRepo(async cwd => {
      const d1 = await commitFile(cwd, 'd1.txt', 'd1\n', 'D1');
      await runGit(cwd, ['checkout', '-b', FRESH_BRANCH, d1]);
      await commitFile(cwd, 'f1.txt', 'f1\n', 'F1');
      await runGit(cwd, ['checkout', 'dev']);
      const d2 = await commitFile(cwd, 'd2.txt', 'd2\n', 'D2');
      await runGit(cwd, ['update-ref', 'refs/remotes/origin/dev', d2]);
      await runGit(cwd, ['checkout', FRESH_BRANCH]);
      const authority = authorityRecord(cwd, FRESH_BRANCH, d1, d1);
      const evidence = await collectRuntimeEvidence(
        {
          getRunAuthority: async () => authority,
          listWorkflowEvents: async () => [
            workflowEvent(authority, 'implement', 'node_completed', 'OK', 'event-implement'),
          ],
        },
        commandRunner,
        runtimeRequest(authority)
      );

      expect(evidence.git.mergeBaseSha).toBe(d1);
      expect(evidence.acceptAdvancedBase).toBeFalsy();
      expect(evidence.repairScopeReanchored).toBeFalsy();
      expect(evidence.scopeValid).toBe(true);
      expect(renderManifestV2(evidence)).not.toContain('Scope: repair re-anchored');
    });
  });
});
