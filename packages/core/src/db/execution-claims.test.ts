import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';

let db: SqliteAdapter;
let currentDbPath = '';

mock.module('./connection', () => ({
  getDatabase: () => db,
}));

import { acquireXoLease, type BoardPrincipal } from './board-authority';
import {
  acquireExecutionClaim,
  acquireRecoveryExecutionClaim,
  completeExecutionClaim,
  computeActionKey,
  getExecutionClaim,
  markExecutionReconciliationRequired,
  validateRecoveryExecutionFence,
  releaseExecutionClaim,
  renewExecutionClaim,
  resolveExecutionReconciliation,
  validateExecutionFence,
  type ActionIdentity,
  type ExecutionClaimDependencies,
  type XoProof,
} from './execution-claims';

const XO: BoardPrincipal = { principal_id: 'xo-model', seat_id: 'xo', roles: ['acting_xo'] };

const MOTION_ID = 'M-20260712-27';
const MOTION_PATH = 'docs/board/motions/M-20260712-27-dispatch.md';
const TARGET_SHA = 'a'.repeat(40);
const REVISION_SHA = 'b'.repeat(40);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function identity(over: Partial<ActionIdentity> = {}): ActionIdentity {
  return {
    motion_id: MOTION_ID,
    action_kind: 'production_deploy',
    environment: 'production',
    target_sha: TARGET_SHA,
    ...over,
  };
}

function approvalDeps(
  over: { target_sha?: string; motion_id?: string; motion_revision_sha?: string } = {}
): ExecutionClaimDependencies {
  return {
    resolveApprovedAction: async () => ({
      approved: {
        motion_id: over.motion_id ?? MOTION_ID,
        environment: 'production' as const,
        target_sha: over.target_sha ?? TARGET_SHA,
        motion_blob_sha: over.motion_revision_sha ?? REVISION_SHA,
        acting_xo_principal_id: 'xo-model',
        second_seat_principal_id: 'general-model',
        john_principal_id: 'john-ranson',
      },
      motion_revision_sha: over.motion_revision_sha ?? REVISION_SHA,
    }),
  };
}

const rejectingDeps: ExecutionClaimDependencies = {
  resolveApprovedAction: async () => {
    throw new Error('canonical_approval_rejected: expected one board-approval-v1 block');
  },
};

async function seedXo(
  holderId = 'holder-a',
  holderToken = 'token-a',
  durationMs = 60_000
): Promise<XoProof> {
  const result = await acquireXoLease({
    principal: XO,
    holder_id: holderId,
    holder_token: holderToken,
    lease_duration_ms: durationMs,
  });
  if (!result.ok || !result.lease) throw new Error('failed to seed XO lease');
  return {
    xo_holder_id: holderId,
    xo_lease_id: result.lease.lease_id,
    xo_fencing_token: result.lease.fencing_token,
    xo_holder_token: holderToken,
  };
}

function acquireInput(
  proof: XoProof,
  over: Partial<{
    target_sha: string;
    initiator_seat_id: string;
    initiator_principal_id: string;
    lease_duration_ms: number;
  }> = {}
) {
  return {
    ...identity({ target_sha: over.target_sha ?? TARGET_SHA }),
    motion_file_path: MOTION_PATH,
    xo_holder_id: proof.xo_holder_id,
    xo_lease_id: proof.xo_lease_id,
    xo_fencing_token: proof.xo_fencing_token,
    xo_holder_token: proof.xo_holder_token,
    initiator_principal_id: over.initiator_principal_id ?? 'xo-model',
    initiator_seat_id: over.initiator_seat_id ?? 'xo',
    lease_duration_ms: over.lease_duration_ms,
  };
}

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

async function countEvents(eventType: string): Promise<number> {
  const rows = await db.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM board_audit_events WHERE event_type = $1',
    [eventType]
  );
  return Number(rows.rows[0]?.n ?? 0);
}

async function claimCount(): Promise<number> {
  const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM board_execution_claims');
  return Number(rows.rows[0]?.n ?? 0);
}

