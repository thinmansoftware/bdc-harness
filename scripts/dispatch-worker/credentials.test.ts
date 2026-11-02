import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveOperatorToken } from './credentials';

const original = process.env.DISPATCH_TEST_TOKEN;

afterEach(() => {
  if (original === undefined) delete process.env.DISPATCH_TEST_TOKEN;
  else process.env.DISPATCH_TEST_TOKEN = original;
});

describe('dispatch worker credential resolution', () => {
  test('prefers the named environment variable', async () => {
    process.env.DISPATCH_TEST_TOKEN = 'env-token';
    await expect(
      resolveOperatorToken({ envName: 'DISPATCH_TEST_TOKEN', tokenFile: 'missing' })
    ).resolves.toBe('env-token');
  });

  test('falls back to a secure file reference without returning path metadata', async () => {
    delete process.env.DISPATCH_TEST_TOKEN;
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-token-'));
    const path = join(dir, 'token');
    await writeFile(path, 'file-token\n', 'utf8');
    try {
      await expect(
        resolveOperatorToken({ envName: 'DISPATCH_TEST_TOKEN', tokenFile: path })
      ).resolves.toBe('file-token');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('fails closed when neither credential reference resolves', async () => {
    delete process.env.DISPATCH_TEST_TOKEN;
    await expect(
      resolveOperatorToken({ envName: 'DISPATCH_TEST_TOKEN', tokenFile: 'missing' })
    ).rejects.toThrow('operator_token_unavailable');
  });
});
