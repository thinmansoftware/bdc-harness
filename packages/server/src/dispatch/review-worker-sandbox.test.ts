import { describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTrustedCheckPlan,
  readTrustedCheckPlan,
  REVIEW_CHECK_PLAN_PATH,
  sealReviewCheckout,
} from './review-worker-clock';

describe('trusted review check plan', () => {
  test('accepts only nonempty argv arrays', () => {
    expect(parseTrustedCheckPlan('[[' + '"bun","test"' + ']]')).toEqual({
      status: 'present',
      commands: [['bun', 'test']],
    });
    expect(parseTrustedCheckPlan('[]').status).toBe('unsafe');
    expect(parseTrustedCheckPlan('[["sh","-c","touch /tmp/pwned"]]').status).toBe('unsafe');
  });
  test('rejects malformed and NUL-bearing plans', () => {
    expect(parseTrustedCheckPlan('not-json').status).toBe('unsafe');
    expect(parseTrustedCheckPlan('[["bun","a\\u0000b"]]').status).toBe('unsafe');
  });
  test('reads only the source-controlled exact-head plan and distinguishes absence', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'review-plan-'));
    try {
      expect(await readTrustedCheckPlan(checkout)).toEqual({ status: 'absent', commands: [] });
      await mkdir(join(checkout, '.github'));
      await writeFile(join(checkout, REVIEW_CHECK_PLAN_PATH), '[["bun","test"]]');
      expect(await readTrustedCheckPlan(checkout)).toEqual({
        status: 'present',
        commands: [['bun', 'test']],
      });
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
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
    const outsideSize = (await lstat(outside)).size;
    await symlink(outside, join(checkout, 'outside-link'));
    await sealReviewCheckout(checkout);
    if (process.platform !== 'win32') {
      expect((await lstat(checkout)).mode & 0o022).toBe(0);
      expect((await lstat(nested)).mode & 0o022).toBe(0);
      expect((await lstat(join(nested, 'file'))).mode & 0o022).toBe(0);
      expect((await lstat(outside)).mode & 0o777).toBe(0o666);
    }
    expect((await lstat(join(checkout, 'outside-link'))).isSymbolicLink()).toBe(true);
    expect((await lstat(outside)).size).toBe(outsideSize);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('negative_probe_success_fails_closed', async () => {
  const script = "console.log('FAIL: forbidden probe succeeded'); process.exit(1)";
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).not.toBe(0);
  expect(output).toContain('FAIL: forbidden probe succeeded');
});
