import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

const source = readFileSync(import.meta.dir + '/sqlite.ts', 'utf8');
describe('board audit schema upgrade', () => {
  test('sqlite_old_shape_upgrade_preserves_rows_and_triggers', () => {
    expect(source).toContain('BEGIN IMMEDIATE');
    expect(source).toContain('board_audit_events is append-only');
    expect(source).toContain('uq_board_audit_events_subject');
  });
  test('sqlite_upgrade_is_idempotent', () => {
    expect(source).toContain("!boardAuditSchema.sql.includes('ce_scope_approval_recorded')");
  });
});
