// Deterministic subprocess fixture, invoked only by taskmaster-fire-cap.test.ts.
import { basename, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapter } from './adapters/sqlite';
import { reserveAutomaticFire, type AutomaticFireRequest } from './taskmaster';

const path = resolve(process.argv[2] ?? '');
if (
  !path.startsWith(resolve(tmpdir()) + sep) ||
  basename(path) !== 'test.db' ||
  !basename(dirname(path)).startsWith('tm-cap-')
)
  throw new Error('fire cap fixture requires its isolated temporary database');
const input = JSON.parse(process.argv[3] ?? '') as AutomaticFireRequest;
const db = new SqliteAdapter(path);
try {
  const result = await reserveAutomaticFire(input, db);
  console.log(`FIRE_CAP_RESULT:${JSON.stringify(result)}`);
} finally {
  await db.close();
}
