import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtemp, readFile, rm } from 'fs/promises';
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

async function runCli(args: string[]): Promise<CliResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', scriptPath, ...args],
    cwd: join(import.meta.dir, '..', '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LOG_LEVEL: 'fatal' },
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
      expect(result.stderr).toContain('refusing known live database path');
      expect(result.stderr).not.toContain('ENOENT');
    }
  });
});
