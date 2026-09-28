import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './sqlite';

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(path + suffix); } catch { /* absent */ }
  }
});

describe('board audit schema upgrade', () => {
  test('upgrades an old populated table while preserving rowid, rows, triggers, and indexes', async () => {
    const path = join(import.meta.dir, `.audit-upgrade-${crypto.randomUUID()}.db`);
    paths.push(path);
    const old = new Database(path);
    old.exec(`CREATE TABLE board_audit_events (
      id TEXT PRIMARY KEY, event_type TEXT NOT NULL CHECK(event_type IN ('xo_lease_acquired')),
      actor_principal_id TEXT, actor_seat_id TEXT, xo_lease_id TEXT, xo_fencing_token INTEGER,
      motion_id TEXT, motion_revision_sha TEXT, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE INDEX old_audit_index ON board_audit_events(created_at);
    CREATE TRIGGER old_audit_trigger BEFORE UPDATE ON board_audit_events BEGIN SELECT RAISE(ABORT, 'old append only'); END;
    INSERT INTO board_audit_events(rowid,id,event_type,details,created_at) VALUES (41,'old-1','xo_lease_acquired','{}','2026-01-01T00:00:00Z');`);
    old.close();

    const db = new SqliteAdapter(path);
    expect((await db.query<{ rowid: number; id: string }>('SELECT rowid,id FROM board_audit_events')).rows).toEqual([{ rowid: 41, id: 'old-1' }]);
    const objects = (await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE tbl_name='board_audit_events' AND type IN ('index','trigger')")).rows.map(row => row.name);
    expect(objects).toContain('old_audit_index');
    expect(objects).toContain('old_audit_trigger');
    expect(objects).toContain('uq_board_audit_events_subject');
    expect(db.query("UPDATE board_audit_events SET details='x' WHERE id='old-1'")).rejects.toThrow('append-only');
    await db.query("INSERT INTO board_audit_events(id,event_type,details,created_at,subject_key) VALUES ('new-1','ce_scope_approval_recorded','{}','2026-01-02T00:00:00Z','subject')");
    await db.close();

    const reopened = new SqliteAdapter(path);
    expect((await reopened.query<{ n: number }>('SELECT COUNT(*) AS n FROM board_audit_events')).rows[0]?.n).toBe(2);
    await reopened.close();
  });
});
