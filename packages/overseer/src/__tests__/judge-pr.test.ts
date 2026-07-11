import { describe, expect, test } from 'bun:test';
import { judgePr } from '../index.ts';

describe('judgePr', () => {
  test('requires mergeability, checks, manifest, diff content, and ASCII gate', () => {
    const pass = judgePr({
      runId: 'run-1',
      prUrl: 'https://github.test/pr/1',
      mergeable: 'MERGEABLE',
      checksPassing: true,
      manifestValid: true,
      diffHasContent: true,
      asciiClean: true,
    });
    expect(pass.verdict).toBe('merge_ready');

    const fail = judgePr({
      runId: 'run-1',
      prUrl: 'https://github.test/pr/1',
      mergeable: 'MERGEABLE',
      checksPassing: true,
      manifestValid: true,
      diffHasContent: false,
      asciiClean: true,
    });
    expect(fail.verdict).toBe('blocked');
    expect(fail.action.status).toBe('blocked');
  });
});
