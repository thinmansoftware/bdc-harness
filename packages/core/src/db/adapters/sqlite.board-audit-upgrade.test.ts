import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './sqlite';

let path = '';
afterEach(() => {
  for (const suffix of ['', '-wal', '-shm'])
    try {
      unlinkSync(path + suffix);
    } catch {}
});
function oldDatabase(): void {
  path = join(import.meta.dir, `.audit-upgrade-${crypto.randomUUID()}.db`);
  const raw = new Database(path);
  raw.exec(`CREATE TABLE board_audit_events (
    id TEXT PRIMARY KEY, event_type TEXT NOT NULL CHECK (event_type IN (
      'xo_lease_acquired','xo_lease_acquire_rejected','xo_lease_renewed','xo_lease_renew_rejected',
      'xo_lease_released','xo_lease_release_rejected','board_recipient_resolved','board_recipient_deferred',
      'canonical_motion_frozen','canonical_approval_accepted','canonical_approval_rejected',
      'motion_notification_enqueued','motion_notification_deduplicated','board_alias_resolved','board_petition_delivered')),
    actor_principal_id TEXT, actor_seat_id TEXT, xo_lease_id TEXT, xo_fencing_token INTEGER,
    motion_id TEXT, motion_revision_sha TEXT, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE INDEX idx_board_audit_events_created ON board_audit_events(created_at);
    CREATE INDEX idx_board_audit_events_motion ON board_audit_events(motion_id,motion_revision_sha) WHERE motion_id IS NOT NULL;
    CREATE TRIGGER trg_board_audit_events_no_update BEFORE UPDATE ON board_audit_events BEGIN SELECT RAISE(ABORT,'board_audit_events is append-only'); END;
    CREATE TRIGGER trg_board_audit_events_no_delete BEFORE DELETE ON board_audit_events BEGIN SELECT RAISE(ABORT,'board_audit_events is append-only'); END;`);
  for (let i = 1; i <= 3; i++)
    raw
      .prepare('INSERT INTO board_audit_events VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(
        String(i),
        'xo_lease_acquired',
        null,
        null,
        null,
        null,
        null,
        null,
        JSON.stringify({ i }),
        `2026-01-0${i}T00:00:00Z`
      );
  raw.close();
}

describe('board audit sqlite upgrade', () => {
  test('sqlite_old_shape_upgrade_preserves_rows_and_triggers', async () => {
    oldDatabase();
    const db = new SqliteAdapter(path);
    const rows = await db.query<{ id: string; details: string }>(
      'SELECT id,details FROM board_audit_events ORDER BY id'
    );
    expect(rows.rows).toEqual([
      { id: '1', details: '{"i":1}' },
      { id: '2', details: '{"i":2}' },
      { id: '3', details: '{"i":3}' },
    ]);
    await expect(
      db.query("UPDATE board_audit_events SET details='{}' WHERE id='1'")
    ).rejects.toThrow('append-only');
    await db.query(
      "INSERT INTO board_audit_events(id,event_type,details,created_at) VALUES('4','manual_initiation_recorded','{}','2026-01-04')"
    );
    await db.query(
      "INSERT INTO board_audit_events(id,event_type,details,created_at,subject_key) VALUES('5','ce_scope_approval_recorded','{}','2026-01-05','subject')"
    );
    const indexes = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='board_audit_events'"
    );
    expect(indexes.rows.map(row => row.name)).toContain('uq_board_audit_events_subject');
    await db.close();
  });
  test('sqlite_upgrade_is_idempotent', async () => {
    oldDatabase();
    const first = new SqliteAdapter(path);
    await first.close();
    const second = new SqliteAdapter(path);
    const rows = await second.query<{ rowid: number }>(
      'SELECT rowid FROM board_audit_events ORDER BY rowid'
    );
    expect(rows.rows.map(row => row.rowid)).toEqual([1, 2, 3]);
    await second.close();
  });
});
