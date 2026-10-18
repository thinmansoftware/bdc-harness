import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse } from 'yaml';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';

interface WorkflowNode {
  id: string;
  depends_on?: string[];
  bash?: string;
}

interface WorkflowDocument {
  nodes: WorkflowNode[];
}

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');
const LANE_FILES = readdirSync(LANES_DIR)
  .filter(file => /^bdc-feature-development(?:-.*)?\.yaml$/.test(file))
  .filter(file => readFileSync(join(LANES_DIR, file), 'utf8').includes('- id: diff-repair'))
  .sort();
const EXPECTED_LANES = [
  'bdc-feature-development-astra.yaml',
  'bdc-feature-development-codex-only.yaml',
  'bdc-feature-development-codex.yaml',
  'bdc-feature-development-cursor.yaml',
  'bdc-feature-development-fable.yaml',
  'bdc-feature-development-fusion-cx-kimi.yaml',
  'bdc-feature-development-fusion-cx-qwen.yaml',
  'bdc-feature-development-grok.yaml',
  'bdc-feature-development-kimi-k3.yaml',
  'bdc-feature-development-zero-claude.yaml',
  'bdc-feature-development-zero-open.yaml',
  'bdc-feature-development-zero.yaml',
  'bdc-feature-development.yaml',
];
const tempDirs: string[] = [];

function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  return Bun.spawnSync(args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}
function git(args: string[], cwd: string): string {
  const result = run(['git', ...args], cwd);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diff-repair-checkpoint-'));
  tempDirs.push(dir);
  git(['init', '--initial-branch=main'], dir);
  writeFileSync(join(dir, 'README.md'), 'initial\n');
  git(['add', 'README.md'], dir);
  git(['commit', '-m', 'initial'], dir);
  return dir;
}
function nodeBash(id: string, lane = 'bdc-feature-development-codex.yaml'): string {
  const file = join(LANES_DIR, lane);
  const workflow = parse(readFileSync(file, 'utf8')) as WorkflowDocument;
  const bash = workflow.nodes.find(node => node.id === id)?.bash;
  if (!bash) throw new Error(`missing bash node ${id}`);
  return bash;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTempDirWithRetry(dir, { throwOnFailure: true });
});

function checkpointFixture() {
  const dir = makeRepo();
  const remote = mkdtempSync(join(tmpdir(), 'checkpoint-remote-'));
  const artifacts = mkdtempSync(join(tmpdir(), 'checkpoint-artifacts-'));
  tempDirs.push(remote, artifacts);
  git(['init', '--bare', remote], dir);
  git(['remote', 'add', 'origin', remote], dir);
  git(['push', '-u', 'origin', 'main'], dir);
  const baseline = git(['rev-parse', 'HEAD'], dir);
  writeFileSync(join(artifacts, 'run-start-sha.txt'), baseline + '\n');
  return { dir, remote, artifacts, baseline };
}

function runCheckpoint(
  fixture: ReturnType<typeof checkpointFixture>,
  lane = 'bdc-feature-development-codex.yaml',
  prefix = ''
) {
  const script = nodeBash('checkpoint-push', lane).replace(
    '$read-spec.output',
    "'WO_ID=WO-CHECKPOINT-PRESERVATION-01'"
  );
  return run(['bash', '-c', prefix + script], fixture.dir, {
    ARTIFACTS_DIR: fixture.artifacts.replaceAll('\\', '/'),
    WO_ID: 'WO-CHECKPOINT-PRESERVATION-01',
  });
}

function wipRefs(fixture: ReturnType<typeof checkpointFixture>): string {
  return git(
    ['--git-dir', fixture.remote, 'for-each-ref', '--format=%(objectname)', 'refs/heads/wip/'],
    fixture.dir
  );
}

