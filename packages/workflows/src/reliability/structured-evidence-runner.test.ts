import { describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  allowAssertion,
  allowTestCommand,
  checkAttemptRecord,
  checkBoundAttempts,
  displayCommands,
  execAssertion,
  extractTestCommands,
  normalizeTestCommand,
  observeAssertion,
  resolveTrustedRunnerFile,
  runTestCommands,
  scopeEvidence,
  scrubEnv,
  selectStagesBlock,
  testedTreeIdentity,
  type EvidenceAttempt,
  type EvidenceAuthority,
} from './structured-evidence-runner';

const ROOT = join(import.meta.dir, '..', '..', '..', '..');
process.env.HARNESS_ROOT_OVERRIDE = ROOT;
process.env.NODE_ENV = 'test';
process.env.SER_TEST_TRUSTED_ROOT = ROOT;
const RUNNER = join(ROOT, 'packages/workflows/src/reliability/structured-evidence-runner.ts');

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeExec(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')}`);
}

function initRepo(cwd: string): void {
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 't@example.com']);
  git(cwd, ['config', 'user.name', 'Test']);
  writeFileSync(join(cwd, 'README'), 'base\n');
  git(cwd, ['add', 'README']);
  git(cwd, ['commit', '-qm', 'base']);
}

it('rejects an executable runner copied into a spoofed writable harness checkout', () => {
  const fakeHarness = tempDir('ser-untrusted-harness-');
  const product = tempDir('ser-product-');
  const saved = process.env.HARNESS_ROOT_OVERRIDE;
  try {
    mkdirSync(join(fakeHarness, 'packages/workflows/src/reliability'), { recursive: true });
    writeFileSync(
      join(fakeHarness, 'packages/workflows/package.json'),
      JSON.stringify({ name: '@archon/workflows' })
    );
    writeFileSync(
      join(fakeHarness, 'packages/workflows/src/reliability/structured-evidence-runner.ts'),
      'process.stdout.write("ATTACKER_HELPER_EXECUTED\\n");\n'
    );
    initRepo(fakeHarness);
    git(fakeHarness, [
      'remote',
      'add',
      'origin',
      'https://evilgithub.com/thinmansoftware/bdc-harness.git',
    ]);
    initRepo(product);
    process.env.HARNESS_ROOT_OVERRIDE = fakeHarness;
    expect(resolveTrustedRunnerFile(product)).not.toBe(
      join(fakeHarness, 'packages/workflows/src/reliability/structured-evidence-runner.ts')
    );
    const trustedResolution = spawnSync('bun', [RUNNER, 'allow-test', '--', 'bash ./x.sh'], {
      cwd: product,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SER_TEST_TRUSTED_ROOT: '',
        HARNESS_ROOT_OVERRIDE: fakeHarness,
      },
      encoding: 'utf8',
    });
    expect(trustedResolution.stdout).not.toContain('ATTACKER_HELPER_EXECUTED');
    expect(trustedResolution.stderr).toContain('NEVER_RAN');
  } finally {
    if (saved === undefined) delete process.env.HARNESS_ROOT_OVERRIDE;
    else process.env.HARNESS_ROOT_OVERRIDE = saved;
    rmSync(fakeHarness, { recursive: true, force: true });
    rmSync(product, { recursive: true, force: true });
  }
});

function authority(cwd: string): EvidenceAuthority {
  return { repo: '', stageId: null, targetBranch: null, worktree: cwd, baseSha: '' };
}

function stageBody(stages: string): string {
  return ['stages:', ...stages.split('\n')].join('\n');
}

function oneStage(id: string, repo: string, command: string, branch = 'dev'): string {
  return [
    `  - id: ${id}`,
    `    repo: ${repo}`,
    `    target_branch: ${branch}`,
    '    in_scope_files: ["README"]',
    `    verify_commands: ["${command}"]`,
    '    readiness_bar:',
    '      pr_open: true',
    '      ci_green: true',
    '      diff_review_clean: true',
    '      mergeable: true',
  ].join('\n');
}

