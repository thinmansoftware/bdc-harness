import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';
import {
  getScopeApprovalDecision,
  getScopeApprovalMetadata,
  recordScopeApproval,
  revokeScopeApproval,
} from './board-scope-approvals';

const S = '1'.repeat(40),
  B = '2'.repeat(40),
  B2 = '3'.repeat(40);
const principal = { principal_id: 'p', seat_id: 'xo' as const, roles: [] };
const proof = { holder_id: 'h', holder_token: 't', fencing_token: 1 };
let db: SqliteAdapter, path: string;
const github = (base = B, head = S, state = 'open') => ({
  getPullRequest: async () => ({
    state,
    head: { sha: head, ref: 'feature' },
    base: { sha: base, ref: 'release/ce' },
  }),
});

beforeEach(async () => {
  path = join(import.meta.dir, `.scope-${crypto.randomUUID()}.db`);
  db = new SqliteAdapter(path);
  await db.query(
    `INSERT INTO board_xo_leases
    (id,lease_id,principal_id,seat_id,holder_id,holder_token_hash,fencing_token,acquired_at,expires_at)
    VALUES (1,$1,$2,'xo',$3,$4,1,$5,$6)`,
    [
      'lease',
      'p',
      'h',
      createHash('sha256').update('t').digest('hex'),
      new Date().toISOString(),
      '2999-01-01T00:00:00.000Z',
    ]
  );
});
afterEach(async () => {
  await db.close();
  for (const suffix of ['', '-wal', '-shm'])
    try {
      unlinkSync(path + suffix);
    } catch {}
});
const record = (overrides: Record<string, unknown> = {}) =>
  recordScopeApproval({
    principal,
    proof,
    repo: 'thinmansoftware/lspro-react',
    pr_number: 626,
    head_sha: S,
    conditions: 'keep safe',
    evidence_url: 'https://example.test/e',
    github: github(),
    database: db,
    ...overrides,
  });

