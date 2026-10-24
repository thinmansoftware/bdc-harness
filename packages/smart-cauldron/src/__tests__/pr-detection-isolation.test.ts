import { afterEach, expect, test } from 'bun:test';

if (Reflect.get(globalThis, Symbol.for('bdc.pr-detection-isolated')) !== true) {
  throw new Error('PR_DETECTION_ISOLATION_PRELOAD_REQUIRED');
}
const { assertMemoryTarget, setSyntheticResponse, takeDeniedFallbacks } =
  await import('./pr-detection-isolation.preload');
afterEach(() => {
  setSyntheticResponse();
  takeDeniedFallbacks();
});

test('guard denies database construction and bootstrap before an operational target can open', async () => {
  const connection = await import('@archon/core/db/connection');
  expect(Reflect.get(connection, '__PR_DETECTION_GUARD__')).toBe(true);
  expect(() => connection.getDatabase()).toThrow('PR_DETECTION_DATABASE_DENIED');
  expect(() => connection.pool.query('SELECT 1')).toThrow('PR_DETECTION_DATABASE_DENIED');
  const { Database } = await import('bun:sqlite');
  const memory = new Database(':memory:');
  try {
    expect(memory.query('SELECT 1 AS n').get()).toEqual({ n: 1 });
  } finally {
    memory.close();
  }
  // Validation is pure: no forbidden filename is handed to a native open.
  for (const target of [undefined, '', 'owned-placeholder.db', 'file::memory:', new Uint8Array()]) {
    expect(() => assertMemoryTarget(target)).toThrow('PR_DETECTION_DATABASE_DENIED');
  }
  const memoryViaOpen = Database.open(':memory:');
  memoryViaOpen.close();
  const pg = await import('pg');
  expect(() => new pg.Client()).toThrow('PR_DETECTION_DATABASE_DENIED');
  expect(() => new pg.Pool()).toThrow('PR_DETECTION_DATABASE_DENIED');
});

test('guard denies child processes, including native Bun and gh fallthrough', async () => {
  const child = await import('node:child_process');
  // This harmless local command would only exit if a broken guard allowed it;
  // no provider/model, shell, credential or operational target is supplied.
  expect(() => child.execFile(process.execPath, ['-e', 'process.exit(0)'])).toThrow(
    'PR_DETECTION_PROCESS_DENIED'
  );
  expect(() => child.spawn(process.execPath, ['-e', 'process.exit(0)'])).toThrow(
    'PR_DETECTION_PROCESS_DENIED'
  );
  expect(() => Bun.spawn([process.execPath, '-e', 'process.exit(0)'])).toThrow(
    'PR_DETECTION_PROCESS_DENIED'
  );
  expect(() => Bun.spawnSync([process.execPath, '-e', 'process.exit(0)'])).toThrow(
    'PR_DETECTION_PROCESS_DENIED'
  );
  const bun = await import('bun');
  expect(bun.$).toBe(Bun.$);
  expect(() => bun.$``).toThrow('PR_DETECTION_PROCESS_DENIED');
  const threads = await import('node:worker_threads');
  expect(() => new threads.Worker('')).toThrow('PR_DETECTION_PROCESS_DENIED');
  expect(() => new Worker('')).toThrow('PR_DETECTION_PROCESS_DENIED');
  const ffi = await import('bun:ffi');
  expect(() => ffi.dlopen('', {})).toThrow('PR_DETECTION_PROCESS_DENIED');
});

test('guard denies network fallthrough without probing a remote or local service', async () => {
  let failure: unknown;
  // A data URL cannot contact a server even if the guard were broken.
  try {
    await fetch('data:text/plain,synthetic');
  } catch (error) {
    failure = error;
  }
  expect((failure as Error)?.message).toBe('PR_DETECTION_NETWORK_DENIED');
  expect(Object.getOwnPropertyDescriptor(globalThis, 'fetch')?.writable).toBe(false);
  setSyntheticResponse(() => new Response('synthetic'));
  expect(await (await fetch('http://archon.test/fixture')).text()).toBe('synthetic');
  const { Socket } = await import('node:net');
  // Empty options cannot identify an operational target.
  expect(() => new Socket().connect({} as never)).toThrow('PR_DETECTION_NETWORK_DENIED');
  expect(() => Bun.connect({} as never)).toThrow('PR_DETECTION_NETWORK_DENIED');
});