describe('execution claims db', () => {
  beforeEach(() => {
    currentDbPath = join(
      import.meta.dir,
      `.test-execution-claims-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    await db.close();
    cleanupDb(currentDbPath);
  });

  // Test 1 -- Concurrent acquire
  // bun:sqlite cannot run two real transactions concurrently on one connection,
  // so (as in board-authority.test.ts) a fake db forces both acquire flows to
  // read the empty claim table before either inserts. The winner is decided by
  // INSERT ... ON CONFLICT(action_key) DO NOTHING, exactly as Postgres would.
  test('concurrent acquire yields exactly one owner and one idempotent existing', async () => {
    const realDb = db;
    const holderTokenHash = sha256('token-a');
    const leaseRow = {
      lease_id: 'lease-a',
      principal_id: 'xo-model',
      seat_id: 'xo',
      holder_id: 'holder-a',
      holder_token_hash: holderTokenHash,
      fencing_token: 7,
      expires_at: '2999-01-01T00:00:00.000Z',
      released_at: null,
    };
    const proof: XoProof = {
      xo_holder_id: 'holder-a',
      xo_lease_id: 'lease-a',
      xo_fencing_token: 7,
      xo_holder_token: 'token-a',
    };

    let storedClaim: Record<string, unknown> | undefined;
    let selectsWhileEmpty = 0;
    let releaseBarrier: (() => void) | undefined;
    const bothSelected = new Promise<void>(resolve => {
      releaseBarrier = resolve;
    });

    const txQuery = mock(async (sql: string, params?: unknown[]) => {
      if (sql.includes('AS now')) {
        return { rows: [{ now: '2026-01-01T00:00:00.000Z' }], rowCount: 1 };
      }
      if (sql.includes('FROM board_xo_leases')) {
        return { rows: [leaseRow], rowCount: 1 };
      }
      if (sql.includes('MAX(event_sequence)')) {
        return { rows: [{ next: 1 }], rowCount: 1 };
      }
      if (sql.includes('SELECT * FROM board_execution_claims WHERE action_key')) {
        if (!storedClaim) {
          selectsWhileEmpty += 1;
          if (selectsWhileEmpty === 2) releaseBarrier?.();
          await bothSelected;
          return { rows: [], rowCount: 0 };
        }
        return { rows: [storedClaim], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO board_execution_claims')) {
        if (!storedClaim && params) {
          storedClaim = {
            claim_id: params[0],
            motion_id: params[1],
            action_kind: params[2],
            environment: params[3],
            target_sha: params[4],
            action_key: params[5],
            idempotency_key: params[5],
            motion_file_path: params[6],
            motion_revision_sha: params[7],
            claimant_principal: params[8],
            claimant_xo_holder_id: params[9],
            claimant_xo_lease_id: params[10],
            claimant_xo_fencing_token: params[11],
            execution_fencing_token: 1,
            status: 'active',
            reconciliation_status: 'clear',
            effect_attempt_id: null,
            effect_attempt_state: 'none',
            effect_armed_at: null,
            acquired_at: params[12],
            renewed_at: null,
            expires_at: params[13],
            released_at: null,
            completed_at: null,
            external_effect_reference: null,
            completion_evidence_json: null,
            reconciliation_evidence_json: null,
          };
        }
        return { rows: [], rowCount: 1 };
      }
      // event insert and anything else
      return { rows: [], rowCount: 1 };
    });

    const fakeDb = {
      dialect: 'sqlite',
      query: mock(async () => ({ rows: [], rowCount: 0 })),
      withTransaction: mock(async (fn: (q: typeof txQuery) => Promise<unknown>) => fn(txQuery)),
      close: mock(async () => {}),
    };

    db = fakeDb as unknown as SqliteAdapter;
    try {
      const [a, b] = await Promise.all([
        acquireExecutionClaim(acquireInput(proof), approvalDeps()),
        acquireExecutionClaim(acquireInput(proof), approvalDeps()),
      ]);

      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      const created = [a, b].filter(r => r.ok && r.created);
      const existing = [a, b].filter(r => r.ok && !r.created);
      expect(created).toHaveLength(1);
      expect(existing).toHaveLength(1);
      if (created[0]?.ok) expect(created[0].outcome).toBe('acquired');
      if (existing[0]?.ok) expect(existing[0].outcome).toBe('existing_active');
    } finally {
      db = realDb;
    }
  });

  // Test 2 -- Approval mismatch fails closed
  test('missing approval fails closed with a precondition audit event and no claim', async () => {
    const proof = await seedXo();
    const result = await acquireExecutionClaim(acquireInput(proof), rejectingDeps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('authority_rejected');
    expect(await claimCount()).toBe(0);
    expect(await countEvents('execution_claim_authority_rejected')).toBe(1);
  });

  test('target SHA mismatch fails closed with an identity-mismatch audit event', async () => {
    const proof = await seedXo();
    // Request target SHA differs from the approved action's target SHA.
    const result = await acquireExecutionClaim(
      acquireInput(proof, { target_sha: 'c'.repeat(40) }),
      approvalDeps({ target_sha: TARGET_SHA })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('authority_rejected');
    expect(await claimCount()).toBe(0);
    expect(await countEvents('execution_claim_authority_rejected')).toBe(1);
  });

  // Test 3 -- Takeover fencing
  test('expired takeover increments the fence and old token cannot mutate', async () => {
    const proof = await seedXo();
    const first = await acquireExecutionClaim(
      acquireInput(proof, { lease_duration_ms: 5 }),
      approvalDeps()
    );
    expect(first.ok && first.claim.execution_fencing_token).toBe(1);
    await Bun.sleep(20);

    const takeover = await acquireExecutionClaim(acquireInput(proof), approvalDeps());
    expect(takeover.ok).toBe(true);
    if (takeover.ok) {
      expect(takeover.outcome).toBe('taken_over');
      expect(takeover.claim.execution_fencing_token).toBe(2);
    }
    const claimId = takeover.ok ? takeover.claim.claim_id : '';

    const staleRenew = await renewExecutionClaim({
      claim_id: claimId,
      execution_fencing_token: 1,
      ...proof,
    });
    expect(staleRenew.ok).toBe(false);
    if (!staleRenew.ok) expect(staleRenew.code).toBe('stale_fence');

    const stalePreEffect = await validateExecutionFence(
      { claim_id: claimId, execution_fencing_token: 1, ...proof },
      approvalDeps()
    );
    expect(stalePreEffect.ok).toBe(false);

    const staleRelease = await releaseExecutionClaim({
      claim_id: claimId,
      execution_fencing_token: 1,
      ...proof,
    });
    expect(staleRelease.ok).toBe(false);
  });

  // Test 4 -- XO takeover during acquire validation
  test('XO lease change between parsing and CAS fails closed with no owner', async () => {
    const proof = await seedXo();
    const mutatingDeps: ExecutionClaimDependencies = {
      resolveApprovedAction: async () => {
        // A different XO takes over the singleton slot before the claim write.
        await db.query(
          `UPDATE board_xo_leases
             SET lease_id = $1, holder_id = $2, holder_token_hash = $3,
                 fencing_token = fencing_token + 1
           WHERE id = 1`,
          ['lease-b', 'holder-b', sha256('token-b')]
        );
        return {
          approved: {
            motion_id: MOTION_ID,
            environment: 'production' as const,
            target_sha: TARGET_SHA,
            motion_blob_sha: REVISION_SHA,
            acting_xo_principal_id: 'xo-model',
            second_seat_principal_id: 'general-model',
            john_principal_id: 'john-ranson',
          },
          motion_revision_sha: REVISION_SHA,
        };
      },
    };

    const result = await acquireExecutionClaim(acquireInput(proof), mutatingDeps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('authority_rejected');
    expect(await claimCount()).toBe(0);
    expect(await countEvents('execution_claim_authority_rejected')).toBe(1);
  });

  // Test 5 -- John/XO convergence
  test('John and XO initiation converge on one claim record', async () => {
    const proof = await seedXo();
    const johnAcquire = await acquireExecutionClaim(
      acquireInput(proof, { initiator_seat_id: 'john', initiator_principal_id: 'john-ranson' }),
      approvalDeps()
    );
    const xoAcquire = await acquireExecutionClaim(acquireInput(proof), approvalDeps());

    expect(johnAcquire.ok).toBe(true);
    expect(xoAcquire.ok).toBe(true);
    if (johnAcquire.ok && xoAcquire.ok) {
      expect(xoAcquire.claim.claim_id).toBe(johnAcquire.claim.claim_id);
    }
    expect(await claimCount()).toBe(1);
    expect(await countEvents('manual_initiation_recorded')).toBe(1);
  });

  // Test 6 -- Uncertain outcome reconciliation
  test('uncertain outcome blocks acquire and pre-effect until reconciled', async () => {
    const proof = await seedXo();
    const acquire = await acquireExecutionClaim(acquireInput(proof), approvalDeps());
    expect(acquire.ok).toBe(true);
    const claimId = acquire.ok ? acquire.claim.claim_id : '';

    const armed = await validateExecutionFence(
      { claim_id: claimId, execution_fencing_token: 1, ...proof },
      approvalDeps()
    );
    expect(armed.ok).toBe(true);
    const attemptId = armed.ok ? armed.effect_attempt_id : '';

    const marked = await markExecutionReconciliationRequired({
      claim_id: claimId,
      execution_fencing_token: 1,
      effect_attempt_id: attemptId,
      uncertainty: { reported_at: '2026-07-13T00:00:00Z', summary: 'deploy may have started' },
      ...proof,
    });
    expect(marked.ok).toBe(true);

    // Acquire and a second pre-effect are blocked while reconciliation is required.
    const blockedAcquire = await acquireExecutionClaim(acquireInput(proof), approvalDeps());
    expect(blockedAcquire.ok).toBe(false);
    if (!blockedAcquire.ok) expect(blockedAcquire.code).toBe('reconciliation_required');

    const blockedPreEffect = await validateExecutionFence(
      { claim_id: claimId, execution_fencing_token: 1, ...proof },
      approvalDeps()
    );
    expect(blockedPreEffect.ok).toBe(false);
    if (!blockedPreEffect.ok) expect(blockedPreEffect.code).toBe('reconciliation_required');

    const resolved = await resolveExecutionReconciliation({
      claim_id: claimId,
      execution_fencing_token: 1,
      effect_attempt_id: attemptId,
      resolution: 'retryable',
      evidence: {
        observed_at: '2026-07-13T00:01:00Z',
        checked_by: 'xo-model',
        command_or_source: 'live deploy status probe',
        observed_state: 'not_started',
        evidence_reference: 'https://example/log',
      },
      ...proof,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.claim.status).toBe('released');
      expect(resolved.claim.reconciliation_status).toBe('resolved_retryable');
    }
  });

  // Test 7 -- Completion fence and evidence
  test('completion requires the armed attempt, exact evidence, and happens once', async () => {
    const proof = await seedXo();
    const acquire = await acquireExecutionClaim(acquireInput(proof), approvalDeps());
    const claimId = acquire.ok ? acquire.claim.claim_id : '';
    const armed = await validateExecutionFence(
      { claim_id: claimId, execution_fencing_token: 1, ...proof },
      approvalDeps()
    );
    const attemptId = armed.ok ? armed.effect_attempt_id : '';

    const evidence = {
      verified_target_sha: TARGET_SHA,
      active_work_count: 0,
      backup_ready: true,
      rollback_ready: true,
      deployment_health: 'green',
      post_deploy_evidence: 'https://example/deploy',
    };

    const wrongAttempt = await completeExecutionClaim({
      claim_id: claimId,
      execution_fencing_token: 1,
      effect_attempt_id: 'not-the-attempt',
      external_effect_reference: 'ref-1',
      evidence,
      ...proof,
    });
    expect(wrongAttempt.ok).toBe(false);
    if (!wrongAttempt.ok) expect(wrongAttempt.code).toBe('effect_attempt_mismatch');

    const wrongSha = await completeExecutionClaim({
      claim_id: claimId,
      execution_fencing_token: 1,
      effect_attempt_id: attemptId,
      external_effect_reference: 'ref-1',
      evidence: { ...evidence, verified_target_sha: 'd'.repeat(40) },
      ...proof,
    });
    expect(wrongSha.ok).toBe(false);
    if (!wrongSha.ok) expect(wrongSha.code).toBe('validation_failed');

    const done = await completeExecutionClaim({
      claim_id: claimId,
      execution_fencing_token: 1,
      effect_attempt_id: attemptId,
      external_effect_reference: 'ref-1',
      evidence,
      ...proof,
    });
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.claim.status).toBe('completed');

    const secondComplete = await completeExecutionClaim({
      claim_id: claimId,
      execution_fencing_token: 1,
      effect_attempt_id: attemptId,
      external_effect_reference: 'ref-1',
      evidence,
      ...proof,
    });
    expect(secondComplete.ok).toBe(false);
  });

  // Test 8 -- Store separation
  test('module source references no Dispatch table, message claim, or Dispatch token', () => {
    const source = readFileSync(join(import.meta.dir, 'execution-claims.ts'), 'utf8');
    expect(source).not.toContain('agent_dispatch_messages');
    expect(source).not.toContain('claimMessage');
    expect(source).not.toContain('DispatchMessage');
    expect(source).not.toContain('dispatch_fencing');
    expect(source).toContain('board_execution_claims');
    expect(source).toContain('board_execution_claim_events');
  });

  // Test 9 -- Crash after permission is durably blocked
  test('armed-then-crash state blocks takeover but allows same-attempt completion', async () => {
    const proof = await seedXo();
    const acquire = await acquireExecutionClaim(
      acquireInput(proof, { lease_duration_ms: 5 }),
      approvalDeps()
    );
    const claimId = acquire.ok ? acquire.claim.claim_id : '';
    const armed = await validateExecutionFence(
      { claim_id: claimId, execution_fencing_token: 1, ...proof },
      approvalDeps()
    );
    expect(armed.ok).toBe(true);
    const attemptId = armed.ok ? armed.effect_attempt_id : '';

    // Simulate a crash after arming: the claim's lease expires with no completion.
    await Bun.sleep(20);

    // Even though expired, the armed/reconciliation-required state blocks takeover.
    const blockedTakeover = await acquireExecutionClaim(acquireInput(proof), approvalDeps());
    expect(blockedTakeover.ok).toBe(false);
    if (!blockedTakeover.ok) expect(blockedTakeover.code).toBe('reconciliation_required');

    // Only the same armed attempt can complete the claim.
    const completed = await completeExecutionClaim({
      claim_id: claimId,
      execution_fencing_token: 1,
      effect_attempt_id: attemptId,
      external_effect_reference: 'ref-9',
      evidence: {
        verified_target_sha: TARGET_SHA,
        active_work_count: 0,
        backup_ready: true,
        rollback_ready: true,
        deployment_health: 'green',
        post_deploy_evidence: 'https://example/deploy',
      },
      ...proof,
    });
    expect(completed.ok).toBe(true);
    if (completed.ok) expect(completed.claim.status).toBe('completed');
  });

  test('recovery execution claims conflict while active and allow expired takeover', async () => {
    const identity = {
      repository: 'bluedevilcollectibles/bdc-harness',
      wo_id: 'WO-RECOVERY-CLAIM',
      execution_id: 'exec-recovery-1',
      target_digest: sha256('target-recovery'),
    };

    const first = await acquireRecoveryExecutionClaim({
      ...identity,
      actor_principal: 'overseer-a',
      lease_duration_ms: 60_000,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.message);

    const conflicted = await acquireRecoveryExecutionClaim({
      ...identity,
      actor_principal: 'overseer-b',
      lease_duration_ms: 60_000,
    });
    expect(conflicted.ok).toBe(false);
    if (!conflicted.ok) {
      expect(conflicted.code).toBe('claim_conflict');
      expect(conflicted.holder?.claimant_principal).toBe('overseer-a');
    }

    const expired = await acquireRecoveryExecutionClaim({
      ...identity,
      execution_id: 'exec-recovery-expired',
      actor_principal: 'overseer-a',
      lease_duration_ms: -1,
    });
    expect(expired.ok).toBe(true);
    if (!expired.ok) throw new Error(expired.message);

    const takeover = await acquireRecoveryExecutionClaim({
      ...identity,
      execution_id: 'exec-recovery-expired',
      actor_principal: 'overseer-b',
      lease_duration_ms: 60_000,
    });
    expect(takeover.ok).toBe(true);
    if (!takeover.ok) throw new Error(takeover.message);
    expect(takeover.outcome).toBe('taken_over');
    expect(takeover.claim.claimant_principal).toBe('overseer-b');
    expect(takeover.claim.execution_fencing_token).toBe(expired.claim.execution_fencing_token + 1);

    const staleFence = await validateRecoveryExecutionFence({
      claim_id: expired.claim.claim_id,
      execution_fencing_token: expired.claim.execution_fencing_token,
      actor_principal: 'overseer-a',
    });
    expect(staleFence.ok).toBe(false);
    if (!staleFence.ok) expect(staleFence.code).toBe('authority_rejected');
  });

  // Test 10 -- Pre-claim rejection dedup and manual initiation writer
  test('repeated authority rejection deduplicates and only John writes manual initiation', async () => {
    const proof = await seedXo();
    // Two identical bad requests -> one deduplicated authority-rejection event.
    await acquireExecutionClaim(acquireInput(proof), rejectingDeps);
    await acquireExecutionClaim(acquireInput(proof), rejectingDeps);
    expect(await countEvents('execution_claim_authority_rejected')).toBe(1);
    expect(await claimCount()).toBe(0);

    // John initiation writes exactly one manual-initiation event; XO writes none.
    await acquireExecutionClaim(
      acquireInput(proof, { initiator_seat_id: 'john', initiator_principal_id: 'john-ranson' }),
      approvalDeps()
    );
    await acquireExecutionClaim(acquireInput(proof), approvalDeps());
    expect(await countEvents('manual_initiation_recorded')).toBe(1);
  });

  test('getExecutionClaim reads by exact action identity', async () => {
    const proof = await seedXo();
    await acquireExecutionClaim(acquireInput(proof), approvalDeps());
    const found = await getExecutionClaim(identity());
    expect(found).not.toBeNull();
    expect(found?.action_key).toBe(computeActionKey(identity()));
    const missing = await getExecutionClaim(identity({ target_sha: 'e'.repeat(40) }));
    expect(missing).toBeNull();
  });

  // Test 11 -- Dispatch foreign-key detector variants
  test('Stop 5 case-insensitive FK detector matches dispatch fixtures but not claim schemas', () => {
    const fkPattern =
      /REFERENCES\s+(?:(?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?(?:"agent_dispatch_messages"|agent_dispatch_messages)/i;

    expect(fkPattern.test('references agent_dispatch_messages(id)')).toBe(true);
    expect(fkPattern.test('REFERENCES "public"."agent_dispatch_messages"(id)')).toBe(true);

    const migration = readFileSync(
      join(import.meta.dir, '../../../../migrations', '032_board_execution_claims.sql'),
      'utf8'
    );
    const moduleSource = readFileSync(join(import.meta.dir, 'execution-claims.ts'), 'utf8');
    expect(fkPattern.test(migration)).toBe(false);
    expect(fkPattern.test(moduleSource)).toBe(false);
  });
});
