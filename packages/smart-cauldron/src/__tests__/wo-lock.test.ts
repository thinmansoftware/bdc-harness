/**
 * wo-lock.test.ts -- exclusive active-cascade lock per WO+project.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { acquireWoLock, releaseWoLock, isWoExecutionSettled } from '../wo-lock.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function makeOutDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wo-lock-'));
  tempDirs.push(dir);
  return dir;
}

describe('wo-lock', () => {
  test('settlement observation requires exact released generation and never repairs evidence', async () => {
    const outDir = await makeOutDir();
    expect(await isWoExecutionSettled('WO-LOCK-01', 'shopops', 'prior', outDir)).toBe(false);
    const prior = await acquireWoLock('WO-LOCK-01', 'shopops', 'prior', outDir);
    expect(await isWoExecutionSettled('WO-LOCK-01', 'shopops', 'prior', outDir)).toBe(false);
    await releaseWoLock('WO-LOCK-01', 'shopops', 'prior', outDir, prior.executionToken!);
    const released = await readFile(prior.path, 'utf8');
    expect(await isWoExecutionSettled('WO-LOCK-01', 'shopops', 'prior', outDir)).toBe(true);
    expect(await isWoExecutionSettled('WO-LOCK-01', 'shopops', 'other', outDir)).toBe(false);
    expect(await isWoExecutionSettled('WO-LOCK-01', 'other-project', 'prior', outDir)).toBe(false);
    expect(await readFile(prior.path, 'utf8')).toBe(released);
    for (const patch of [
      { executionToken: undefined },
      { status: 'invented' },
      { woId: 'other' },
      { project: 'other' },
    ]) {
      const malformed = JSON.stringify({ ...JSON.parse(released), ...patch });
      await writeFile(prior.path, malformed);
      expect(await isWoExecutionSettled('WO-LOCK-01', 'shopops', 'prior', outDir)).toBe(false);
      expect(await readFile(prior.path, 'utf8')).toBe(malformed);
    }
    await writeFile(prior.path, released);
    await acquireWoLock('WO-LOCK-01', 'shopops', 'replacement', outDir);
    expect(await isWoExecutionSettled('WO-LOCK-01', 'shopops', 'prior', outDir)).toBe(false);
  });

  test('concurrent takeover of a released lock grants exactly one cascade', async () => {
    const outDir = await makeOutDir();
    const prior = await acquireWoLock('WO-LOCK-01', 'shopops', 'prior', outDir);
    await releaseWoLock('WO-LOCK-01', 'shopops', 'prior', outDir, prior.executionToken!);
    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        acquireWoLock('WO-LOCK-01', 'shopops', `candidate-${i}`, outDir)
      )
    );
    expect(claims.filter(claim => claim.acquired)).toHaveLength(1);
    const winner = claims.find(claim => claim.acquired)!;
    expect(JSON.parse(await readFile(prior.path, 'utf8')).cascadeId).toBe(winner.record.cascadeId);
  });

  test('independent processes grant one released-lock takeover', async () => {
    const outDir = await makeOutDir();
    const prior = await acquireWoLock('WO-LOCK-01', 'shopops', 'prior', outDir);
    await releaseWoLock('WO-LOCK-01', 'shopops', 'prior', outDir, prior.executionToken!);
    const url = pathToFileURL(join(import.meta.dir, '../wo-lock.ts')).href;
    const children = [0, 1, 2].map(i =>
      Bun.spawn(
        [
          process.execPath,
          '-e',
          `
      const { acquireWoLock } = await import(${JSON.stringify(url)});
      console.log('READY');
      for await (const chunk of Bun.stdin.stream()) { break; }
      const result = await acquireWoLock('WO-LOCK-01', 'shopops', 'child-${i}', ${JSON.stringify(outDir)});
      console.log('RESULT:' + result.acquired);
    `,
        ],
        { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
      )
    );
    try {
      const readers = children.map(child => child.stdout.getReader());
      await Promise.all(
        readers.map(async reader => {
          let output = '';
          while (!output.includes('READY\n')) {
            const next = await reader.read();
            if (next.done) throw new Error(`lock child exited before READY: ${output}`);
            output += new TextDecoder().decode(next.value);
          }
        })
      );
      for (const child of children) {
        child.stdin.write('go\n');
        child.stdin.end();
      }
      const outputs = await Promise.all(
        readers.map(async reader => {
          let output = '';
          for (;;) {
            const next = await reader.read();
            if (next.done) return output;
            output += new TextDecoder().decode(next.value);
          }
        })
      );
      const exits = await Promise.all(children.map(child => child.exited));
      const errors = await Promise.all(children.map(child => new Response(child.stderr).text()));
      expect(exits, errors.join('\n')).toEqual([0, 0, 0]);
      expect(outputs.filter(output => output.includes('RESULT:true'))).toHaveLength(1);
      expect(outputs.filter(output => output.includes('RESULT:false'))).toHaveLength(2);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.all(children.map(child => child.exited));
    }
  }, 15000);

  test.each(['write', 'rename'])(
    '%s failure during release never deletes shared evidence',
    async fault => {
      const outDir = await makeOutDir();
      const first = await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir);
      const original = await readFile(first.path, 'utf8');
      const url = pathToFileURL(join(import.meta.dir, '../wo-lock.ts')).href;
      const child = Bun.spawn(
        [
          process.execPath,
          '-e',
          `
      import { mock } from 'bun:test';
      const fs = await import('fs/promises');
      const write = fs.writeFile;
      const rename = fs.rename;
      mock.module('fs/promises', () => ({ ...fs,
        writeFile: async (...args) => {
          if (${JSON.stringify(fault)} === 'write' && String(args[0]).endsWith('.tmp')) throw new Error('fixture-write-failure');
          return write(...args);
        },
        rename: async (...args) => {
          if (${JSON.stringify(fault)} === 'rename') throw new Error('fixture-rename-failure');
          return rename(...args);
        },
      }));
      const { releaseWoLock } = await import(${JSON.stringify(url)});
      await releaseWoLock('WO-LOCK-01', 'shopops', 'cascade-a', ${JSON.stringify(outDir)}, ${JSON.stringify(first.executionToken)});
    `,
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(exit, stderr).toBe(0);
      expect(await readFile(first.path, 'utf8')).toBe(original);
      expect((await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-b', outDir)).acquired).toBe(
        false
      );
    }
  );

  test('an abandoned mutation guard times out without deleting or taking over evidence', async () => {
    const outDir = await makeOutDir();
    const first = await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir);
    const original = await readFile(first.path, 'utf8');
    await writeFile(`${first.path}.mutation-guard`, 'abandoned', { flag: 'wx' });
    await expect(acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-b', outDir)).rejects.toThrow(
      'smart_cauldron_wo_lock_busy'
    );
    expect(await readFile(`${first.path}.mutation-guard`, 'utf8')).toBe('abandoned');
    expect(await readFile(first.path, 'utf8')).toBe(original);
    expect((await acquireWoLock('WO-LOCK-02', 'shopops', 'independent', outDir)).acquired).toBe(
      true
    );
  });

  test('an old owner release preserves the newer running owner', async () => {
    const outDir = await makeOutDir();
    const first = await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir);
    await releaseWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir, first.executionToken!);
    await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-b', outDir);
    await releaseWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir, first.executionToken!);
    expect(JSON.parse(await readFile(first.path, 'utf8'))).toMatchObject({
      cascadeId: 'cascade-b',
      status: 'running',
    });
  });

  test('corrupt release evidence is retained instead of deleting the shared lock', async () => {
    const outDir = await makeOutDir();
    const first = await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir);
    await writeFile(first.path, '{corrupt', 'utf8');
    await releaseWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir, first.executionToken!);
    expect(await readFile(first.path, 'utf8')).toBe('{corrupt');
    await expect(acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-b', outDir)).rejects.toThrow();
  });

  test.each(['status', 'woId', 'project'])(
    'invalid existing %s never grants takeover',
    async field => {
      const outDir = await makeOutDir();
      const first = await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir);
      const corrupt = { ...first.record, [field]: 'unknown' };
      await writeFile(first.path, JSON.stringify(corrupt), 'utf8');
      await expect(acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir)).rejects.toThrow();
      expect(JSON.parse(await readFile(first.path, 'utf8'))).toEqual(corrupt);
    }
  );
  test('second cascade for same WO is refused while first is running', async () => {
    const outDir = await makeOutDir();
    const first = await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir);
    expect(first.acquired).toBe(true);

    const second = await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-b', outDir);
    expect(second.acquired).toBe(false);
    expect(second.record.cascadeId).toBe('cascade-a');
  });

  test('same cascadeId can re-acquire', async () => {
    const outDir = await makeOutDir();
    await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir);
    const again = await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir);
    expect(again.acquired).toBe(true);
    expect(again.executionToken).toBeNull();
  });

  test('same-ID stale generation and missing token cannot release a new owner', async () => {
    const outDir = await makeOutDir();
    const first = await acquireWoLock('WO-LOCK-01', 'shopops', 'same-id', outDir);
    expect(typeof first.executionToken).toBe('string');
    await releaseWoLock('WO-LOCK-01', 'shopops', 'same-id', outDir, first.executionToken!);
    const next = await acquireWoLock('WO-LOCK-01', 'shopops', 'same-id', outDir);
    expect(next.executionToken).not.toBe(first.executionToken);
    await releaseWoLock('WO-LOCK-01', 'shopops', 'same-id', outDir, first.executionToken!);
    await releaseWoLock('WO-LOCK-01', 'shopops', 'same-id', outDir);
    expect(JSON.parse(await readFile(first.path, 'utf8'))).toMatchObject({
      status: 'running',
      executionToken: next.executionToken,
    });
    await releaseWoLock('WO-LOCK-01', 'shopops', 'same-id', outDir, next.executionToken!);
    expect(JSON.parse(await readFile(first.path, 'utf8')).status).toBe('released');
  });

  test('release allows a new cascade', async () => {
    const outDir = await makeOutDir();
    const first = await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir);
    await releaseWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir, first.executionToken!);
    const next = await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-b', outDir);
    expect(next.acquired).toBe(true);
    expect(next.record.cascadeId).toBe('cascade-b');
  });

  test('different WOs do not contend', async () => {
    const outDir = await makeOutDir();
    const a = await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir);
    const b = await acquireWoLock('WO-LOCK-02', 'shopops', 'cascade-b', outDir);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
  });
});
