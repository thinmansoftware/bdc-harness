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
      id TEXT PRIMARY KEY, event_type TEXT NOT NULL CHECK(event_type IN (
        'xo_lease_acquired','xo_lease_acquire_rejected','xo_lease_renewed',
        'xo_lease_renew_rejected','xo_lease_released','xo_lease_release_rejected',
        'board_recipient_resolved','board_recipient_deferred','canonical_motion_frozen',
        'canonical_approval_accepted','canonical_approval_rejected',
        'motion_notification_enqueued','motion_notification_deduplicated',
        'board_alias_resolved','board_petition_delivered'
      )),
      actor_principal_id TEXT, actor_seat_id TEXT, xo_lease_id TEXT, xo_fencing_token INTEGER,
      motion_id TEXT, motion_revision_sha TEXT, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE INDEX old_audit_index ON board_audit_events(created_at);
    CREATE TRIGGER old_audit_trigger BEFORE UPDATE ON board_audit_events BEGIN SELECT RAISE(ABORT, 'old append only'); END;
    INSERT INTO board_audit_events(rowid,id,event_type,details,created_at) VALUES
      (41,'old-1','xo_lease_acquired','{ "bytes": 1 }','2026-01-01T00:00:00Z'),
      (57,'old-2','canonical_motion_frozen',X'00FF10','2026-01-01T00:00:01Z'),
      (99,'old-3','board_petition_delivered','plain text','2026-01-01T00:00:02Z');`);
    old.close();

    const db = new SqliteAdapter(path);
    expect((await db.query<{ rowid: number; id: string }>('SELECT rowid,id FROM board_audit_events ORDER BY rowid')).rows).toEqual([
      { rowid: 41, id: 'old-1' }, { rowid: 57, id: 'old-2' }, { rowid: 99, id: 'old-3' },
    ]);
    const bytes = (await db.query<{ hex: string }>('SELECT hex(details) AS hex FROM board_audit_events ORDER BY rowid')).rows.map(row => row.hex);
    expect(bytes).toEqual(['7B20226279746573223A2031207D', '00FF10', '706C61696E2074657874']);
    const objects = (await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE tbl_name='board_audit_events' AND type IN ('index','trigger')")).rows.map(row => row.name);
    expect(objects).toContain('old_audit_index');
    expect(objects).toContain('old_audit_trigger');
    expect(objects).toContain('idx_board_audit_events_created');
    expect(objects).toContain('idx_board_audit_events_motion');
    expect(objects).toContain('uq_board_audit_events_subject');
    expect(objects).toContain('trg_board_audit_events_no_update');
    expect(objects).toContain('trg_board_audit_events_no_delete');
    expect(db.query("UPDATE board_audit_events SET details='x' WHERE id='old-1'")).rejects.toThrow('append-only');
    await db.query("INSERT INTO board_audit_events(id,event_type,details,created_at,subject_key) VALUES ('new-1','ce_scope_approval_recorded','{}','2026-01-02T00:00:00Z','subject')");
    await db.close();

    const reopened = new SqliteAdapter(path);
    expect((await reopened.query<{ n: number }>('SELECT COUNT(*) AS n FROM board_audit_events')).rows[0]?.n).toBe(4);
    expect((await reopened.query<{ rowid: number; id: string }>('SELECT rowid,id FROM board_audit_events WHERE id LIKE \'old-%\' ORDER BY rowid')).rows).toEqual([
      { rowid: 41, id: 'old-1' }, { rowid: 57, id: 'old-2' }, { rowid: 99, id: 'old-3' },
    ]);
    await reopened.close();
  });
});
