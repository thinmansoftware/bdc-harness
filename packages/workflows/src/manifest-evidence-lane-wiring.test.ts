import { describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseWorkflow } from './loader';
import { substituteNodeOutputRefs } from './dag-executor';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';

// bdc-xo #1940 (harness defect 2026-09-05, shopops #674 run 69f9d306 / lspro-react
// #580 run d31037ff): the engine-side build-manifest renders "Tests: N/A (required
// gates are reported separately)" and "Grep assertions: N/A" for every WO, and the
// validator's test claim was never tied to an executed command. Every
// bdc-feature-development lane must now carry four mechanical evidence nodes and
// the validator's executed-command contract. These are string-level wiring
// assertions (like already-satisfied-base-ref-visibility.test.ts), CI-enforced so
// a lane cannot silently drop the contract. The node cores themselves are tested
// by .archon/workflows/defaults/__tests__/{run-stop-tests,run-stop-greps,
// stamp-manifest-evidence,manifest-evidence-check}.sh, which extract them from the
// YAML and execute them.

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

// Hardcoded on purpose: a NEW lane that carries an evidence: manifest_v2
// build-manifest must be added here AND given the evidence nodes.
const EXPECTED_LANES = [
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
].sort();

const EVIDENCE_NODES = [
  'run-stop-tests',
  'run-stop-greps',
  'stamp-manifest-evidence',
  'manifest-evidence-check',
] as const;

const MANIFEST_V2_LANES = readdirSync(LANES_DIR)
  .filter(file => file.endsWith('.yaml'))
  .filter(file => readFileSync(join(LANES_DIR, file), 'utf-8').includes('kind: manifest_v2'))
  .sort();

interface LaneNode {
  readonly id: string;
  readonly depends_on?: readonly string[];
  readonly when?: string;
  readonly bash?: string;
  readonly prompt?: string;
  readonly timeout?: number;
}

function laneNodes(file: string): readonly LaneNode[] {
  const content = readFileSync(join(LANES_DIR, file), 'utf-8');
  const result = parseWorkflow(content, file);
  if (!result.workflow) {
    throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);
  }
  return result.workflow.nodes as unknown as readonly LaneNode[];
}

function node(nodes: readonly LaneNode[], id: string, file: string): LaneNode {
  const found = nodes.find(n => n.id === id);
  if (!found) throw new Error(`${file}: no ${id} node`);
  return found;
}

function coreOf(bash: string, marker: string): string {
  const begin = bash.indexOf(`# ---- BEGIN ${marker} core`);
  const end = bash.indexOf(`# ---- END ${marker} core`);
  if (begin < 0 || end < 0) throw new Error(`missing ${marker} core markers`);
  return bash.slice(begin, end);
}

