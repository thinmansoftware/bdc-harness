import { describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  admitPartialGrep,
  parseStagesYaml,
  requiredEvidenceKinds,
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
    initRepo(cwd);
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

  it('does not publish a passed summary for a chained zero-count or unparsed segment', () => {
    const cwd = tempDir('ser-chain-summary-');
    writeExec(join(cwd, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\nexit 0\n');
    writeExec(join(cwd, 'zero.sh'), '#!/bin/sh\necho "Tests: 0/0"\nexit 0\n');
    writeExec(join(cwd, 'nocount.sh'), '#!/bin/sh\necho "no counts here"\nexit 0\n');
    const countsPass = (summary: {
      exitCode: number;
      passed: number | null;
      total: number | null;
    }): boolean =>
      summary.exitCode === 0 &&
      summary.passed !== null &&
      summary.total !== null &&
      summary.passed === summary.total &&
      summary.total > 0;
    try {
      const zero = runTestCommands(['bash ./ok.sh && bash ./zero.sh'], cwd, join(cwd, 'zero.log'));
      expect(zero.line).not.toBe('0 1 1');
      expect(zero.line).toBe('0 0 0');
      expect(zero.passed).toBe(0);
      expect(zero.total).toBe(0);
      expect(zero.attempt.aggregate).not.toBe('PASSED');
      expect(zero.attempt.members.map(member => member.status)).toEqual(['PASSED', 'FAILED']);
      expect(zero.attempt.members[1]?.reason).toBe('zero-count');
      expect(countsPass(zero)).toBe(false);

      const unparsed = runTestCommands(
        ['bash ./ok.sh && bash ./nocount.sh'],
        cwd,
        join(cwd, 'nocount.log')
      );
      expect(unparsed.line).not.toBe('0 1 1');
      expect(unparsed.line).toBe('0  ');
      expect(unparsed.passed).toBeNull();
      expect(unparsed.total).toBeNull();
      expect(unparsed.attempt.aggregate).not.toBe('PASSED');
      expect(unparsed.attempt.members.map(member => member.status)).toEqual([
        'PASSED',
        'COUNTS_UNPARSED',
      ]);
      expect(countsPass(unparsed)).toBe(false);

      const control = runTestCommands(
        ['bash ./ok.sh && bash ./ok.sh'],
        cwd,
        join(cwd, 'control.log')
      );
      expect(control.line).toBe('0 2 2');
      expect(control.attempt.members[0]?.status).toBe('PASSED');
      expect(countsPass(control)).toBe(true);
    } finally {
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
    if (!crossRepo.ok) {
      expect(crossRepo.message).toContain('repo');
    }
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

  it('parses stage YAML in isolated mode without product imports or secrets', () => {
    const cwd = tempDir('ser-yaml-isolate-');
    const shimDir = tempDir('ser-yaml-shim-');
    const argvLog = join(cwd, 'argv.log');
    const envLog = join(cwd, 'env.log');
    const cwdLog = join(cwd, 'cwd.log');
    const sentinel = join(cwd, 'yaml-import-sentinel');
    const previousCwd = process.cwd();
    const envKeys = [
      'PATH',
      'BDC_PARSER_SECRET',
      'GH_TOKEN',
      'CLAUDE_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'CURSOR_API_KEY',
      'PYTHONPATH',
    ] as const;
    const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
    for (const key of envKeys) savedEnv[key] = process.env[key];
    const secret = 'bdc-parser-secret-round12';
    try {
      initRepo(cwd);
      writeFileSync(
        join(cwd, 'yaml.py'),
        [
          'import os',
          'sentinel = os.path.join(os.path.dirname(os.path.abspath(__file__)), "yaml-import-sentinel")',
          'handle = open(sentinel, "w")',
          'handle.write(os.environ.get("BDC_PARSER_SECRET", ""))',
          'handle.close()',
          '',
        ].join('\n')
      );
      git(cwd, ['add', 'yaml.py']);
      git(cwd, ['commit', '-qm', 'hostile yaml']);
      const probed = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {
        encoding: 'utf8',
      });
      if (probed.status !== 0 || !probed.stdout) {
        throw new Error(probed.stderr || 'python3 executable probe failed');
      }
      const realPython = probed.stdout.trim();
      writeExec(
        join(shimDir, 'python3'),
        [
          '#!/bin/sh',
          `ARGV_LOG='${argvLog}'`,
          `ENV_LOG='${envLog}'`,
          `CWD_LOG='${cwdLog}'`,
          `REAL_PYTHON='${realPython}'`,
          `SHIM_DIR='${shimDir}'`,
          ': > "$ARGV_LOG"',
          'for arg in "$@"; do',
          '  printf \'%s\\0\' "$arg" >> "$ARGV_LOG"',
          'done',
          'pwd > "$CWD_LOG"',
          '/usr/bin/env > "$ENV_LOG"',
          'CLEAN_PATH=',
          'OLD_IFS=$IFS',
          'IFS=:',
          'for dir in $PATH; do',
          '  if [ "$dir" = "$SHIM_DIR" ]; then',
          '    continue',
          '  fi',
          '  if [ -z "$CLEAN_PATH" ]; then',
          '    CLEAN_PATH=$dir',
          '  else',
          '    CLEAN_PATH="$CLEAN_PATH:$dir"',
          '  fi',
          'done',
          'IFS=$OLD_IFS',
          'PATH=$CLEAN_PATH',
          'export PATH',
          'exec "$REAL_PYTHON" "$@"',
          '',
        ].join('\n')
      );
      process.env.BDC_PARSER_SECRET = secret;
      process.env.GH_TOKEN = 'bdc-gh-token-round12';
      process.env.CLAUDE_API_KEY = 'bdc-claude-round12';
      process.env.ANTHROPIC_API_KEY = 'bdc-anthropic-round12';
      process.env.OPENAI_API_KEY = 'bdc-openai-round12';
      process.env.CURSOR_API_KEY = 'bdc-cursor-round12';
      process.env.PYTHONPATH = cwd;
      process.env.PATH = `${shimDir}:${savedEnv.PATH ?? ''}`;
      process.chdir(cwd);
      let parsedOk = false;
      let parseError = '';
      try {
        const parsed = parseStagesYaml(
          stageBody(oneStage('api', 'thinmansoftware/shopops', 'bash ./ok.sh'))
        );
        parsedOk = parsed.ok;
        if (!parsed.ok) parseError = parsed.message;
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
      expect(existsSync(sentinel)).toBe(false);
      expect(parsedOk).toBe(true);
      expect(parseError).toBe('');
      expect(existsSync(envLog)).toBe(false);
      expect(process.env.BDC_PARSER_SECRET).toBe(secret);
      expect(process.env.CLAUDE_API_KEY).toBe('bdc-claude-round12');
    } finally {
      process.chdir(previousCwd);
      for (const key of envKeys) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(cwd, { recursive: true, force: true });
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it('refuses a hostile user-site yaml when system PyYAML is unavailable', () => {
    const cwd = tempDir('ser-yaml-usersite-cwd-');
    const home = tempDir('ser-yaml-usersite-home-');
    const shimDir = tempDir('ser-yaml-usersite-shim-');
    const sentinel = join(cwd, 'user-site-yaml-sentinel');
    const argvLog = join(cwd, 'argv.log');
    const savedPath = process.env.PATH;
    try {
      const probedPython = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {
        encoding: 'utf8',
      });
      if (probedPython.status !== 0 || !probedPython.stdout) {
        throw new Error(probedPython.stderr || 'python3 executable probe failed');
      }
      const realPython = probedPython.stdout.trim();
      const probedSite = spawnSync(
        realPython,
        ['-I', '-c', 'import site; print(site.getusersitepackages())'],
        { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } }
      );
      if (probedSite.status !== 0 || !probedSite.stdout.trim()) {
        throw new Error(probedSite.stderr || 'user site probe failed');
      }
      const userSite = probedSite.stdout.trim();
      expect(userSite.startsWith(`${home}/`)).toBe(true);
      mkdirSync(userSite, { recursive: true });
      writeFileSync(
        join(userSite, 'yaml.py'),
        [
          'import os',
          `sentinel = ${JSON.stringify(sentinel)}`,
          'handle = open(sentinel, "w")',
          'handle.write("imported\\n")',
          'handle.close()',
          'def safe_load(text):',
          '    return {',
          '        "stages": [{',
          '            "id": "pwned",',
          '            "repo": "evil/evil",',
          '            "target_branch": "dev",',
          '            "in_scope_files": ["README"],',
          '            "verify_commands": ["bash ./pwned.sh"],',
          '            "readiness_bar": {',
          '                "pr_open": True,',
          '                "ci_green": True,',
          '                "diff_review_clean": True,',
          '                "mergeable": True,',
          '            },',
          '        }]',
          '    }',
          '',
        ].join('\n')
      );
      const wrapper = join(shimDir, 'hide-system-yaml.py');
      writeFileSync(
        wrapper,
        [
          'import os, sys',
          '',
          'def entry_has_yaml(entry):',
          '    if not entry or not os.path.isdir(entry):',
          '        return False',
          '    if os.path.isfile(os.path.join(entry, "yaml.py")):',
          '        return True',
          '    return os.path.isdir(os.path.join(entry, "yaml"))',
          '',
          'args = sys.argv[1:]',
          'script = None',
          'file_arg = None',
          'index = 0',
          'while index < len(args):',
          '    arg = args[index]',
          '    if arg == "-c" and index + 1 < len(args):',
          '        script = args[index + 1]',
          '        index += 2',
          '        continue',
          '    if arg.startswith("-"):',
          '        index += 1',
          '        continue',
          '    file_arg = arg',
          '    index += 1',
          'if script is None or file_arg is None:',
          '    sys.stderr.write("FAIL: parser wrapper missing -c script\\n")',
          '    sys.exit(2)',
          '# Drop trusted PyYAML so this case is "system module unavailable".',
          '# Leave the user site off sys.path; python -I already omitted it.',
          'sys.path[:] = [entry for entry in sys.path if not entry_has_yaml(entry)]',
          'sys.argv = ["-c", file_arg]',
          'exec(compile(script, "<stages-parser>", "exec"), {"__name__": "__main__"})',
          '',
        ].join('\n')
      );
      writeExec(
        join(shimDir, 'python3'),
        [
          '#!/bin/sh',
          `HOME='${home}'`,
          'export HOME',
          `ARGV_LOG='${argvLog}'`,
          `REAL_PYTHON='${realPython}'`,
          `WRAPPER='${wrapper}'`,
          ': > "$ARGV_LOG"',
          'for arg in "$@"; do',
          '  printf \'%s\\0\' "$arg" >> "$ARGV_LOG"',
          'done',
          'exec "$REAL_PYTHON" -I "$WRAPPER" "$@"',
          '',
        ].join('\n')
      );
      process.env.PATH = `${shimDir}:${savedPath ?? ''}`;
      const parsed = parseStagesYaml(
        stageBody(oneStage('api', 'thinmansoftware/shopops', 'bash ./ok.sh'))
      );
      expect(existsSync(sentinel)).toBe(false);
      expect(parsed.ok).toBe(true);
      expect(existsSync(argvLog)).toBe(false);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(shimDir, { recursive: true, force: true });
    }
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
      git(cwd, ['add', 'src.js', 'probe.sh']);
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
      expect(renamed.method).toBe('git-write-tree');
      expect(renamed.tree).toMatch(/^[0-9a-f]{40}$/);
      expect(renamed.tree).not.toBe(summary.attempt.tree.tree);
      git(cwd, ['reset', '--hard', 'HEAD']);
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
      rmSync(join(cwd, 'gone.js'));
      const deleted = testedTreeIdentity(cwd);
      expect(deleted.method).toBe('git-write-tree');
      expect(deleted.tree).not.toBe(summary.attempt.tree.tree);
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
      expect(testedTreeIdentity(cwd).method).toBe('git-write-tree');
      refuse(summary.attempt, 'dirty-bytes');
      rmSync(join(cwd, 'broken-link'));
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
    } finally {
      if (savedArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = savedArtifacts;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('hashes an unborn repository and refuses changed tracked or untracked bytes', () => {
    const plain = tempDir('ser-notgit-');
    expect(testedTreeIdentity(plain).method).toBe('hash-failed');
    rmSync(plain, { recursive: true, force: true });
    const cwd = tempDir('ser-unborn-');
    git(cwd, ['init', '-q']);
    git(cwd, ['config', 'user.email', 't@example.com']);
    git(cwd, ['config', 'user.name', 'Test']);
    writeFileSync(join(cwd, 'src.js'), 'v1\n');
    git(cwd, ['add', 'src.js']);
    writeFileSync(join(cwd, 'extra.js'), 'u1\n');
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
    try {
      const summary = runTestCommands(['bash ./ok.sh'], cwd, join(artifacts, 'stop-tests.log'));
      const recorded = summary.attempt.tree;
      expect(recorded.method).toBe('hash-failed');
      expect(recorded.headSha).toBe('');
      expect(recorded.tree).toBe('');
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(false);
      const freshCli = spawnSync('bun', [RUNNER, 'check-attempt'], {
        cwd,
        env: cliEnv,
        encoding: 'utf8',
      });
      expect(freshCli.status).not.toBe(0);
      expect(freshCli.stderr).toContain('hash-failed');
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
      expect(testedTreeIdentity(cwd).method).toBe('git-write-tree');
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

describe('stale-source-log-exclusion', () => {
  it('does not exclude a tracked source path named as a persisted log', () => {
    const cwd = tempDir('ser-stale-source-');
    initRepo(cwd);
    mkdirSync(join(cwd, 'src/evidence'), { recursive: true });
    const source = join(cwd, 'src/evidence/check.ts');
    writeFileSync(source, 'export const value = 1;\n');
    git(cwd, ['add', '--', 'src/evidence/check.ts']);
    git(cwd, ['commit', '-qm', 'source']);
    writeExec(join(cwd, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\n');
    const artifacts = join(cwd, 'artifacts');
    mkdirSync(join(artifacts, 'evidence', 'attempts'), { recursive: true });
    const savedArtifacts = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = artifacts;
    const log = join(artifacts, 'evidence', 'attempts', 'stop-tests.log');
    const tamper = (attempt: EvidenceAttempt, logPath: string): EvidenceAttempt => {
      const copy = JSON.parse(JSON.stringify(attempt)) as EvidenceAttempt;
      for (const member of copy.members) member.logPath = logPath;
      return copy;
    };
    try {
      const summary = runTestCommands(['bash ./ok.sh'], cwd, log);
      expect(summary.attempt.aggregate).toBe('PASSED');
      expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
      const named = tamper(summary.attempt, source);
      expect(checkAttemptRecord(named, cwd, authority(cwd)).ok).toBe(true);
      writeFileSync(source, 'export const value = 2;\n');
      const stale = checkAttemptRecord(named, cwd, authority(cwd));
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.reason).toBe('dirty-bytes');
      const prefixed = tamper(summary.attempt, `${join(cwd, 'src/evidence')}/`);
      const prefixVerdict = checkAttemptRecord(prefixed, cwd, authority(cwd));
      expect(prefixVerdict.ok).toBe(false);
      if (!prefixVerdict.ok) expect(prefixVerdict.reason).toBe('dirty-bytes');
      const recordPath = join(
        artifacts,
        'evidence',
        'attempts',
        `${summary.attempt.attemptId}.json`
      );
      writeFileSync(
        recordPath,
        `${JSON.stringify(tamper(summary.attempt, 'src/evidence/check.ts'), null, 2)}\n`
      );
      const cli = spawnSync('bun', [RUNNER, 'check-attempt'], {
        cwd,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          ARTIFACTS_DIR: artifacts,
          NODE_ENV: 'test',
          SER_TEST_TRUSTED_ROOT: ROOT,
        },
        encoding: 'utf8',
      });
      expect(cli.status).not.toBe(0);
      expect(cli.stderr).toContain('dirty-bytes');
      expect(cli.stdout).not.toContain('OK');
    } finally {
      if (savedArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = savedArtifacts;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// Overseer PR #1286 review at c4e80205 (and the same two classes found on a
// full read): evidence that is absent or corrupt must never pass, and the
// tested-tree identity must not collide across different trees.
describe('required-evidence-and-identity-collisions', () => {
  function withArtifacts<T>(cwd: string, run: (artifacts: string) => T): T {
    const artifacts = join(cwd, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    const saved = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = artifacts;
    try {
      return run(artifacts);
    } finally {
      if (saved === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = saved;
    }
  }

  it('refuses passing tests alone when declared grep evidence is deleted or corrupt', () => {
    const cwd = tempDir('ser-required-greps-');
    initRepo(cwd);
    writeExec(join(cwd, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\n');
    try {
      withArtifacts(cwd, artifacts => {
        const env = { ...process.env, HARNESS_ROOT_OVERRIDE: ROOT, ARTIFACTS_DIR: artifacts };
        const check = (...extra: string[]) =>
          spawnSync('bun', [RUNNER, 'check-attempt', ...extra], { cwd, env, encoding: 'utf8' });
        runTestCommands(['bash ./ok.sh'], cwd, join(artifacts, 'stop-tests.log'));
        const greps = spawnSync('bun', [RUNNER, 'run-greps'], {
          cwd,
          env,
          encoding: 'utf8',
          input: 'grep -c base README\teq\t1\nDECLARED\t1\n',
        });
        expect(greps.status).toBe(0);
        const attempts = join(artifacts, 'evidence', 'attempts');
        const pointer = join(attempts, 'current-greps');
        const grepId = readFileSync(pointer, 'utf8').trim();
        const record = join(attempts, `${grepId}.json`);
        const body = readFileSync(record, 'utf8');
        expect(check('--require', 'tests,greps').status).toBe(0);

        writeFileSync(record, '{ not json');
        const corruptRecord = check('--require', 'tests,greps');
        expect(corruptRecord.status).not.toBe(0);
        expect(corruptRecord.stderr).toContain('REFUSED greps:malformed');
        // Even when greps are not declared, a live pointer to an unreadable
        // record is bound and refused, never silently dropped.
        expect(check('--require', 'tests').status).not.toBe(0);
        rmSync(record);
        expect(check('--require', 'tests,greps').stderr).toContain('REFUSED missing-grep-attempt');
        writeFileSync(record, body);

        writeFileSync(pointer, '../escape\n');
        const corruptPointer = check('--require', 'tests,greps');
        expect(corruptPointer.status).not.toBe(0);
        expect(corruptPointer.stderr).toContain('REFUSED corrupt-grep-pointer');

        rmSync(pointer);
        const deleted = check('--require', 'tests,greps');
        expect(deleted.status).not.toBe(0);
        expect(deleted.stderr).toContain('REFUSED missing-grep-attempt');
        // Only an explicit "no greps declared" requirement admits tests alone.
        expect(check('--require', 'tests').status).toBe(0);
        expect(check('--require', 'tests,bogus').stderr).toContain('REFUSED unknown-required-kind');

        const none = spawnSync('bun', [RUNNER, 'run-greps'], {
          cwd,
          env,
          encoding: 'utf8',
          input: 'DECLARED\t0\n',
        });
        expect(none.status).toBe(0);
        expect(none.stdout).toContain('GREP_STATUS=none_declared');
        const notApplicable = check('--require', 'tests,greps');
        expect(notApplicable.status).not.toBe(0);
        expect(notApplicable.stderr).toContain('REFUSED greps:not-applicable');
        expect(check('--require', 'tests').status).toBe(0);
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('refuses a test attempt with no selected members', () => {
    const cwd = tempDir('ser-empty-tests-');
    initRepo(cwd);
    try {
      withArtifacts(cwd, artifacts => {
        const summary = runTestCommands([], cwd, join(artifacts, 'stop-tests.log'));
        const verdict = checkBoundAttempts(cwd, authority(cwd), {
          testAttemptId: summary.attempt.attemptId,
          grepAttemptId: null,
        });
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason).toBe('tests:no-selected-members');
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('every lane check-attempt call passes the required evidence kinds', () => {
    const laneDir = join(ROOT, '.archon/workflows/defaults');
    let calls = 0;
    for (const lane of readdirSync(laneDir).filter(name => name.endsWith('.yaml'))) {
      const text = readFileSync(join(laneDir, lane), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.includes('ser_runner check-attempt')) continue;
        calls += 1;
        expect(line).toContain('check-attempt --require "$SER_REQUIRE_KINDS"');
      }
    }
    expect(calls).toBeGreaterThan(20);
  });

  it('records rename sources so a different source cannot reuse the identity', () => {
    const cwd = tempDir('ser-rename-source-');
    initRepo(cwd);
    git(cwd, ['config', 'core.autocrlf', 'false']);
    writeFileSync(join(cwd, 'a.js'), 'same\n');
    writeFileSync(join(cwd, 'b.js'), 'same\n');
    writeExec(join(cwd, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\n');
    git(cwd, ['add', '--', 'a.js', 'b.js', 'ok.sh']);
    git(cwd, ['commit', '-qm', 'identical sources']);
    try {
      withArtifacts(cwd, artifacts => {
        git(cwd, ['mv', 'a.js', 'c.js']);
        const tested = testedTreeIdentity(cwd);
        expect(tested.method).toBe('git-write-tree');
        expect(tested.tree).toMatch(/^[0-9a-f]{40}$/);
        const summary = runTestCommands(['bash ./ok.sh'], cwd, join(artifacts, 'stop-tests.log'));
        expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
        git(cwd, ['reset', '-q', '--hard', 'HEAD']);
        git(cwd, ['mv', 'b.js', 'c.js']);
        const swapped = checkAttemptRecord(summary.attempt, cwd, authority(cwd));
        expect(swapped.ok).toBe(false);
        if (!swapped.ok) expect(swapped.reason).toBe('dirty-bytes');
        git(cwd, ['reset', '-q', '--hard', 'HEAD']);
        git(cwd, ['mv', 'a.js', 'c.js']);
        expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
        git(cwd, ['commit', '-qm', 'commit the tested rename']);
        expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when skip-worktree or assume-unchanged hides tracked bytes', () => {
    const cwd = tempDir('ser-hidden-index-');
    initRepo(cwd);
    try {
      expect(testedTreeIdentity(cwd).method).toBe('git-write-tree');
      git(cwd, ['update-index', '--skip-worktree', 'README']);
      expect(testedTreeIdentity(cwd).method).toBe('git-write-tree');
      git(cwd, ['update-index', '--no-skip-worktree', 'README']);
      git(cwd, ['update-index', '--assume-unchanged', 'README']);
      expect(testedTreeIdentity(cwd).method).toBe('git-write-tree');
      git(cwd, ['update-index', '--no-assume-unchanged', 'README']);
      expect(testedTreeIdentity(cwd).method).toBe('git-write-tree');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not exclude tracked product files under .ser-attempts', () => {
    const cwd = tempDir('ser-dot-attempts-');
    initRepo(cwd);
    mkdirSync(join(cwd, '.ser-attempts'), { recursive: true });
    writeFileSync(join(cwd, '.ser-attempts/lib.js'), 'v1\n');
    writeExec(join(cwd, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\n');
    git(cwd, ['add', '--', '.ser-attempts/lib.js', 'ok.sh']);
    git(cwd, ['commit', '-qm', 'product dir']);
    try {
      withArtifacts(cwd, artifacts => {
        const summary = runTestCommands(['bash ./ok.sh'], cwd, join(artifacts, 'stop-tests.log'));
        expect(checkAttemptRecord(summary.attempt, cwd, authority(cwd)).ok).toBe(true);
        writeFileSync(join(cwd, '.ser-attempts/lib.js'), 'v2\n');
        const stale = checkAttemptRecord(summary.attempt, cwd, authority(cwd));
        expect(stale.ok).toBe(false);
        if (!stale.ok) expect(stale.reason).toBe('dirty-bytes');
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function productionResolverSource(): string {
  const yaml = readFileSync(
    join(ROOT, '.archon/workflows/defaults/bdc-feature-development-cursor.yaml'),
    'utf8'
  );
  const start = yaml.indexOf('      ser_root() {');
  const end = yaml.indexOf('      rst_command_looks_runnable()', start);
  if (start < 0 || end < 0) throw new Error('production ser_root block missing');
  return yaml.slice(start, end).replace(/^ {6}/gm, '');
}

function runResolver(
  product: string,
  env: NodeJS.ProcessEnv
): { stdout: string; status: number | null } {
  const script = [
    productionResolverSource(),
    'if resolved=$(ser_root); then echo "root:0"; echo "resolved:$resolved"; else echo "root:1"; fi',
    "if ser_runner allow-test -- 'bash ./x.sh' >/dev/null; then echo 'run:0'; else echo \"run:$?\"; fi",
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { cwd: product, env, encoding: 'utf8' });
  return { stdout: result.stdout ?? '', status: result.status };
}

describe('trust-boundary regressions', () => {
  it('trust_root_only_app_path', () => {
    const product = tempDir('ser-trust-product-');
    const sentinel = join(product, 'sentinel');
    const appSentinel = join(product, 'app-ran');
    const appRunner = '/app/packages/workflows/src/reliability/structured-evidence-runner.ts';
    const previous = existsSync(appRunner) ? readFileSync(appRunner) : null;
    const bin = join(product, 'bin');
    try {
      initRepo(product);
      git(product, [
        'remote',
        'add',
        'origin',
        'https://github.com/thinmansoftware/bdc-harness.git',
      ]);
      const fake = join(product, 'packages/workflows/src/reliability');
      mkdirSync(fake, { recursive: true });
      writeFileSync(
        join(product, 'packages/workflows/package.json'),
        '{"name":"@archon/workflows"}\n'
      );
      writeFileSync(
        join(fake, 'structured-evidence-runner.ts'),
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'pwned\\n');\n`
      );
      mkdirSync(bin);
      writeExec(
        join(bin, 'structured-evidence-runner'),
        `#!/bin/sh\nprintf 'pwned\\n' > ${JSON.stringify(sentinel)}\n`
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HARNESS_ROOT_OVERRIDE: product,
      };
      rmSync(appRunner, { force: true });
      const absent = runResolver(product, env);
      expect(existsSync(sentinel)).toBe(false);
      expect(absent.stdout).toContain('root:1');
      expect(absent.stdout).toContain('run:127');
      mkdirSync(join('/app/packages/workflows/src/reliability'), { recursive: true });
      symlinkSync(join(fake, 'structured-evidence-runner.ts'), appRunner);
      const linked = runResolver(product, env);
      expect(existsSync(sentinel)).toBe(false);
      expect(linked.stdout).toContain('root:1');
      rmSync(appRunner, { force: true });
      writeFileSync(
        appRunner,
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(appSentinel)}, 'app\\n');\n`
      );
      const present = runResolver(product, env);
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(appSentinel)).toBe(true);
      expect(present.stdout).toContain('root:0');
      expect(present.stdout).toContain(`resolved:${appRunner}`);
      expect(present.stdout).toContain('run:0');
    } finally {
      if (previous === null) rmSync(appRunner, { force: true });
      else writeFileSync(appRunner, previous);
      rmSync(product, { recursive: true, force: true });
      rmSync(appSentinel, { force: true });
    }
  });

  it('stage_parse_in_process', () => {
    const cwd = tempDir('ser-stage-parse-');
    const sentinel = join(cwd, 'sentinel');
    const spawnLog = join(cwd, 'spawn.log');
    const shimDir = join(cwd, 'shims');
    try {
      writeFileSync(join(cwd, 'yaml.py'), 'raise SystemExit("yaml.py")\n');
      writeFileSync(join(cwd, 'sitecustomize.py'), 'raise SystemExit("sitecustomize")\n');
      mkdirSync(shimDir);
      for (const name of ['python', 'python3', 'node', 'bun']) {
        writeExec(
          join(shimDir, name),
          `#!/bin/sh\nprintf '%s\\n' "$0" >> ${JSON.stringify(spawnLog)}\nexit 0\n`
        );
      }
      const spec = `<!-- canonical-stages -->\n\`\`\`yaml\n${stageBody(
        `${oneStage('api', 'thinmansoftware/shopops', 'bash ./api.sh')}\n${oneStage('web', 'thinmansoftware/lspro', 'bash ./web.sh')}`
      )}\n\`\`\`\n`;
      const parsed = parseStagesYaml(
        stageBody(
          `${oneStage('api', 'thinmansoftware/shopops', 'bash ./api.sh')}\n${oneStage('web', 'thinmansoftware/lspro', 'bash ./web.sh')}`
        )
      );
      expect(parsed.ok).toBe(true);
      const scoped = scopeEvidence(spec, { repo: 'thinmansoftware/shopops' });
      expect(scoped.ok).toBe(true);
      const specPath = join(cwd, 'spec.md');
      const yamlOut = join(cwd, 'stages.yaml');
      const jsonOut = join(cwd, 'stages.json');
      writeFileSync(specPath, spec);
      const cli = spawnSync(
        process.execPath,
        [RUNNER, 'parse-stages', specPath, yamlOut, jsonOut],
        {
          cwd,
          env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        }
      );
      expect(cli.status).toBe(0);
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(spawnLog)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('tree_identity_is_git_tree', () => {
    const cafe = tempDir('ser-tree-cafe-');
    const renamed = tempDir('ser-tree-rename-');
    const linked = tempDir('ser-tree-link-');
    const corrupt = tempDir('ser-tree-corrupt-');
    const logged = tempDir('ser-tree-log-');
    const savedArtifacts = process.env.ARTIFACTS_DIR;
    delete process.env.ARTIFACTS_DIR;
    try {
      const accented = `caf${String.fromCharCode(0xe9)}.txt`;
      initRepo(cafe);
      writeFileSync(join(cafe, accented), 'one\n');
      git(cafe, ['add', '--', accented]);
      git(cafe, ['commit', '-qm', 'accent']);
      writeFileSync(join(cafe, accented), 'two\n');
      writeExec(join(cafe, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\nexit 0\n');
      const cafeRun = runTestCommands(['bash ./ok.sh'], cafe, join(cafe, 'cafe.log'));
      expect(cafeRun.attempt.tree.method).toBe('git-write-tree');
      writeFileSync(join(cafe, accented), 'three\n');
      expect(testedTreeIdentity(cafe).tree).not.toBe(cafeRun.attempt.tree.tree);
      const cafeVerdict = checkAttemptRecord(cafeRun.attempt, cafe, authority(cafe));
      expect(cafeVerdict.ok).toBe(false);
      if (!cafeVerdict.ok) expect(cafeVerdict.reason).toBe('dirty-bytes');

      initRepo(renamed);
      writeFileSync(join(renamed, 'a.js'), 'same\n');
      writeFileSync(join(renamed, 'b.js'), 'same\n');
      git(renamed, ['add', 'a.js', 'b.js']);
      git(renamed, ['commit', '-qm', 'pair']);
      git(renamed, ['mv', 'a.js', 'c.js']);
      writeExec(join(renamed, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\nexit 0\n');
      const renameRun = runTestCommands(['bash ./ok.sh'], renamed, join(renamed, 'rename.log'));
      const firstTree = renameRun.attempt.tree.tree;
      git(renamed, ['mv', 'c.js', 'a.js']);
      git(renamed, ['mv', 'b.js', 'c.js']);
      expect(testedTreeIdentity(renamed).tree).not.toBe(firstTree);
      const renameVerdict = checkAttemptRecord(renameRun.attempt, renamed, authority(renamed));
      expect(renameVerdict.ok).toBe(false);
      if (!renameVerdict.ok) expect(renameVerdict.reason).toBe('dirty-bytes');

      initRepo(linked);
      writeFileSync(join(linked, 'a.txt'), 'same\n');
      writeFileSync(join(linked, 'b.txt'), 'same\n');
      symlinkSync('a.txt', join(linked, 'link'));
      git(linked, ['add', 'a.txt', 'b.txt', 'link']);
      git(linked, ['commit', '-qm', 'link']);
      writeExec(join(linked, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\nexit 0\n');
      const linkRun = runTestCommands(['bash ./ok.sh'], linked, join(linked, 'link.log'));
      rmSync(join(linked, 'link'));
      symlinkSync('b.txt', join(linked, 'link'));
      expect(testedTreeIdentity(linked).tree).not.toBe(linkRun.attempt.tree.tree);
      const linkVerdict = checkAttemptRecord(linkRun.attempt, linked, authority(linked));
      expect(linkVerdict.ok).toBe(false);
      if (!linkVerdict.ok) expect(linkVerdict.reason).toBe('dirty-bytes');

      initRepo(corrupt);
      writeExec(join(corrupt, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\nexit 0\n');
      const corruptRun = runTestCommands(['bash ./ok.sh'], corrupt, join(corrupt, 'corrupt.log'));
      expect(corruptRun.attempt.tree.method).toBe('git-write-tree');
      writeFileSync(join(corrupt, '.git/index'), 'not-an-index');
      expect(testedTreeIdentity(corrupt).method).toBe('hash-failed');
      const corruptVerdict = checkAttemptRecord(corruptRun.attempt, corrupt, authority(corrupt));
      expect(corruptVerdict.ok).toBe(false);
      if (!corruptVerdict.ok) expect(corruptVerdict.reason).toBe('hash-failed');

      initRepo(logged);
      mkdirSync(join(logged, 'src/evidence'), { recursive: true });
      writeFileSync(join(logged, 'src/evidence/check.ts'), 'export const n = 1;\n');
      git(logged, ['add', 'src/evidence/check.ts']);
      git(logged, ['commit', '-qm', 'src']);
      writeExec(join(logged, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\nexit 0\n');
      const logPath = join(logged, 'evidence-run.log');
      const logRun = runTestCommands(['bash ./ok.sh'], logged, logPath);
      expect(logRun.attempt.tree.method).toBe('git-write-tree');
      const loggedTree = logRun.attempt.tree.tree;
      writeFileSync(logPath, 'edited evidence log\n');
      expect(testedTreeIdentity(logged).tree).toBe(loggedTree);
      writeFileSync(join(logged, 'src/evidence/check.ts'), 'export const n = 2;\n');
      expect(testedTreeIdentity(logged).tree).not.toBe(loggedTree);
      const logVerdict = checkAttemptRecord(logRun.attempt, logged, authority(logged));
      expect(logVerdict.ok).toBe(false);
      if (!logVerdict.ok) expect(logVerdict.reason).toBe('dirty-bytes');
    } finally {
      if (savedArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = savedArtifacts;
      for (const dir of [cafe, renamed, linked, corrupt, logged]) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('multistage_no_greps_not_incomplete', () => {
    const cwd = tempDir('ser-no-grep-');
    const artifacts = tempDir('ser-no-grep-art-');
    const saved = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = artifacts;
    try {
      initRepo(cwd);
      writeExec(join(cwd, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\nexit 0\n');
      const spec = [
        '<!-- canonical-stages -->',
        '```yaml',
        stageBody(
          `${oneStage('api', 'thinmansoftware/shopops', 'bash ./ok.sh')}\n${oneStage('web', 'thinmansoftware/lspro', 'bash ./web.sh')}`
        ),
        '```',
        'Stop 1 (test suite):',
        '  bash ./ok.sh',
        '  Expected: 1',
        '',
      ].join('\n');
      expect(requiredEvidenceKinds(spec)).toEqual(['tests']);
      const tests = runTestCommands(['bash ./ok.sh'], cwd, join(artifacts, 'stop-tests.log'));
      expect(tests.attempt.aggregate).toBe('PASSED');
      const greps = spawnSync(process.execPath, [RUNNER, 'run-greps'], {
        cwd,
        input: 'DECLARED\t0\n',
        encoding: 'utf8',
        env: { ...process.env, ARTIFACTS_DIR: artifacts },
      });
      expect(greps.status).toBe(0);
      expect(greps.stdout).toContain('GREP_STATUS=none_declared');
      const check = spawnSync(process.execPath, [RUNNER, 'check-attempt', '--require', 'tests'], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ARTIFACTS_DIR: artifacts },
      });
      expect(check.status).toBe(0);
      expect(check.stderr ?? '').not.toContain('REFUSED');
    } finally {
      if (saved === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = saved;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(artifacts, { recursive: true, force: true });
    }
  });

  it('member_status_drives_summary', () => {
    const cwd = tempDir('ser-members-');
    const saved = process.env.ARTIFACTS_DIR;
    delete process.env.ARTIFACTS_DIR;
    try {
      initRepo(cwd);
      writeExec(join(cwd, 'pass.sh'), '#!/bin/sh\necho "Tests: 1/1"\nexit 0\n');
      writeExec(join(cwd, 'zero.sh'), '#!/bin/sh\necho "Tests: 0/0"\nexit 0\n');
      writeExec(join(cwd, 'nocount.sh'), '#!/bin/sh\necho "no counts here"\nexit 0\n');
      const zero = runTestCommands(
        ['bash ./pass.sh && bash ./zero.sh'],
        cwd,
        join(cwd, 'zero.log')
      );
      expect(zero.attempt.aggregate).not.toBe('PASSED');
      expect(zero.line).not.toBe('0 1 1');
      expect(checkAttemptRecord(zero.attempt, cwd, authority(cwd)).ok).toBe(false);
      const unparsed = runTestCommands(
        ['bash ./pass.sh && bash ./nocount.sh'],
        cwd,
        join(cwd, 'nocount.log')
      );
      expect(unparsed.attempt.aggregate).not.toBe('PASSED');
      expect(unparsed.line).not.toBe('0 1 1');
      expect(checkAttemptRecord(unparsed.attempt, cwd, authority(cwd)).ok).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = saved;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('required_kinds_enforced', () => {
    const cwd = tempDir('ser-kinds-');
    const artifacts = tempDir('ser-kinds-art-');
    const saved = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = artifacts;
    try {
      initRepo(cwd);
      writeExec(join(cwd, 'ok.sh'), '#!/bin/sh\necho "Tests: 1/1"\nexit 0\n');
      writeFileSync(join(cwd, 'notes.txt'), 'hello\n');
      const tests = runTestCommands(['bash ./ok.sh'], cwd, join(artifacts, 'stop-tests.log'));
      expect(tests.attempt.aggregate).toBe('PASSED');
      const greps = spawnSync(process.execPath, [RUNNER, 'run-greps'], {
        cwd,
        input: ['DECLARED\t1', 'grep -c hello notes.txt\teq\t1', ''].join('\n'),
        encoding: 'utf8',
        env: { ...process.env, ARTIFACTS_DIR: artifacts },
      });
      expect(greps.status).toBe(0);
      expect(greps.stdout).toContain('GREP_STATUS=passed');
      const attempts = join(artifacts, 'evidence', 'attempts');
      const grepId = readFileSync(join(attempts, 'current-greps'), 'utf8').trim();
      const grepFile = join(attempts, `${grepId}.json`);
      const grepBody = readFileSync(grepFile);
      const testId = readFileSync(join(attempts, 'current-tests'), 'utf8').trim();
      const testBody = readFileSync(join(attempts, `${testId}.json`));
      const check = (): { status: number | null; stderr: string } => {
        const result = spawnSync(
          process.execPath,
          [RUNNER, 'check-attempt', '--require', 'tests,greps'],
          {
            cwd,
            encoding: 'utf8',
            env: { ...process.env, ARTIFACTS_DIR: artifacts },
          }
        );
        return { status: result.status, stderr: result.stderr ?? '' };
      };
      rmSync(grepFile);
      const missing = check();
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain('missing-grep-attempt');
      writeFileSync(grepFile, '{');
      const malformed = check();
      expect(malformed.status).not.toBe(0);
      expect(malformed.stderr).toContain('greps:malformed');
      writeFileSync(grepFile, testBody);
      const wrongKind = check();
      expect(wrongKind.status).not.toBe(0);
      expect(wrongKind.stderr).toContain('grep-attempt-kind');
      writeFileSync(grepFile, grepBody);
      const prose = spawnSync(process.execPath, [RUNNER, 'run-greps'], {
        cwd,
        input: [
          'DECLARED\t2',
          'grep -c hello notes.txt\teq\t1',
          'UNPARSED\t1\tprose assertion',
          '',
        ].join('\n'),
        encoding: 'utf8',
        env: { ...process.env, ARTIFACTS_DIR: artifacts },
      });
      expect(prose.status).toBe(0);
      expect(prose.stderr).toContain('SER_GREP_FP4=admitted');
      const admitted = check();
      expect(admitted.status).toBe(0);
      const proseId = readFileSync(join(attempts, 'current-greps'), 'utf8').trim();
      const proseAttempt = JSON.parse(readFileSync(join(attempts, `${proseId}.json`), 'utf8')) as {
        kind: string;
        aggregate: string;
        grepExecuted?: number;
        grepDropped?: number;
        grepUnparsed?: number;
        grepMismatch?: number;
      };
      expect(admitPartialGrep(proseAttempt)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = saved;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(artifacts, { recursive: true, force: true });
    }
  });

  it('find_terminator_predicates_refused', () => {
    const cwd = tempDir('ser-find-');
    try {
      writeFileSync(join(cwd, 'keep'), 'stay\n');
      const commands = ['find -- . -delete', 'find . -- -exec rm {} ;', 'find -- . -fprint out'];
      for (const command of commands) {
        const allowed = allowAssertion(command);
        expect(allowed.ok).toBe(false);
        const cli = spawnSync(process.execPath, [RUNNER, 'allow-assertion', '--', command], {
          cwd,
          encoding: 'utf8',
        });
        expect(cli.status).not.toBe(0);
      }
      expect(existsSync(join(cwd, 'keep'))).toBe(true);
      expect(readFileSync(join(cwd, 'keep'), 'utf8')).toBe('stay\n');
      expect(existsSync(join(cwd, 'out'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('single_extractor_parity', () => {
    const lanes = readdirSync(join(ROOT, '.archon/workflows/defaults'))
      .filter(name => /^bdc-feature-development.*\.yaml$/.test(name))
      .sort();
    expect(lanes).toHaveLength(13);
    for (const lane of lanes) {
      const yaml = readFileSync(join(ROOT, '.archon/workflows/defaults', lane), 'utf8');
      const rstBegin = yaml.indexOf('# ---- BEGIN rst core');
      const rstEnd = yaml.indexOf('# ---- END rst core');
      const rsgBegin = yaml.indexOf('# ---- BEGIN rsg core');
      const rsgEnd = yaml.indexOf('# ---- END rsg core');
      expect(rstBegin).toBeGreaterThanOrEqual(0);
      expect(rsgBegin).toBeGreaterThanOrEqual(0);
      const rst = yaml.slice(rstBegin, rstEnd);
      const rsg = yaml.slice(rsgBegin, rsgEnd);
      expect(rst).toContain('ser_runner extract-tests');
      expect(rsg).toContain('ser_runner extract-greps');
      for (const core of [rst, rsg]) {
        const programs = [...core.matchAll(/awk(?:\s+-v\s+\S+)*\s+'([^']*)'/g)].map(
          match => match[1] ?? ''
        );
        for (const program of programs) {
          expect(program.includes('Stop')).toBe(false);
          expect(program.includes('Expected')).toBe(false);
        }
      }
    }
  });
});
