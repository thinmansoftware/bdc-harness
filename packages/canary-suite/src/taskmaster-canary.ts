import { Database } from 'bun:sqlite';
import type { CanaryVerdict } from './types';

const DEFAULT_INTERVAL_MS = 60_000;
export const TASKMASTER_CANARY_P2_NUDGE_CLOCK_MS = 24 * 60 * 60 * 1_000;

interface Query<T> {
  all(...params: unknown[]): T[];
  get(...params: unknown[]): T | null;
}

export interface TaskmasterCanaryDatabase {
  query<T>(sql: string): Query<T>;
}

export interface TaskmasterCanaryResult {
  readonly verdict: CanaryVerdict;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly checks?: readonly TaskmasterCanaryResult[];
}

export interface TaskmasterCanaryDeps {
  readonly dbPath?: string;
  readonly db?: TaskmasterCanaryDatabase;
  readonly now?: () => number;
  readonly fetcher?: typeof fetch;
  readonly statusUrl?: string;
  readonly operatorToken?: string;
  readonly intervalMs?: number;
  readonly githubRepo?: string;
  readonly githubIssue?: number;
  readonly nudgeClockMs?: number;
}

interface JournalTimestampRow {
  readonly created_at: string;
}

interface JournalNudgeRow extends JournalTimestampRow {
  readonly idempotency_key: string;
  readonly outcome: string;
}

function openDatabase(deps: TaskmasterCanaryDeps): {
  db: TaskmasterCanaryDatabase;
  close: () => void;
} {
  if (deps.db) return { db: deps.db, close: () => undefined };
  if (!deps.dbPath) throw new Error('taskmaster_canary_db_path_required');
  const db = new Database(deps.dbPath, { readonly: true });
  return {
    db,
    close: (): void => {
      db.close();
    },
  };
}

function failed(reasonCode: string, evidenceRefs: readonly string[]): TaskmasterCanaryResult {
  return { verdict: 'failed', reasonCodes: [reasonCode], evidenceRefs };
}

