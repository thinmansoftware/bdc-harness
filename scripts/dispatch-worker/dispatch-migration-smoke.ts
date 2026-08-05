import { Database, constants } from 'bun:sqlite';
import { createHash } from 'crypto';
import { copyFile, mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const KNOWN_LIVE_PATHS = new Set(['/.archon/archon.db', '/opt/bdc/archon-data/archon.db']);
const PHASE_0_MESSAGE_COLUMNS = [
  'priority',
  'task_outcome',
  'acknowledged_at',
  'acknowledged_by',
  'addressed_at',
  'addressed_by',
  'escalated_tg_at',
  'escalated_sms_at',
  'subject_key',
  'route_disposition',
  'supersedes_id',
] as const;
const PRINCIPAL_COLUMNS = [
  'principal_id',
  'display_name',
  'delivery_mode',
  'active',
  'created_at',
  'updated_at',
] as const;

interface SmokeArguments {
  sourceCopy: string;
  expectedHeartbeats: number;
}

interface CountRow {
  count: number;
}

interface NameRow {
  name: string;
}

interface MigrationSnapshot {
  messageColumns: string[];
  principalColumns: string[];
  rows: number;
  heartbeatRows: number;
  otherHeartbeatRows: number;
  otherNonNormalRows: number;
  missingLivePrincipalRows: number;
}

function parseArguments(args: string[]): SmokeArguments {
  let sourceCopy: string | null = null;
  let expectedHeartbeatsText: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === '--source-copy' && value) {
      sourceCopy = value;
      index += 1;
      continue;
    }
    if (argument === '--expected-heartbeats' && value) {
      expectedHeartbeatsText = value;
      index += 1;
      continue;
    }
    throw new Error(`unsupported argument: ${argument ?? ''}`);
  }

  if (!sourceCopy) throw new Error('--source-copy is required');
  if (KNOWN_LIVE_PATHS.has(sourceCopy.replace(/\\/g, '/'))) {
    throw new Error('refusing known live database path');
  }
  if (expectedHeartbeatsText === null) throw new Error('--expected-heartbeats is required');
  const expectedHeartbeats = Number(expectedHeartbeatsText);
  if (!Number.isSafeInteger(expectedHeartbeats) || expectedHeartbeats < 0) {
    throw new Error('--expected-heartbeats must be a non-negative integer');
  }
  return { sourceCopy, expectedHeartbeats };
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function count(database: Database, sql: string): number {
  const row = database.query<CountRow, []>(sql).get();
  if (!row) throw new Error('migration smoke count query returned no row');
  return row.count;
}

function columnNames(database: Database, table: string): string[] {
  return database
    .query<NameRow, []>(`PRAGMA table_info('${table}')`)
    .all()
    .map(row => row.name)
    .sort();
}

function inspectBeforeMigration(path: string): { rows: number; messageColumns: string[] } {
  const database = new Database(path, constants.SQLITE_OPEN_READONLY);
  try {
    return {
      rows: count(database, 'SELECT COUNT(*) AS count FROM agent_dispatch_messages'),
      messageColumns: columnNames(database, 'agent_dispatch_messages'),
    };
  } finally {
    database.close();
  }
}

function inspectAfterMigration(path: string): MigrationSnapshot {
  const database = new Database(path, constants.SQLITE_OPEN_READONLY);
  try {
    return {
      messageColumns: columnNames(database, 'agent_dispatch_messages'),
      principalColumns: columnNames(database, 'dispatch_principals'),
      rows: count(database, 'SELECT COUNT(*) AS count FROM agent_dispatch_messages'),
      heartbeatRows: count(
        database,
        `SELECT COUNT(*) AS count
         FROM agent_dispatch_messages
         WHERE status = 'queued' AND task_type = 'run_report' AND priority = 'heartbeat'`
      ),
      otherHeartbeatRows: count(
        database,
        `SELECT COUNT(*) AS count
         FROM agent_dispatch_messages
         WHERE priority = 'heartbeat'
           AND NOT (status = 'queued' AND task_type = 'run_report')`
      ),
      otherNonNormalRows: count(
        database,
        `SELECT COUNT(*) AS count
         FROM agent_dispatch_messages
         WHERE NOT (status = 'queued' AND task_type = 'run_report')
           AND priority <> 'normal'`
      ),
      missingLivePrincipalRows: count(
        database,
        `SELECT COUNT(*) AS count
         FROM (
           SELECT DISTINCT LOWER(TRIM(message.recipient)) AS principal_id
           FROM agent_dispatch_messages AS message
           LEFT JOIN dispatch_principals AS principal
             ON principal.principal_id = LOWER(TRIM(message.recipient))
           WHERE TRIM(message.recipient) <> '' AND principal.principal_id IS NULL
         )`
      ),
    };
  } finally {
    database.close();
  }
}

