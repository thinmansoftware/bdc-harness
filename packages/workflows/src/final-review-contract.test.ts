import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { substituteNodeOutputRefs } from './dag-executor';

const ROOT = join(import.meta.dir, '..', '..', '..');
const LANES = join(ROOT, '.archon/workflows/defaults');
const CODEX = 'bdc-feature-development-codex.yaml';
const FIXTURES = join(import.meta.dir, 'fixtures/final-review');
const temporary: string[] = [];

interface NodeDef {
  id: string;
  prompt?: string;
  bash?: string;
}
interface LaneDef {
  nodes: NodeDef[];
}

function lane(file = CODEX): LaneDef {
  return Bun.YAML.parse(readFileSync(join(LANES, file), 'utf8')) as LaneDef;
}

function node(id: string, file = CODEX): NodeDef {
  const result = lane(file).nodes.find(candidate => candidate.id === id);
  if (!result) throw new Error(`${file}: missing ${id}`);
  return result;
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'slice-t-'));
  temporary.push(cwd);
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');
  writeFileSync(join(cwd, 'a.ts'), 'export const value = 1;\n');
  git(cwd, 'add', 'a.ts');
  git(cwd, 'commit', '-qm', 'base');
  writeFileSync(join(cwd, 'a.ts'), 'export const value = 2;\n');
  const head = git(cwd, 'rev-parse', 'HEAD');
  const artifacts = join(cwd, 'artifacts');
  Bun.spawnSync(['mkdir', '-p', artifacts]);
  const patch = `### committed diff (${head}..HEAD)\n\n### unstaged working-tree diff (HEAD..worktree)\n${git(cwd, 'diff', 'HEAD')}\n`;
  writeFileSync(join(artifacts, 'diff-final.patch'), patch);
  writeFileSync(join(artifacts, 'diff-final.files'), 'a.ts\n');
  return { cwd, artifacts, head, patch };
}

