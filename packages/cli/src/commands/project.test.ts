import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';

const record = {
  record_version: 1,
  tier: 'bdc',
  base_branch: 'dev',
  production_branches: ['main'],
  test_command: 'bun test',
  runner_profile: 'default',
  spec_home: 'docs',
  reviewer_role: 'reviewer',
  allowed_providers: [],
  secret_namespace: 'test',
  github: 'connected',
  approver: 'operator',
  rollout: 'direct',
  health_url: null,
  state: 'idea',
};
let root: string;
let db: SqliteAdapter;
const repo = 'thinmansoftware/bdc-harness';
const commandPath = resolve(import.meta.dir, 'project.ts');
async function run(
  command = 'verify',
  extra: string[] = [],
  policy?: string,
  legacyRepoConfig?: string
) {
  const proc = Bun.spawn(
    [
      'bun',
      '-e',
      `import {projectCommand} from ${JSON.stringify(commandPath)}; process.exit(await projectCommand(${JSON.stringify(command)}, ${JSON.stringify(repo)}, ${JSON.stringify({ xoRoot: extra.includes('xo') ? root : undefined, json: extra.includes('json') })}));`,
    ],
    {
      env: {
        ...process.env,
        ARCHON_HOME: root,
        DATABASE_URL: '',
        MERGE_MANAGER_REPO_POLICY: policy,
        MERGE_MANAGER_ALLOWED_BASES: undefined,
        OVERSEER_MERGE_REPO_CONFIG: legacyRepoConfig,
        LOG_LEVEL: 'silent',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  return {
    code: await proc.exited,
    output: await new Response(proc.stdout).text(),
    error: await new Response(proc.stderr).text(),
  };
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'grimoire-'));
  db = new SqliteAdapter(join(root, 'archon.db'));
  await db.query(
    'INSERT INTO remote_agent_codebases (id,name,default_cwd,default_branch,repository_url,project_record) VALUES ($1,$2,$3,$4,$5,$6)',
    [
      'test',
      repo,
      root,
      'dev',
      'https://x-access-token:SECRETVALUE@github.com/thinmansoftware/bdc-harness.git',
      JSON.stringify(record),
    ]
  );
  mkdirSync(join(root, 'scripts/cauldron'), { recursive: true });
  writeFileSync(
    join(root, 'scripts/cauldron/repo-canonical-map.json'),
    JSON.stringify({ [repo]: repo })
  );
  writeFileSync(
    join(root, 'scripts/cauldron/cauldron-projects.json'),
    JSON.stringify({ [repo]: { base_branch: 'dev' } })
  );
});
afterEach(async () => {
  await db.close();
  rmSync(root, { recursive: true, force: true });
});
test('verify_agrees_on_matching_surfaces', async () => {
  const result = await run('verify', ['xo']);
  expect(result.code).toBe(0);
  expect(result.output.match(/^AGREE /gm)?.length).toBe(5);
});
test('verify_names_the_disagreeing_surface (injected failure) and writes nothing', async () => {
  const file = join(root, 'scripts/cauldron/cauldron-projects.json');
  writeFileSync(file, JSON.stringify({ [repo]: { base_branch: 'main' } }));
  await db.close();
  const before = readFileSync(join(root, 'archon.db'));
  const fixture = readFileSync(file);
  const result = await run(
    'verify',
    ['xo'],
    JSON.stringify({
      [repo]: {
        dev: { unattended: true, docs_only: 'skip' },
        main: { unattended: true, docs_only: 'skip' },
      },
    })
  );
  expect(result.code).toBe(1);
  expect(result.output).toContain('DISAGREE xo.cauldron_projects_base record=dev live=main');
  expect(result.output).toContain('DISAGREE merge_policy.production');
  expect(readFileSync(join(root, 'archon.db'))).toEqual(before);
  expect(readFileSync(file)).toEqual(fixture);
});
test('unreadable, skipped, JSON and exit precedence', async () => {
  writeFileSync(join(root, 'scripts/cauldron/cauldron-projects.json'), '{broken');
  expect((await run('verify', ['xo'])).code).toBe(3);
  const skipped = await run('verify', ['json']);
  expect(skipped.code).toBe(0);
  expect(
    JSON.parse(skipped.output).surfaces.filter((s: { status: string }) => s.status === 'SKIPPED')
      .length
  ).toBe(2);
  expect((await run('verify', ['xo'], '{}')).code).toBe(1);
});
test('thinman_alias_and_redaction', async () => {
  const pkg = await Bun.file(resolve(import.meta.dir, '../../package.json')).json();
  expect(pkg.bin.thinman).toBe(pkg.bin.archon);
  const outputs = [];
  for (const name of ['archon', 'thinman'])
    symlinkSync(resolve(import.meta.dir, '../../', pkg.bin[name]), join(root, name));
  for (const name of ['archon', 'thinman']) {
    const proc = Bun.spawn(['bun', join(root, name), 'project', 'show', repo], {
      env: { ...process.env, ARCHON_HOME: root, DATABASE_URL: '', LOG_LEVEL: 'silent' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(output).not.toContain('SECRETVALUE');
    expect(output).toContain('***@github.com');
    outputs.push(output);
  }
  expect(outputs[0]).toBe(outputs[1]);
});
test('show corrupt, absent and unregistered records exits 2', async () => {
  await db.query("UPDATE remote_agent_codebases SET project_record = '{not json'");
  const corrupt = await run('show');
  expect(corrupt.code).toBe(2);
  expect(corrupt.output).toContain('RECORD_UNPARSEABLE');
  await db.query('UPDATE remote_agent_codebases SET project_record = NULL');
  expect((await run('show')).output).toContain('NO_RECORD');
  await db.query('DELETE FROM remote_agent_codebases');
  expect((await run('verify')).output).toContain('REPO_NOT_REGISTERED');
});

test('missing entries disagree and JSON preserves values and reasons', async () => {
  writeFileSync(
    join(root, 'scripts/cauldron/repo-canonical-map.json'),
    JSON.stringify({ 'bdc-harness': 'other/repo' })
  );
  writeFileSync(join(root, 'scripts/cauldron/cauldron-projects.json'), '{}');
  const result = await run('verify', ['xo', 'json']);
  expect(result.code).toBe(1);
  const output = JSON.parse(result.output);
  expect(output.exitCode).toBe(1);
  expect(
    output.surfaces.find((s: { surface: string }) => s.surface === 'xo.cauldron_projects_base')
  ).toEqual({
    surface: 'xo.cauldron_projects_base',
    status: 'DISAGREE',
    record: 'dev',
    live: null,
  });
  expect(
    output.surfaces.find((s: { surface: string }) => s.surface === 'xo.repo_canonical_map').status
  ).toBe('DISAGREE');
  rmSync(join(root, 'scripts/cauldron/cauldron-projects.json'));
  const unreadable = await run('verify', ['xo', 'json']);
  expect(
    JSON.parse(unreadable.output).surfaces.find(
      (s: { surface: string }) => s.surface === 'xo.cauldron_projects_base'
    ).reason
  ).toContain('cauldron-projects.json');
  expect(unreadable.code).toBe(1);
});

test('policy_lookup_matches_merge_engine_case_and_whitespace (Overseer #1423 regression)', async () => {
  // The merge engine (getRepoBasePolicy) trims and lowercases the base name, so a
  // record naming 'Main' / ' Dev ' must be judged against policy.main / policy.dev.
  await db.query('UPDATE remote_agent_codebases SET project_record = $1, default_branch = $2', [
    JSON.stringify({ ...record, base_branch: ' Dev ', production_branches: ['Main'] }),
    ' Dev ',
  ]);
  const result = await run(
    'verify',
    [],
    JSON.stringify({
      [repo]: {
        dev: { unattended: true, docs_only: 'skip' },
        main: { unattended: true, docs_only: 'skip' },
      },
    })
  );
  expect(result.code).toBe(1);
  expect(result.output).toMatch(/^AGREE merge_policy\.base$/m);
  expect(result.output).toContain('DISAGREE merge_policy.production record=["Main"] live=["Main"]');
});

test('legacy_overseer_merge_repo_config_is_honored_like_merge_execution (Overseer #1507)', async () => {
  // Merge execution (merge-execution-bridge configuredPolicy) parses the deprecated
  // OVERSEER_MERGE_REPO_CONFIG; verify must judge against the same effective policy.
  const base = await run(
    'verify',
    [],
    undefined,
    JSON.stringify({ [repo]: { baseBranch: 'dev' } })
  );
  expect(base.output).toMatch(/^AGREE merge_policy\.base$/m);
  expect(base.output).toMatch(/^AGREE merge_policy\.production$/m);
  const unsafe = await run(
    'verify',
    [],
    undefined,
    JSON.stringify({ [repo]: { baseBranch: 'Main' } })
  );
  expect(unsafe.code).toBe(1);
  expect(unsafe.output).toContain('DISAGREE merge_policy.production record=["main"] live=["main"]');
});
