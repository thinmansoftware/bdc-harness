import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEventStore, readTaskmaster } from '../sources/event-store';

const input = { owner: 'thinmansoftware', repo: 'bdc-harness', number: 7, headRef: 'feat/x-7' };

function createMinimalArchonDb(path: string): void {
  const db = new Database(path);
  db.run(`CREATE TABLE remote_agent_workflow_runs (
    id TEXT PRIMARY KEY, workflow_name TEXT, status TEXT, started_at TEXT,
    user_message TEXT NOT NULL, metadata TEXT DEFAULT '{}')`);
  db.run(`CREATE TABLE remote_agent_workflow_events (
    id TEXT PRIMARY KEY, workflow_run_id TEXT, event_type TEXT, step_name TEXT,
    data TEXT DEFAULT '{}', created_at TEXT)`);
  db.run(`CREATE TABLE tm_expectations (
    id TEXT PRIMARY KEY, status TEXT, dispatch_ref TEXT NOT NULL, recipient TEXT NOT NULL,
    evidence_json TEXT NOT NULL, created_at TEXT)`);
  const now = new Date().toISOString();
  db.run('INSERT INTO remote_agent_workflow_runs VALUES (?, ?, ?, ?, ?, ?)', [
    'run-1',
    'bdc-feature-development',
    'failed',
    now,
    'build it',
    '{"branch":"feat/x-7"}',
  ]);
  db.run('INSERT INTO tm_expectations VALUES (?, ?, ?, ?, ?, ?)', [
    'tm-1',
    'pending',
    'gh:thinmansoftware/bdc-harness#7',
    'codex',
    '{}',
    now,
  ]);
  db.close();
}

function tableNames(path: string): string[] {
  const db = new Database(path, { readonly: true });
  const names = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type IN ('table','index')")
    .all()
    .map(row => row.name)
    .sort();
  db.close();
  return names;
}

describe('event-store and taskmaster reads are genuinely read-only', () => {
  let home: string;
  const saved = { home: process.env.ARCHON_HOME, url: process.env.DATABASE_URL };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'grimoire-ro-'));
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    process.env.ARCHON_HOME = saved.home;
    if (saved.url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.url;
    rmSync(home, { recursive: true, force: true });
  });

  test('ro_missing_db_reports_unavailable_and_creates_no_file', async () => {
    const events = await readEventStore(input);
    const tm = await readTaskmaster(input);
    expect(events.status).toMatch(/^unavailable/);
    expect(tm.status).toMatch(/^unavailable/);
    expect(existsSync(join(home, 'archon.db'))).toBe(false);
  });

  test('ro_existing_db_is_read_without_schema_changes', async () => {
    const path = join(home, 'archon.db');
    createMinimalArchonDb(path);
    const before = tableNames(path);
    const events = await readEventStore(input);
    const tm = await readTaskmaster(input);
    expect(events.status).toBe('ok');
    expect(events.runs.map(r => r.id)).toEqual(['run-1']);
    expect(tm).toEqual({ recipient: 'codex', status: 'ok' });
    expect(tableNames(path)).toEqual(before);
  });
});

describe('event-store SQL is valid for PostgreSQL JSONB columns', () => {
  test('jsonb_columns_are_cast_to_text_before_like', async () => {
    const statements: string[] = [];
    const database = {
      query: async <T>(sql: string): Promise<{ rows: T[]; rowCount: number }> => {
        statements.push(sql);
        return { rows: [], rowCount: 0 };
      },
    };
    const result = await readEventStore(input, database);
    expect(result.status).toBe('ok');
    const sql = statements.join('\n');
    // metadata (runs) and data (events) are JSONB in PostgreSQL; `jsonb LIKE text`
    // has no operator there, so each must be cast to text first.
    expect(sql).not.toMatch(/(?<!CAST\()\b(r\.metadata|e\.data)\s+LIKE/i);
    expect(sql).toMatch(/CAST\(r\.metadata AS TEXT\) LIKE/);
    expect(sql).toMatch(/CAST\(e\.data AS TEXT\) LIKE/);
  });
});

describe('stdio entry points keep stdout for protocol output only', () => {
  for (const entry of ['cli', 'mcp'] as const) {
    test(`stdio_${entry}_entry_routes_dependency_logs_to_stderr`, async () => {
      const env: Record<string, string | undefined> = { ...process.env };
      delete env.LOG_LEVEL;
      delete env.ARCHON_LOG_STDERR;
      const child = Bun.spawn(
        ['bun', 'run', fileURLToPath(new URL('./fixtures/stdio-probe.ts', import.meta.url)), entry],
        { stdout: 'pipe', stderr: 'pipe', env }
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(stdout.trim()).toBe('{"probe":"ok"}');
      expect(stderr).toContain('db.connection_sqlite_selected');
    });
  }
});

describe('PostgreSQL reads are transaction-scoped read-only', () => {
  test('pg_read_runs_in_read_only_transaction_and_never_sets_session_state', async () => {
    const { ReadOnlyPostgres } = await import('../sources/read-only-db');
    const sent: string[] = [];
    const transactions: string[][] = [];
    const adapter = {
      withTransaction: async <T>(
        fn: (
          q: <U>(sql: string, params?: unknown[]) => Promise<{ rows: U[]; rowCount: number }>
        ) => Promise<T>
      ): Promise<T> => {
        const tx: string[] = [];
        transactions.push(tx);
        return fn(async <U>(sql: string) => {
          tx.push(sql);
          sent.push(sql);
          return { rows: [] as U[], rowCount: 0 };
        });
      },
    };
    const db = new ReadOnlyPostgres(adapter);
    await readEventStore(input, db);
    await readTaskmaster(input, db);
    expect(transactions).toHaveLength(2);
    for (const tx of transactions) {
      expect(tx[0]).toBe('SET TRANSACTION READ ONLY');
      expect(tx).toHaveLength(2);
    }
    // A session-level setting would outlive the transaction on a pooled backend.
    expect(sent.some(sql => /SET\s+(SESSION|default_transaction)/i.test(sql))).toBe(false);
  });
});