async function classify(review: string, setup = repo(), first = '{"verdict":"satisfied"}') {
  const capture = [
    `DIFF_FINAL_BASE=${setup.head}`,
    `DIFF_FINAL_HEAD=${setup.head}`,
    `DIFF_FINAL_SHA256=${sha(setup.patch)}`,
    `DIFF_FINAL_FILES=${join(setup.artifacts, 'diff-final.files')}`,
  ].join('\n');
  const outputs = new Map([
    ['diff-review-final', { state: 'completed' as const, output: review }],
    ['capture-diff-final', { state: 'completed' as const, output: capture }],
    ['classify-diff-review', { state: 'completed' as const, output: first }],
    [
      'assert-implement-produced-work',
      { state: 'completed' as const, output: 'BUILD_OUTCOME=REAL_BUILD' },
    ],
    [
      'gate-already-satisfied',
      { state: 'completed' as const, output: 'PRECHECK_VERDICT=needs-build' },
    ],
  ]);
  const script = substituteNodeOutputRefs(node('block-classify').bash ?? '', outputs, true);
  const proc = Bun.spawn(['bash', '-c', script], {
    cwd: setup.cwd,
    env: { ...process.env, ARTIFACTS_DIR: setup.artifacts },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

function good(head: string): string {
  return `DIFF_REVIEW_FINAL=satisfied\nREVIEWED_HEAD=${head}\nFILES_READ:\n- a.ts\nUNRESOLVED:\n- (none)\nSEMANTIC_RISK=LOW`;
}

afterEach(() => {
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true });
});

describe('Slice T final review contract', () => {
  it('sliceTProof c8731715 replay reports the cross-app check collapse', async () => {
    const fixture = join(FIXTURES, 'c8731715');
    const meta = JSON.parse(readFileSync(join(fixture, 'meta.json'), 'utf8'));
    const recording = readFileSync(join(fixture, 'recording.txt'), 'utf8');
    expect(meta.prompt_template_sha256).toBe(sha(node('diff-review-final').prompt ?? ''));
    expect(meta.model).not.toMatch(/^gpt-|^o[0-9]/);
    expect(recording).toContain('checksAreTerminal');
    expect(recording).toContain('DIFF_REVIEW_FINAL=needs_revision');
    expect((await classify(recording)).status).toBe('BLOCKED');
  });

  it('sliceTProof unparseable final output fails closed', async () => {
    expect(await classify('')).toMatchObject({ status: 'BLOCKED', reason: 'verdict_missing' });
    expect(await classify('plain prose')).toMatchObject({
      status: 'BLOCKED',
      reason: 'verdict_missing',
    });
    expect(await classify('DIFF_REVIEW_FINAL=satisfied')).toMatchObject({
      status: 'BLOCKED',
      reason: 'unresolved_missing',
    });
  });

  it('sliceTProof head and diff binding', async () => {
    const clean = repo();
    expect(await classify(good(clean.head), clean)).toMatchObject({
      status: 'PROCEED',
      reason: 'ok',
    });
    const changed = repo();
    writeFileSync(join(changed.cwd, 'a.ts'), 'export const value = 3;\n');
    expect(await classify(good(changed.head), changed)).toMatchObject({
      status: 'BLOCKED',
      reason: 'diff_changed_after_review',
    });
    const wrongHead = repo();
    expect(await classify(good('deadbeef'), wrongHead)).toMatchObject({
      status: 'BLOCKED',
      reason: 'head_mismatch',
    });
    const missing = repo();
    expect(
      await classify(good(missing.head).replace('- a.ts', '- other.ts'), missing)
    ).toMatchObject({ status: 'BLOCKED', reason: 'files_not_read' });
  });

  it('sliceTProof satisfied with a listed finding is blocked', async () => {
    const setup = repo();
    const review = good(setup.head).replace('- (none)', '- [minor] a.ts:3 x');
    expect(await classify(review, setup)).toMatchObject({
      status: 'BLOCKED',
      reason: 'findings_present',
    });
    const opusScript = node('classify-opus-rereview').bash ?? '';
    expect(opusScript).toContain('reason=findings_present');
    expect(opusScript).toContain('verdict=needs_revision');
  });

  it('sliceTProof original c8731715 output no longer passes', async () => {
    const original = readFileSync(join(FIXTURES, 'c8731715/original-final-output.txt'), 'utf8');
    expect(await classify(original)).toMatchObject({ status: 'BLOCKED', reason: 'head_mismatch' });
  });

  it('sliceTProof seeded regression introduced by repair is caught', async () => {
    const fixture = join(FIXTURES, 'seeded-regression');
    const meta = JSON.parse(readFileSync(join(fixture, 'meta.json'), 'utf8'));
    const recording = readFileSync(join(fixture, 'recording.txt'), 'utf8');
    expect(meta.prompt_template_sha256).toBe(sha(node('diff-review-final').prompt ?? ''));
    expect(recording).toContain('run-lease.ts');
    expect(recording).toMatch(/claimed|claimRunLease/);
    expect(recording).toContain('DIFF_REVIEW_FINAL=needs_revision');
    expect((await classify(recording)).status).toBe('BLOCKED');
  });

  it('sliceTProof every final prompt is fresh and complete', () => {
    for (const file of new Bun.Glob('bdc-feature-development*.yaml').scanSync(LANES)) {
      const final = node('diff-review-final', file).prompt ?? '';
      expect(final).not.toContain('Your original findings:');
      expect(final).not.toContain('For EACH finding you raised originally');
      expect(final).toContain('direct callers and callees');
    }
  });

  it('sliceTProof salvage opens a draft in every lane', () => {
    for (const file of new Bun.Glob('bdc-feature-development*.yaml').scanSync(LANES)) {
      const salvage = node('noninteractive-salvage', file).bash ?? '';
      expect(salvage).toContain('gh pr create --draft --repo');
      expect(salvage).not.toMatch(/gh pr create (?!--draft)/);
    }
  });
});
