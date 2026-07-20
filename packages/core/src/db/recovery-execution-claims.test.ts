import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { IDatabase, QueryResult } from './adapters/types';
import type { AcquireRecoveryExecutionClaimInput } from './recovery-execution-claims';

let db: FakeDb;

mock.module('./connection', () => ({
  getDatabase: () => db,
}));

const {
  acquireRecoveryExecutionClaim,
  completeRecoveryExecutionClaim,
  computeRecoveryExecutionClaimKey,
  getRecoveryExecutionClaim,
  releaseRecoveryExecutionClaim,
  validateRecoveryExecutionFence,
} = await import('./recovery-execution-claims');

type Row = {
  claim_id: string;
  repository: string;
  wo_id: string;
  source_run_id: string | null;
  target_digest: string;
  scope_digest: string;
  action_key: string;
  actor_id: string;
  actor_kind: 'overseer' | 'conductor' | 'manual';
  execution_fencing_token: number;
  status: 'active' | 'released' | 'completed';
  effect_attempt_id: string | null;
  effect_attempt_state: 'none' | 'armed' | 'completed' | 'released';
  acquired_at: string;
  renewed_at: string | null;
  expires_at: string;
  released_at: string | null;
  completed_at: string | null;
  external_effect_reference: string | null;
  completion_evidence_json: string | null;
};

