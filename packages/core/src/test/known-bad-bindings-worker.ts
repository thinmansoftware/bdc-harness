// Deterministic fixture, NOT an agent/provider worker. Only a parent's fresh
// harness-kbb-* temp directory is accepted; no shared DB/config or credentials.
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const [rawHome, mode] = process.argv.slice(2);
if (!rawHome || !['increment', 'clear', 'mixed'].includes(mode ?? '')) {
  throw new Error('invalid_kbb_test_fixture_arguments');
}
const home = resolve(rawHome);
if (dirname(home) !== resolve(tmpdir()) || !basename(home).startsWith('harness-kbb-')) {
  throw new Error('kbb_fixture_requires_owned_temp_home');
}
process.env.ARCHON_HOME = home;
delete process.env.DATABASE_URL;
const { getDatabase, closeDatabase } = await import('../db/connection');
const { incrementKnownBadBindingHit, clearKnownBadBinding } =
  await import('../db/known-bad-bindings');
const db = getDatabase();
try {
  await db.query('SELECT 1');
  if (db.dialect !== 'sqlite') throw new Error('kbb_fixture_requires_sqlite');
  // Record the actual SQLite path without opening anything else.
  const files = await db.query<{ file: string }>('PRAGMA database_list');
  if (files.rows[0]?.file !== join(home, 'archon.db')) throw new Error('kbb_fixture_path_mismatch');
  console.log('KBB_READY');
  if ((await Bun.stdin.text()) !== 'go') throw new Error('kbb_fixture_missing_start_gate');
  const results = [];
  for (let i = 0; i < 20; i++) {
    results.push(
      mode === 'clear' || (mode === 'mixed' && i === 10)
        ? await clearKnownBadBinding('target', 'operator')
        : await incrementKnownBadBindingHit('target')
    );
    await Bun.sleep(1);
  }
  console.log(`KBB_RESULT ${JSON.stringify(results)}`);
} finally {
  await closeDatabase();
}