describe('implement checkpoint preserves committed work', () => {
  for (const lane of EXPECTED_LANES) {
    it(`${lane} pushes a clean unpushed implementation commit`, () => {
      const fixture = checkpointFixture();
      writeFileSync(join(fixture.dir, 'README.md'), 'implementation committed locally\n');
      git(['commit', '-am', 'implement'], fixture.dir);
      const implementation = git(['rev-parse', 'HEAD'], fixture.dir);
      expect(git(['status', '--porcelain'], fixture.dir)).toBe('');

      const result = runCheckpoint(fixture, lane);
      expect(result.exitCode).toBe(0);
      expect(wipRefs(fixture), result.stdout.toString() + result.stderr.toString()).toBe(
        implementation
      );
      expect(result.stdout.toString()).toContain(`CHECKPOINT_SHA=${implementation}`);
      expect(git(['rev-parse', 'HEAD'], fixture.dir)).toBe(implementation);
    }, 30_000);
  }

  it('does not create a checkpoint ref when implement produced no work', () => {
    const fixture = checkpointFixture();
    const result = runCheckpoint(fixture);
    expect(result.exitCode).toBe(0);
    expect(wipRefs(fixture)).toBe('');
    expect(result.stdout.toString()).not.toContain('CHECKPOINT_SHA=');
  });

  it('pushes the verified commit even if HEAD advances immediately before push', () => {
    const fixture = checkpointFixture();
    writeFileSync(join(fixture.dir, 'README.md'), 'implementation committed locally\n');
    git(['commit', '-am', 'implement'], fixture.dir);
    const verified = git(['rev-parse', 'HEAD'], fixture.dir);
    const prefix = [
      'git() {',
      '  if [ "$1" = push ]; then',
      '    printf "late writer\\n" > README.md',
      '    command git commit -am "late writer" >/dev/null || return 1',
      '  fi',
      '  command git "$@"',
      '}',
      '',
    ].join('\n');
    const result = runCheckpoint(fixture, 'bdc-feature-development-codex.yaml', prefix);
    expect(result.exitCode).toBe(0);
    expect(git(['rev-parse', 'HEAD'], fixture.dir)).not.toBe(verified);
    expect(wipRefs(fixture)).toBe(verified);
    expect(result.stdout.toString()).toContain(`CHECKPOINT_SHA=${verified}`);
  }, 30_000);

  for (const baseline of ['missing', 'HEAD', 'short', 'multiline', 'nonancestor', 'blob']) {
    it(`does not export clean committed work with ${baseline} run-start identity`, () => {
      const fixture = checkpointFixture();
      writeFileSync(join(fixture.dir, 'README.md'), 'implementation committed locally\n');
      git(['commit', '-am', 'implement'], fixture.dir);
      const file = join(fixture.artifacts, 'run-start-sha.txt');
      if (baseline === 'missing') rmSync(file);
      else if (baseline === 'HEAD') writeFileSync(file, 'HEAD\n');
      else if (baseline === 'short') writeFileSync(file, fixture.baseline.slice(0, 8) + '\n');
      else if (baseline === 'multiline') writeFileSync(file, fixture.baseline + '\n\n');
      else if (baseline === 'blob')
        writeFileSync(file, git(['rev-parse', 'HEAD:README.md'], fixture.dir) + '\n');
      else
        writeFileSync(
          file,
          git(['commit-tree', 'HEAD^{tree}', '-m', 'unrelated root'], fixture.dir) + '\n'
        );

      const result = runCheckpoint(fixture);
      expect(result.exitCode).toBe(0);
      expect(wipRefs(fixture)).toBe('');
      expect(result.stdout.toString()).toContain(
        'CHECKPOINT_STATUS=local_only_unverified_baseline'
      );
      expect(result.stdout.toString()).not.toContain('CHECKPOINT_SHA=');
    }, 30_000);
  }

  it('still commits and pushes dirty implementation work', () => {
    const fixture = checkpointFixture();
    rmSync(join(fixture.artifacts, 'run-start-sha.txt'));
    writeFileSync(join(fixture.dir, 'feature.ts'), 'export const feature = true;\n');
    const result = runCheckpoint(fixture);
    expect(result.exitCode).toBe(0);
    const checkpoint = git(['rev-parse', 'HEAD'], fixture.dir);
    expect(checkpoint).not.toBe(fixture.baseline);
    expect(wipRefs(fixture)).toBe(checkpoint);
    expect(git(['status', '--porcelain'], fixture.dir)).toBe('');
  }, 30_000);

  it('does not export when the baseline read emits bytes but reports failure', () => {
    const fixture = checkpointFixture();
    writeFileSync(join(fixture.dir, 'README.md'), 'implementation committed locally\n');
    git(['commit', '-am', 'implement'], fixture.dir);
    const result = runCheckpoint(
      fixture,
      'bdc-feature-development-codex.yaml',
      'cat() { command cat "$@"; return 1; }\n'
    );
    expect(result.exitCode).toBe(0);
    expect(wipRefs(fixture)).toBe('');
    expect(result.stdout.toString()).toContain('CHECKPOINT_STATUS=local_only_unverified_baseline');
    expect(result.stdout.toString()).not.toContain('CHECKPOINT_SHA=');
  }, 30_000);

  it('does not claim preservation when the remote push fails', () => {
    const fixture = checkpointFixture();
    writeFileSync(join(fixture.dir, 'README.md'), 'implementation committed locally\n');
    git(['commit', '-am', 'implement'], fixture.dir);
    git(['remote', 'set-url', '--push', 'origin', join(fixture.remote, 'missing')], fixture.dir);
    const result = runCheckpoint(fixture);
    expect(result.exitCode).toBe(0);
    expect(wipRefs(fixture)).toBe('');
    expect(result.stdout.toString()).not.toContain('CHECKPOINT_SHA=');
    expect(result.stderr.toString()).toContain('work is local only');
  }, 30_000);
});

