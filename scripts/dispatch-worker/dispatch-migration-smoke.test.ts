import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { link, mkdtemp, readFile, readdir, rm, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const temporaryDirectories: string[] = [];
const scriptPath = join(import.meta.dir, 'dispatch-migration-smoke.ts');

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function makeLegacyFixture(): Promise<{ dir: string; dbPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-migration-smoke-test-'));
  temporaryDirectories.push(dir);
  const dbPath = join(dir, 'source-copy.db');
  const db = new Database(dbPath);
  db.run(`
    CREATE TABLE agent_dispatch_messages (
      id TEXT PRIMARY KEY,
      correlation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      task_type TEXT NOT NULL CHECK (task_type IN ('agent_message', 'run_review', 'draft_spec', 'run_report')),
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'done', 'failed', 'cancelled')),
      result_body TEXT,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      completed_at TEXT,
      not_before TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      fencing_token INTEGER NOT NULL DEFAULT 0,
      recipient_alias TEXT,
      motion_id TEXT,
      motion_revision_sha TEXT,
      resolved_recipient TEXT,
      resolved_xo_lease_id TEXT,
      resolved_xo_fencing_token INTEGER,
      resolved_at TEXT
    );
  `);
  const insert = db.prepare(
    `INSERT INTO agent_dispatch_messages
     (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insert.run(
    'report-1',
    'correlation-1',
    'idempotency-1',
    'run_report',
    'overseer',
    'operator',
    'SECRET-report-one',
    'queued',
    '2026-08-05T10:00:00.000Z'
  );
  insert.run(
    'report-2',
    'correlation-2',
    'idempotency-2',
    'run_report',
    'not-overseer',
    'xo',
    'SECRET-report-two',
    'queued',
    '2026-08-05T10:01:00.000Z'
  );
  insert.run(
    'old-report',
    'correlation-3',
    'idempotency-3',
    'run_report',
    'overseer',
    'operator',
    'SECRET-old-report',
    'done',
    '2026-08-05T10:02:00.000Z'
  );
  insert.run(
    'live-only',
    'correlation-4',
    'idempotency-4',
    'agent_message',
    'xo',
    'fable',
    'SECRET-live-only',
    'queued',
    '2026-08-05T10:03:00.000Z'
  );
  insert.finalize();
  db.close();
  return { dir, dbPath };
}

async function runCli(
  args: string[],
  environment: Record<string, string> = {}
): Promise<CliResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, scriptPath, ...args],
    cwd: join(import.meta.dir, '..', '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LOG_LEVEL: 'fatal', NODE_ENV: 'test', ...environment },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('dispatch-migration-smoke CLI', () => {
  test('migrates only a temporary copy and prints the exact non-secret PASS summary', async () => {
    const { dbPath } = await makeLegacyFixture();
    const beforeHash = await sha256(dbPath);

    const result = await runCli(['--source-copy', dbPath, '--expected-heartbeats', '2']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('SECRET-');
    expect(result.stdout.trim()).toBe(
      'PASS rows_before=4 rows_after=4 heartbeat_rows=2 source_unchanged=true second_run_idempotent=true'
    );
    expect(result.stdout).not.toContain('SECRET-');
    expect(await sha256(dbPath)).toBe(beforeHash);

    const source = new Database(dbPath, { readonly: true, create: false });
    const columns = source
      .query<{ name: string }, []>("PRAGMA table_info('agent_dispatch_messages')")
      .all()
      .map(row => row.name);
    expect(columns).not.toContain('priority');
    expect(
      source
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_principals'")
        .get()?.count
    ).toBe(0);
    source.close();
  });

  test('fails when the expected heartbeat count does not match', async () => {
    const { dbPath } = await makeLegacyFixture();
    const beforeHash = await sha256(dbPath);

    const result = await runCli(['--source-copy', dbPath, '--expected-heartbeats', '3']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('SECRET-');
    expect(result.stderr).toContain('expected 3 heartbeat rows, found 2');
    expect(await sha256(dbPath)).toBe(beforeHash);
  });

  test('rejects missing input and both exact known live paths before database access', async () => {
    const missing = await runCli(['--expected-heartbeats', '369']);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain('--source-copy is required');

    for (const livePath of ['/.archon/archon.db', '/opt/bdc/archon-data/archon.db']) {
      const result = await runCli(['--source-copy', livePath, '--expected-heartbeats', '369']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('source_copy_forbidden');
      expect(result.stderr).not.toContain('ENOENT');
    }
  });

  test('rejects canonical dot-segment and duplicate-separator live paths before access', async () => {
    const aliases = [
      '/opt/bdc/archon-data/../archon-data/archon.db',
      '/opt//bdc//archon-data//archon.db',
    ];

    for (const alias of aliases) {
      const result = await runCli(['--source-copy', alias, '--expected-heartbeats', '369']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('source_copy_forbidden');
      expect(result.stderr).not.toContain(alias);
      expect(result.stderr).not.toContain('ENOENT');
    }
  });

  test('rejects symlink and hardlink identities of a protected file without reading it', async () => {
    const { dir, dbPath } = await makeLegacyFixture();
    const symlinkPath = join(dir, 'symlink-copy.db');
    const hardlinkPath = join(dir, 'hardlink-copy.db');
    await symlink(dbPath, symlinkPath, 'file');
    await link(dbPath, hardlinkPath);
    const environment = {
      BDC_DISPATCH_MIGRATION_SMOKE_TEST_KNOWN_LIVE_PATHS: JSON.stringify([dbPath]),
    };

    for (const alias of [symlinkPath, hardlinkPath]) {
      const beforeHash = await sha256(dbPath);
      const result = await runCli(
        ['--source-copy', alias, '--expected-heartbeats', '2'],
        environment
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('source_copy_forbidden');
      expect(result.stderr).not.toContain(alias);
      expect(await sha256(dbPath)).toBe(beforeHash);
    }
  });

  test('rejects malformed Phase 0 column definitions even when aggregate counts pass', async () => {
    const { dbPath } = await makeLegacyFixture();
    const database = new Database(dbPath);
    database.run('DELETE FROM agent_dispatch_messages');
    database.run('ALTER TABLE agent_dispatch_messages ADD COLUMN priority INTEGER DEFAULT 0');
    database.close();

    const result = await runCli(['--source-copy', dbPath, '--expected-heartbeats', '0']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('migration_schema_validation_failed');
  });

  test('rejects a pre-existing dispatch index with the right name but wrong definition', async () => {
    const { dbPath } = await makeLegacyFixture();
    const database = new Database(dbPath);
    database.run('CREATE INDEX idx_dispatch_board_pending ON agent_dispatch_messages(status)');
    database.close();

    const result = await runCli(['--source-copy', dbPath, '--expected-heartbeats', '2']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('migration_schema_validation_failed');
  });

  test('detects complete message-state drift between migration runs', async () => {
    const { dbPath } = await makeLegacyFixture();
    const result = await runCli(['--source-copy', dbPath, '--expected-heartbeats', '2'], {
      BDC_DISPATCH_MIGRATION_SMOKE_TEST_DRIFT_AFTER_FIRST: '1',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('migration_second_run_not_idempotent');
    expect(result.stderr).not.toContain('SECRET-');
  });

  test('does not disclose a sensitive nonexistent source path', async () => {
    const sensitivePath = join(tmpdir(), 'CUSTOMER-SECRET-ACCOUNT-NAME', 'private-snapshot.db');
    const result = await runCli(['--source-copy', sensitivePath, '--expected-heartbeats', '369']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('source_copy_unavailable');
    expect(result.stderr).not.toContain(sensitivePath);
    expect(result.stderr).not.toContain('CUSTOMER-SECRET-ACCOUNT-NAME');
  });

  test('cleans the temporary copy after constructor failure and preserves the primary error', async () => {
    const { dbPath } = await makeLegacyFixture();
    const source = new Database(dbPath);
    source.run('CREATE TABLE dispatch_principals (principal_id TEXT PRIMARY KEY)');
    source.close();
    const tempParent = await mkdtemp(join(tmpdir(), 'dispatch-smoke-parent-'));
    temporaryDirectories.push(tempParent);

    const result = await runCli(['--source-copy', dbPath, '--expected-heartbeats', '2'], {
      BDC_DISPATCH_MIGRATION_SMOKE_TEST_TEMP_PARENT: tempParent,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('migration_initialization_failed');
    expect(result.stderr).not.toContain(dbPath);
    expect(result.stderr).not.toContain(tempParent);
    expect(await readdir(tempParent)).toEqual([]);
  });

  test('surfaces cleanup failure together with a primary migration failure', async () => {
    const { dbPath } = await makeLegacyFixture();
    const source = new Database(dbPath);
    source.run('CREATE TABLE dispatch_principals (principal_id TEXT PRIMARY KEY)');
    source.close();
    const tempParent = await mkdtemp(join(tmpdir(), 'CUSTOMER-SECRET-DISPATCH-SMOKE-'));
    temporaryDirectories.push(tempParent);

    const result = await runCli(['--source-copy', dbPath, '--expected-heartbeats', '2'], {
      BDC_DISPATCH_MIGRATION_SMOKE_TEST_TEMP_PARENT: tempParent,
      BDC_DISPATCH_MIGRATION_SMOKE_TEST_FAIL_CLEANUP: '1',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split(/\r?\n/).at(-1)).toBe(
      'migration_initialization_failed;temporary_cleanup_failed'
    );
    expect(result.stderr).not.toContain(dbPath);
    expect(result.stderr).not.toContain(tempParent);
    expect(result.stderr).not.toContain('CUSTOMER-SECRET-DISPATCH-SMOKE');
    expect(result.stderr).not.toContain('SECRET-');
  });
});
