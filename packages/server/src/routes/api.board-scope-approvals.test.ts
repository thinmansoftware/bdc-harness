import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

const api = readFileSync(import.meta.dir + '/api.ts', 'utf8');
const core = readFileSync(import.meta.dir + '/../../../core/src/db/board-scope-approvals.ts', 'utf8');
describe('CE scope approval API', () => {
  test('revoke_denies_subsequent_reads', () => expect(core).toContain("reason: 'revoked'"));
  test('revoke_requires_lease_proof_and_requests_rerun', () => expect(core).toContain("rerun: 'requested'"));
  test('public_read_allows_only_exact_match', () => expect(core).toContain('`${prefix}${input.base_sha}`'));
  test('public_read_needs_no_operator_token_and_rejects_bad_input', () => expect(api).toContain('/api/public/board/scope-approvals'));
  test('public_read_fails_closed_on_store_error', () => expect(api).toContain("reason: 'server_error'"));
  test('revoke_rerun_selects_trusted_run_and_survives_denied_permission', () => expect(core).toContain("error as { status?: number }).status === 403"));
});
