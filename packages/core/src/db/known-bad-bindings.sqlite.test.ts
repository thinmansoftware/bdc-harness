import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from './adapters/sqlite';
import type { QueryResult } from './adapters/types';
import { clearRegistry, registerBuiltinProviders } from '@archon/providers';
import type { IAgentProvider, MessageChunk } from '@archon/providers/types';

let current: SqliteAdapter;
// Substitute connection selection only: every DAL statement reaches a REAL
// adapter. Run this suite in its own process, apart from module-mocked suites.
mock.module('./connection', () => ({
  getDatabase: () => current,
  getDialect: () => current.sql,
  pool: {
    query: <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> =>
      current.query<T>(sql, params),
  },
}));

const {
  clearKnownBadBinding,
  findActiveByBindingKey,
  incrementKnownBadBindingHit,
  upsertKnownBadBinding,
} = await import('./known-bad-bindings');
import type { KnownBadBindingRow } from './known-bad-bindings';
const { runFireTimeProbe, formatProbeBlock } =
  await import('@archon/workflows/reliability/fire-time-probe');
const { resolveWorkflowProbeBindings } =
  await import('@archon/workflows/reliability/resolve-binding');

let home: string;
let left: SqliteAdapter;
let right: SqliteAdapter;
let path: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'harness-kbb-'));
  path = join(home, 'archon.db');
  left = new SqliteAdapter(path);
  await left.query('SELECT 1');
  right = new SqliteAdapter(path);
  await right.query('SELECT 1');
  current = left;
  clearRegistry();
  registerBuiltinProviders();
  // Fake providers below never use credentials, including ambient API keys.
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
});

afterEach(async () => {
  clearRegistry();
  await right.close();
  await left.close();
  rmSync(home, { recursive: true, force: true });
});

async function seed(key = 'target'): Promise<KnownBadBindingRow> {
  return upsertKnownBadBinding({
    bindingKey: key,
    providerId: 'codex',
    modelId: 'test-model',
    authContextId: 'test-account',
    assistantConfigHash: 'assistant-fixture',
    nodeOverrideHash: 'node-fixture',
    errorClass: 'structural_model_not_supported',
    httpStatus: 400,
    errorBodyExcerpt: 'original structural diagnostic',
    source: 'binding_change',
  });
}

async function stored(key = 'target', db = left): Promise<KnownBadBindingRow | undefined> {
  return (
    await db.query<KnownBadBindingRow>('SELECT * FROM known_bad_bindings WHERE binding_key = $1', [
      key,
    ])
  ).rows[0];
}

function on<T>(db: SqliteAdapter, action: () => Promise<T>): Promise<T> {
  current = db;
  return action();
}

async function reopened(): Promise<KnownBadBindingRow | undefined> {
  const db = new SqliteAdapter(path);
  try {
    return await stored('target', db);
  } finally {
    await db.close();
  }
}

type Operation = 'increment' | 'clear' | 'mixed';
async function raceProcesses(
  first: Operation,
  second: Operation
): Promise<(KnownBadBindingRow | null)[][]> {
  const children = [first, second].map(mode => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, '../test/known-bad-bindings-worker.ts'), home, mode],
      {
        cwd: join(import.meta.dir, '../../../..'),
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          ARCHON_HOME: home,
          NODE_ENV: 'test',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    let ready!: () => void;
    const gate = new Promise<void>(resolve => {
      ready = resolve;
    });
    const output = (async () => {
      let text = '';
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        text += decoder.decode(chunk, { stream: true });
        if (text.includes('KBB_READY\n')) ready();
      }
      return text + decoder.decode();
    })();
    const errors = new Response(child.stderr).text();
    return { child, gate, output, errors };
  });
  const timeout = setTimeout(() => {
    for (const { child } of children) child.kill();
  }, 15_000);
  try {
    await Promise.all(
      children.map(({ child, gate }) =>
        Promise.race([
          gate,
          child.exited.then(code => {
            throw new Error(`KBB child exited before gate: ${code}`);
          }),
        ])
      )
    );
    // Both independent connections are initialized before either may mutate.
    for (const { child } of children) {
      child.stdin.write('go');
      child.stdin.end();
    }
    return await Promise.all(
      children.map(async ({ child, output, errors }) => {
        const code = await child.exited;
        const text = await output;
        const stderr = await errors;
        if (code !== 0) throw new Error(`KBB child failed (${code}): ${stderr}\n${text}`);
        const result = text.split('\n').find(line => line.startsWith('KBB_RESULT '));
        if (!result) throw new Error(`KBB child missing result: ${text}`);
        return JSON.parse(result.slice('KBB_RESULT '.length)) as (KnownBadBindingRow | null)[];
      })
    );
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null) child.kill();
    }
    await Promise.all(children.map(({ child }) => child.exited));
    clearTimeout(timeout);
  }
}

