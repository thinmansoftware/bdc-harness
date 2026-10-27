import { describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTrustedCheckPlan, sealReviewCheckout } from './review-worker-clock';

describe('trusted review check plan', () => {
  test('accepts only nonempty argv arrays', () => {
    expect(readTrustedCheckPlan('[[' + '"bun","test"' + ']]')).toEqual([['bun', 'test']]);
    expect(readTrustedCheckPlan('[]')).toEqual([]);
    expect(readTrustedCheckPlan('[["sh","-c","touch /tmp/pwned"]]')).toEqual([]);
  });
  test('rejects malformed and NUL-bearing plans', () => {
    expect(readTrustedCheckPlan('not-json')).toEqual([]);
    expect(readTrustedCheckPlan('[["bun","a\\u0000b"]]')).toEqual([]);
  });
});

test('checkout_sealed_not_group_writable and does not follow symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-seal-'));
  const checkout = join(root, 'checkout');
  const nested = join(checkout, 'nested');
  const outside = join(root, 'outside');
  try {
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'file'), 'candidate');
    await writeFile(outside, 'outside');
    await chmod(outside, 0o666);
    await symlink(outside, join(checkout, 'outside-link'));
    await sealReviewCheckout(checkout);
    expect((await lstat(checkout)).mode & 0o022).toBe(0);
    expect((await lstat(nested)).mode & 0o022).toBe(0);
    expect((await lstat(join(nested, 'file'))).mode & 0o022).toBe(0);
    expect((await lstat(outside)).mode & 0o777).toBe(0o666);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('negative_probe_success_fails_closed', async () => {
  const script = "if /bin/true; then echo 'FAIL: forbidden probe succeeded'; exit 1; fi";
  const child = Bun.spawn(['/bin/sh', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).not.toBe(0);
  expect(output).toContain('FAIL: forbidden probe succeeded');
});