describe('quoted-argv-historical-replays', () => {
  it('keeps quoted historical tokens literal and does not split an in-quote pipe', () => {
    const samples = [
      ["grep -c 'SET LOCAL app.tenant_id' f", ['grep', '-c', 'SET LOCAL app.tenant_id', 'f']],
      ["grep -c '^<<<<<<<' f", ['grep', '-c', '^<<<<<<<', 'f']],
      [
        "grep -c 'ON CONFLICT (tenant_id, stripe_payment_id)' f",
        ['grep', '-c', 'ON CONFLICT (tenant_id, stripe_payment_id)', 'f'],
      ],
      ["grep -c 'localhost:$PORT/health' f", ['grep', '-c', 'localhost:$PORT/health', 'f']],
      ["grep -c 'runScopeSha}..${headSha}' f", ['grep', '-c', 'runScopeSha}..${headSha}', 'f']],
      ["grep -c 'foo|bar' f", ['grep', '-c', 'foo|bar', 'f']],
      ["grep -c 'a\\b' f", ['grep', '-c', 'a\\b', 'f']],
    ] as const;
    const cwd = tempDir('ser-replay-');
    const bin = join(cwd, 'bin');
    const record = join(cwd, 'argv.txt');
    mkdirSync(bin);
    writeExec(
      join(bin, 'grep'),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> '${record}'\nprintf '---\\n' >> '${record}'\nexit 0\n`
    );
    writeFileSync(join(cwd, 'f'), 'x\n');
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved ?? ''}`;
    try {
      for (const [command, argv] of samples) {
        const allowed = allowAssertion(command);
        expect(allowed.ok).toBe(true);
        if (!allowed.ok) continue;
        expect(allowed.segments).toHaveLength(1);
        expect(allowed.segments[0]?.argv).toEqual([...argv]);
        writeFileSync(record, '');
        const ran = execAssertion(command, cwd);
        expect(ran.upstreamError).toBe(false);
        expect(readFileSync(record, 'utf8').split('---')[0]?.trim().split('\n')).toEqual([
          ...argv.slice(1),
        ]);
      }
    } finally {
      process.env.PATH = saved;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('unsafe-and-decode-bypasses', () => {
  it('refuses prohibited forms and decoded sort flags without running them', () => {
    const cwd = tempDir('ser-unsafe-');
    const sentinel = join(cwd, 'pwned');
    writeExec(join(cwd, 'touch-sentinel'), `#!/bin/sh\ntouch '${sentinel}'\n`);
    const refused = [
      'grep -c "x" f',
      "grep -c '$(id)' f",
      "grep -c 'a'b f",
      "grep -c '' f",
      'grep -c x f; true',
      'grep -c x f && true',
      'grep -c x f > out',
      'sort --output=glob',
      "sort '--out\\put'",
      "sort '--output=glob'",
      'find . -exec touch pwned ;',
      "find . '-exec' rm",
      'grep --file=/etc/passwd x',
      'git commit -m x',
      'git diff --output',
      'git -c user.name=x diff',
      'git checkout -- README',
    ];
    for (const command of refused) {
      const allowed = allowAssertion(command);
      expect(allowed.ok).toBe(false);
      const ran = execAssertion(command, cwd);
      expect(ran.upstreamError).toBe(true);
      expect(ran.stdout).toBe('');
    }
    const pathData = allowAssertion("sort -- '--output=glob'");
    expect(pathData.ok).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('refuses find predicates after -- without spawning or writing', () => {
    const cwd = tempDir('ser-find-');
    writeFileSync(join(cwd, 'keep.txt'), 'stay\n');
    const marker = join(cwd, 'marker');
    const spawned = join(cwd, 'find-spawned');
    const bin = join(cwd, 'bin');
    mkdirSync(bin);
    writeExec(join(bin, 'find'), `#!/bin/sh\ntouch '${spawned}'\nexit 0\n`);
    const commands = [
      'find -- . -delete',
      'find -- . -exec touch marker',
      'find -- . -execdir touch marker',
      'find -- . -ok touch marker',
      'find -- . -okdir touch marker',
      'find -- . -fprint marker',
      'find -- . -fls marker',
      "find -- . '-delete'",
      "find -- . '-fprint' marker",
      "find -- . '-de\\lete'",
      "find -- . '-ex\\ec' touch marker",
      "find -- . '-fp\\rint' marker",
    ];
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    try {
      for (const command of commands) {
        const allowed = allowAssertion(command);
        expect(allowed.ok).toBe(false);
        if (!allowed.ok) expect(allowed.reason).toBe('find-flag');
        const ran = execAssertion(command, cwd);
        expect(ran.reason).toBe('find-flag');
        expect(ran.stdout).toBe('');
        expect(ran.steps).toEqual([]);
        expect(existsSync(join(cwd, 'keep.txt'))).toBe(true);
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(spawned)).toBe(false);
      }
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
    const sortPath = allowAssertion("sort -- '--output=glob'");
    expect(sortPath.ok).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('rejects tab controls in the assertion runner before execution', () => {
    const cwd = tempDir('ser-tab-');
    const sentinel = join(cwd, 'pwned');
    const bin = join(cwd, 'bin');
    mkdirSync(bin);
    writeExec(join(bin, 'grep'), `#!/bin/sh\ntouch '${sentinel}'\nexit 0\n`);
    const command = 'grep\t-c\tbase\tREADME';
    const allowed = allowAssertion(command);
    expect(allowed.ok).toBe(false);
    if (!allowed.ok) expect(allowed.reason).toBe('control');
    const direct = execAssertion(command, cwd);
    expect(direct.reason).toBe('control');
    expect(direct.stdout).toBe('');
    expect(direct.steps).toEqual([]);
    const ran = spawnSync('bun', [RUNNER, 'exec-assertion', '--', command], {
      cwd,
      env: {
        ...process.env,
        HARNESS_ROOT_OVERRIDE: ROOT,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
    });
    expect(ran.stderr ?? '').not.toContain('NEVER_RAN missing trusted');
    expect(ran.status).toBe(127);
    expect(ran.stdout ?? '').toBe('');
    expect(existsSync(sentinel)).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe('git-and-pipeline-safety', () => {
  it('does not run hostile git helpers and does not launder upstream errors', () => {
    const cwd = tempDir('ser-git-');
    initRepo(cwd);
    const hostile = join(cwd, 'hostile.sh');
    writeExec(hostile, '#!/bin/sh\ntouch pwned\n');
    git(cwd, ['config', 'core.fsmonitor', hostile]);
    git(cwd, ['config', 'diff.external', hostile]);
    git(cwd, ['config', 'diff.hostile.textconv', hostile]);
    writeFileSync(join(cwd, '.gitattributes'), '* diff=hostile\n');
    writeFileSync(join(cwd, 'notes.txt'), 'alpha\n');
    const diff = execAssertion('git diff --stat', cwd);
    expect(diff.upstreamError).toBe(false);
    expect(diff.segments[0]?.argv.slice(0, 8)).toEqual([
      'git',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.pager=cat',
      '--no-pager',
      'diff',
      '--no-ext-diff',
    ]);
    expect(existsSync(join(cwd, 'pwned'))).toBe(false);
    writeFileSync(join(cwd, 'hay.txt'), 'needle\n');
    expect(observeAssertion('grep -c absent hay.txt', cwd)).toBe('0');
    expect(observeAssertion('grep -c needle missing-file.txt', cwd)).toBe('ERR');
    expect(observeAssertion('grep -c needle missing-file.txt | wc -l', cwd)).toBe('ERR');
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe('partial-failure-and-compatibility', () => {
  it('does not label zero, impossible, negative, or unparsed counts as passed', () => {
    const cwd = tempDir('ser-counts-');
    const cases: { body: string; status: string; reason: string }[] = [
      { body: 'echo "Tests: 2/2"\nexit 0\n', status: 'PASSED', reason: 'passed' },
      { body: 'echo "Tests: 0/0"\nexit 0\n', status: 'FAILED', reason: 'zero-count' },
      { body: 'echo "Tests: 2/3"\nexit 0\n', status: 'FAILED', reason: 'count-mismatch' },
      { body: 'echo "Tests: 4/3"\nexit 0\n', status: 'FAILED', reason: 'count-mismatch' },
      { body: 'echo "Tests: 2/2"\nexit 3\n', status: 'FAILED', reason: 'nonzero' },
      {
        body: 'echo "no counts here"\nexit 0\n',
        status: 'COUNTS_UNPARSED',
        reason: 'counts_unparsed',
      },
    ];
    for (const row of cases) {
      writeExec(join(cwd, 'case.sh'), `#!/bin/sh\n${row.body}`);
      const summary = runTestCommands(['bash ./case.sh'], cwd, join(cwd, 'case.log'));
      expect(summary.attempt.members[0]?.status).toBe(row.status);
      expect(summary.attempt.members[0]?.reason).toBe(row.reason);
    }
    expect(allowTestCommand("python -c 'print(1)'")).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('does not publish a pass when a later required member has no counts or zero counts', () => {
    const cwd = tempDir('ser-mixed-counts-');
    const artifacts = join(cwd, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    writeExec(join(cwd, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\nexit 0\n');
    writeExec(join(cwd, 'nocount.sh'), '#!/bin/sh\necho "no counts here"\nexit 0\n');
    writeExec(join(cwd, 'zero.sh'), '#!/bin/sh\necho "Tests: 0/0"\nexit 0\n');
    writeExec(join(cwd, 'impossible.sh'), '#!/bin/sh\necho "Tests: 4/3"\nexit 0\n');
    writeExec(join(cwd, 'negative.sh'), '#!/bin/sh\necho "Tests: -1/-1"\nexit 0\n');
    const saved = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = artifacts;
    try {
      const unparsed = runTestCommands(
        ['bash ./ok.sh', 'bash ./nocount.sh'],
        cwd,
        join(artifacts, 'nocount.log')
      );
      expect(unparsed.line).toBe('0  ');
      expect(unparsed.passed).toBeNull();
      expect(unparsed.total).toBeNull();
      expect(unparsed.attempt.aggregate).toBe('COUNTS_UNPARSED');
      expect(unparsed.attempt.members.map(member => member.status)).toEqual([
        'PASSED',
        'COUNTS_UNPARSED',
      ]);
      const unparsedVerdict = checkAttemptRecord(unparsed.attempt, cwd, authority(cwd));
      expect(unparsedVerdict.ok).toBe(false);
      if (!unparsedVerdict.ok) expect(unparsedVerdict.reason).toContain('nocount.sh');

      const zero = runTestCommands(
        ['bash ./ok.sh', 'bash ./zero.sh'],
        cwd,
        join(artifacts, 'zero.log')
      );
      expect(zero.line).toBe('0 0 0');
      expect(zero.attempt.aggregate).toBe('FAILED');
      expect(zero.attempt.members[1]?.status).toBe('FAILED');
      expect(zero.attempt.members[1]?.reason).toBe('zero-count');
      expect(zero.attempt.members[1]?.passed).toBe(0);
      expect(zero.attempt.members[1]?.total).toBe(0);
      const zeroVerdict = checkAttemptRecord(zero.attempt, cwd, authority(cwd));
      expect(zeroVerdict.ok).toBe(false);

      const impossible = runTestCommands(
        ['bash ./impossible.sh'],
        cwd,
        join(artifacts, 'impossible.log')
      );
      expect(impossible.line.startsWith('0 ')).toBe(false);
      expect(impossible.passed).toBeNull();
      expect(impossible.total).toBeNull();
      expect(impossible.exitCode).not.toBe(0);
      expect(impossible.attempt.members[0]?.status).toBe('FAILED');
      expect(checkAttemptRecord(impossible.attempt, cwd, authority(cwd)).ok).toBe(false);

      const negative = runTestCommands(
        ['bash ./ok.sh', 'bash ./negative.sh'],
        cwd,
        join(artifacts, 'negative.log')
      );
      expect(negative.line).toBe('0  ');
      expect(negative.passed).toBeNull();
      expect(negative.total).toBeNull();
      expect(negative.attempt.aggregate).toBe('COUNTS_UNPARSED');
      expect(negative.attempt.members[1]?.status).toBe('COUNTS_UNPARSED');
      expect(checkAttemptRecord(negative.attempt, cwd, authority(cwd)).ok).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = saved;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('precedence-no-fallback-laundering', () => {
  it('keeps an explicit failing command ahead of a project-map command', () => {
    const cwd = tempDir('ser-prec-');
    initRepo(cwd);
    writeExec(join(cwd, 'fail.sh'), '#!/bin/sh\necho "Tests: 0/1"\nexit 1\n');
    writeExec(join(cwd, 'map.sh'), '#!/bin/sh\necho "Tests: 1/1"\nexit 0\n');
    const spec = [
      'WO Class: CODE',
      '',
      'Stop 2 (test suite):',
      '  bash ./fail.sh',
      '  Expected: 1',
    ].join('\n');
    const commands = extractTestCommands(spec);
    expect(commands).toEqual(['bash ./fail.sh']);
    const summary = runTestCommands(commands, cwd, join(cwd, 'prec.log'));
    expect(summary.attempt.members[0]?.status).toBe('FAILED');
    expect(readFileSync(join(cwd, 'prec.log'), 'utf8')).not.toContain('map.sh');
    const absent = extractTestCommands(
      'WO Class: CODE\n\nStop 1 (grep assertion):\n  grep -c x y\n  Expected: 0\n'
    );
    expect(absent).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe('canonical-stage-authority', () => {
  it('executes only the authorized stage and refuses ambiguity before a command list is used', () => {
    const shop = oneStage('api', 'thinmansoftware/shopops', 'bash ./api.sh');
    const web = oneStage('web', 'thinmansoftware/lspro', 'bash ./web.sh');
    const marked = `<!-- canonical-stages -->\n\`\`\`yaml\n${stageBody(`${shop}\n${web}`)}\n\`\`\`\n`;
    const selected = scopeEvidence(marked, { repo: 'thinmansoftware/shopops' });
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.scope.stageId).toBe('api');
      expect(selected.scope.commands).toEqual(['bash ./api.sh']);
      expect(selected.scope.otherStage).toEqual(['bash ./web.sh']);
      expect(selected.scope.unresolved).toBe(false);
    }
    const dup = scopeEvidence(
      `\`\`\`yaml\n${stageBody(`${shop}\n${oneStage('api', 'thinmansoftware/other', 'bash ./x.sh')}`)}\n\`\`\`\n`,
      {
        stageId: 'api',
      }
    );
    expect(dup.ok).toBe(false);
    const sameRepo = scopeEvidence(
      `\`\`\`yaml\n${stageBody(`${shop}\n${oneStage('other', 'thinmansoftware/shopops', 'bash ./y.sh')}`)}\n\`\`\`\n`,
      { repo: 'thinmansoftware/shopops' }
    );
    expect(sameRepo.ok).toBe(false);
    const mismatch = scopeEvidence(`\`\`\`yaml\n${stageBody(shop)}\n\`\`\`\n`, {
      repo: 'thinmansoftware/shopops',
      targetBranch: 'main',
    });
    expect(mismatch.ok).toBe(false);
    const crossRepo = scopeEvidence(marked, {
      stageId: 'api',
      repo: 'thinmansoftware/lspro',
    });
    expect(crossRepo.ok).toBe(false);
    if (!crossRepo.ok) expect(crossRepo.message).toContain('repo');
    const bound = scopeEvidence(marked, {
      stageId: 'web',
      repo: 'git@github.com:thinmansoftware/lspro.git',
    });
    expect(bound.ok).toBe(true);
    if (bound.ok) {
      expect(bound.scope.stageId).toBe('web');
      expect(bound.scope.commands).toEqual(['bash ./web.sh']);
      expect(bound.scope.otherStage).toEqual(['bash ./api.sh']);
    }
    const none = scopeEvidence('WO Class: CODE\n', {});
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.scope.stageId).toBeNull();
    const multi = selectStagesBlock(
      `\`\`\`yaml\n${stageBody(shop)}\n\`\`\`\n\n\`\`\`yaml\n${stageBody(web)}\n\`\`\`\n`
    );
    expect('ok' in multi && multi.ok === false).toBe(true);
  });

  it('persists other-stage commands as OTHER_STAGE members and does not execute them', () => {
    const cwd = tempDir('ser-other-stage-');
    const artifacts = join(cwd, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    writeExec(join(cwd, 'api.sh'), '#!/bin/sh\necho "Tests: 1/1"\n');
    writeExec(join(cwd, 'web.sh'), `#!/bin/sh\ntouch '${join(cwd, 'sentinel')}'\n`);
    const shop = oneStage('api', 'thinmansoftware/shopops', 'bash ./api.sh');
    const web = oneStage('web', 'thinmansoftware/lspro', 'bash ./web.sh');
    const specPath = join(cwd, 'spec.md');
    writeFileSync(
      specPath,
      `<!-- canonical-stages -->\n\`\`\`yaml\n${stageBody(`${shop}\n${web}`)}\n\`\`\`\n`
    );
    const env = {
      ...process.env,
      HARNESS_ROOT_OVERRIDE: ROOT,
      ARTIFACTS_DIR: artifacts,
      SER_STAGE_ID: 'api',
      SER_REPO: 'https://github.com/thinmansoftware/shopops.git',
    };
    const scoped = spawnSync('bun', [RUNNER, 'scope-evidence', '--spec', specPath], {
      cwd,
      env,
      encoding: 'utf8',
    });
    expect(scoped.status).toBe(0);
    expect(scoped.stdout).toContain('OTHER_STAGE=bash ./web.sh');
    expect(scoped.stdout).toContain('COMMAND=bash ./api.sh');
    const attempts = join(artifacts, 'evidence', 'attempts');
    const inventoryId = readFileSync(join(attempts, 'inventory-other-stage'), 'utf8').trim();
    const inventory = JSON.parse(readFileSync(join(attempts, `${inventoryId}.json`), 'utf8')) as {
      members: { rawCommand: string; status: string; scope: string; exitCode: number | null }[];
    };
    expect(inventory.members).toEqual([
      expect.objectContaining({
        rawCommand: 'bash ./web.sh',
        status: 'OTHER_STAGE',
        scope: 'other_stage',
        exitCode: null,
      }),
    ]);
    writeFileSync(join(cwd, 'cmds'), 'bash ./api.sh\n');
    const ran = spawnSync(
      'bun',
      [RUNNER, 'run-tests', '--commands', join(cwd, 'cmds'), '--log', join(artifacts, 'stop.log')],
      { cwd, env, encoding: 'utf8' }
    );
    expect(ran.status).toBe(0);
    expect(existsSync(join(cwd, 'sentinel'))).toBe(false);
    const testId = readFileSync(join(attempts, 'current-tests'), 'utf8').trim();
    const recorded = JSON.parse(readFileSync(join(attempts, `${testId}.json`), 'utf8')) as {
      aggregate: string;
      members: { rawCommand: string; status: string; scope: string }[];
    };
    expect(recorded.aggregate).toBe('PASSED');
    expect(recorded.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rawCommand: 'bash ./api.sh',
          status: 'PASSED',
          scope: 'selected',
        }),
        expect.objectContaining({
          rawCommand: 'bash ./web.sh',
          status: 'OTHER_STAGE',
          scope: 'other_stage',
        }),
      ])
    );
    const refused = spawnSync('bun', [RUNNER, 'scope-evidence', '--spec', specPath], {
      cwd,
      env: { ...env, SER_REPO: 'thinmansoftware/lspro' },
      encoding: 'utf8',
    });
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain('repo');
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe('python-node-execution', () => {
  it('resolves python to python3, runs real node --test, and refuses escapes', () => {
    const cwd = tempDir('ser-rt-');
    initRepo(cwd);
    const bin = join(cwd, 'bin');
    mkdirSync(bin);
    const record = join(cwd, 'py-argv.txt');
    writeExec(
      join(bin, 'python3'),
      `#!/bin/sh\nprintf '%s\\n' "$0" "$@" > '${record}'\necho 'Tests: 1/1'\n`
    );
    writeExec(join(bin, 'python'), `#!/bin/sh\ntouch '${join(cwd, 'python-ran')}'\n`);
    writeFileSync(join(cwd, 't.py'), 'print(1)\n');
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    try {
      const summary = runTestCommands(['python t.py'], cwd, join(cwd, 'py.log'));
      expect(summary.attempt.members[0]?.status).toBe('PASSED');
      expect(summary.attempt.members[0]?.declaredExecutable).toBe('python');
      expect(summary.attempt.members[0]?.resolvedExecutable).toBe('python3');
      expect(existsSync(join(cwd, 'python-ran'))).toBe(false);
      process.env.PATH = '/bin:/usr/bin';
      const missing = runTestCommands(['python t.py'], cwd, join(cwd, 'missing.log'));
      const python3 = spawnSync('python3', ['-c', 'print(1)'], { env: { PATH: '/bin:/usr/bin' } });
      if (python3.status !== 0) {
        expect(missing.attempt.members[0]?.status).toBe('NEVER_RAN');
        expect(missing.attempt.members[0]?.reason).toBe('python3-unavailable');
      }
    } finally {
      process.env.PATH = saved;
    }
    writeFileSync(
      join(cwd, 'ok.test.js'),
      "const test = require('node:test');\nconst fs = require('fs');\ntest('ok', () => fs.writeFileSync('node-ran.txt', 'yes'));\n"
    );
    const nodeRun = runTestCommands(
      ['node --test --test-reporter=spec ok.test.js'],
      cwd,
      join(cwd, 'node.log')
    );
    expect(existsSync(join(cwd, 'node-ran.txt'))).toBe(true);
    expect(nodeRun.attempt.members[0]?.resolvedExecutable).toBe('node');
    const outside = tempDir('ser-out-');
    writeFileSync(join(outside, 'secret.test.js'), 'process.exit(0)\n');
    symlinkSync(join(outside, 'secret.test.js'), join(cwd, 'escape.test.js'));
    const escaped = runTestCommands(['node --test escape.test.js'], cwd, join(cwd, 'escape.log'));
    expect(escaped.attempt.members[0]?.status).toBe('NEVER_RAN');
    expect(allowTestCommand('node --test')).toBe(false);
    expect(allowTestCommand('node --test --eval ok.test.js')).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('header-cd-display-counts', () => {
  it('inventories pairs, collapses one cd, and keeps later independent lines', () => {
    const spec = [
      'Stop 1 (grep assertion, tests mentioned):',
      '  grep -c x y',
      '  Expected: 0',
      'Stop 2 (unit tests):',
      '  bash ./one.sh',
      '  Expected: 1',
      '  bash ./two.sh',
      '  Expected: 1',
      'Stop 3 (community notes):',
      '  bash ./nope.sh',
      '  Expected: 1',
      'Stop 4 (tests):',
      '  Expected: 1',
    ].join('\n');
    expect(extractTestCommands(spec)).toEqual([
      'bash ./one.sh',
      'bash ./two.sh',
      'MALFORMED:expected-without-command',
    ]);
    const same = normalizeTestCommand(
      'cd pkg && bun test a.test.ts && cd pkg && bun test b.test.ts'
    );
    expect(same.ok).toBe(true);
    if (same.ok) {
      expect(same.cd).toBe('pkg');
      expect(same.segments).toHaveLength(2);
    }
    expect(
      normalizeTestCommand('cd a && bun test a.test.ts && cd b && bun test b.test.ts').ok
    ).toBe(false);
    expect(displayCommands(['cd pkg && bun test a.test.ts', 'cd pkg && bun test b.test.ts'])).toBe(
      'cd pkg && bun test a.test.ts; bun test b.test.ts'
    );
    const cwd = tempDir('ser-cd-');
    mkdirSync(join(cwd, 'pkg'));
    writeExec(join(cwd, 'pkg/a.sh'), '#!/bin/sh\necho "Tests: 1/1"\nexit 1\n');
    writeExec(join(cwd, 'pkg/b.sh'), '#!/bin/sh\necho "Tests: 1/1"\nexit 0\n');
    const summary = runTestCommands(
      ['cd missing && bash ./a.sh', 'cd pkg && bash ./a.sh', 'bash ./pkg/b.sh'],
      cwd,
      join(cwd, 'cd.log')
    );
    expect(summary.failStep).toBe('test_failed');
    expect(summary.exitCode).toBe(1);
    const log = readFileSync(join(cwd, 'cd.log'), 'utf8');
    expect(log).toContain('cd missing && bash ./a.sh');
    expect(log).toContain('SER_FAIL_STEP=test_failed');
    expect(log).toContain('bash ./pkg/b.sh');
    const onlyCd = runTestCommands(['cd missing && bash ./a.sh'], cwd, join(cwd, 'only-cd.log'));
    expect(onlyCd.failStep).toBe('cd_failed');
    expect(onlyCd.failDir).toBe('missing');
    const names = Array.from({ length: 34 }, (_, index) => `f${index}.test.js`);
    for (const name of names) writeFileSync(join(cwd, name), 'process.exit(0)\n');
    const recorder = join(cwd, 'node-record.txt');
    const bin = join(cwd, 'nodebin');
    mkdirSync(bin);
    writeExec(join(bin, 'node'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${recorder}'\n`);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved ?? ''}`;
    try {
      runTestCommands([`node --test ${names.join(' ')}`], cwd, join(cwd, 'files.log'));
    } finally {
      process.env.PATH = saved;
    }
    const args = readFileSync(recorder, 'utf8').trim().split('\n');
    expect(args.filter(arg => arg.endsWith('.test.js'))).toHaveLength(34);
    expect(args.filter(arg => arg === '--test')).toHaveLength(1);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe('hermetic-fresh-attempt', () => {
  it('scrubs child env, refuses stale bytes, and accepts the same tree on a descendant HEAD', () => {
    const cwd = tempDir('ser-attempt-');
    initRepo(cwd);
    writeFileSync(join(cwd, 'src.js'), 'v1\n');
    writeExec(
      join(cwd, 'probe.sh'),
      "#!/bin/sh\nprintf 'BOT=%s\\n' \"${TELEGRAM_BOT_TOKEN-unset}\"\necho 'Tests: 1/1'\n"
    );
    const saved = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = 'production-shaped-test-value';
    const artifacts = join(cwd, 'artifacts');
    mkdirSync(artifacts);
    const savedArtifacts = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = artifacts;
    try {
      const parentBefore = process.env.TELEGRAM_BOT_TOKEN;
      const summary = runTestCommands(['bash ./probe.sh'], cwd, join(artifacts, 'stop-tests.log'));
      expect(process.env.TELEGRAM_BOT_TOKEN).toBe(parentBefore);
      expect(readFileSync(join(artifacts, 'stop-tests.log'), 'utf8')).toContain('BOT=unset');
      expect(readFileSync(join(artifacts, 'stop-tests.log'), 'utf8')).not.toContain(
        'production-shaped-test-value'
      );
      expect(
        scrubEnv({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_TEST_FIXTURE: 'ok', PATH: '/bin' })
          .TELEGRAM_BOT_TOKEN
      ).toBeUndefined();
      const fresh = checkAttemptRecord(summary.attempt, cwd, authority(cwd));
      expect(fresh.ok).toBe(true);
      writeFileSync(join(cwd, 'src.js'), 'v2\n');
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(false);
      writeFileSync(join(cwd, 'src.js'), 'v1\n');
      git(cwd, ['add', 'src.js']);
      git(cwd, ['commit', '-qm', 'same bytes']);
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
      writeFileSync(join(cwd, 'extra.js'), 'new\n');
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = saved;
      if (savedArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = savedArtifacts;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('hashes real porcelain paths and refuses stale or unreadable bytes', () => {
    const cwd = tempDir('ser-bytes-');
    initRepo(cwd);
    const accent = String.fromCharCode(0xe9);
    const nonAscii = `caf${accent}.js`;
    const quoted = 'a"b.js';
    const arrow = 'old -> new.js';
    writeFileSync(join(cwd, 'src.js'), 'v1\n');
    writeFileSync(join(cwd, quoted), 'v1\n');
    writeFileSync(join(cwd, arrow), 'v1\n');
    writeFileSync(join(cwd, nonAscii), 'v1\n');
    writeFileSync(join(cwd, 'gone.js'), 'v1\n');
    git(cwd, ['add', '--', 'src.js', quoted, arrow, nonAscii, 'gone.js']);
    git(cwd, ['commit', '-qm', 'sources']);
    writeExec(join(cwd, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\n');
    const artifacts = join(cwd, 'artifacts');
    mkdirSync(artifacts);
    const savedArtifacts = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = artifacts;
    const cliEnv = {
      ...process.env,
      HARNESS_ROOT_OVERRIDE: ROOT,
      ARTIFACTS_DIR: artifacts,
      NODE_ENV: 'test',
      SER_TEST_TRUSTED_ROOT: ROOT,
    };
    const refuse = (attempt: EvidenceAttempt, reason: string): void => {
      const verdict = checkAttemptRecord(attempt, cwd, authority(cwd));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe(reason);
      const cli = spawnSync('bun', [RUNNER, 'check-attempt'], {
        cwd,
        env: cliEnv,
        encoding: 'utf8',
      });
      expect(cli.status).not.toBe(0);
      expect(cli.stderr).toContain(reason);
    };
    try {
      const summary = runTestCommands(['bash ./ok.sh'], cwd, join(artifacts, 'stop-tests.log'));
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
      const freshCli = spawnSync('bun', [RUNNER, 'check-attempt'], {
        cwd,
        env: cliEnv,
        encoding: 'utf8',
      });
      expect(freshCli.status).toBe(0);
      const mutate = (name: string): void => {
        writeFileSync(join(cwd, name), 'v2\n');
        refuse(summary.attempt, 'dirty-bytes');
        writeFileSync(join(cwd, name), 'v1\n');
        expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
      };
      mutate('src.js');
      mutate(quoted);
      mutate(arrow);
      mutate(nonAscii);
      writeFileSync(join(cwd, 'leaf.js'), 'untracked\n');
      refuse(summary.attempt, 'dirty-bytes');
      rmSync(join(cwd, 'leaf.js'));
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
      const attempts = join(artifacts, 'evidence', 'attempts');
      writeFileSync(join(attempts, 'extra.txt'), 'generated\n');
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
      git(cwd, ['mv', 'src.js', 'src-renamed.js']);
      const renamed = testedTreeIdentity(cwd);
      expect(renamed.method).toBe('sha256-worktree-bytes-v1');
      const renamedBody = readFileSync(join(cwd, 'src-renamed.js'));
      expect(renamed.paths.find(item => item.path === 'src-renamed.js')?.sha256).toBe(
        createHash('sha256').update(renamedBody).digest('hex')
      );
      expect(renamed.paths.some(item => item.path === 'src.js')).toBe(false);
      git(cwd, ['reset', '--hard', 'HEAD']);
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
      rmSync(join(cwd, 'gone.js'));
      const deleted = testedTreeIdentity(cwd);
      expect(deleted.method).toBe('sha256-worktree-bytes-v1');
      expect(deleted.paths.find(item => item.path === 'gone.js')?.sha256).toBe('missing');
      refuse(summary.attempt, 'dirty-bytes');
      git(cwd, ['checkout', '--', 'gone.js']);
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
      git(cwd, ['add', 'ok.sh']);
      git(cwd, ['commit', '-qm', 'identical tested bytes']);
      expect(summary.attempt.tree.headSha).not.toBe(testedTreeIdentity(cwd).headSha);
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
      const sameCli = spawnSync('bun', [RUNNER, 'check-attempt'], {
        cwd,
        env: cliEnv,
        encoding: 'utf8',
      });
      expect(sameCli.status).toBe(0);
      symlinkSync('missing-target', join(cwd, 'broken-link'));
      expect(testedTreeIdentity(cwd).method).toBe('hash-failed');
      refuse(summary.attempt, 'hash-failed');
      rmSync(join(cwd, 'broken-link'));
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
    } finally {
      if (savedArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = savedArtifacts;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('leaves a killed runner plan incomplete', () => {
    const cwd = tempDir('ser-kill-');
    const artifacts = join(cwd, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    writeExec(join(cwd, 'sleep.sh'), '#!/bin/sh\nsleep 30\n');
    writeFileSync(join(cwd, 'cmds'), 'bash ./sleep.sh\n');
    const attemptId = 'ser-kill-attempt';
    const child = spawn(
      'bun',
      [
        RUNNER,
        'run-tests',
        '--commands',
        join(cwd, 'cmds'),
        '--log',
        join(artifacts, 'stop-tests.log'),
      ],
      {
        cwd,
        env: {
          ...process.env,
          HARNESS_ROOT_OVERRIDE: ROOT,
          ARTIFACTS_DIR: artifacts,
          SER_ATTEMPT_ID: attemptId,
        },
        detached: true,
        stdio: 'ignore',
      }
    );
    const file = join(artifacts, 'evidence', 'attempts', `${attemptId}.json`);
    const started = Date.now();
    while (!existsSync(file) && Date.now() - started < 10000) {
      spawnSync('sleep', ['0.05']);
    }
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
    expect(existsSync(file)).toBe(true);
    const body = JSON.parse(readFileSync(file, 'utf8')) as {
      members: { status: string }[];
      aggregate: string;
    };
    expect(body.members[0]?.status).toBe('INCOMPLETE');
    expect(body.aggregate).toBe('INCOMPLETE');
    rmSync(cwd, { recursive: true, force: true });
  });

  it('validates explicit test and grep attempt ids after greps replace current', () => {
    const cwd = tempDir('ser-bind-');
    initRepo(cwd);
    writeFileSync(join(cwd, 'src.js'), 'v1\n');
    writeExec(join(cwd, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\n');
    const artifacts = join(cwd, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    const savedArtifacts = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = artifacts;
    const env = {
      ...process.env,
      HARNESS_ROOT_OVERRIDE: ROOT,
      ARTIFACTS_DIR: artifacts,
    };
    try {
      const summary = runTestCommands(['bash ./ok.sh'], cwd, join(artifacts, 'stop-tests.log'));
      const before = spawnSync('bun', [RUNNER, 'run-greps'], {
        cwd,
        env,
        encoding: 'utf8',
        input: 'grep -c base README\teq\t1\nDECLARED\t1\n',
      });
      expect(before.status).toBe(0);
      const attempts = join(artifacts, 'evidence', 'attempts');
      const grepId = readFileSync(join(attempts, 'current-greps'), 'utf8').trim();
      const current = readFileSync(join(attempts, 'current'), 'utf8').trim();
      expect(current).toBe(grepId);
      expect(grepId).not.toBe(summary.attempt.attemptId);
      expect(readFileSync(join(attempts, 'current-tests'), 'utf8').trim()).toBe(
        summary.attempt.attemptId
      );
      const fresh = spawnSync(
        'bun',
        [RUNNER, 'check-attempt', '--tests', summary.attempt.attemptId, '--greps', grepId],
        { cwd, env, encoding: 'utf8' }
      );
      expect(fresh.status).toBe(0);
      expect(fresh.stdout).toContain('OK');
      writeFileSync(join(cwd, 'src.js'), 'v2\n');
      const stale = spawnSync('bun', [RUNNER, 'check-attempt'], { cwd, env, encoding: 'utf8' });
      expect(stale.status).not.toBe(0);
      expect(stale.stderr).toContain('REFUSED tests:');
      const grepOnly = spawnSync('bun', [RUNNER, 'check-attempt', '--greps', grepId], {
        cwd,
        env: { ...env, SER_TEST_ATTEMPT_ID: '' },
        encoding: 'utf8',
      });
      expect(grepOnly.status).not.toBe(0);
      expect(grepOnly.stderr).toContain('REFUSED tests:');
    } finally {
      if (savedArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = savedArtifacts;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('refuses stale tests, cross-run ids, wrong kinds, and incomplete members', () => {
    const cwd = tempDir('ser-bind-gate-');
    initRepo(cwd);
    writeFileSync(join(cwd, 'src.js'), 'v1\n');
    writeExec(join(cwd, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\n');
    const artifacts = join(cwd, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    const savedArtifacts = process.env.ARTIFACTS_DIR;
    const savedRun = process.env.SER_RUN_ID;
    const savedRepo = process.env.SER_REPO;
    process.env.ARTIFACTS_DIR = artifacts;
    process.env.SER_RUN_ID = 'run-a';
    process.env.SER_REPO = 'thinmansoftware/bdc-harness';
    const env = {
      ...process.env,
      HARNESS_ROOT_OVERRIDE: ROOT,
      ARTIFACTS_DIR: artifacts,
      SER_RUN_ID: 'run-a',
      SER_REPO: 'thinmansoftware/bdc-harness',
    };
    try {
      const summary = runTestCommands(['bash ./ok.sh'], cwd, join(artifacts, 'stop-tests.log'));
      const greps = spawnSync('bun', [RUNNER, 'run-greps'], {
        cwd,
        env,
        encoding: 'utf8',
        input: 'grep -c base README\teq\t1\nDECLARED\t1\n',
      });
      expect(greps.status).toBe(0);
      const attempts = join(artifacts, 'evidence', 'attempts');
      const grepId = readFileSync(join(attempts, 'current-greps'), 'utf8').trim();
      const live = authority(cwd);
      live.repo = 'thinmansoftware/bdc-harness';
      expect(
        checkBoundAttempts(
          cwd,
          { ...live, repo: '' },
          {
            testAttemptId: summary.attempt.attemptId,
            grepAttemptId: grepId,
          }
        ).ok
      ).toBe(true);
      const wrongRepo = checkBoundAttempts(
        cwd,
        { ...live, repo: 'thinmansoftware/other' },
        {
          testAttemptId: summary.attempt.attemptId,
          grepAttemptId: grepId,
        }
      );
      expect(wrongRepo.ok).toBe(false);
      if (!wrongRepo.ok) expect(wrongRepo.reason).toContain('authority-repo');

      git(cwd, ['add', 'src.js', 'ok.sh']);
      git(cwd, ['commit', '-qm', 'identical tested bytes']);
      expect(
        checkBoundAttempts(cwd, live, {
          testAttemptId: summary.attempt.attemptId,
          grepAttemptId: grepId,
        }).ok
      ).toBe(true);

      process.env.SER_RUN_ID = 'run-b';
      const crossRun = checkBoundAttempts(cwd, live, {
        testAttemptId: summary.attempt.attemptId,
        grepAttemptId: grepId,
      });
      expect(crossRun.ok).toBe(false);
      if (!crossRun.ok) expect(crossRun.reason).toContain('run-id');
      process.env.SER_RUN_ID = 'run-a';

      const wrongKind = checkBoundAttempts(cwd, live, {
        testAttemptId: grepId,
        grepAttemptId: summary.attempt.attemptId,
      });
      expect(wrongKind.ok).toBe(false);
      if (!wrongKind.ok) expect(wrongKind.reason).toContain('attempt-kind');

      const incomplete = structuredClone(summary.attempt);
      const selected = incomplete.members.find(member => member.scope === 'selected');
      if (!selected) throw new Error('missing selected member');
      selected.status = 'INCOMPLETE';
      selected.reason = 'planned';
      incomplete.aggregate = 'INCOMPLETE';
      writeFileSync(
        join(attempts, `${summary.attempt.attemptId}.json`),
        `${JSON.stringify(incomplete, null, 2)}\n`
      );
      const incompleteVerdict = checkBoundAttempts(cwd, live, {
        testAttemptId: summary.attempt.attemptId,
        grepAttemptId: null,
      });
      expect(incompleteVerdict.ok).toBe(false);
      if (!incompleteVerdict.ok) expect(incompleteVerdict.reason.startsWith('tests:')).toBe(true);

      writeFileSync(
        join(attempts, `${summary.attempt.attemptId}.json`),
        `${JSON.stringify(summary.attempt, null, 2)}\n`
      );
      writeFileSync(join(cwd, 'src.js'), 'v2\n');
      const laterGrep = spawnSync('bun', [RUNNER, 'run-greps'], {
        cwd,
        env: { ...env, SER_RUN_ID: 'run-a' },
        encoding: 'utf8',
        input: 'grep -c base README\teq\t1\nDECLARED\t1\n',
      });
      expect(laterGrep.status).toBe(0);
      const freshGrepId = readFileSync(join(attempts, 'current-greps'), 'utf8').trim();
      const stale = checkBoundAttempts(cwd, live, {
        testAttemptId: summary.attempt.attemptId,
        grepAttemptId: freshGrepId,
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.reason.startsWith('tests:')).toBe(true);

      const matched = structuredClone(summary.attempt);
      const required: EvidenceAuthority = {
        repo: 'ThinManSoftware/BDC-Harness',
        stageId: 'api',
        targetBranch: 'dev',
        worktree: cwd,
        baseSha: 'deadbeef',
      };
      matched.authority = {
        repo: 'thinmansoftware/bdc-harness',
        stageId: 'api',
        targetBranch: 'dev',
        worktree: cwd,
        baseSha: 'deadbeef',
      };
      writeFileSync(join(cwd, 'src.js'), 'v1\n');
      expect(checkAttemptRecord(matched, cwd, required).ok).toBe(true);
      const blanks: {
        field: 'repo' | 'stageId' | 'targetBranch' | 'baseSha' | 'worktree';
        value: string | null;
        reason: string;
      }[] = [
        { field: 'repo', value: '', reason: 'authority-repo' },
        { field: 'stageId', value: null, reason: 'authority-stage' },
        { field: 'targetBranch', value: null, reason: 'authority-branch' },
        { field: 'baseSha', value: '', reason: 'authority-base' },
        { field: 'worktree', value: '', reason: 'authority-worktree' },
      ];
      for (const blank of blanks) {
        const replay = structuredClone(matched);
        if (blank.field === 'stageId' || blank.field === 'targetBranch') {
          replay.authority[blank.field] = blank.value;
        } else {
          replay.authority[blank.field] = blank.value ?? '';
        }
        const verdict = checkAttemptRecord(replay, cwd, required);
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason).toBe(blank.reason);
      }
    } finally {
      if (savedArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = savedArtifacts;
      if (savedRun === undefined) delete process.env.SER_RUN_ID;
      else process.env.SER_RUN_ID = savedRun;
      if (savedRepo === undefined) delete process.env.SER_REPO;
      else process.env.SER_REPO = savedRepo;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('persists every executed grep pipeline segment in the attempt chain', () => {
    const cwd = tempDir('ser-grep-chain-');
    initRepo(cwd);
    const artifacts = join(cwd, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    const ran = spawnSync('bun', [RUNNER, 'run-greps'], {
      cwd,
      env: {
        ...process.env,
        HARNESS_ROOT_OVERRIDE: ROOT,
        ARTIFACTS_DIR: artifacts,
      },
      encoding: 'utf8',
      input: 'grep -c base README | wc -l\teq\t1\nDECLARED\t1\n',
    });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('GREP_STATUS=passed');
    const attempts = join(artifacts, 'evidence', 'attempts');
    const grepId = readFileSync(join(attempts, 'current-greps'), 'utf8').trim();
    const body = JSON.parse(readFileSync(join(attempts, `${grepId}.json`), 'utf8')) as {
      members: {
        argv: string[];
        declaredExecutable: string;
        resolvedExecutable: string;
        chain: {
          argv: string[];
          resolvedArgv: string[];
          exitCode: number | null;
          signal: string | null;
        }[];
      }[];
    };
    const member = body.members[0];
    expect(member?.argv).toEqual(['grep', '-c', 'base', 'README']);
    expect(member?.declaredExecutable).toBe('grep');
    expect(member?.resolvedExecutable).toBe('wc');
    expect(member?.chain).toEqual([
      {
        argv: ['grep', '-c', 'base', 'README'],
        resolvedArgv: ['grep', '-c', 'base', 'README'],
        exitCode: 0,
        signal: null,
        passed: null,
        total: null,
        status: 'PASSED',
        reason: 'passed',
      },
      {
        argv: ['wc', '-l'],
        resolvedArgv: ['wc', '-l'],
        exitCode: 0,
        signal: null,
        passed: null,
        total: null,
        status: 'PASSED',
        reason: 'passed',
      },
    ]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns hash-failed when git status fails or exceeds the capture limit', () => {
    const cwd = tempDir('ser-status-');
    initRepo(cwd);
    writeExec(join(cwd, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\n');
    const artifacts = join(cwd, 'artifacts');
    const bin = join(cwd, 'bin');
    mkdirSync(artifacts);
    mkdirSync(bin);
    const located = spawnSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' });
    if (located.status !== 0 || located.stdout.trim().length === 0) {
      throw new Error('git not found');
    }
    const realGit = located.stdout.trim();
    const savedPath = process.env.PATH ?? '';
    const savedArtifacts = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = artifacts;
    const writeShim = (mode: 'fail' | 'huge'): void => {
      const body =
        mode === 'fail'
          ? 'echo forced-status-failure >&2\nexit 7'
          : 'head -c 17825792 /dev/zero\nexit 0';
      writeExec(
        join(bin, 'git'),
        [
          '#!/bin/sh',
          `real='${realGit}'`,
          'for arg in "$@"; do',
          '  if [ "$arg" = "status" ]; then',
          body,
          '  fi',
          'done',
          'exec "$real" "$@"',
          '',
        ].join('\n')
      );
    };
    const refuse = (attempt: EvidenceAttempt, reason: string): void => {
      const verdict = checkAttemptRecord(attempt, cwd, authority(cwd));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe(reason);
    };
    try {
      const summary = runTestCommands(['bash ./ok.sh'], cwd, join(artifacts, 'stop-tests.log'));
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
      writeShim('fail');
      process.env.PATH = `${bin}:${savedPath}`;
      expect(testedTreeIdentity(cwd).method).toBe('hash-failed');
      refuse(summary.attempt, 'hash-failed');
      writeShim('huge');
      expect(testedTreeIdentity(cwd).method).toBe('hash-failed');
      refuse(summary.attempt, 'hash-failed');
      rmSync(bin, { recursive: true, force: true });
      process.env.PATH = savedPath;
      expect(testedTreeIdentity(cwd).method).toBe('sha256-worktree-bytes-v1');
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
    } finally {
      process.env.PATH = savedPath;
      if (savedArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = savedArtifacts;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('admits passing grep evidence with unparsed prose and refuses other incomplete greps', () => {
    const cwd = tempDir('ser-fp4-');
    initRepo(cwd);
    writeExec(join(cwd, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\n');
    const artifacts = join(cwd, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    const attempts = join(artifacts, 'evidence', 'attempts');
    const savedArtifacts = process.env.ARTIFACTS_DIR;
    const savedRun = process.env.SER_RUN_ID;
    process.env.ARTIFACTS_DIR = artifacts;
    process.env.SER_RUN_ID = 'run-fp4';
    const env = {
      ...process.env,
      HARNESS_ROOT_OVERRIDE: ROOT,
      ARTIFACTS_DIR: artifacts,
      NODE_ENV: 'test',
      SER_TEST_TRUSTED_ROOT: ROOT,
      SER_RUN_ID: 'run-fp4',
    };
    const runGreps = (input: string): ReturnType<typeof spawnSync> =>
      spawnSync('bun', [RUNNER, 'run-greps'], { cwd, env, encoding: 'utf8', input });
    const readGrep = (): EvidenceAttempt => {
      const id = readFileSync(join(attempts, 'current-greps'), 'utf8').trim();
      return JSON.parse(readFileSync(join(attempts, `${id}.json`), 'utf8')) as EvidenceAttempt;
    };
    const checkCli = (): ReturnType<typeof spawnSync> =>
      spawnSync('bun', [RUNNER, 'check-attempt'], { cwd, env, encoding: 'utf8' });
    try {
      const summary = runTestCommands(['bash ./ok.sh'], cwd, join(artifacts, 'stop-tests.log'));
      expect(summary.attempt.aggregate).toBe('PASSED');
      expect(summary.attempt.runId).toBe('run-fp4');
      const admitted = runGreps('grep -c base README\teq\t1\nUNPARSED\t1\tprose\nDECLARED\t2\n');
      expect(admitted.status).toBe(0);
      expect(admitted.stdout).toContain('GREP_STATUS=incomplete');
      expect(admitted.stdout).toContain('UNVERIFIED (unparsed)');
      const grepAttempt = readGrep();
      expect(grepAttempt.aggregate).toBe('INCOMPLETE');
      expect(grepAttempt.grepExecuted).toBe(1);
      expect(grepAttempt.grepDropped).toBe(0);
      expect(grepAttempt.grepUnparsed).toBe(1);
      expect(grepAttempt.grepMismatch).toBe(0);
      expect(checkAttemptRecord(grepAttempt, cwd, authority(cwd)).ok).toBe(true);
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
      const admittedCli = checkCli();
      expect(admittedCli.status).toBe(0);
      expect(admittedCli.stdout).toContain('OK');

      const dropped = runGreps('grep -c base README\teq\t1\necho unsafe\teq\t0\nDECLARED\t2\n');
      expect(dropped.status).toBe(0);
      expect(dropped.stdout).toContain('GREP_DROPPED=1');
      expect(checkAttemptRecord(readGrep(), cwd, authority(cwd)).ok).toBe(false);
      expect(checkCli().status).not.toBe(0);

      const mismatch = runGreps('grep -c base README\teq\t9\nDECLARED\t1\n');
      expect(mismatch.status).toBe(0);
      expect(mismatch.stdout).toContain('GREP_MISMATCH=1');
      expect(checkAttemptRecord(readGrep(), cwd, authority(cwd)).ok).toBe(false);
      expect(checkCli().status).not.toBe(0);

      const proseOnly = runGreps('UNPARSED\t1\tprose\nDECLARED\t1\n');
      expect(proseOnly.status).toBe(0);
      expect(proseOnly.stdout).toContain('GREP_EXECUTED=0');
      expect(proseOnly.stdout).toContain('GREP_UNPARSED=1');
      expect(checkAttemptRecord(readGrep(), cwd, authority(cwd)).ok).toBe(false);
      expect(checkCli().status).not.toBe(0);

      const restored = runGreps('grep -c base README\teq\t1\nUNPARSED\t1\tprose\nDECLARED\t2\n');
      expect(restored.status).toBe(0);
      const stripped = readGrep();
      expect(stripped.grepExecuted).toBe(1);
      delete stripped.grepExecuted;
      delete stripped.grepDropped;
      delete stripped.grepUnparsed;
      delete stripped.grepMismatch;
      const strippedId = readFileSync(join(attempts, 'current-greps'), 'utf8').trim();
      writeFileSync(join(attempts, `${strippedId}.json`), `${JSON.stringify(stripped, null, 2)}\n`);
      const missingCounters = checkAttemptRecord(stripped, cwd, authority(cwd));
      expect(missingCounters.ok).toBe(false);
      if (!missingCounters.ok) expect(missingCounters.reason).toBe('aggregate-INCOMPLETE');
      expect(checkCli().status).not.toBe(0);
    } finally {
      if (savedArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = savedArtifacts;
      if (savedRun === undefined) delete process.env.SER_RUN_ID;
      else process.env.SER_RUN_ID = savedRun;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('parity-stage-and-bundle', () => {
  it('exposes NEVER_RAN and INCOMPLETE on the shared status enum', () => {
    const source = readFileSync(RUNNER, 'utf8');
    expect(source.includes('NEVER_RAN')).toBe(true);
    expect(source.includes('INCOMPLETE')).toBe(true);
    const lanes = [
      'bdc-feature-development.yaml',
      'bdc-feature-development-codex.yaml',
      'bdc-feature-development-cursor.yaml',
    ];
    for (const lane of lanes) {
      const text = readFileSync(join(ROOT, '.archon/workflows/defaults', lane), 'utf8');
      expect(text.includes('structured-evidence-runner.ts')).toBe(true);
      expect(text.includes('bash -c "$cmd"')).toBe(false);
    }
  });
});

describe('installed-helper-resolution', () => {
  it('uses the trusted harness module and refuses a product-local helper', () => {
    const product = tempDir('ser-product-');
    initRepo(product);
    git(product, ['remote', 'add', 'origin', 'https://github.com/example/product.git']);
    const fake = join(product, 'packages/workflows/src/reliability');
    mkdirSync(fake, { recursive: true });
    writeFileSync(
      join(fake, 'structured-evidence-runner.ts'),
      'process.stderr.write("product-helper\\n"); process.exit(0)\n'
    );
    writeFileSync(
      join(product, 'packages/workflows/package.json'),
      '{"name":"@archon/workflows"}\n'
    );
    const saved = process.env.HARNESS_ROOT_OVERRIDE;
    const savedTestRoot = process.env.SER_TEST_TRUSTED_ROOT;
    process.env.HARNESS_ROOT_OVERRIDE = product;
    delete process.env.SER_TEST_TRUSTED_ROOT;
    try {
      expect(resolveTrustedRunnerFile(product)).toBeNull();
      const missing = spawnSync('bun', [RUNNER, 'allow-test', '--', 'bash ./x.sh'], {
        cwd: product,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          SER_TEST_TRUSTED_ROOT: '',
          HARNESS_ROOT_OVERRIDE: product,
        },
        encoding: 'utf8',
      });
      expect(missing.stderr).toContain('NEVER_RAN');
      expect(missing.stdout).not.toContain('product-helper');
    } finally {
      process.env.HARNESS_ROOT_OVERRIDE = saved;
      process.env.SER_TEST_TRUSTED_ROOT = savedTestRoot;
    }
    process.env.HARNESS_ROOT_OVERRIDE = ROOT;
    const trusted = resolveTrustedRunnerFile(product);
    expect(trusted).toBe(RUNNER);
    rmSync(product, { recursive: true, force: true });
  });
});
