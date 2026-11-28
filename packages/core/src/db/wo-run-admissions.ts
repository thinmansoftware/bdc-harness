import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getDatabase } from './connection';
import type { IDatabase } from './adapters/types';

interface WoRunAdmission {
  readonly woId: string;
  readonly reservationId: string;
}

type TransactionQuery = Parameters<Parameters<IDatabase['withTransaction']>[0]>[0];

// The orchestrator has several routes to the workflow store. Scope the fence
// to the admitted dispatch, including its conversation-queue callback.
const admissionContext = new AsyncLocalStorage<WoRunAdmission | undefined>();
export const currentWoRunAdmission = (): WoRunAdmission | undefined => admissionContext.getStore();

export function withWoRunAdmission<T>(admission: WoRunAdmission | undefined, task: () => T): T {
  return admissionContext.run(admission, task);
}

const LEASE_SECONDS = 300;

function epochNow(db: IDatabase): string {
  return db.dialect === 'postgres'
    ? 'FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::bigint'
    : "CAST(strftime('%s', 'now') AS INTEGER)";
}

export async function reserveWoRunAdmission(woId: string): Promise<WoRunAdmission | undefined> {
  const db = getDatabase();
  const now = epochNow(db);
  const reservationId = randomUUID();
  const inserted = await db.query(
    `INSERT INTO wo_run_admissions (wo_id, reservation_id, expires_at_epoch)
     VALUES ($1, $2, ${now} + $3)
     ON CONFLICT (wo_id) DO UPDATE
     SET reservation_id = excluded.reservation_id, expires_at_epoch = ${now} + $3
     WHERE wo_run_admissions.expires_at_epoch <= ${now}`,
    [woId, reservationId, LEASE_SECONDS]
  );
  return inserted.rowCount === 1 ? { woId, reservationId } : undefined;
}

export async function releaseWoRunAdmission(admission: WoRunAdmission): Promise<void> {
  await getDatabase().query(
    'DELETE FROM wo_run_admissions WHERE wo_id = $1 AND reservation_id = $2',
    [admission.woId, admission.reservationId]
  );
}

// The delete and the run write commit together. A stale dispatch cannot write
// after expiry or takeover, and a competing reservation waits for the commit.
export async function consumeWoRunAdmission(
  db: IDatabase,
  query: TransactionQuery,
  admission: WoRunAdmission
): Promise<void> {
  const removed = await query(
    `DELETE FROM wo_run_admissions
     WHERE wo_id = $1 AND reservation_id = $2 AND expires_at_epoch > ${epochNow(db)}`,
    [admission.woId, admission.reservationId]
  );
  if (removed.rowCount !== 1) throw new Error('wo_run_admission_expired_or_lost');
}

export async function persistWoRunAdmission<T>(
  admission: WoRunAdmission,
  persist: (query: TransactionQuery) => Promise<T>
): Promise<T> {
  const db = getDatabase();
  return db.withTransaction(
    async query => {
      await consumeWoRunAdmission(db, query, admission);
      return persist(query);
    },
    { immediate: true }
  );
}
