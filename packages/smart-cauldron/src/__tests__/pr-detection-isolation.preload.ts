/** Only explicit memory fixtures are authorized; singleton/process/network deny. */
import { mock } from 'bun:test';
import { Database as NativeDatabase } from 'bun:sqlite';
import { Socket, Server } from 'node:net';
import { fileURLToPath } from 'node:url';

const deniedFallbacks: string[] = [];
export function takeDeniedFallbacks(): string[] {
  return deniedFallbacks.splice(0);
}
const denyDatabase = (): never => {
  deniedFallbacks.push('database');
  throw new Error('PR_DETECTION_DATABASE_DENIED');
};
const denyProcess = (): never => {
  deniedFallbacks.push('process');
  throw new Error('PR_DETECTION_PROCESS_DENIED');
};
const denyNetwork = (): never => {
  deniedFallbacks.push('network');
  throw new Error('PR_DETECTION_NETWORK_DENIED');
};
const connection = (): Record<string, unknown> => ({
  __PR_DETECTION_GUARD__: true,
  getDatabase: denyDatabase,
  getDialect: denyDatabase,
  getDatabaseType: denyDatabase,
  pool: { query: denyDatabase, withTransaction: denyDatabase },
  closeDatabase: denyDatabase,
  resetDatabase: denyDatabase,
  initializeDatabase: denyDatabase,
});
mock.module(
  fileURLToPath(new URL('../../../core/src/db/connection.ts', import.meta.url)),
  connection
);
mock.module('@archon/core/db/connection', connection);
function DisabledDatabase(): never {
  return denyDatabase();
}
// This constructor is the only real storage capability admitted here. The
// application singleton remains denied even when a test deliberately uses RAM.
export function assertMemoryTarget(filename: unknown): void {
  if (filename !== ':memory:') denyDatabase();
}
class MemoryDatabase extends NativeDatabase {
  constructor(filename: string, options?: ConstructorParameters<typeof NativeDatabase>[1]) {
    assertMemoryTarget(filename);
    super(':memory:', options);
  }
  static open(
    filename: string,
    options?: ConstructorParameters<typeof NativeDatabase>[1]
  ): MemoryDatabase {
    return new MemoryDatabase(filename, options);
  }
  static deserialize(): never {
    return denyDatabase();
  }
}
mock.module('bun:sqlite', () => ({ Database: MemoryDatabase, default: MemoryDatabase }));
mock.module('pg', () => ({
  Client: DisabledDatabase,
  Pool: DisabledDatabase,
  default: { Client: DisabledDatabase, Pool: DisabledDatabase },
}));
const childProcess = (): Record<string, unknown> => {
  const methods = {
    exec: denyProcess,
    execSync: denyProcess,
    execFile: denyProcess,
    execFileSync: denyProcess,
    spawn: denyProcess,
    spawnSync: denyProcess,
    fork: denyProcess,
  };
  return { ...methods, default: methods };
};
mock.module('child_process', childProcess);
mock.module('node:child_process', childProcess);
for (const key of ['spawn', 'spawnSync', '$']) {
  Object.defineProperty(Bun, key, { value: denyProcess, writable: false, configurable: false });
}
mock.module('bun', () => ({ ...Bun, $: denyProcess, spawn: denyProcess, spawnSync: denyProcess }));
function DisabledWorker(): never {
  return denyProcess();
}
mock.module('worker_threads', () => ({ Worker: DisabledWorker }));
mock.module('node:worker_threads', () => ({ Worker: DisabledWorker }));
mock.module('bun:ffi', () => ({ dlopen: denyProcess }));
Object.defineProperty(globalThis, 'Worker', {
  value: DisabledWorker,
  writable: false,
  configurable: false,
});
Object.defineProperty(process, 'dlopen', {
  value: denyProcess,
  writable: false,
  configurable: false,
});
for (const key of ['connect', 'listen', 'serve']) {
  Object.defineProperty(Bun, key, { value: denyNetwork, writable: false, configurable: false });
}
Object.defineProperty(Socket.prototype, 'connect', {
  value: denyNetwork,
  writable: false,
  configurable: false,
});
Object.defineProperty(Server.prototype, 'listen', {
  value: denyNetwork,
  writable: false,
  configurable: false,
});
let syntheticResponse: (() => Response) | undefined;
export function setSyntheticResponse(factory?: () => Response): void {
  syntheticResponse = factory;
}
const guardedFetch = async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== 'http://archon.test' || url.username || url.password || !syntheticResponse) {
    return denyNetwork();
  }
  return syntheticResponse();
};
Object.defineProperty(globalThis, 'fetch', {
  value: guardedFetch,
  writable: false,
  configurable: false,
});
// Checked before dynamic production imports, so forgetting --preload fails
// before the application graph (and any default connection) is evaluated.
Object.defineProperty(globalThis, Symbol.for('bdc.pr-detection-isolated'), {
  value: true,
  writable: false,
  configurable: false,
});
