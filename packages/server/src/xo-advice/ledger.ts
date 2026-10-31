import { Database } from 'bun:sqlite';
import { isAbsolute } from 'path';

export interface LeaseBinding {
  lease_id: string;
  fencing_token: number;
  principal_id: string;
}
export const PILOT_MICROUSD = 1_000_000;

/** One configured durable file, one owner, one lifetime pilot. No reset API. */
export class AdviceLedger {
  private db: Database;
  private closed = false;

  constructor(file: string) {
    if (!isAbsolute(file) || file === ':memory:') throw new Error('durable_ledger_required');
    this.db = new Database(file, { create: true, strict: true });
    try {
      this.db.exec(`PRAGMA busy_timeout=1; PRAGMA locking_mode=EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS campaign (id INTEGER PRIMARY KEY CHECK(id=1), cap INTEGER NOT NULL, halted INTEGER NOT NULL);
        INSERT OR IGNORE INTO campaign VALUES(1,1000000,0);
        CREATE TABLE IF NOT EXISTS halt_reasons (reason TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, packet_hash TEXT NOT NULL UNIQUE, binding TEXT NOT NULL, packet TEXT NOT NULL, outcome TEXT);
        CREATE TABLE IF NOT EXISTS calls (request_id TEXT NOT NULL, leg INTEGER NOT NULL, reserve INTEGER NOT NULL, actual INTEGER, started INTEGER NOT NULL DEFAULT 0, attribution TEXT, PRIMARY KEY(request_id,leg));
        BEGIN EXCLUSIVE; COMMIT;`);
      const cap = this.db.query<{ cap: number }, []>('SELECT cap FROM campaign WHERE id=1').get();
      if (cap?.cap !== PILOT_MICROUSD) throw new Error('campaign_config_mismatch');
      const halted = this.db
        .query<{ halted: number }, []>('SELECT halted FROM campaign WHERE id=1')
        .get();
      const reasons = this.db
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM halt_reasons')
        .get();
      if (halted?.halted && reasons?.n === 0) this.halt('legacy_unclassified_halt');
      const pending = this.db
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM requests WHERE outcome IS NULL')
        .get();
      if (pending?.n) this.halt('interrupted_request');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  total(): number {
    const row = this.db
      .query<{ n: number }, []>('SELECT COALESCE(SUM(COALESCE(actual,reserve)),0) AS n FROM calls')
      .get();
    if (!row) throw new Error('ledger_invalid');
    return row.n;
  }

  halt(reason = 'unclassified_halt'): void {
    this.db.query('INSERT OR IGNORE INTO halt_reasons(reason) VALUES(?)').run(reason);
    this.db.exec('UPDATE campaign SET halted=1 WHERE id=1');
  }

  admit(
    id: string,
    hash: string,
    binding: LeaseBinding,
    reserves: number[],
    packet: unknown = {}
  ): void {
    if (!reserves.length || reserves.some(v => !Number.isSafeInteger(v) || v <= 0))
      throw new Error('invalid_reservation');
    this.db
      .transaction(() => {
        if (
          this.db.query<{ halted: number }, []>('SELECT halted FROM campaign WHERE id=1').get()
            ?.halted !== 0
        )
          throw new Error('campaign_halted');
        if (this.db.query('SELECT id FROM requests WHERE id=? OR packet_hash=?').get(id, hash))
          throw new Error('duplicate_request');
        if (this.total() + reserves.reduce((a, b) => a + b, 0) > PILOT_MICROUSD)
          throw new Error('pilot_cap');
        this.db
          .query('INSERT INTO requests(id,packet_hash,binding,packet) VALUES(?,?,?,?)')
          .run(id, hash, JSON.stringify(binding), JSON.stringify(packet));
        reserves.forEach((r, leg) =>
          this.db.query('INSERT INTO calls(request_id,leg,reserve) VALUES(?,?,?)').run(id, leg, r)
        );
      })
      .immediate();
  }

  started(id: string, leg: number): void {
    if (
      this.db.query<{ halted: number }, []>('SELECT halted FROM campaign WHERE id=1').get()
        ?.halted !== 0
    )
      throw new Error('campaign_halted');
    const result = this.db
      .query(
        'UPDATE calls SET started=1 WHERE request_id=? AND leg=? AND started=0 AND actual IS NULL'
      )
      .run(id, leg);
    if (result.changes !== 1) throw new Error('call_not_admitted');
  }

  settle(id: string, leg: number, actual: number | null): void {
    if (actual === null) {
      this.halt('unverified_charge');
      return;
    }
    if (!Number.isSafeInteger(actual) || actual < 0) throw new Error('invalid_charge');
    const row = this.db
      .query<
        { reserve: number },
        [string, number]
      >('SELECT reserve FROM calls WHERE request_id=? AND leg=? AND started=1 AND actual IS NULL')
      .get(id, leg);
    if (!row) throw new Error('call_not_started');
    this.db.query('UPDATE calls SET actual=? WHERE request_id=? AND leg=?').run(actual, id, leg);
    if (actual > row.reserve || this.total() > PILOT_MICROUSD) {
      this.halt('reservation_exceeded');
      throw new Error('reservation_exceeded');
    }
  }

  recordAttribution(id: string, leg: number, attribution: unknown): void {
    this.db
      .query('UPDATE calls SET attribution=? WHERE request_id=? AND leg=? AND started=1')
      .run(JSON.stringify(attribution), id, leg);
  }

  /** Operator CLI only, using a freshly fetched provider receipt, never a reset.
   * Completed/incomplete request identity remains non-replayable. */
  reconcileVerifiedCall(
    id: string,
    leg: number,
    receipt: { id: string; model: string; provider_name: string; total_cost: number }
  ): void {
    this.db
      .transaction(() => {
        const row = this.db
          .query<
            { attribution: string; reserve: number; actual: number | null },
            [string, number]
          >('SELECT attribution,reserve,actual FROM calls WHERE request_id=? AND leg=? AND started=1')
          .get(id, leg);
        if (row?.actual !== null || !row.attribution) throw new Error('reconciliation_not_pending');
        const observed = JSON.parse(row.attribution) as {
          requested_model?: string;
          served_model?: string;
          generation_id?: string;
          status?: string;
          reported_cost_usd?: number;
        };
        const model = observed.requested_model;
        const dated =
          model &&
          receipt.model.startsWith(model + '-') &&
          /^\d{8}$/.test(receipt.model.slice(model.length + 1));
        if (
          !model ||
          !['openai/gpt-6.1-terra', 'openai/gpt-6.1-sol'].includes(model) ||
          ![model, model.split('/')[1]].includes(observed.served_model ?? '') ||
          observed.status !== 'completed' ||
          receipt.id !== observed.generation_id ||
          receipt.provider_name !== 'OpenAI' ||
          (receipt.model !== model && !dated) ||
          !Number.isFinite(receipt.total_cost) ||
          receipt.total_cost < 0 ||
          (observed.reported_cost_usd !== undefined &&
            Math.abs(observed.reported_cost_usd - receipt.total_cost) > 1e-8)
        )
          throw new Error('reconciliation_receipt_mismatch');
        const actual = Math.ceil(receipt.total_cost * 1_000_000);
        if (actual > row.reserve) throw new Error('reconciliation_over_reserve');
        this.db
          .query('UPDATE calls SET actual=?, attribution=? WHERE request_id=? AND leg=?')
          .run(
            actual,
            JSON.stringify({ ...observed, receipt, late_receipt_reconciled: true }),
            id,
            leg
          );
        const unresolved = this.db
          .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM calls WHERE actual IS NULL')
          .get();
        const unfinished = this.db
          .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM requests WHERE outcome IS NULL')
          .get();
        const brokenBounds = this.db
          .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM calls WHERE actual>reserve')
          .get();
        if (
          unresolved?.n === 0 &&
          unfinished?.n === 0 &&
          brokenBounds?.n === 0 &&
          this.total() <= PILOT_MICROUSD
        ) {
          this.db.exec(
            "DELETE FROM halt_reasons WHERE reason IN ('unverified_charge','receipt_pending')"
          );
          const remaining = this.db
            .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM halt_reasons')
            .get();
          if (remaining?.n === 0) this.db.exec('UPDATE campaign SET halted=0 WHERE id=1');
        }
      })
      .immediate();
  }

  snapshot(): { requests: unknown[]; calls: unknown[]; conservative_microusd: number } {
    return {
      requests: this.db.query('SELECT * FROM requests').all(),
      calls: this.db.query('SELECT * FROM calls').all(),
      conservative_microusd: this.total(),
    };
  }

  finish(id: string, outcome: unknown): void {
    this.db
      .transaction(() => {
        // Only these calls are proven never sent. Started/unknown calls retain reserve.
        this.db.query('UPDATE calls SET actual=0 WHERE request_id=? AND started=0').run(id);
        this.db
          .query('UPDATE requests SET outcome=? WHERE id=? AND outcome IS NULL')
          .run(JSON.stringify(outcome), id);
      })
      .immediate();
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