class FakeDb implements IDatabase {
  readonly dialect = 'sqlite' as const;
  readonly sql = {
    generateUuid: () => 'fake-uuid',
    now: () => "datetime('now')",
    jsonMerge: (column: string) => column,
    jsonArrayContains: () => '0',
    nowMinusDays: () => "datetime('now')",
    daysSince: () => '0',
  };
  readonly claims = new Map<string, Row>();
  readonly events = new Map<string, number>();

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const now = new Date().toISOString();
    if (sql.includes('AS now')) return qr([{ now }] as T[]);
    if (sql.includes('SELECT * FROM remote_agent_recovery_execution_claims WHERE action_key')) {
      const row = this.claims.get(String(params[0]));
      return qr((row ? [row] : []) as T[]);
    }
    if (sql.includes('SELECT * FROM remote_agent_recovery_execution_claims WHERE claim_id')) {
      const row = [...this.claims.values()].find(claim => claim.claim_id === params[0]);
      return qr((row ? [row] : []) as T[]);
    }
    if (sql.includes('COALESCE(MAX(event_sequence)')) {
      const claimId = String(params[0]);
      return qr([{ next: (this.events.get(claimId) ?? 0) + 1 }] as T[]);
    }
    if (sql.includes('INSERT INTO remote_agent_recovery_execution_claim_events')) {
      const claimId = String(params[1]);
      this.events.set(claimId, Number(params[2]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO remote_agent_recovery_execution_claims')) {
      const actionKey = String(params[6]);
      if (!this.claims.has(actionKey)) {
        this.claims.set(actionKey, {
          claim_id: String(params[0]),
          repository: String(params[1]),
          wo_id: String(params[2]),
          source_run_id: params[3] === null ? null : String(params[3]),
          target_digest: String(params[4]),
          scope_digest: String(params[5]),
          action_key: actionKey,
          actor_id: String(params[7]),
          actor_kind: params[8] as Row['actor_kind'],
          execution_fencing_token: 1,
          status: 'active',
          effect_attempt_id: null,
          effect_attempt_state: 'none',
          acquired_at: String(params[9]),
          renewed_at: null,
          expires_at: String(params[10]),
          released_at: null,
          completed_at: null,
          external_effect_reference: null,
          completion_evidence_json: null,
        });
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET actor_id = $1, actor_kind = $2, execution_fencing_token = $3")) {
      const actionKey = String(params[5]);
      const row = this.claims.get(actionKey);
      if (row) {
        row.actor_id = String(params[0]);
        row.actor_kind = params[1] as Row['actor_kind'];
        row.execution_fencing_token = Number(params[2]);
        row.status = 'active';
        row.effect_attempt_id = null;
        row.effect_attempt_state = 'none';
        row.acquired_at = String(params[3]);
        row.renewed_at = null;
        row.expires_at = String(params[4]);
        row.released_at = null;
        row.completed_at = null;
        row.external_effect_reference = null;
        row.completion_evidence_json = null;
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("SET effect_attempt_id = $1, effect_attempt_state = 'armed'")) {
      const row = [...this.claims.values()].find(claim => claim.claim_id === params[1]);
      if (row && row.execution_fencing_token === params[2] && row.effect_attempt_state === 'none') {
        row.effect_attempt_id = String(params[0]);
        row.effect_attempt_state = 'armed';
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SET status = 'completed'")) {
      const row = [...this.claims.values()].find(claim => claim.claim_id === params[3]);
      if (row && row.execution_fencing_token === params[4]) {
        row.status = 'completed';
        row.effect_attempt_state = 'completed';
        row.completed_at = String(params[0]);
        row.external_effect_reference = params[1] === null ? null : String(params[1]);
        row.completion_evidence_json = String(params[2]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SET status = 'released'")) {
      const row = [...this.claims.values()].find(claim => claim.claim_id === params[1]);
      if (row && row.execution_fencing_token === params[2]) {
        row.status = 'released';
        row.effect_attempt_state = 'released';
        row.released_at = String(params[0]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }

  async withTransaction<T>(fn: Parameters<IDatabase['withTransaction']>[0]): Promise<T> {
    return fn(this.query.bind(this));
  }

  async close(): Promise<void> {
    return undefined;
  }
}

function qr<T>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length };
}

function acquireInput(
  overrides: Partial<AcquireRecoveryExecutionClaimInput> = {}
): AcquireRecoveryExecutionClaimInput {
  return {
    repository: 'bluedevilcollectibles/bdc-harness',
    wo_id: 'WO-RECOVERY-CLAIM-01',
    source_run_id: 'run-1',
    target_digest: 'target-digest',
    scope_digest: 'scope-digest',
    actor_id: 'overseer-a',
    actor_kind: 'overseer',
    ...overrides,
  };
}

describe('recovery execution claims db', () => {
  beforeEach(async () => {
    db = new FakeDb();
  });

  afterEach(async () => {
    await db.close();
  });

  test('acquire returns one active claim and conflicts for another active actor', async () => {
    const first = await acquireRecoveryExecutionClaim(acquireInput());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.message);
    expect(first.claim.execution_fencing_token).toBe(1);

    const second = await acquireRecoveryExecutionClaim(
      acquireInput({ actor_id: 'conductor-a', actor_kind: 'conductor' })
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('second actor unexpectedly acquired claim');
    expect(second.code).toBe('claim_conflict');
    expect(second.holder?.actor_id).toBe('overseer-a');

    const found = await getRecoveryExecutionClaim(acquireInput());
    expect(found?.action_key).toBe(computeRecoveryExecutionClaimKey(acquireInput()));
  });

  test('release permits a later reacquire with a higher fence', async () => {
    const first = await acquireRecoveryExecutionClaim(acquireInput());
    if (!first.ok) throw new Error(first.message);

    const released = await releaseRecoveryExecutionClaim({
      claim_id: first.claim.claim_id,
      execution_fencing_token: first.claim.execution_fencing_token,
      actor_id: first.claim.actor_id,
      actor_kind: first.claim.actor_kind,
      reason: 'no_effect',
    });
    expect(released.ok).toBe(true);

    const reacquired = await acquireRecoveryExecutionClaim(
      acquireInput({ actor_id: 'manual-a', actor_kind: 'manual' })
    );
    expect(reacquired.ok).toBe(true);
    if (reacquired.ok) {
      expect(reacquired.outcome).toBe('reactivated');
      expect(reacquired.claim.execution_fencing_token).toBe(2);
    }
  });

  test('expired takeover increments fence and stale token cannot complete', async () => {
    const first = await acquireRecoveryExecutionClaim(acquireInput({ lease_duration_ms: 5 }));
    if (!first.ok) throw new Error(first.message);
    await Bun.sleep(20);

    const takeover = await acquireRecoveryExecutionClaim(
      acquireInput({ actor_id: 'overseer-b', actor_kind: 'overseer' })
    );
    expect(takeover.ok).toBe(true);
    if (!takeover.ok) throw new Error(takeover.message);
    expect(takeover.outcome).toBe('taken_over');
    expect(takeover.claim.execution_fencing_token).toBe(2);

    const fenced = await validateRecoveryExecutionFence({
      claim_id: takeover.claim.claim_id,
      execution_fencing_token: takeover.claim.execution_fencing_token,
      actor_id: takeover.claim.actor_id,
      actor_kind: takeover.claim.actor_kind,
    });
    expect(fenced.ok).toBe(true);
    if (!fenced.ok) throw new Error(fenced.message);

    const staleComplete = await completeRecoveryExecutionClaim({
      claim_id: first.claim.claim_id,
      execution_fencing_token: first.claim.execution_fencing_token,
      effect_attempt_id: fenced.effect_attempt_id,
      actor_id: first.claim.actor_id,
      actor_kind: first.claim.actor_kind,
      external_effect_reference: 'fake://old-token',
      evidence: { outcome: 'stale' },
    });
    expect(staleComplete.ok).toBe(false);
    if (!staleComplete.ok) expect(staleComplete.code).toBe('stale_fence');

    const complete = await completeRecoveryExecutionClaim({
      claim_id: takeover.claim.claim_id,
      execution_fencing_token: takeover.claim.execution_fencing_token,
      effect_attempt_id: fenced.effect_attempt_id,
      actor_id: takeover.claim.actor_id,
      actor_kind: takeover.claim.actor_kind,
      external_effect_reference: 'fake://success',
      evidence: { outcome: 'succeeded' },
    });
    expect(complete.ok).toBe(true);
    if (complete.ok) expect(complete.claim.status).toBe('completed');
  });
});
