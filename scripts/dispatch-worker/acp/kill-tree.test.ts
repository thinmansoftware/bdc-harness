import { describe, expect, test } from 'bun:test';
import { liveProcessPids } from './kill-tree';

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
