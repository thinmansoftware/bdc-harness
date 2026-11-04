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
  localStateCounts,
  resolveDiscoveryBaseBranch,
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

describe('dispatch discovery sync honors worktree.baseBranch (A2 round 2)', () => {
  let root: string;
  let origin: string;
  let seed: string;
  let clone: string;

  function commitFile(rel: string, content: string, msg: string): void {
    mkdirSync(join(seed, rel, '..'), { recursive: true });
    writeFileSync(join(seed, rel), content);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', msg);
  }

  /** origin/HEAD = main; dev is a separate branch; clone of it sits on `onBranch`. */
  function setup(opts: { devConfig: boolean }): void {
    root = mkdtempSync(join(tmpdir(), 'dds-base-'));
    origin = join(root, 'origin.git');
    seed = join(root, 'seed');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', seed]);
    git(seed, 'config', 'user.email', 't@t');
    git(seed, 'config', 'user.name', 't');
    commitFile(`.archon/workflows/${LANE}.yaml`, laneYaml('MAIN-1'), 'main lane');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'main');
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(seed, 'checkout', '-q', '-b', 'dev');
    if (opts.devConfig) commitFile('.archon/config.yaml', 'worktree:\n  baseBranch: dev\n', 'cfg');
    commitFile(`.archon/workflows/${LANE}.yaml`, laneYaml('DEV-1'), 'dev lane 1');
    git(seed, 'push', '-q', 'origin', 'dev');

    const ws = getArchonWorkspacesPath();
    mkdirSync(join(ws, 'owner'), { recursive: true });
    clone = join(ws, 'owner', `repo-b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    execFileSync('git', ['clone', '-q', origin, clone]);
  }

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  });

  test('origin/HEAD=main with worktree.baseBranch=dev: published dev commits are not unpushed, sync targets dev', async () => {
    setup({ devConfig: true });
    git(clone, 'checkout', '-q', '-B', 'dev', 'origin/dev'); // clone builds dev, as configured
    // origin/dev moves one commit ahead of the clone
    commitFile(`.archon/workflows/${LANE}.yaml`, laneYaml('DEV-2'), 'dev lane 2');
    git(seed, 'push', '-q', 'origin', 'dev');
    const devHead = git(origin, 'rev-parse', 'dev');

    // Safety comparison is against origin/dev: nothing unpushed (against origin/main it would be 2+)
    const counts = await localStateCounts(clone);
    expect(counts.branch).toBe('dev');
    expect(counts.unpushedCommits).toBe(0);
    expect(countCommits(clone, 'origin/main..HEAD')).toBeGreaterThan(0);

    const cap = captureErrors();
    try {
      const result = await syncManagedSourceBeforeDiscovery(clone, clone);
      expect(result).toBeDefined();
      expect(result?.branch).toBe('dev');
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(devHead);
      expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('dev');
      expect(cap.errors.find(e => e.msg.includes('refused_local_state'))).toBeUndefined();
    } finally {
      cap.restore();
    }
    // discovery reads dev's workflows, not main's
    const description = await discoveredDescription(clone);
    expect(description).toContain('DEV-2');
    expect(description).not.toContain('MAIN-1');
  });

  test('worktree.baseBranch=dev still refuses a genuinely unpushed local commit on dev', async () => {
    setup({ devConfig: true });
    git(clone, 'checkout', '-q', '-B', 'dev', 'origin/dev');
    git(clone, 'config', 'user.email', 't@t');
    git(clone, 'config', 'user.name', 't');
    writeFileSync(join(clone, 'local-only.txt'), 'local work');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'local only');
    const headBefore = git(clone, 'rev-parse', 'HEAD');
    const cap = captureErrors();
    try {
      expect(await syncManagedSourceBeforeDiscovery(clone, clone)).toBeUndefined();
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(headBefore);
      const refused = cap.errors.find(e => e.msg.includes('refused_local_state'));
      expect(refused?.unpushedCommits).toBe(1);
      expect(refused?.branch).toBe('dev');
    } finally {
      cap.restore();
    }
  });

  test('no baseBranch configured: origin/HEAD (main) is still used', async () => {
    setup({ devConfig: false });
    expect(await resolveDiscoveryBaseBranch(clone)).toBe('main');
    // main advances
    git(seed, 'checkout', '-q', 'main');
    commitFile(`.archon/workflows/${LANE}.yaml`, laneYaml('MAIN-2'), 'main lane 2');
    git(seed, 'push', '-q', 'origin', 'main');
    const mainHead = git(origin, 'rev-parse', 'main');

    const result = await syncManagedSourceBeforeDiscovery(clone, clone);
    expect(result?.branch).toBe('main');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(mainHead);
    expect(await discoveredDescription(clone)).toContain('MAIN-2');
  });
});

function countCommits(repo: string, range: string): number {
  const out = git(repo, 'rev-list', range);
  return out === '' ? 0 : out.split('\n').length;
}

function captureErrors(): {
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
