import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PostgresAdapter } from './adapters/postgres';
import {
  getScopeApprovalDecision,
  getScopeApprovalMetadata,
  recordScopeApproval,
  revokeScopeApproval,
} from './board-scope-approvals';

// Real PostgreSQL record/revoke path. node-postgres returns TIMESTAMPTZ as Date and
// BIGINT as string, which a SQLite-backed test cannot reproduce. The schema is built
// from the real migrations (029 foundation, 058 scope approvals), not hand-written DDL.
const schema = `scope_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const S = '1'.repeat(40);
const B = '2'.repeat(40);
const principal = { principal_id: 'p', seat_id: 'xo' as const, roles: [] };
const proof = { holder_id: 'h', holder_token: 't', fencing_token: 1 };
const github = {
  getPullRequest: async () => ({
    state: 'open',
    head: { sha: S, ref: 'feature' },
    base: { sha: B, ref: 'release/ce' },
  }),
};
let admin: PostgresAdapter | undefined;
let db: PostgresAdapter;

function loopbackUrl(): string {
  const raw =
    process.env.SCOPE_APPROVALS_POSTGRES_TEST_URL ?? process.env.DISPATCH_POSTGRES_PHASE15_TEST_URL;
  if (!raw) throw new Error('SCOPE_APPROVALS_POSTGRES_TEST_URL is required');
  const url = new URL(raw);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    (url.pathname !== '/phase15' && !url.pathname.endsWith('_test'))
  ) {
    throw new Error('scope approval integration requires a loopback test database');
  }
  return raw;
}

function migration(name: string): string {
  return readFileSync(resolve(import.meta.dir, '../../../../migrations', name), 'utf8');
}

beforeAll(async () => {
  const raw = loopbackUrl();
  admin = new PostgresAdapter(raw);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(raw);
  url.searchParams.set('options', `-c search_path=${schema}`);
  db = new PostgresAdapter(url.toString());
  await db.query(migration('029_board_authority_foundation.sql'));
  await db.query(migration('058_board_scope_approvals.sql'));
  await db.query(
    `INSERT INTO board_xo_leases
      (id, lease_id, principal_id, seat_id, holder_id, holder_token_hash, fencing_token,
       acquired_at, expires_at)
     VALUES (1, $1, 'p', 'xo', 'h', $2, 1, NOW(), NOW() + INTERVAL '1 hour')`,
    [randomUUID(), createHash('sha256').update('t').digest('hex')]
  );
});

afterAll(async () => {
  await db?.close();
  if (admin) {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.close();
    }
  }
});

describe('scope approvals on PostgreSQL', () => {
  test('postgres_record_and_revoke_with_real_column_types', async () => {
    expect(db.dialect).toBe('postgres');
    const recorded = await recordScopeApproval({
      principal,
      proof,
      repo: 'thinmansoftware/lspro-react',
      pr_number: 626,
      head_sha: S,
      conditions: 'no production regression',
      evidence_url: 'https://example.test/e',
      github,
      database: db,
    });
    if (!recorded.ok) throw new Error(`record rejected: ${recorded.reason}`);
    expect(recorded.approval.authority).toBe('john');
    expect(recorded.approval.base_sha).toBe(B);

    const allowed = await getScopeApprovalDecision({
      repo: 'thinmansoftware/lspro-react',
      pr_number: 626,
      head_sha: S,
      base_sha: B,
      database: db,
    });
    expect(allowed.decision).toBe('allow');

    const revoked = await revokeScopeApproval({
      principal,
      proof,
      approval_id: recorded.approval.approval_id,
      reason: 'John withdrew',
      database: db,
    });
    expect(revoked.ok).toBe(true);
    const denied = await getScopeApprovalDecision({
      repo: 'thinmansoftware/lspro-react',
      pr_number: 626,
      head_sha: S,
      base_sha: B,
      database: db,
    });
    expect(denied).toEqual({ decision: 'deny', reason: 'revoked' });
    // created_at comes back from node-postgres as a Date; metadata must hand back an
    // ISO string so the premerge recheck's revoked_after_green comparison works.
    const metadata = await getScopeApprovalMetadata({
      repo: 'thinmansoftware/lspro-react',
      pr_number: 626,
      head_sha: S,
      database: db,
    });
    expect(typeof metadata.newestRevokedAt).toBe('string');
    expect(metadata.newestRevokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('postgres_stale_fencing_token_is_rejected', async () => {
    const result = await recordScopeApproval({
      principal,
      proof: { ...proof, fencing_token: 2 },
      repo: 'thinmansoftware/lspro-react',
      pr_number: 627,
      head_sha: S,
      conditions: 'x',
      evidence_url: 'https://example.test/e',
      github,
      database: db,
    });
    expect(result).toEqual({ ok: false, reason: 'stale_xo_lease_token' });
  });
});