describe('board scope approvals', () => {
  test('record_valid_xo_holder_stamps_server_fields', async () => {
    const result = await record();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created).toBe(true);
      expect(result.approval.authority).toBe('john');
      expect(result.approval.base_sha).toBe(B);
    }
  });
  test('record_rejects_general_seat', async () => {
    const result = await record({ principal: { ...principal, seat_id: 'general' } });
    expect(result).toEqual({ ok: false, reason: 'seat_not_permitted' });
  });
  test('record_rejects_stale_or_wrong_lease_proof', async () => {
    expect(await record({ proof: { ...proof, fencing_token: 2 } })).toEqual({
      ok: false,
      reason: 'stale_xo_lease_token',
    });
  });
  test('record_authority_is_constant_john', async () => {
    const result = await record();
    if (!result.ok) throw new Error('record failed');
    expect(result.approval.authority).toBe('john');
    expect(result.approval.recorded_by_seat).toBe('xo');
  });
  test('record_rejects_moved_head_and_closed_pr', async () => {
    expect(await record({ github: github(B, '4'.repeat(40)) })).toEqual({
      ok: false,
      reason: 'head_moved',
    });
    expect(await record({ github: github(B, S, 'closed') })).toEqual({
      ok: false,
      reason: 'pr_not_open',
    });
  });
  test('record_rejects_repo_outside_allowlist', async () => {
    expect(await record({ repo: 'thinmansoftware/shopops' })).toEqual({
      ok: false,
      reason: 'repo_not_allowed',
    });
  });
  test('record_is_idempotent_and_not_rewritable', async () => {
    const first = await record(),
      second = await record({ conditions: 'different' });
    if (!first.ok || !second.ok) throw new Error('record failed');
    expect(second.created).toBe(false);
    expect(second.approval.approval_id).toBe(first.approval.approval_id);
    expect(second.approval.conditions).toBe('keep safe');
  });
  test('revoke_denies_subsequent_reads', async () => {
    const made = await record();
    if (!made.ok) throw new Error('record failed');
    expect(
      (
        await revokeScopeApproval({
          principal,
          proof,
          approval_id: made.approval.approval_id,
          reason: 'withdrawn',
          database: db,
        })
      ).ok
    ).toBe(true);
    expect(
      await getScopeApprovalDecision({
        repo: 'thinmansoftware/lspro-react',
        pr_number: 626,
        head_sha: S,
        base_sha: B,
        database: db,
      })
    ).toEqual({ decision: 'deny', reason: 'revoked' });
  });
  test('revoked approvals do not count as an approval at another base', async () => {
    const made = await record();
    if (!made.ok) throw new Error('record failed');
    await revokeScopeApproval({
      principal,
      proof,
      approval_id: made.approval.approval_id,
      reason: 'withdrawn',
      database: db,
    });
    const metadata = await getScopeApprovalMetadata({
      repo: 'thinmansoftware/lspro-react',
      pr_number: 626,
      head_sha: S,
      database: db,
    });
    expect(metadata.hasOtherBase).toBe(false);
    expect(metadata.newestRevokedAt).not.toBeNull();
  });
  test('public_read_allows_only_exact_match', async () => {
    await record();
    expect(
      (
        await getScopeApprovalDecision({
          repo: 'thinmansoftware/lspro-react',
          pr_number: 626,
          head_sha: S,
          base_sha: B,
          database: db,
        })
      ).decision
    ).toBe('allow');
    expect(
      await getScopeApprovalDecision({
        repo: 'thinmansoftware/lspro-react',
        pr_number: 626,
        head_sha: S,
        base_sha: B2,
        database: db,
      })
    ).toEqual({ decision: 'deny', reason: 'no_record' });
  });
  test('force_push_back_requires_unchanged_base', async () => {
    await record();
    expect(
      (
        await getScopeApprovalDecision({
          repo: 'thinmansoftware/lspro-react',
          pr_number: 626,
          head_sha: S,
          base_sha: B,
          database: db,
        })
      ).decision
    ).toBe('allow');
    expect(
      (
        await getScopeApprovalDecision({
          repo: 'thinmansoftware/lspro-react',
          pr_number: 626,
          head_sha: S,
          base_sha: B2,
          database: db,
        })
      ).decision
    ).toBe('deny');
  });
  test('reapproval_after_base_advance_creates_new_record', async () => {
    const one = await record(),
      two = await record({ github: github(B2) });
    if (!one.ok || !two.ok) throw new Error('record failed');
    expect(two.created).toBe(true);
    expect(two.approval.approval_id).not.toBe(one.approval.approval_id);
  });
  test('record_locks_lease_row_before_clock_and_rejects_concurrent_release', async () => {
    // Postgres-dialect view over the real SQLite store. It records the statement
    // order inside the transaction and simulates a concurrent release that commits
    // first and so wins the row lock: the locked read must see it and reject.
    const statements: string[] = [];
    const translate = (sql: string): string =>
      sql
        .replace(' FOR UPDATE', '')
        .replace(
          /SELECT to_char\(clock_timestamp\(\)[^]*? AS value/,
          "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS value"
        );
    const pg = {
      dialect: 'postgres',
      query: (sql: string, params?: unknown[]) => db.query(translate(sql), params),
      withTransaction: <T>(fn: (q: never) => Promise<T>) =>
        db.withTransaction(async q => {
          const wrapped = async (sql: string, params?: unknown[]) => {
            statements.push(sql);
            if (sql.startsWith('SELECT * FROM board_xo_leases'))
              await q(
                "UPDATE board_xo_leases SET released_at = '2026-01-01T00:00:00.000Z' WHERE id = 1"
              );
            return q(translate(sql), params);
          };
          return fn(wrapped as never);
        }),
    };
    const result = await record({ database: pg as never });
    expect(result).toEqual({ ok: false, reason: 'stale_xo_lease_token' });
    expect(statements[0]).toBe('SELECT * FROM board_xo_leases WHERE id = 1 FOR UPDATE');
    expect(statements[1]).toContain('clock_timestamp');
    const recorded = await db.query(
      "SELECT 1 FROM board_audit_events WHERE event_type = 'ce_scope_approval_recorded'"
    );
    expect(recorded.rowCount).toBe(0);
  });
});
