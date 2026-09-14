import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse } from 'yaml';

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
  'bdc-feature-development-codex-only.yaml',
  'bdc-feature-development-codex.yaml',
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

function run(args: string[], cwd: string) {
  return Bun.spawnSync(args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
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
function nodeBash(id: string): string {
  const file = join(LANES_DIR, 'bdc-feature-development-codex.yaml');
  const workflow = parse(readFileSync(file, 'utf8')) as WorkflowDocument;
  const bash = workflow.nodes.find(node => node.id === id)?.bash;
  if (!bash) throw new Error(`missing bash node ${id}`);
  return bash;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
      expect(git(['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', 'HEAD'], dir)).toBe(
        `README.md\n${name}`
      );
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
