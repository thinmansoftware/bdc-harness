import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { MessageChunk } from '../types';
const instances: object[] = [];
let queries = 0;
let fail = false;
let expectedSignal: AbortSignal | undefined;
const constructor = mock(function (options: unknown) {
  expect(options).toEqual({ restricted: true });
  const instance = {
    getType: () => 'codex-teetime-restricted',
    getCapabilities: () => ({ sessionResume: true }),
    async *sendQuery(...args: unknown[]): AsyncGenerator<MessageChunk> {
      queries++;
      expect(args[1]).toBe('/workspace');
      expect(args[2]).toBeUndefined();
      expect(args[3]).toEqual({ model: 'gpt-5.6-sol', abortSignal: expectedSignal });
      if (fail) throw new Error('synthetic provider failure');
      expectedSignal?.throwIfAborted();
      yield { type: 'assistant', content: 'synthetic' };
    },
  };
  instances.push(instance);
  return instance;
});
mock.module('./provider', () => ({ CodexProvider: constructor }));
const { createRestrictedWorkerProvider } = await import('./restricted-run-factory');
const valid = () => ({
  runId: 'fixture-run',
  policyDigest: 'sha256:' + 'a'.repeat(64),
  workspace: '/workspace',
});
let cwd: ReturnType<typeof spyOn>;
beforeEach(() => {
  cwd = spyOn(process, 'cwd').mockReturnValue('/workspace');
  queries = 0;
  fail = false;
  expectedSignal = undefined;
  instances.length = 0;
  constructor.mockClear();
});
afterEach(() => cwd.mockRestore());

test('rejects invalid binding before constructing provider', () => {
  for (const input of [
    { ...valid(), runId: '' },
    { ...valid(), policyDigest: 'unapproved' },
    { ...valid(), workspace: '/elsewhere' },
  ])
    expect(() => createRestrictedWorkerProvider(input)).toThrow('binding');
  expect(constructor).not.toHaveBeenCalled();
});
test('separate private instances freeze caller binding and disable resume', async () => {
  const binding = valid();
  const first = createRestrictedWorkerProvider(binding);
  const second = createRestrictedWorkerProvider({ ...valid(), runId: 'other-run' });
  binding.workspace = '/elsewhere';
  expect(instances).toHaveLength(2);
  expect(instances[0]).not.toBe(instances[1]);
  expect(first.getCapabilities().sessionResume).toBe(false);
  for await (const chunk of first.sendQuery('fixture', '/workspace'))
    expect(chunk.type).toBe('assistant');
  for await (const chunk of second.sendQuery('fixture', '/workspace'))
    expect(chunk.type).toBe('assistant');
  expect(queries).toBe(2);
});
test('rejects resume, workspace, model and options before query', async () => {
  const provider = createRestrictedWorkerProvider(valid());
  await expect(provider.sendQuery('fixture', '/elsewhere').next()).rejects.toThrow('workspace');
  await expect(provider.sendQuery('fixture', '/workspace', 'foreign').next()).rejects.toThrow(
    'resume'
  );
  await expect(
    provider.sendQuery('fixture', '/workspace', undefined, { model: 'other' }).next()
  ).rejects.toThrow('model');
  await expect(
    provider.sendQuery('fixture', '/workspace', undefined, { env: {} }).next()
  ).rejects.toThrow('override');
  expect(queries).toBe(0);
});
test('rejects overlap and releases ownership on early iterator close', async () => {
  const provider = createRestrictedWorkerProvider(valid());
  const first = provider.sendQuery('fixture', '/workspace');
  await first.next();
  await expect(provider.sendQuery('fixture', '/workspace').next()).rejects.toThrow('overlapping');
  await first.return(undefined);
  for await (const _ of provider.sendQuery('fixture', '/workspace')) {
    /* fixture */
  }
  expect(queries).toBe(2);
});

test('propagates failure and cancellation and permits subsequent calls', async () => {
  const provider = createRestrictedWorkerProvider(valid());
  fail = true;
  await expect(provider.sendQuery('fixture', '/workspace').next()).rejects.toThrow(
    'synthetic provider failure'
  );
  fail = false;
  expectedSignal = AbortSignal.abort(new Error('synthetic cancellation'));
  await expect(
    provider.sendQuery('fixture', '/workspace', undefined, { abortSignal: expectedSignal }).next()
  ).rejects.toThrow('synthetic cancellation');
  expectedSignal = undefined;
  for await (const _ of provider.sendQuery('fixture', '/workspace')) {
    /* fixture */
  }
  expect(queries).toBe(3);
});
