import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const temporaryDirectories: string[] = [];
const scriptPath = join(import.meta.dir, 'report-unroutable.ts');

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function makeFixture(): Promise<{ dir: string; dbPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'report-unroutable-test-'));
  temporaryDirectories.push(dir);
  const dbPath = join(dir, 'dispatch.db');
  const db = new Database(dbPath);
  db.run(`
    CREATE TABLE dispatch_principals (
      principal_id TEXT PRIMARY KEY,
      active INTEGER NOT NULL
    );
    CREATE TABLE agent_dispatch_messages (
      id TEXT PRIMARY KEY,
      recipient TEXT NOT NULL,
      task_type TEXT NOT NULL,
      priority TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      recipient_alias TEXT,
      body TEXT NOT NULL
    );
  `);
  db.run("INSERT INTO dispatch_principals VALUES ('active-seat', 1), ('inactive-seat', 0)");
  const insert = db.prepare(
    `INSERT INTO agent_dispatch_messages
     (id, recipient, task_type, priority, created_at, status, recipient_alias, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insert.run(
    'active-id',
    'active-seat',
    'agent_message',
    'normal',
    '2026-08-05T10:00:00.000Z',
    'queued',
    null,
    'SECRET-active-body'
  );
  insert.run(
    'inactive-id',
    'inactive-seat',
    'draft_spec',
    'blocker',
    '2026-08-05T10:01:00.000Z',
    'queued',
    null,
    'SECRET-inactive-body'
  );
  insert.run(
    'missing-id',
    'missing-seat',
    'run_report',
    'heartbeat',
    '2026-08-05T10:02:00.000Z',
    'queued',
    null,
    'SECRET-missing-body'
  );
  insert.run(
    'done-id',
    'missing-seat',
    'run_review',
    'normal',
    '2026-08-05T10:03:00.000Z',
    'done',
    null,
    'SECRET-done-body'
  );
  insert.run(
    'board-id',
    'missing-seat',
    'agent_message',
    'normal',
    '2026-08-05T10:04:00.000Z',
    'queued',
    'board',
    'SECRET-board-body'
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

describe('report-unroutable CLI', () => {
  test('reports only queued concrete inactive and missing recipients as metadata', async () => {
    const { dbPath } = await makeFixture();

    const result = await runCli(['--db', dbPath, '--format', 'json']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('SECRET-');
    expect(JSON.parse(result.stdout)).toEqual({
      count: 2,
      findings: [
        {
          id: 'inactive-id',
          recipient: 'inactive-seat',
          task_type: 'draft_spec',
          priority: 'blocker',
          created_at: '2026-08-05T10:01:00.000Z',
        },
        {
          id: 'missing-id',
          recipient: 'missing-seat',
          task_type: 'run_report',
          priority: 'heartbeat',
          created_at: '2026-08-05T10:02:00.000Z',
        },
      ],
    });
    expect(result.stdout).not.toContain('SECRET-');
  });

  test('leaves database bytes unchanged and creates no WAL or SHM sidecars', async () => {
    const { dir, dbPath } = await makeFixture();
    const beforeHash = await sha256(dbPath);

    const result = await runCli(['--db', dbPath, '--format', 'json']);

    expect(result.exitCode).toBe(0);
    expect(await sha256(dbPath)).toBe(beforeHash);
    expect(await readdir(dir)).toEqual(['dispatch.db']);
  });

  test('rejects mutation-shaped and unsupported arguments', async () => {
    const { dbPath } = await makeFixture();
    const beforeHash = await sha256(dbPath);

    for (const option of ['--apply', '--cancel', '--mutate']) {
      const result = await runCli(['--db', dbPath, '--format', 'json', option]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
    }

    expect(await sha256(dbPath)).toBe(beforeHash);
  });
});
