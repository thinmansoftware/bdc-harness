/**
 * WO-HARNESS-A2-ENGAGES-ALL-REPOS-01 Test 5: a fire after a dev merge loads the merged lane.
 *
 * Real git repos, no mocks: an origin, a managed clone under the workspaces root that is
 * one commit behind, and a lane YAML that the newer commit changes.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getArchonWorkspacesPath } from '@archon/paths';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { loadConfig } from '../config/config-loader';
import {
  syncManagedSourceBeforeDiscovery,
  isManagedSourceClone,
  withSyncedManagedSource,
  setDiscoverySyncLoggerForTest,
} from './dispatch-discovery-sync';

const LANE = 'sync-probe-lane';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function laneYaml(marker: string): string {
  return `name: ${LANE}\ndescription: lane definition ${marker}\nnodes:\n  - id: only\n    prompt: hello\n`;
}

async function discoveredDescription(cwd: string): Promise<string | undefined> {
  const result = await discoverWorkflowsWithConfig(cwd, loadConfig);
  return result.workflows.find(w => w.workflow.name === LANE)?.workflow.description;
}

describe('dispatch discovery sync (A2 engages all repos)', () => {
  let root: string;
  let origin: string;
  let seed: string;
  let clone: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dds-'));
    origin = join(root, 'origin.git');
    seed = join(root, 'seed');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', origin]);
    execFileSync('git', ['init', '-q', '-b', 'dev', seed]);
    git(seed, 'config', 'user.email', 't@t');
    git(seed, 'config', 'user.name', 't');
    mkdirSync(join(seed, '.archon', 'workflows'), { recursive: true });
    writeFileSync(join(seed, '.archon', 'workflows', `${LANE}.yaml`), laneYaml('OLD'));
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'old lane');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'dev');
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/dev');

    const ws = getArchonWorkspacesPath();
    mkdirSync(join(ws, 'owner'), { recursive: true });
    clone = join(ws, 'owner', `repo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    execFileSync('git', ['clone', '-q', origin, clone]);

    // origin moves one commit ahead: the merged lane
    writeFileSync(join(seed, '.archon', 'workflows', `${LANE}.yaml`), laneYaml('NEW'));
    git(seed, 'commit', '-q', '-am', 'new lane');
    git(seed, 'push', '-q', 'origin', 'dev');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  });

  test('Test 5: a fire after a dev merge loads the merged lane (clone reset before discovery)', async () => {
    // Precondition: the stale clone really serves the old definition (the 8849e767 failure).
    expect(await discoveredDescription(clone)).toContain('OLD');
    const originHead = git(origin, 'rev-parse', 'dev');
    expect(git(clone, 'rev-parse', 'HEAD')).not.toBe(originHead);

    const result = await syncManagedSourceBeforeDiscovery(clone, clone);

    expect(result).toBeDefined();
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(originHead);
    const description = await discoveredDescription(clone);
    expect(description).toContain('NEW');
    expect(description).not.toContain('OLD');
  });

  test('a path that is not the default_cwd (a worktree) is never reset', async () => {
    const before = git(clone, 'rev-parse', 'HEAD');
    const result = await syncManagedSourceBeforeDiscovery(join(clone, 'wt'), clone);
    expect(result).toBeUndefined();
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(before);
  });

  test('a clone outside the workspaces root is never reset', async () => {
    const outside = join(root, 'outside');
    execFileSync('git', ['clone', '-q', origin, outside]);
    const before = git(outside, 'rev-parse', 'HEAD');
    expect(isManagedSourceClone(outside)).toBe(false);
    const result = await syncManagedSourceBeforeDiscovery(outside, outside);
    expect(result).toBeUndefined();
    expect(git(outside, 'rev-parse', 'HEAD')).toBe(before);
  });

  test('a failing fetch is non-fatal and returns undefined', async () => {
    git(clone, 'remote', 'set-url', 'origin', join(root, 'does-not-exist.git'));
    const result = await syncManagedSourceBeforeDiscovery(clone, clone);
    expect(result).toBeUndefined();
  });

  function captureLog(): {
    errors: Array<Record<string, unknown> & { msg: string }>;
    restore: () => void;
  } {
    const errors: Array<Record<string, unknown> & { msg: string }> = [];
    const stub = {
      error: (obj: Record<string, unknown>, msg: string) => errors.push({ ...obj, msg }),
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    };
    setDiscoverySyncLoggerForTest(stub as never);
    return { errors, restore: () => setDiscoverySyncLoggerForTest(undefined) };
  }

  function laneFile(): string {
    return join(clone, '.archon', 'workflows', `${LANE}.yaml`);
  }

  test('concurrent_dispatch_does_not_reset_mid_discovery', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let firstReads: string[] = [];
    let firstStarted!: () => void;
    const started = new Promise<void>(resolve => {
      firstStarted = resolve;
    });

    const first = withSyncedManagedSource(clone, clone, async () => {
      order.push('first:start');
      const before = readFileSync(laneFile(), 'utf8');
      firstStarted();
      await gate; // the first dispatch is still reading its workflow YAML
      const after = readFileSync(laneFile(), 'utf8');
      firstReads = [before, after];
      order.push('first:end');
    });
    await started;

    // origin moves again while the first dispatch is mid-read
    writeFileSync(join(seed, '.archon', 'workflows', `${LANE}.yaml`), laneYaml('NEWER'));
    git(seed, 'commit', '-q', '-am', 'newer lane');
    git(seed, 'push', '-q', 'origin', 'dev');

    const second = withSyncedManagedSource(clone, clone, async () => {
      order.push('second:start');
      return readFileSync(laneFile(), 'utf8');
    });
    // give a racing second dispatch every chance to reset the clone under the first
    await new Promise(resolve => setTimeout(resolve, 3000));
    releaseFirst();
    await first;
    const secondRead = await second;

    expect(firstReads[0]).toContain('NEW');
    expect(firstReads[1]).toBe(firstReads[0]); // consistent tree for the first dispatch
    expect(firstReads[1]).not.toContain('NEWER');
    expect(order).toEqual(['first:start', 'first:end', 'second:start']); // second waited
    expect(secondRead).toContain('NEWER'); // and then saw the reset to the latest origin
  }, 60000);

  test('dirty_clone_not_reset_logs_error', async () => {
    const dirtyPath = join(clone, '.archon', 'workflows', `${LANE}.yaml`);
    const dirtyContent = laneYaml('LOCAL-EDIT');
    writeFileSync(dirtyPath, dirtyContent);
    const headBefore = git(clone, 'rev-parse', 'HEAD');
    const cap = captureLog();
    try {
      const result = await syncManagedSourceBeforeDiscovery(clone, clone);
      expect(result).toBeUndefined();
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(headBefore);
      expect(readFileSync(dirtyPath, 'utf8')).toBe(dirtyContent); // local edit survived
      const refused = cap.errors.find(e => e.msg.includes('discovery_sync.refused_local_state'));
      expect(refused).toBeDefined();
      expect(refused?.dirtyEntries).toBe(1);
      expect(refused?.unpushedCommits).toBe(0);
    } finally {
      cap.restore();
    }
  });

  test('local_commit_clone_not_reset_logs_error', async () => {
    git(clone, 'config', 'user.email', 't@t');
    git(clone, 'config', 'user.name', 't');
    writeFileSync(join(clone, 'local-only.txt'), 'local work');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'local only commit');
    const headBefore = git(clone, 'rev-parse', 'HEAD');
    const cap = captureLog();
    try {
      const result = await syncManagedSourceBeforeDiscovery(clone, clone);
      expect(result).toBeUndefined();
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(headBefore);
      expect(git(clone, 'cat-file', '-t', headBefore)).toBe('commit');
      const refused = cap.errors.find(e => e.msg.includes('discovery_sync.refused_local_state'));
      expect(refused).toBeDefined();
      expect(refused?.unpushedCommits).toBe(1);
      expect(refused?.dirtyEntries).toBe(0);
    } finally {
      cap.restore();
    }
  });
});
