import { Database, constants, type SQLQueryBindings } from 'bun:sqlite';
import {
  listUnroutableQueuedMessages,
  type DispatchQueryExecutor,
} from '../../packages/core/src/db/dispatch';

interface ReportArguments {
  dbPath: string;
  format: 'json';
}

function parseArguments(args: string[]): ReportArguments {
  let dbPath: string | null = null;
  let format: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === '--db' && value) {
      dbPath = value;
      index += 1;
      continue;
    }
    if (argument === '--format' && value) {
      format = value;
      index += 1;
      continue;
    }
    throw new Error(`unsupported argument: ${argument ?? ''}`);
  }

  if (!dbPath) throw new Error('--db is required');
  if (format !== 'json') throw new Error('--format json is required');
  return { dbPath, format: 'json' };
}

function createReadOnlyQuery(database: Database): DispatchQueryExecutor {
  const execute = async (
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: unknown[]; rowCount: number }> => {
    const placeholderOrder: number[] = [];
    const convertedSql = sql.replace(/\$(\d+)/g, (_match, indexText: string) => {
      placeholderOrder.push(Number(indexText));
      return '?';
    });
    const bindings = placeholderOrder.map(index => params[index - 1]) as SQLQueryBindings[];
    const statement = database.prepare<unknown, SQLQueryBindings[]>(convertedSql);
    try {
      const rows = statement.all(...bindings);
      return { rows, rowCount: rows.length };
    } finally {
      statement.finalize();
    }
  };
  return execute as DispatchQueryExecutor;
}

export async function runReportUnroutable(args: string[]): Promise<string> {
  const options = parseArguments(args);
  const database = new Database(options.dbPath, constants.SQLITE_OPEN_READONLY);
  try {
    const findings = await listUnroutableQueuedMessages(createReadOnlyQuery(database));
    return JSON.stringify({ count: findings.length, findings });
  } finally {
    database.close();
  }
}

if (import.meta.main) {
  runReportUnroutable(process.argv.slice(2))
    .then(output => {
      process.stdout.write(`${output}\n`);
    })
    .catch(() => {
      process.stderr.write('report_unroutable_failed\n');
      process.exitCode = 1;
    });
}
