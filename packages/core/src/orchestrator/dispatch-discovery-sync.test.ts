/**
 * WO-HARNESS-A2-ENGAGES-ALL-REPOS-01 Test 5: a fire after a dev merge loads the merged lane.
 *
 * Real git repos, no mocks: an origin, a managed clone under the workspaces root that is
 * one commit behind, and a lane YAML that the newer commit changes.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getArchonWorkspacesPath } from '@archon/paths';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { loadConfig } from '../config/config-loader';
import { syncManagedSourceBeforeDiscovery, isManagedSourceClone } from './dispatch-discovery-sync';

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
});
