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
        CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, packet_hash TEXT NOT NULL UNIQUE, binding TEXT NOT NULL, packet TEXT NOT NULL, outcome TEXT);
        CREATE TABLE IF NOT EXISTS calls (request_id TEXT NOT NULL, leg INTEGER NOT NULL, reserve INTEGER NOT NULL, actual INTEGER, started INTEGER NOT NULL DEFAULT 0, attribution TEXT, PRIMARY KEY(request_id,leg));
        BEGIN EXCLUSIVE; COMMIT;`);
      const cap = this.db.query<{ cap: number }, []>('SELECT cap FROM campaign WHERE id=1').get();
      if (cap?.cap !== PILOT_MICROUSD) throw new Error('campaign_config_mismatch');
      const pending = this.db
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM requests WHERE outcome IS NULL')
        .get();
      if (pending?.n) this.halt();
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

  halt(): void {
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
      this.halt();
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
      this.halt();
      throw new Error('reservation_exceeded');
    }
  }

  recordAttribution(id: string, leg: number, attribution: unknown): void {
    this.db
      .query('UPDATE calls SET attribution=? WHERE request_id=? AND leg=? AND started=1')
      .run(JSON.stringify(attribution), id, leg);
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
