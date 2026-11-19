import { Database } from 'bun:sqlite';
import type { CanaryVerdict } from './types';

/**
 * Dispatch worker heartbeat freshness (WO-HARNESS-DISPATCH-WORKER-STALE-LOCK-01, Test 7).
 *
 * This is a SELECTED-SOURCE freshness diagnostic: it reads one worker's
 * agent_dispatch_workers.last_heartbeat_at from the one read-only SQLite file it is
 * pointed at and compares it to the clock. It is NOT a runtime-health attestation: a fresh
 * row in an unrelated SQLite file passes, and the result always says
 * runtime_health=not_assessed. It changes no alarm semantics and sends nothing.
 */

/** Matches the existing five-minute worker alarm with one interval of slack. */
export const DISPATCH_WORKER_HEARTBEAT_THRESHOLD_MS = 600_000;

export const DISPATCH_WORKER_ASSESSMENT_SCOPE = 'selected_source_heartbeat_freshness' as const;

interface Query<T> {
  all(...params: unknown[]): T[];
  get(...params: unknown[]): T | null;
}

export interface DispatchWorkerCanaryDatabase {
  query<T>(sql: string): Query<T>;
}

export interface DispatchWorkerCanaryDeps {
  readonly dbPath?: string;
  readonly db?: DispatchWorkerCanaryDatabase;
  readonly workerId: string;
  readonly now?: () => number;
}

export interface DispatchWorkerCanaryEvidence {
  readonly worker_id: string;
  readonly last_heartbeat_at: string | null;
  readonly age_ms: number | null;
  readonly threshold_ms: number;
  readonly source_ref: string;
  readonly assessment_scope: typeof DISPATCH_WORKER_ASSESSMENT_SCOPE;
  readonly runtime_health: 'not_assessed';
}

export interface DispatchWorkerCanaryResult {
  readonly verdict: Extract<CanaryVerdict, 'passed' | 'failed' | 'blocked'>;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly evidence: DispatchWorkerCanaryEvidence;
}

interface HeartbeatRow {
  readonly last_heartbeat_at: unknown;
}

// Strict ISO-8601 with an explicit offset. A bare SQLite datetime ("2026-11-09 12:00:00")
// is rejected: JavaScript would read it as LOCAL time and could hide hours of staleness.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function result(
  verdict: DispatchWorkerCanaryResult['verdict'],
  reasonCode: string | null,
  evidence: Omit<DispatchWorkerCanaryEvidence, 'assessment_scope' | 'runtime_health'>
): DispatchWorkerCanaryResult {
  const full: DispatchWorkerCanaryEvidence = {
    ...evidence,
    assessment_scope: DISPATCH_WORKER_ASSESSMENT_SCOPE,
    runtime_health: 'not_assessed',
  };
  return {
    verdict,
    reasonCodes: reasonCode ? [reasonCode] : [],
    evidenceRefs: [
      `worker_id=${full.worker_id}`,
      `last_heartbeat_at=${full.last_heartbeat_at ?? 'none'}`,
      `age_ms=${full.age_ms ?? 'unknown'}`,
      `threshold_ms=${full.threshold_ms}`,
      `source_ref=${full.source_ref}`,
      `assessment_scope=${full.assessment_scope}`,
      `runtime_health=${full.runtime_health}`,
    ],
    evidence: full,
  };
}

export async function runDispatchWorkerHeartbeatCheck(
  deps: DispatchWorkerCanaryDeps
): Promise<DispatchWorkerCanaryResult> {
  const sourceRef = deps.db ? 'injected_db' : (deps.dbPath ?? 'none');
  const base = {
    worker_id: deps.workerId,
    last_heartbeat_at: null,
    age_ms: null,
    threshold_ms: DISPATCH_WORKER_HEARTBEAT_THRESHOLD_MS,
    source_ref: sourceRef,
  };

  let db: DispatchWorkerCanaryDatabase;
  let close: () => void = () => undefined;
  if (deps.db) {
    db = deps.db;
  } else {
    if (!deps.dbPath) return result('blocked', 'dispatch_worker_db_path_required', base);
    try {
      const opened = new Database(deps.dbPath, { readonly: true });
      // Prepared and finalized per call (db.query() caches a statement that keeps the file
      // open on Windows after close()).
      db = {
        query: <T>(sql: string): Query<T> => ({
          all: (...params: unknown[]): T[] => {
            const statement = opened.prepare(sql);
            try {
              return statement.all(...(params as never[])) as T[];
            } finally {
              statement.finalize();
            }
          },
          get: (...params: unknown[]): T | null => {
            const statement = opened.prepare(sql);
            try {
              return statement.get(...(params as never[])) as T | null;
            } finally {
              statement.finalize();
            }
          },
        }),
      };
      close = (): void => {
        opened.close();
      };
    } catch {
      return result('blocked', 'dispatch_worker_db_unreachable', base);
    }
  }

  try {
    let row: HeartbeatRow | null;
    try {
      row = db
        .query<HeartbeatRow>(
          'SELECT last_heartbeat_at FROM agent_dispatch_workers WHERE worker_id = ?'
        )
        .get(deps.workerId);
    } catch {
      return result('blocked', 'dispatch_worker_db_unreachable', base);
    }
    if (!row) return result('failed', 'dispatch_worker_not_found', base);

    const raw = row.last_heartbeat_at;
    if (typeof raw !== 'string' || !ISO_WITH_OFFSET.test(raw)) {
      return result('failed', 'heartbeat_timestamp_invalid', {
        ...base,
        last_heartbeat_at: typeof raw === 'string' ? raw : null,
      });
    }
    const observedAt = Date.parse(raw);
    if (!Number.isFinite(observedAt)) {
      return result('failed', 'heartbeat_timestamp_invalid', { ...base, last_heartbeat_at: raw });
    }
    const ageMs = (deps.now ?? Date.now)() - observedAt;
    const evidence = { ...base, last_heartbeat_at: raw, age_ms: ageMs };
    if (ageMs < 0) return result('failed', 'heartbeat_timestamp_in_future', evidence);
    // Exactly the threshold is fresh; one millisecond more is stale.
    if (ageMs > DISPATCH_WORKER_HEARTBEAT_THRESHOLD_MS) {
      return result('failed', 'dispatch_worker_heartbeat_stale', evidence);
    }
    return result('passed', null, evidence);
  } finally {
    close();
  }
}