describe('known-bad-bindings real SQLite callers', () => {
  test('real fixture exposes the audited migration029 columns and identity', async () => {
    const schema = await left.query<{ name: string; type: string; pk: number }>(
      'PRAGMA table_info(known_bad_bindings)'
    );
    // Literal inventory from migration029, independently checked against the
    // adapter-created disposable file (not inferred from a production database).
    expect(schema.rows.map(column => column.name)).toEqual([
      'id',
      'binding_key',
      'provider_id',
      'model_id',
      'auth_context_id',
      'assistant_config_hash',
      'node_override_hash',
      'error_class',
      'http_status',
      'error_body_excerpt',
      'first_seen_at',
      'last_seen_at',
      'hit_count',
      'source',
      'cleared_at',
      'clear_reason',
    ]);
    expect(schema.rows.filter(column => column.pk).map(column => column.name)).toEqual(['id']);
    expect(schema.rows.find(column => column.name === 'hit_count')?.type).toBe('INTEGER');
  });

  test('increments original row after an unrelated insert and preserves diagnostics', async () => {
    const original = await seed();
    await left.query('UPDATE known_bad_bindings SET last_seen_at = $1 WHERE binding_key = $2', [
      '2000-01-01T00:00:00.000Z',
      'target',
    ]);
    await seed('unrelated');
    const result = await incrementKnownBadBindingHit('target');
    expect(result).toEqual({ ...original, hit_count: 2, last_seen_at: expect.any(String) });
    expect(result?.last_seen_at).not.toBe('2000-01-01T00:00:00.000Z');
    expect(await stored()).toEqual(result);
    expect((await stored('unrelated'))?.hit_count).toBe(1);
    expect(await reopened()).toEqual(result);
  });

  for (const reason of ['operator', 'fire_reprobe'] as const) {
    test(`clears original row with ${reason} reason, preserving other fields`, async () => {
      const original = await seed();
      await seed('unrelated');
      const result = await clearKnownBadBinding('target', reason);
      expect(result).toEqual({ ...original, cleared_at: expect.any(String), clear_reason: reason });
      expect(await findActiveByBindingKey('target')).toBeNull();
      expect(await reopened()).toEqual(result);
    });
  }

  test('missing mutations return null and never insert a row', async () => {
    expect(await incrementKnownBadBindingHit('missing')).toBeNull();
    expect(await clearKnownBadBinding('missing', 'operator')).toBeNull();
    expect((await left.query('SELECT * FROM known_bad_bindings')).rows).toEqual([]);
  });

  test('already cleared rows cannot be incremented, recleared or resurrected', async () => {
    await seed();
    await left.query('UPDATE known_bad_bindings SET cleared_at = $1, clear_reason = $2', [
      '2020-01-01T00:00:00.000Z',
      'operator',
    ]);
    const original = await stored();
    expect(await incrementKnownBadBindingHit('target')).toBeNull();
    expect(await clearKnownBadBinding('target', 'fire_reprobe')).toBeNull();
    expect(await stored()).toEqual(original);
    expect(await reopened()).toEqual(original);
  });

  test('overlapping increments through two same-file connections lose no updates', async () => {
    const original = await seed();
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        on(i % 2 ? left : right, () => incrementKnownBadBindingHit('target'))
      )
    );
    expect(results.map(row => row?.hit_count).sort((a, b) => a! - b!)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 2)
    );
    expect(results.every(row => row?.id === original.id)).toBe(true);
    expect((await reopened())?.hit_count).toBe(41);
  });

  test('overlapping clears through two same-file connections have one winner', async () => {
    await seed();
    const results = await Promise.all([
      on(left, () => clearKnownBadBinding('target', 'operator')),
      on(right, () => clearKnownBadBinding('target', 'fire_reprobe')),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await reopened()).toEqual(results.find(Boolean));
  });

  test('mixed overlapping calls preserve the winning clear and forbid later increments', async () => {
    await seed();
    const results = await Promise.all([
      on(left, () => incrementKnownBadBindingHit('target')),
      on(right, () => clearKnownBadBinding('target', 'operator')),
      on(left, () => incrementKnownBadBindingHit('target')),
    ]);
    expect(results[0]?.hit_count).toBe(2);
    expect(results[1]?.clear_reason).toBe('operator');
    expect(results[2]).toBeNull();
    expect(await reopened()).toEqual(results[1]);
  });

  test('independent processes concurrently increment the same file atomically', async () => {
    const original = await seed();
    const results = (await raceProcesses('increment', 'increment')).flat();
    expect(results).toHaveLength(40);
    expect(results.map(row => row?.hit_count).sort((a, b) => a! - b!)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 2)
    );
    expect(results.every(row => row?.id === original.id)).toBe(true);
    expect((await reopened())?.hit_count).toBe(41);
  });

  test('independent process clears return exactly one winner without resurrection', async () => {
    await seed();
    const results = (await raceProcesses('clear', 'clear')).flat();
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await reopened()).toEqual(results.find(Boolean));
  });

  test('independent mixed processes preserve all admitted increments before clear', async () => {
    const original = await seed();
    const results = (await raceProcesses('mixed', 'mixed')).flat();
    const increments = results.filter(row => row && !row.cleared_at);
    const clears = results.filter(row => row?.cleared_at);
    expect(clears).toHaveLength(1);
    expect(clears[0]?.hit_count).toBe(1 + increments.length);
    expect((await reopened())?.id).toBe(original.id);
    expect(await reopened()).toEqual(clears[0]);
    expect(await incrementKnownBadBindingHit('target')).toBeNull();
  });

  for (const mutation of ['increment', 'clear'] as const) {
    test(`${mutation} statement fault leaves the stored row unchanged`, async () => {
      const original = await seed();
      await left.query(`CREATE TRIGGER kbb_test_abort AFTER UPDATE ON known_bad_bindings
        BEGIN SELECT RAISE(ABORT, 'kbb_test_fault'); END`);
      let caught: unknown;
      try {
        if (mutation === 'increment') await incrementKnownBadBindingHit('target');
        else await clearKnownBadBinding('target', 'operator');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain('kbb_test_fault');
      expect(await stored()).toEqual(original);
      expect(await reopened()).toEqual(original);
    });
  }
});