describe('manifest evidence lane wiring (bdc-xo #1940)', () => {
  it('every lane with an evidence: manifest_v2 build-manifest is in the expected list', () => {
    expect(MANIFEST_V2_LANES).toEqual(EXPECTED_LANES);
  });

  for (const file of EXPECTED_LANES) {
    describe(file, () => {
      const nodes = laneNodes(file);

      it('carries the four mechanical evidence nodes as bash nodes', () => {
        for (const id of EVIDENCE_NODES) {
          const n = node(nodes, id, file);
          expect(typeof n.bash).toBe('string');
          expect(n.prompt).toBeUndefined();
        }
      });

      it('run-stop-tests runs after format-autofix with a 30-minute budget', () => {
        const n = node(nodes, 'run-stop-tests', file);
        expect(n.depends_on).toEqual(['format-autofix']);
        expect(n.timeout).toBe(1800000);
        expect(n.bash).toContain(
          "case \"$cmd\" in *'{{'*|*';'*|*'`'*|*'$('*|*'>'*|*'<'*|*'|'*) return 1"
        );
        expect(n.bash).toContain(
          'inline-flag rejection: -c -e --eval -p --print -r --require -i -m'
        );
        expect(n.bash).toContain('timeout 1500 "$@"');
        expect(n.bash).toContain('[ -n "$CMD_JOINED" ] && [ "$EXIT_CODE" -ne 0 ]');
      });

      it('run-stop-greps tokenizes argv pipelines and rejects find -execdir', () => {
        const n = node(nodes, 'run-stop-greps', file);
        expect(n.depends_on).toEqual(['format-autofix']);
        expect(n.timeout).toBe(600000);
        expect(n.bash).toContain('rsg_tokens_safe');
        expect(n.bash).toContain('rsg_exec_pipeline');
        expect(n.bash).toContain('-execdir');
        expect(n.bash).toContain('^[A-Za-z0-9@%+=:,./_*?-]+$');
        expect(n.bash).not.toContain('bash -c "$1"');
      });

      it('war-council-validator depends on both evidence nodes and carries the executed-command contract', () => {
        const n = node(nodes, 'war-council-validator', file);
        expect(n.depends_on).toEqual(['ascii-gate', 'run-stop-tests', 'run-stop-greps']);
        expect(n.prompt).toContain('$run-stop-tests.output');
        expect(n.prompt).toContain('$run-stop-greps.output');
        expect(n.prompt).toContain('TESTS_OBSERVED: <passed>/<total> (<command you executed>)');
        expect(n.prompt).toContain('TESTS_OBSERVED: not_run (<reason>)');
        expect(n.prompt).toContain('without an executed command');
        expect(n.prompt).toContain('needs_revision');
      });

      it('stamp-manifest-evidence rewrites the raw engine manifest from both evidence nodes', () => {
        const n = node(nodes, 'stamp-manifest-evidence', file);
        expect(n.depends_on).toEqual(['build-manifest', 'run-stop-tests', 'run-stop-greps']);
        expect(n.bash).toContain('$build-manifest.output');
        expect(n.bash).toContain('$run-stop-tests.output');
        expect(n.bash).toContain('$run-stop-greps.output');
      });

      it('manifest-evidence-check reads the stamped manifest and gates patch-pr-body', () => {
        const check = node(nodes, 'manifest-evidence-check', file);
        expect(check.depends_on).toContain('stamp-manifest-evidence');
        expect(check.bash).toContain('$stamp-manifest-evidence.output');
        const patch = node(nodes, 'patch-pr-body', file);
        expect(patch.depends_on).toContain('manifest-evidence-check');
        expect(patch.when).toContain("$manifest-evidence-check.output == 'OK'");
      });

      it('no consumer other than stamp-manifest-evidence reads the raw $build-manifest.output', () => {
        for (const n of nodes) {
          if (n.id === 'stamp-manifest-evidence') continue;
          const body = `${n.bash ?? ''}\n${n.prompt ?? ''}`;
          expect(body.includes('$build-manifest.output')).toBe(false);
        }
      });
    });
  }

  it('the four node cores are byte-identical across all lanes', () => {
    const canonical = laneNodes('bdc-feature-development-codex.yaml');
    const markers: Record<(typeof EVIDENCE_NODES)[number], string> = {
      'run-stop-tests': 'rst',
      'run-stop-greps': 'rsg',
      'stamp-manifest-evidence': 'sme',
      'manifest-evidence-check': 'mec',
    };
    for (const file of EXPECTED_LANES) {
      const nodes = laneNodes(file);
      for (const id of EVIDENCE_NODES) {
        const expected = coreOf(node(canonical, id, 'canonical').bash ?? '', markers[id]);
        const actual = coreOf(node(nodes, id, file).bash ?? '', markers[id]);
        expect(actual).toBe(expected);
      }
    }
  });

  it('the placeholder Tests text is still what the engine renders (so the stamp is load-bearing)', () => {
    const collector = readFileSync(
      join(REPO_ROOT, 'packages/workflows/src/reliability/evidence-collector.ts'),
      'utf-8'
    );
    expect(collector).toContain("'Tests: N/A (required gates are reported separately)'");
  });
});

function rstField(stdout: string, key: string): string {
  const line = stdout.split('\n').find(row => row.startsWith(`${key}=`));
  if (!line) {
    throw new Error(`missing ${key} in:\n${stdout}`);
  }
  return line.slice(key.length + 1);
}

