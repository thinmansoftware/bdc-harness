import { describe, expect, test } from 'bun:test';
import { enumerateProcessTree, killProcessTree, liveProcessPids, waitForTreeDeath } from './kill-tree';

describe('liveProcessPids', () => {
  test('excludes defunct processes from the live set', () => {
    const livePids = liveProcessPids([
      { pid: 101, ppid: 1, name: 'running', state: 'S' },
      { pid: 102, ppid: 1, name: 'zombie', state: 'Z' },
      { pid: 103, ppid: 1, name: 'zombie-with-flags', state: 'Z+' },
      { pid: 104, ppid: 1, name: 'windows-process' },
    ]);

    expect([...livePids]).toEqual([101, 104]);
  });
});

describe('killProcessTree', () => {
  test.skipIf(process.platform === 'win32')('kills a real child and grandchild fixture', async () => {
    const root = Bun.spawn(['sh', '-c', 'sleep 30 & wait'], { stdout: 'ignore', stderr: 'ignore' });
    await new Promise(resolve => setTimeout(resolve, 100));
    const before = await enumerateProcessTree(root.pid);
    expect(before.some(process => process.ppid === root.pid)).toBe(true);
    const pids = before.map(process => process.pid);
    await killProcessTree(root.pid);
    expect(await waitForTreeDeath(pids, 3_000)).toEqual([]);
  }, 5_000);
});