async function statusEvidence(deps: TaskmasterCanaryDeps): Promise<{
  intervalMs?: number;
  evidenceRefs: string[];
}> {
  if (!deps.statusUrl || !deps.operatorToken) return { evidenceRefs: [] };
  try {
    const response = await (deps.fetcher ?? fetch)(deps.statusUrl, {
      headers: { 'x-archon-operator-token': deps.operatorToken },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { evidenceRefs: [`taskmaster_status_http=${response.status}`] };
    const body = (await response.json()) as {
      interval_ms?: unknown;
      last_tick_at?: unknown;
      tick_health?: unknown;
    };
    const intervalMs =
      typeof body.interval_ms === 'number' && body.interval_ms > 0 ? body.interval_ms : undefined;
    const tickHealth = typeof body.tick_health === 'string' ? body.tick_health : 'unknown';
    const lastTickAt = typeof body.last_tick_at === 'string' ? body.last_tick_at : 'unknown';
    return {
      intervalMs,
      evidenceRefs: [
        `taskmaster_status.tick_health=${tickHealth}`,
        `taskmaster_status.last_tick_at=${lastTickAt}`,
      ],
    };
  } catch (error) {
    return { evidenceRefs: [`taskmaster_status_error=${(error as Error).message}`] };
  }
}

export async function runTaskmasterHeartbeatCheck(
  deps: TaskmasterCanaryDeps
): Promise<TaskmasterCanaryResult> {
  let opened: ReturnType<typeof openDatabase>;
  try {
    opened = openDatabase(deps);
  } catch (error) {
    return failed('tm_journal_unreachable', [`error=${(error as Error).message}`]);
  }
  try {
    let row: JournalTimestampRow | null;
    try {
      row = opened.db
        .query<JournalTimestampRow>(
          'SELECT created_at FROM tm_journal ORDER BY created_at DESC LIMIT 1'
        )
        .get();
    } catch (error) {
      return failed('tm_journal_unreachable', [`error=${(error as Error).message}`]);
    }
    if (!row) return failed('tm_journal_empty', ['tm_journal.row_count=0']);

    const observedAt = Date.parse(row.created_at);
    if (!Number.isFinite(observedAt)) {
      return failed('tick_heartbeat_stale', [
        `tm_journal.created_at=${row.created_at}`,
        'age_ms=invalid',
      ]);
    }
    const status = await statusEvidence(deps);
    const intervalMs = deps.intervalMs ?? status.intervalMs ?? DEFAULT_INTERVAL_MS;
    const ageMs = (deps.now ?? Date.now)() - observedAt;
    const evidenceRefs = [
      `tm_journal.created_at=${row.created_at}`,
      `age_ms=${ageMs}`,
      `threshold_ms=${2 * intervalMs}`,
      ...status.evidenceRefs,
    ];
    return ageMs > 2 * intervalMs
      ? failed('tick_heartbeat_stale', evidenceRefs)
      : { verdict: 'passed', reasonCodes: [], evidenceRefs };
  } finally {
    opened.close();
  }
}

export async function runTaskmasterSyntheticIdempotencyCheck(
  deps: TaskmasterCanaryDeps
): Promise<TaskmasterCanaryResult> {
  if (!deps.githubRepo || !deps.githubIssue) {
    return failed('synthetic_target_required', ['github_repo_and_issue_required']);
  }
  let opened: ReturnType<typeof openDatabase>;
  try {
    opened = openDatabase(deps);
  } catch (error) {
    return failed('tm_journal_unreachable', [`error=${(error as Error).message}`]);
  }
  try {
    const prefix = `tm:nudge:gh:${deps.githubRepo}#${deps.githubIssue}:`;
    let rows: JournalNudgeRow[];
    try {
      rows = opened.db
        .query<JournalNudgeRow>(
          'SELECT idempotency_key, created_at, outcome FROM tm_journal WHERE idempotency_key LIKE ? ORDER BY created_at DESC'
        )
        .all(`${prefix}%`);
    } catch (error) {
      return failed('tm_journal_unreachable', [`error=${(error as Error).message}`]);
    }
    const sentCounts = new Map<string, number>();
    for (const row of rows) {
      if (row.outcome === 'sent')
        sentCounts.set(row.idempotency_key, (sentCounts.get(row.idempotency_key) ?? 0) + 1);
    }
    const duplicate = [...sentCounts].find(([, count]) => count > 1);
    if (duplicate) {
      return failed('synthetic_target_duplicate_nudge_same_key', [
        `idempotency_key=${duplicate[0]}`,
        `sent_count=${duplicate[1]}`,
      ]);
    }
    const nowMs = (deps.now ?? Date.now)();
    const windowMs = 2 * (deps.nudgeClockMs ?? TASKMASTER_CANARY_P2_NUDGE_CLOCK_MS);
    const fresh = rows.find(row => {
      const createdAt = Date.parse(row.created_at);
      return Number.isFinite(createdAt) && nowMs - createdAt <= windowMs;
    });
    if (!fresh) {
      return failed('synthetic_target_no_nudge_in_window', [
        `idempotency_key_prefix=${prefix}`,
        `window_ms=${windowMs}`,
        `matching_rows=${rows.length}`,
      ]);
    }
    return {
      verdict: 'passed',
      reasonCodes: [],
      evidenceRefs: [
        `idempotency_key=${fresh.idempotency_key}`,
        `tm_journal.created_at=${fresh.created_at}`,
      ],
    };
  } finally {
    opened.close();
  }
}

export async function runTaskmasterCanarySuite(
  deps: TaskmasterCanaryDeps
): Promise<TaskmasterCanaryResult> {
  const checks = await Promise.all([
    runTaskmasterHeartbeatCheck(deps),
    runTaskmasterSyntheticIdempotencyCheck(deps),
  ]);
  return {
    verdict: checks.every(check => check.verdict === 'passed') ? 'passed' : 'failed',
    reasonCodes: checks.flatMap(check => check.reasonCodes),
    evidenceRefs: checks.flatMap(check => check.evidenceRefs),
    checks,
  };
}
