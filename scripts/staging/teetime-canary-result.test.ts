import { expect, test } from 'bun:test';
import { acceptCanaryChunk, type CanaryCompletion } from './teetime-canary-result';
import type { MessageChunk } from '../../packages/providers/src/types';
import { resolve } from 'node:path';

const completed: MessageChunk = {
  type: 'result',
  servedModelId: null,
  servedModelMissingReason: 'codex_sdk_does_not_expose_served_model',
};

test('accepts exact successful file notifications and completion without a session id', () => {
  for (const path of ['canary.txt', '/workspace/canary.txt']) {
    const state: CanaryCompletion = { results: 0, failureCode: 'none' };
    acceptCanaryChunk(state, { type: 'system', content: '[OK] File changes:\n[+] ' + path });
    acceptCanaryChunk(state, completed);
    expect(state).toEqual({ results: 1, failureCode: 'none' });
  }
});

test('rejects failed changes, extra paths, warnings and unexpected system messages', () => {
  for (const content of [
    '[X] File change failed',
    '[WARNING] fallback',
    '[TASKS] Tasks:',
    '[OK] File changes:\n[+] canary.txt\n[+] extra.txt',
    '[OK] File changes:\n[+] /tmp/canary.txt',
  ]) {
    const state: CanaryCompletion = { results: 0, failureCode: 'none' };
    expect(() => acceptCanaryChunk(state, { type: 'system', content })).toThrow();
    expect(state.failureCode).toBe('unexpected_system');
  }
});

test('rejects duplicate, error and unsupported terminal results', () => {
  for (const change of [
    { isError: true },
    { errors: ['synthetic error'] },
    { servedModelId: 'unexpected' },
    { servedModelMissingReason: undefined },
  ]) {
    const state: CanaryCompletion = { results: 0, failureCode: 'none' };
    expect(() => acceptCanaryChunk(state, { ...completed, ...change } as MessageChunk)).toThrow();
  }
  const state: CanaryCompletion = { results: 0, failureCode: 'none' };
  acceptCanaryChunk(state, completed);
  expect(() => acceptCanaryChunk(state, completed)).toThrow();
});

test('silences actual Pino diagnostics before child logger construction', () => {
  const logger = resolve(import.meta.dir, '../../packages/paths/src/logger.ts');
  const probe = Bun.spawnSync([
    process.execPath,
    '-e',
    'import {rootLogger,createLogger} from ' +
      JSON.stringify(logger) +
      '; rootLogger.level="silent"; createLogger("canary-test").error("RAW_DIAGNOSTIC_SENTINEL"); console.log("sanitized-marker");',
  ]);
  expect(probe.exitCode).toBe(0);
  expect(probe.stdout.toString().trim()).toBe('sanitized-marker');
  // The runtime may report an existing package.json warning; no diagnostic payload may escape.
  expect(probe.stderr.toString()).not.toContain('RAW_DIAGNOSTIC_SENTINEL');
});
