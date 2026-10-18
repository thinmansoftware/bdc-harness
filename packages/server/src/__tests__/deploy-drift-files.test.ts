import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readLaneFiles } from '../dispatch/duty-officer-deploy-drift-detector';

let home: string;
const originalHome = process.env.ARCHON_HOME;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'deploy-drift-files-'));
  process.env.ARCHON_HOME = home;
});
afterEach(async () => {
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

test('hashes regular files and skips directories without changing file digest', async () => {
  await mkdir(join(home, 'workflows', 'directory'), { recursive: true });
  await writeFile(join(home, 'workflows', 'lane.yaml'), 'name: fixture\n');
  const maps = await readLaneFiles();
  expect(maps.served).toEqual({
    'lane.yaml': createHash('sha256').update('name: fixture\n').digest('hex'),
  });
});

test('missing home workflows remains an empty map', async () => {
  expect((await readLaneFiles()).served).toEqual({});
});

test('non-directory root is an observation failure instead of empty evidence', async () => {
  await writeFile(join(home, 'workflows'), 'not a directory');
  await expect(Promise.resolve().then(() => readLaneFiles())).rejects.toThrow();
});

test('oversized regular file rejects instead of allocating and hashing its full contents', async () => {
  await mkdir(join(home, 'workflows'));
  await writeFile(join(home, 'workflows', 'oversized.yaml'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await expect(Promise.resolve().then(() => readLaneFiles())).rejects.toThrow('limit');
});

test('pre-aborted reader rejects before observing workflow files', async () => {
  const controller = new AbortController();
  controller.abort(new Error('fixture aborted'));
  await expect(Promise.resolve().then(() => readLaneFiles(controller.signal))).rejects.toThrow(
    'fixture aborted'
  );
});

test.skipIf(process.platform === 'win32')(
  'symlink to a regular file is never followed',
  async () => {
    await mkdir(join(home, 'workflows'));
    const target = join(home, 'target.yaml');
    await writeFile(target, 'outside lane directory');
    await symlink(target, join(home, 'workflows', 'linked.yaml'));
    expect((await readLaneFiles()).served).toEqual({});
  }
);

test.skipIf(process.platform === 'win32')(
  'FIFO cannot stall the reader or event loop (isolated child)',
  async () => {
    await mkdir(join(home, 'workflows'));
    execFileSync('mkfifo', [join(home, 'workflows', 'blocked.yaml')]);
    const moduleUrl = pathToFileURL(
      join(import.meta.dir, '../dispatch/duty-officer-deploy-drift-detector.ts')
    ).href;
    const script = `import { readLaneFiles } from ${JSON.stringify(moduleUrl)};
setTimeout(() => console.log('TIMER'), 0);
const maps = await readLaneFiles();
console.log(JSON.stringify(maps.served));`;
    const result = await new Promise<{ code: number | null; output: string; timedOut: boolean }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, ['--eval', script], {
          env: { ...process.env, ARCHON_HOME: home },
        });
        let output = '';
        let timedOut = false;
        child.stdout.on('data', chunk => {
          output += String(chunk);
        });
        child.stderr.on('data', chunk => {
          output += String(chunk);
        });
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, 3000);
        child.on('error', error => {
          clearTimeout(timeout);
          reject(error);
        });
        child.on('close', code => {
          clearTimeout(timeout);
          resolve({ code, output, timedOut });
        });
      }
    );
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.output).toContain('TIMER');
    expect(result.output).toContain('{}');
  },
  10000
);

test('entry cap includes skipped directories and the baked directory', async () => {
  await mkdir(join(home, 'workflows'));
  for (let i = 0; i < 2048; i++) await mkdir(join(home, 'workflows', `entry-${i}`));
  await expect(readLaneFiles()).rejects.toThrow('entry_limit');
});

test('cumulative byte cap applies across regular files and both roots', async () => {
  await mkdir(join(home, 'workflows'));
  const data = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < 16; i++) await writeFile(join(home, 'workflows', `large-${i}.yaml`), data);
  await expect(readLaneFiles()).rejects.toThrow('byte_limit');
});