const probeInput = {
  workflow: {
    name: 'kbb-sqlite-test',
    description: 'offline fake provider',
    nodes: [{ id: 'plan', prompt: 'offline', provider: 'codex', model: 'test-model' }],
  },
  workflowProvider: 'codex',
  workflowModel: 'test-model',
  config: { assistant: 'codex', commands: {}, assistants: { codex: { model: 'test-model' } } },
  cwd: '.',
  source: 'fire_probe' as const,
  allowFireReprobeClear: true,
};

function fakeProvider(fails: boolean): IAgentProvider {
  return {
    getType: () => 'codex',
    getCapabilities: () => ({}) as ReturnType<IAgentProvider['getCapabilities']>,
    sendQuery: async function* (): AsyncGenerator<MessageChunk> {
      if (fails) throw Object.assign(new Error('model is not supported'), { httpStatus: 400 });
      yield { type: 'assistant', content: 'OK' };
    },
  };
}

describe('fire-time reprobe with actual SQLite persistence', () => {
  test('still-bad reprobe increments and returns original structural diagnostics', async () => {
    const binding = resolveWorkflowProbeBindings(probeInput)[0]!;
    const original = await seed(binding.bindingKey!);
    const decision = await runFireTimeProbe(
      {
        getAgentProvider: () => fakeProvider(true),
        sleep: async () => {},
      },
      probeInput
    );
    expect(decision.blocked).toBe(true);
    expect(decision.blockedResult).toMatchObject({
      ok: false,
      attempts: 2,
      classification: {
        kind: 'structural',
        errorClass: 'structural_model_not_supported',
        httpStatus: 400,
        excerpt: 'model is not supported Error: model is not supported',
      },
    });
    expect(formatProbeBlock(decision)).toBe(
      'canary_probe_blocked:structural_model_not_supported:codex:test-model'
    );
    expect((await stored(binding.bindingKey!))?.hit_count).toBe(2);
    expect((await stored(binding.bindingKey!))?.id).toBe(original.id);
    expect((await stored(binding.bindingKey!))?.error_body_excerpt).toBe(
      'original structural diagnostic'
    );
  });

  test('successful reprobe clears via the real caller with fire_reprobe reason', async () => {
    const binding = resolveWorkflowProbeBindings(probeInput)[0]!;
    const original = await seed(binding.bindingKey!);
    const decision = await runFireTimeProbe(
      { getAgentProvider: () => fakeProvider(false) },
      probeInput
    );
    expect(decision.blocked).toBe(false);
    expect(await findActiveByBindingKey(binding.bindingKey!)).toBeNull();
    expect(await stored(binding.bindingKey!)).toEqual({
      ...original,
      cleared_at: expect.any(String),
      clear_reason: 'fire_reprobe',
    });
  });

  test('persistence failure propagates instead of pretending the reprobe was admitted', async () => {
    const binding = resolveWorkflowProbeBindings(probeInput)[0]!;
    const original = await seed(binding.bindingKey!);
    await left.query(`CREATE TRIGGER kbb_test_abort AFTER UPDATE ON known_bad_bindings
      BEGIN SELECT RAISE(ABORT, 'kbb_caller_fault'); END`);
    let caught: unknown;
    try {
      await runFireTimeProbe(
        { getAgentProvider: () => fakeProvider(true), sleep: async () => {} },
        probeInput
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('kbb_caller_fault');
    expect(await stored(binding.bindingKey!)).toEqual(original);
  });
});