describe('diff-repair checkpoint and salvage', () => {
  it('wires every feature-development lane through checkpoint-diff-repair', () => {
    expect(LANE_FILES).toEqual(EXPECTED_LANES);
    for (const file of LANE_FILES) {
      const path = join(LANES_DIR, file);
      const workflow = parse(readFileSync(path, 'utf8')) as WorkflowDocument;
      const node = (id: string) => workflow.nodes.find(item => item.id === id);
      expect(node('checkpoint-diff-repair')?.depends_on).toContain('diff-repair');
      expect(node('capture-diff-final')?.depends_on).toContain('checkpoint-diff-repair');
      expect(node('noninteractive-salvage')?.bash).toContain('SALVAGE=preserved_uncommitted:');
      expect(node('checkpoint-diff-repair')?.bash).not.toContain('git add -A');
      expect(node('noninteractive-salvage')?.bash).not.toContain('git add -A');
    }
  });
  it('commits two modified files before final diff capture', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'README.md'), 'changed\n');
    writeFileSync(join(dir, 'feature.ts'), 'export const feature = true;\n');
    const result = run(['bash', '-c', nodeBash('checkpoint-diff-repair')], dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('CHECKPOINT_DIFF_REPAIR=committed');
    expect(git(['log', '-1', '--pretty=%s'], dir)).toBe('checkpoint(diff-repair): 2 files');
    expect(git(['status', '--porcelain'], dir)).toBe('');
  });
  it('is a no-op on a clean worktree', () => {
    const dir = makeRepo();
    const before = git(['rev-parse', 'HEAD'], dir);
    const result = run(['bash', '-c', nodeBash('checkpoint-diff-repair')], dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('CHECKPOINT_DIFF_REPAIR=noop');
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(before);
  });
  it('uses the uncommitted salvage message and preservation sentinel', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'README.md'), 'salvaged\n');
    const script = nodeBash('noninteractive-salvage').replace(
      '$block-reclassify.output',
      '{"status":"BLOCKED"}'
    );
    const result = run(['bash', '-c', script], dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('SALVAGE=preserved_uncommitted:1');
    expect(git(['log', '-1', '--pretty=%s'], dir)).toBe('salvage(uncommitted): 1 files');
  });
  it('stages a git-mv rename as the new path and drops the old path', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'old-name.ts'), 'export const v = 1;\n');
    git(['add', 'old-name.ts'], dir);
    git(['commit', '-m', 'add old'], dir);
    git(['mv', 'old-name.ts', 'new-name.ts'], dir);
    const result = run(['bash', '-c', nodeBash('checkpoint-diff-repair')], dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('CHECKPOINT_DIFF_REPAIR=committed');
    expect(git(['ls-tree', '-r', '--name-only', 'HEAD'], dir)).toBe('README.md\nnew-name.ts');
    expect(git(['status', '--porcelain'], dir)).toBe('');
  });
  it.skipIf(process.platform === 'win32')(
    'stages a filename containing a space and a double quote',
    () => {
      const dir = makeRepo();
      const name = 'weird " file.ts';
      writeFileSync(join(dir, name), 'export const weird = true;\n');
      const result = run(['bash', '-c', nodeBash('checkpoint-diff-repair')], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain('CHECKPOINT_DIFF_REPAIR=committed');
      // ls-tree C-quotes a double quote in a path even with core.quotepath=false;
      // read NUL-delimited names so the assertion sees the raw filename.
      const tracked = git(['ls-tree', '-r', '--name-only', '-z', 'HEAD'], dir)
        .split('\0')
        .filter(Boolean)
        .sort();
      expect(tracked).toEqual(['README.md', name].sort());
      expect(git(['status', '--porcelain'], dir)).toBe('');
    }
  );
  it('fails closed with stage_failed when git add fails', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'blocked.ts'), 'export const blocked = true;\n');
    const before = git(['rev-parse', 'HEAD'], dir);
    const script = [
      'git() {',
      '  if [ "$1" = "add" ]; then',
      '    echo "fatal: simulated add failure" >&2',
      '    return 1',
      '  fi',
      '  command git "$@"',
      '}',
      nodeBash('checkpoint-diff-repair'),
    ].join('\n');
    const result = run(['bash', '-c', script], dir);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain(
      'CHECKPOINT_DIFF_REPAIR=stage_failed path=blocked.ts'
    );
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(before);
  });
  it('leaves the BLOCKED commit-and-push authorization refusal intact', () => {
    const script = nodeBash('commit-and-push');
    expect(script).toContain("status='$RECLASS_STATUS'");
    expect(script).toContain('Refusing to commit.');
    expect(script).toContain('exit 1');
  });
});
