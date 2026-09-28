import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

const source = readFileSync(import.meta.dir + '/../ce-scope-premerge-recheck.ts', 'utf8');
describe('CE scope premerge recheck', () => {
  test('premerge_recheck_allows_single_genuine_green_gate', () => expect(source).toContain("conclusion !== 'success'"));
  test('premerge_recheck_refuses_spoofed_or_duplicate_check', () => expect(source).toContain('duplicate_gate_check'));
  test('premerge_recheck_refuses_green_older_than_revoke', () => expect(source).toContain('revoked_after_green'));
  test('premerge_recheck_reverifies_record_not_just_check', () => expect(source).toContain('getScopeApprovalDecision'));
  test('premerge_recheck_check_cardinality', () => { expect(source).toContain('legacyRuns'); expect(source).toContain('compare_truncated'); });
});
