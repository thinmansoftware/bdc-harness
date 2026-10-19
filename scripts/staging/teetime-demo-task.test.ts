import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MessageChunk } from '../../packages/providers/src/types';
import { collectDemoTask } from './teetime-demo-task';

const prompt = 'Frozen complete demo prompt';
const hash = createHash('sha256').update(prompt).digest('hex');
const terminal: MessageChunk = {
  type: 'result',
  servedModelId: null,
  servedModelMissingReason: 'codex_sdk_does_not_expose_served_model',
};

test('entry rejects malformed and oversized input without an invocation', () => {
  for (const input of ['{}', '{"runId":"one","runId":"two"}', 'x'.repeat(160001)]) {
    const child = spawnSync(
      process.execPath,
      [join(import.meta.dirname, 'teetime-demo-task-entry.ts')],
      { cwd: tmpdir(), input, timeout: 5000, maxBuffer: 4096 }
    );
    expect(child.status).toBe(1);
    const result = JSON.parse(child.stdout.toString());
    expect(result.modelInvocations).toBe(0);
    expect(result.collected).toBe(false);
    expect(result.artifactBase64).toBeNull();
  }
});

test('full 64KiB artifact is collected once without claiming validation', async () => {
  let calls = 0;
  let closed = 0;
  const controller = new AbortController();
  const result = await collectDemoTask(
    async function* (received) {
      calls++;
      expect(received).toBe(prompt);
      yield { type: 'assistant', content: 'x'.repeat(65536) };
      yield terminal;
    },
    prompt,
    hash,
    controller,
    () => closed++
  );
  expect(calls).toBe(1);
  expect(closed).toBe(1);
  expect(result.collected).toBe(true);
  expect(Buffer.from(result.artifactBase64!, 'base64').length).toBe(65536);
  expect(result).not.toHaveProperty('passed');
  expect(result.aborted).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(90112);
});

test('changed input and prior cancellation never invoke query', async () => {
  for (const changed of [prompt + 'changed', '', '\u0080', 'x'.repeat(131073)]) {
    let calls = 0;
    const result = await collectDemoTask(
      async function* () {
        calls++;
        yield terminal;
      },
      changed,
      hash,
      new AbortController(),
      () => {}
    );
    expect(calls).toBe(0);
    expect(result.collected).toBe(false);
  }
  const controller = new AbortController();
  controller.abort();
  const result = await collectDemoTask(
    async function* () {
      throw new Error('query must not run');
      yield terminal;
    },
    prompt,
    hash,
    controller,
    () => {}
  );
  expect(result.modelInvocations).toBe(0);
});

test('overflow, incomplete, duplicate and post-terminal output is discarded', async () => {
  const assistant: MessageChunk = { type: 'assistant', content: '{}' };
  for (const chunks of [
    [{ type: 'assistant', content: 'x'.repeat(65537) }, terminal],
    [assistant],
    [assistant, assistant, terminal],
    [assistant, terminal, terminal],
  ]) {
    const result = await collectDemoTask(
      async function* () {
        yield* chunks as MessageChunk[];
      },
      prompt,
      hash,
      new AbortController(),
      () => {}
    );
    expect(result.collected).toBe(false);
    expect(result.artifactBase64).toBeNull();
  }
});

test('provider exceptions and cancellation at closure cannot emit candidate', async () => {
  const failed = await collectDemoTask(
    async function* () {
      yield { type: 'assistant', content: 'private candidate' };
      throw new Error('private diagnostic');
    },
    prompt,
    hash,
    new AbortController(),
    () => {}
  );
  expect(failed.collected).toBe(false);
  expect(JSON.stringify(failed)).not.toContain('private');
  const controller = new AbortController();
  const cancelled = await collectDemoTask(
    async function* () {
      yield { type: 'assistant', content: '{}' };
      yield terminal;
    },
    prompt,
    hash,
    controller,
    () => controller.abort()
  );
  expect(cancelled.collected).toBe(false);
  expect(cancelled.artifactBase64).toBeNull();
});
