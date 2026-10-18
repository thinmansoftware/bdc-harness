import { describe, expect, test } from 'bun:test';
import type { MessageChunk } from '../../packages/providers/src/types';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedArtifactContract, runFixedArtifactTask } from './teetime-fixed-artifact';

const nonce = 'a'.repeat(32);
const policy = 'b'.repeat(64);
const terminal: MessageChunk = {
  type: 'result',
  servedModelId: null,
  servedModelMissingReason: 'codex_sdk_does_not_expose_served_model',
};

describe('fixed artifact compliance task', () => {
  test('Python independently derives identical canonical bytes', () => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const code =
      'import sys;sys.path.insert(0,sys.argv[1]);from teetime_fixed_artifact import expected_artifact;sys.stdout.buffer.write(expected_artifact(sys.argv[2],sys.argv[3]))';
    const actual = execFileSync(python, ['-I', '-c', code, import.meta.dirname, nonce, policy], {
      timeout: 5000,
      maxBuffer: 4096,
    });
    expect(
      actual.equals(Buffer.from(createFixedArtifactContract(nonce, policy).expectedText))
    ).toBe(true);
  });

  test('entrypoint invalid binding exits before provider or policy-file access', () => {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, 'teetime-fixed-artifact-task.ts'), 'private-invalid-nonce'],
      { cwd: tmpdir(), timeout: 5000, maxBuffer: 4096 }
    );
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout.toString());
    expect(output.passed).toBe(false);
    expect(output.modelInvocations).toBe(0);
    expect(output.artifactBase64).toBeNull();
    expect(result.stdout.toString()).not.toContain('private-invalid');
  });

  test('exact bytes only after one successful query and natural closure', async () => {
    const contract = createFixedArtifactContract(nonce, policy);
    const controller = new AbortController();
    let calls = 0;
    let closed = 0;
    const result = await runFixedArtifactTask(
      async function* (prompt, signal) {
        calls++;
        expect(prompt).toBe(contract.prompt);
        expect(signal).toBe(controller.signal);
        yield { type: 'thinking', content: 'private thought' };
        yield { type: 'assistant', content: contract.expectedText };
        yield terminal;
      },
      nonce,
      policy,
      controller,
      () => closed++
    );
    expect(calls).toBe(1);
    expect(closed).toBe(1);
    expect(result.passed).toBe(true);
    expect(Buffer.from(result.artifactBase64!, 'base64').toString()).toBe(contract.expectedText);
    expect(result.normalProviderEnd).toBe(true);
    expect(result.providerIteratorClosed).toBe(true);
    expect(result.aborted).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    expect(result.thinkingCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain('private thought');
  });

  test('nonce/hash invalidity prevents any query', async () => {
    let calls = 0;
    const query = async function* (): AsyncGenerator<MessageChunk> {
      calls++;
      yield terminal;
    };
    for (const [n, p] of [
      ['a'.repeat(31), policy],
      [nonce, 'B'.repeat(64)],
      ['../x', policy],
    ]) {
      expect(() => createFixedArtifactContract(n, p)).toThrow();
      await expect(
        runFixedArtifactTask(query, n, p, new AbortController(), () => {})
      ).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });

  test('different serialization, binding, content and duplicate keys never escape', async () => {
    const expected = createFixedArtifactContract(nonce, policy).expectedText;
    for (const text of [
      expected + '\n',
      ' ' + expected,
      JSON.stringify(JSON.parse(expected), null, 2),
      expected.replace('synthetic-artifact-ready', 'unexpected'),
      expected.replace(nonce, 'c'.repeat(32)),
      expected.replace('"version":1', '"version":1,"version":1'),
      'secret-output-that-must-not-be-echoed',
    ]) {
      const result = await runFixedArtifactTask(
        async function* () {
          yield { type: 'assistant', content: text };
          yield terminal;
        },
        nonce,
        policy,
        new AbortController(),
        () => {}
      );
      expect(result.passed).toBe(false);
      expect(result.artifactBase64).toBeNull();
      expect(result.failureCategory).toBe('rejected');
      expect(JSON.stringify(result)).not.toContain('secret-output');
    }
  });

  test('duplicate, missing terminal, exceptions and warnings cannot become success', async () => {
    const expected = createFixedArtifactContract(nonce, policy).expectedText;
    const assistant: MessageChunk = { type: 'assistant', content: expected };
    for (const chunks of [
      [assistant, assistant, terminal],
      [assistant],
      [terminal],
      [assistant, terminal, terminal],
      [assistant, { type: 'system', content: 'warning' } as MessageChunk, terminal],
    ]) {
      const result = await runFixedArtifactTask(
        async function* () {
          yield* chunks;
        },
        nonce,
        policy,
        new AbortController(),
        () => {}
      );
      expect(result.passed).toBe(false);
      expect(result.artifactBase64).toBeNull();
    }
    const result = await runFixedArtifactTask(
      async function* () {
        yield assistant;
        yield terminal;
        throw new Error('private exception');
      },
      nonce,
      policy,
      new AbortController(),
      () => {}
    );
    expect(result.passed).toBe(false);
    expect(result.normalProviderEnd).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private exception');
  });

  test('abort at closure and late abort never salvage output', async () => {
    const controller = new AbortController();
    const result = await runFixedArtifactTask(
      async function* () {
        yield {
          type: 'assistant',
          content: createFixedArtifactContract(nonce, policy).expectedText,
        };
        yield terminal;
      },
      nonce,
      policy,
      controller,
      () => controller.abort()
    );
    expect(result.passed).toBe(false);
    expect(result.artifactBase64).toBeNull();
    expect(result.aborted).toBe(true);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    let calls = 0;
    const rejected = await runFixedArtifactTask(
      async function* () {
        calls++;
        yield terminal;
      },
      nonce,
      policy,
      alreadyAborted,
      () => {}
    );
    expect(rejected.passed).toBe(false);
    expect(calls).toBe(0);
    expect(rejected.modelInvocations).toBe(0);
  });
});
