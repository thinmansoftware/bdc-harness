import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './sqlite';

let path = '';
afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      // File may not exist.
    }
  }
});

function oldDatabase(): void {
  path = join(import.meta.dir, `.operator-settings-upgrade-${crypto.randomUUID()}.db`);
  const raw = new Database(path);
  raw.exec(`CREATE TABLE legacy_notes (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL
  );`);
  const insert = raw.prepare('INSERT INTO legacy_notes (id, body) VALUES (?, ?)');
  insert.run('1', 'keep-me');
  insert.run('2', 'also-keep');
  insert.finalize();
  raw.close();
}

describe('operator_settings sqlite upgrade', () => {
  test('old database gains operator_settings without touching existing rows', async () => {
    oldDatabase();
    const db = new SqliteAdapter(path);
    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operator_settings'"
    );
    expect(tables.rows.map(row => row.name)).toEqual(['operator_settings']);
    const notes = await db.query<{ id: string; body: string }>(
      'SELECT id, body FROM legacy_notes ORDER BY id'
    );
    expect(notes.rows).toEqual([
      { id: '1', body: 'keep-me' },
      { id: '2', body: 'also-keep' },
    ]);
    await db.close();
  });

  test('second open is idempotent and leaves existing rows unchanged', async () => {
    oldDatabase();
    const first = new SqliteAdapter(path);
    await first.close();
    const second = new SqliteAdapter(path);
    const notes = await second.query<{ id: string; body: string }>(
      'SELECT id, body FROM legacy_notes ORDER BY id'
    );
    expect(notes.rows).toEqual([
      { id: '1', body: 'keep-me' },
      { id: '2', body: 'also-keep' },
    ]);
    const tables = await second.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operator_settings'"
    );
    expect(tables.rows).toHaveLength(1);
    await second.close();
  });
});
