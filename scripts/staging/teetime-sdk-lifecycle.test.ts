import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { ArtifactProviderLifecycle } from './teetime-sdk-lifecycle';

test('normal iterator completion closes once and never aborts afterward', async () => {
  const controller = new AbortController();
  let closed = 0;
  const lifecycle = new ArtifactProviderLifecycle(controller, () => closed++);
  async function* source() {
    yield 'exact';
  }
  const values: string[] = [];
  for await (const value of lifecycle.observe(source())) values.push(value);
  expect(values).toEqual(['exact']);
  expect(lifecycle.closed).toBe(true);
  expect(lifecycle.normalEnd).toBe(true);
  expect(closed).toBe(1);
  lifecycle.abortIfActive();
  expect(controller.signal.aborted).toBe(false);
});

test('consumer rejection returns the provider iterator without inventing completion', async () => {
  const controller = new AbortController();
  let providerClosed = false;
  const lifecycle = new ArtifactProviderLifecycle(controller, () => {});
  async function* source() {
    try {
      yield 'reject';
      yield 'never';
    } finally {
      providerClosed = true;
    }
  }
  try {
    for await (const _ of lifecycle.observe(source())) throw new Error('fixed consumer rejection');
  } catch {}
  expect(providerClosed).toBe(true);
  expect(lifecycle.closed).toBe(true);
  expect(lifecycle.normalEnd).toBe(false);
  lifecycle.abortIfActive();
  expect(controller.signal.aborted).toBe(false);
});

test('provider exception closes before failure handling and remains a failure', async () => {
  const controller = new AbortController();
  const lifecycle = new ArtifactProviderLifecycle(controller, () => {});
  async function* source() {
    throw new Error('fixed provider failure');
    yield 'never';
  }
  await expect(
    (async () => {
      for await (const _ of lifecycle.observe(source())) {
      }
    })()
  ).rejects.toThrow('fixed provider failure');
  expect(lifecycle.closed).toBe(true);
  expect(lifecycle.normalEnd).toBe(false);
  lifecycle.abortIfActive();
  expect(controller.signal.aborted).toBe(false);
});

test('a still-active provider is aborted and its eventual closure clears the deadline', async () => {
  const controller = new AbortController();
  let release!: () => void;
  let closed = 0;
  const blocked = new Promise<void>(resolve => {
    release = resolve;
  });
  const lifecycle = new ArtifactProviderLifecycle(controller, () => closed++);
  async function* source() {
    await blocked;
    yield 'released';
  }
  const iterator = lifecycle.observe(source());
  const next = iterator.next();
  lifecycle.abortIfActive();
  expect(controller.signal.aborted).toBe(true);
  expect(lifecycle.closed).toBe(false);
  release();
  await next;
  await iterator.return(undefined);
  expect(lifecycle.closed).toBe(true);
  expect(lifecycle.normalEnd).toBe(false);
  expect(closed).toBe(1);
}, 10000);

test('closed observer clears a pending deadline before it can fire', async () => {
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort();
  }, 20);
  const lifecycle = new ArtifactProviderLifecycle(controller, () => clearTimeout(timer));
  async function* source() {
    yield 'done';
  }
  for await (const _ of lifecycle.observe(source())) {
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(fired).toBe(false);
  expect(controller.signal.aborted).toBe(false);
});

test('pinned SDK cleanup sequence reproduces late-abort failure and clean control', () => {
  const prefix = `import {spawn} from 'node:child_process';
const controller=new AbortController();
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal});
child.once('error',()=>{});
await new Promise(resolve=>setTimeout(resolve,100));
child.removeAllListeners();child.kill();`;
  const late = spawnSync(
    process.execPath,
    ['-e', prefix + "controller.abort();console.log('fixed-marker');"],
    { timeout: 3000, cwd: tmpdir() }
  );
  const clean = spawnSync(process.execPath, ['-e', prefix + "console.log('fixed-marker');"], {
    timeout: 3000,
    cwd: tmpdir(),
  });
  expect(late.status).toBe(1);
  expect(late.stdout.toString()).toBe('fixed-marker\n');
  expect(late.stderr.toString().includes('AbortError')).toBe(true);
  expect(clean.status).toBe(0);
  expect(clean.stdout.toString()).toBe('fixed-marker\n');
  expect(clean.stderr.toString()).toBe('');
}, 10000);