function assertColumns(actual: string[], required: readonly string[], table: string): void {
  const missing = required.filter(column => !actual.includes(column));
  if (missing.length > 0) {
    throw new Error(`${table} missing columns: ${missing.join(', ')}`);
  }
}

function assertFirstMigration(
  before: { rows: number; messageColumns: string[] },
  after: MigrationSnapshot,
  expectedHeartbeats: number
): void {
  assertColumns(after.messageColumns, PHASE_0_MESSAGE_COLUMNS, 'agent_dispatch_messages');
  assertColumns(after.principalColumns, PRINCIPAL_COLUMNS, 'dispatch_principals');
  if (after.rows !== before.rows) {
    throw new Error(`message count changed from ${before.rows} to ${after.rows}`);
  }
  if (after.heartbeatRows !== expectedHeartbeats) {
    throw new Error(`expected ${expectedHeartbeats} heartbeat rows, found ${after.heartbeatRows}`);
  }
  if (after.otherHeartbeatRows !== 0) {
    throw new Error(`found ${after.otherHeartbeatRows} unexpected pre-existing heartbeat rows`);
  }
  if (after.otherNonNormalRows !== 0) {
    throw new Error(`found ${after.otherNonNormalRows} non-heartbeat rows without normal priority`);
  }
  if (after.missingLivePrincipalRows !== 0) {
    throw new Error(`found ${after.missingLivePrincipalRows} live recipients missing principals`);
  }
}

async function runRealMigration(path: string): Promise<void> {
  process.env.LOG_LEVEL = 'fatal';
  const sqliteModule = await import('../../packages/core/src/db/adapters/sqlite');
  const adapter = new sqliteModule.SqliteAdapter(path);
  try {
    await adapter.query('SELECT 1');
  } finally {
    await adapter.close();
  }
}

export async function runDispatchMigrationSmoke(args: string[]): Promise<string> {
  const options = parseArguments(args);
  const sourceInfo = await stat(options.sourceCopy);
  if (!sourceInfo.isFile()) throw new Error('--source-copy must name an existing file');
  const sourceHashBefore = await sha256(options.sourceCopy);
  const tempDirectory = await mkdtemp(join(tmpdir(), 'dispatch-migration-smoke-'));
  const tempPath = join(tempDirectory, 'migration-copy.db');

  try {
    await copyFile(options.sourceCopy, tempPath);
    const before = inspectBeforeMigration(tempPath);
    await runRealMigration(tempPath);
    const first = inspectAfterMigration(tempPath);
    assertFirstMigration(before, first, options.expectedHeartbeats);

    await runRealMigration(tempPath);
    const second = inspectAfterMigration(tempPath);
    if (JSON.stringify(second) !== JSON.stringify(first)) {
      throw new Error('second migration run changed schema or counts');
    }

    const sourceHashAfter = await sha256(options.sourceCopy);
    if (sourceHashAfter !== sourceHashBefore) throw new Error('source copy hash changed');
    return (
      `PASS rows_before=${before.rows} rows_after=${first.rows} ` +
      `heartbeat_rows=${first.heartbeatRows} source_unchanged=true second_run_idempotent=true`
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runDispatchMigrationSmoke(process.argv.slice(2))
    .then(output => {
      process.stdout.write(`${output}\n`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
