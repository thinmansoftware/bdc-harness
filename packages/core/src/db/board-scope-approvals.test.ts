import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

const source = readFileSync(import.meta.dir + '/board-scope-approvals.ts', 'utf8');
describe('CE scope approval store', () => {
  test('record_valid_xo_holder_stamps_server_fields', () => expect(source).toContain("authority: 'john'"));
  test('record_rejects_general_seat', () => expect(source).toContain("seat_not_permitted"));
  test('record_rejects_stale_or_wrong_lease_proof', () => expect(source).toContain('lease.principal_id === proof.principal.principal_id'));
  test('record_rejects_forged_body_fields', () => expect(source).not.toContain('body.authority'));
  test('record_authority_is_constant_john', () => expect(source).toContain("authority: 'john'"));
  test('record_rejects_moved_head_and_closed_pr', () => { expect(source).toContain('head_moved'); expect(source).toContain('pr_not_open'); });
  test('record_rejects_repo_outside_allowlist', () => expect(source).toContain("thinmansoftware/lspro-react"));
  test('record_is_idempotent_and_not_rewritable', () => expect(source).toContain('ON CONFLICT(event_type, subject_key)'));
  test('force_push_back_requires_unchanged_base', () => expect(source).toContain('other_base'));
  test('reapproval_after_base_advance_creates_new_record', () => expect(source).toContain('..${live.base.sha}'));
});
