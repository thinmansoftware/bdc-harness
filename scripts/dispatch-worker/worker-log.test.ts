import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorkerLog } from './worker-log';

describe('dispatch worker rotating log', () => {
  test('writes info and error lines to the active file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-log-'));
    const file = join(dir, 'worker.log');
    try {
      const log = createWorkerLog({ file });
      await log.info('hello');
      await log.error('boom', new Error('bad'));
      const contents = await readFile(file, 'utf8');
      expect(contents).toContain('[INFO] hello');
      expect(contents).toContain('[ERROR] boom: bad');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rotates the active file once it exceeds maxBytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-log-'));
    const file = join(dir, 'worker.log');
    try {
      const log = createWorkerLog({ file, maxBytes: 50, maxFiles: 2 });
      for (let i = 0; i < 20; i += 1) {
        await log.info(`line number ${i} padded to force rotation soon`);
      }
      const entries = await readdir(dir);
      expect(entries).toContain('worker.log');
      expect(entries.some(name => name === 'worker.log.1')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('bounds total retained rotated files to maxFiles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-log-'));
    const file = join(dir, 'worker.log');
    try {
      const log = createWorkerLog({ file, maxBytes: 30, maxFiles: 2 });
      for (let i = 0; i < 60; i += 1) {
        await log.info(`entry ${i} with enough text to roll over quickly`);
      }
      const entries = await readdir(dir);
      const rotated = entries.filter(name => /^worker\.log\.\d+$/.test(name));
      expect(rotated.length).toBeLessThanOrEqual(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('never throws even if the log directory is unwritable', async () => {
    const log = createWorkerLog({ file: 'Z:/definitely/not/a/real/path/worker.log' });
    await expect(log.info('should not throw')).resolves.toBeUndefined();
  });
});
