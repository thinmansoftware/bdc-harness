import { test, expect } from 'bun:test';
import { parseProjectRecord, projectRecordSchema } from './project-record';

export const record = {
  record_version: 1 as const,
  tier: 'learning' as const,
  base_branch: 'dev',
  production_branches: ['main'],
  test_command: 'bun test',
  runner_profile: 'default',
  spec_home: 'docs',
  reviewer_role: 'reviewer',
  allowed_providers: [],
  secret_namespace: 'test',
  github: 'connected' as const,
  approver: 'operator',
  rollout: 'direct' as const,
  health_url: null,
  state: 'idea' as const,
};
test('valid record parses from JSON and object', () => {
  expect(parseProjectRecord(JSON.stringify(record))).toEqual({ status: 'valid', record });
  expect(parseProjectRecord(record).status).toBe('valid');
});
test('empty_production_branches_refused', () => {
  const result = projectRecordSchema.safeParse({ ...record, production_branches: [] });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues[0].path).toEqual(['production_branches']);
});
test('base_branch_listed_as_production_refused_and_unknown_key_refused', () => {
  expect(projectRecordSchema.safeParse({ ...record, production_branches: ['dev'] }).success).toBe(
    false
  );
  expect(projectRecordSchema.safeParse({ ...record, merge_now: true }).success).toBe(false);
});
test('corrupt_stored_record_reads_as_null_not_500', () => {
  for (const raw of ['{not json', '{}', 'null', { record_version: 2 }])
    expect(parseProjectRecord(raw)).toEqual({ status: 'invalid', record: null });
  expect(parseProjectRecord(null).status).toBe('absent');
});

test('fresh and existing SQLite schema migrate safely and preserve rows', async () => {
  const { SqliteAdapter } = await import('../db/adapters/sqlite');
  const { Database } = await import('bun:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'grimoire-upgrade-'));
  const file = join(root, 'test.db');
  try {
    const fresh = new SqliteAdapter(file);
    expect(
      (
        await fresh.query<{ name: string }>("PRAGMA table_info('remote_agent_codebases')")
      ).rows.some(c => c.name === 'project_record')
    ).toBe(true);
    await fresh.query(
      "INSERT INTO remote_agent_codebases (id,name,default_cwd) VALUES ('old','old/repo','/tmp')"
    );
    await fresh.close();
    const legacy = new Database(file);
    legacy.run('ALTER TABLE remote_agent_codebases DROP COLUMN project_record');
    legacy.close();
    for (let i = 0; i < 2; i++) {
      const upgraded = new SqliteAdapter(file);
      expect(
        (
          await upgraded.query<{ project_record: null }>(
            "SELECT project_record FROM remote_agent_codebases WHERE id='old'"
          )
        ).rows[0].project_record
      ).toBeNull();
      await upgraded.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