function rstSpec(command: string): string {
  return [
    'WO Class: CODE',
    '',
    'Stop 2 (test suite):',
    `  ${command}`,
    '  Expected: all passing',
  ].join('\n');
}

function runStopTestsNode(opts: {
  readonly spec: string;
  readonly files?: Readonly<Record<string, string>>;
}): { readonly stdout: string; readonly log: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'rst-ladder-'));
  const artifacts = join(cwd, 'artifacts');
  mkdirSync(artifacts);
  try {
    writeFileSync(
      join(cwd, 'package.json'),
      `${JSON.stringify({ name: 'x', scripts: { test: 'bash ./repo-pass.sh' } })}\n`
    );
    writeFileSync(join(cwd, 'bun.lock'), '{}\n');
    writeFileSync(join(cwd, 'repo-pass.sh'), 'echo "Tests: 1/1"\nexit 0\n');
    for (const [rel, body] of Object.entries(opts.files ?? {})) {
      writeFileSync(join(cwd, rel), body);
    }
    const bash = node(
      laneNodes('bdc-feature-development-codex.yaml'),
      'run-stop-tests',
      'canonical'
    ).bash;
    if (!bash) throw new Error('run-stop-tests has no bash');
    const rendered = substituteNodeOutputRefs(
      bash,
      new Map([['read-spec', { state: 'completed' as const, output: opts.spec }]]),
      true
    );
    const proc = Bun.spawnSync(['bash', '-c', rendered], {
      cwd,
      env: { ...process.env, ARTIFACTS_DIR: artifacts },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = proc.stdout.toString();
    let log = '';
    try {
      log = readFileSync(join(artifacts, 'evidence', 'stop-tests.log'), 'utf-8');
    } catch {
      log = '';
    }
    if (proc.exitCode !== 0) {
      throw new Error(
        `run-stop-tests exited ${proc.exitCode}: ${stdout}\n${proc.stderr.toString()}`
      );
    }
    return { stdout, log };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// The behavioral cases spawn the node's bash; on win32 `bash` resolves to WSL and
// produces nothing, so they run on POSIX CI only (ubuntu-latest).
describe.skipIf(process.platform === 'win32')('run-stop-tests ladder (behavioral)', () => {
  it('a spec-declared command that exits nonzero with no counts stays failed; repo_test_script is not run', () => {
    const { stdout, log } = runStopTestsNode({
      spec: rstSpec('bash ./exit3.sh'),
      files: { 'exit3.sh': 'exit 3\n' },
    });
    expect(rstField(stdout, 'TESTS_STATUS')).toBe('failed');
    expect(rstField(stdout, 'TESTS_SOURCE')).toBe('spec_declared');
    expect(rstField(stdout, 'TESTS_LINE')).toBe(
      'N/A (spec-declared test command exited 3 with no parseable counts: bash ./exit3.sh) -- FAILED'
    );
    expect(log).toContain('### run-stop-tests: bash ./exit3.sh');
    expect(log).toContain('### exit 3');
    expect(log).not.toContain('### run-stop-tests: bun run test');
    expect(stdout).not.toContain('repo_test_script');
  });

  it('a spec-declared command that exits 0 with no counts still falls through to repo_test_script', () => {
    const { stdout, log } = runStopTestsNode({
      spec: rstSpec('bash ./noop.sh'),
      files: { 'noop.sh': 'exit 0\n' },
    });
    expect(rstField(stdout, 'TESTS_STATUS')).toBe('passed');
    expect(rstField(stdout, 'TESTS_SOURCE')).toContain('repo_test_script');
    expect(rstField(stdout, 'TESTS_SOURCE')).toContain('after: spec_declared');
    expect(log).toContain('### run-stop-tests: bash ./noop.sh');
    expect(log).toContain('### run-stop-tests: bun run test');
    expect(rstField(stdout, 'TESTS_LINE')).toBe('1/1 (bun run test)');
  });

  it('parsed passing counts from a spec-declared command still report passed', () => {
    const { stdout, log } = runStopTestsNode({
      spec: rstSpec('bash ./green.sh'),
      files: { 'green.sh': 'echo "Tests: 3/3"\nexit 0\n' },
    });
    expect(rstField(stdout, 'TESTS_STATUS')).toBe('passed');
    expect(rstField(stdout, 'TESTS_SOURCE')).toBe('spec_declared');
    expect(rstField(stdout, 'TESTS_LINE')).toBe('3/3 (bash ./green.sh)');
    expect(log).not.toContain('### run-stop-tests: bun run test');
  });

  it('parsed failing counts from a spec-declared command still report failed', () => {
    const { stdout, log } = runStopTestsNode({
      spec: rstSpec('bash ./red.sh'),
      files: { 'red.sh': 'echo "Tests: 1/2"\nexit 1\n' },
    });
    expect(rstField(stdout, 'TESTS_STATUS')).toBe('failed');
    expect(rstField(stdout, 'TESTS_SOURCE')).toBe('spec_declared');
    expect(rstField(stdout, 'TESTS_LINE')).toBe('1/2 (bash ./red.sh) -- FAILED, exit 1');
    expect(log).not.toContain('### run-stop-tests: bun run test');
  });

  it('a spec-declared python -c line is not runnable and is never executed', () => {
    const { stdout, log } = runStopTestsNode({
      spec: rstSpec("python -c 'print(1)'"),
    });
    expect(rstField(stdout, 'TESTS_STATUS')).toBe('passed');
    expect(rstField(stdout, 'TESTS_SOURCE')).toContain('repo_test_script');
    expect(rstField(stdout, 'TESTS_LINE')).toBe('1/1 (bun run test)');
    expect(stdout).not.toContain('python -c');
    expect(log).not.toContain('python -c');
    expect(log).not.toContain('### run-stop-tests: python');
    expect(log).toContain('### run-stop-tests: bun run test');
  });
});

function rsgField(stdout: string, key: string): string {
  const line = stdout.split('\n').find(row => row.startsWith(`${key}=`));
  if (!line) {
    throw new Error(`missing ${key} in:\n${stdout}`);
  }
  return line.slice(key.length + 1);
}

function runStopGrepsNode(opts: {
  readonly spec: string;
  readonly files?: Readonly<Record<string, string>>;
}): { readonly stdout: string; readonly pwned: boolean } {
  const cwd = mkdtempSync(join(tmpdir(), 'rsg-allow-'));
  try {
    for (const [rel, body] of Object.entries(opts.files ?? {})) {
      writeFileSync(join(cwd, rel), body);
    }
    const bash = node(
      laneNodes('bdc-feature-development-codex.yaml'),
      'run-stop-greps',
      'canonical'
    ).bash;
    if (!bash) throw new Error('run-stop-greps has no bash');
    const rendered = substituteNodeOutputRefs(
      bash,
      new Map([['read-spec', { state: 'completed' as const, output: opts.spec }]]),
      true
    );
    const proc = Bun.spawnSync(['bash', '-c', rendered], {
      cwd,
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = proc.stdout.toString();
    if (proc.exitCode !== 0) {
      throw new Error(
        `run-stop-greps exited ${proc.exitCode}: ${stdout}\n${proc.stderr.toString()}`
      );
    }
    return { stdout, pwned: existsSync(join(cwd, 'pwned-rsg-execdir.txt')) };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === 'win32')('run-stop-greps allowlist (behavioral)', () => {
  it('a spec-declared find -execdir line is dropped and never executed', () => {
    const { stdout, pwned } = runStopGrepsNode({
      spec: [
        'WO Class: CODE',
        '',
        'Stop 1 (grep assertion):',
        '  find . -execdir sh evil.sh \\;',
        '  Expected: 0',
      ].join('\n'),
      files: { 'evil.sh': 'touch pwned-rsg-execdir.txt\n' },
    });
    expect(rsgField(stdout, 'GREP_STATUS')).toBe('all_dropped');
    expect(rsgField(stdout, 'GREP_DROPPED')).toBe('1');
    expect(rsgField(stdout, 'GREP_EXECUTED')).toBe('0');
    expect(stdout).toContain('not on read-only allowlist; not executed');
    expect(stdout).toContain('find . -execdir sh evil.sh');
    expect(pwned).toBe(false);
  });
});
