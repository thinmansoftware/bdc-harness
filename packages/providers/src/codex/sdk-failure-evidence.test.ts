import { expect, test } from 'bun:test';
import { inspectSdkFailureEvidence } from './sdk-failure-evidence';

test('recognizes pinned SDK exit wrapper and retains only closed startup facts', () => {
  const value = inspectSdkFailureEvidence(new Error(
    'Codex Exec exited with code 1: Error loading config.toml: PRIVATE-PATH (os error 13)'));
  expect(value.kind).toBe('cli-exit');
  expect(value.exitCode).toBe(1);
  expect(value.signal).toBeNull();
  expect(value.startupEvidence?.startupStages).toEqual(['config-load']);
  expect(value.startupEvidence?.osErrnos).toEqual([13]);
  expect(JSON.stringify(value)).not.toContain('PRIVATE');
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.startupEvidence?.startupStages)).toBe(true);
});

test('rejects invalid numeric or signal wrappers and recognizes bounded parse/abort forms', () => {
  for (const message of ['Codex Exec exited with code 256: private',
    'Codex Exec exited with code -1: private', 'Codex Exec exited with signal PRIVATE: private']) {
    expect(inspectSdkFailureEvidence(new Error(message)).kind).toBe('other');
  }
  expect(inspectSdkFailureEvidence(new Error('Codex Exec exited with signal SIGKILL: private')).signal).toBe('SIGKILL');
  expect(inspectSdkFailureEvidence(new Error('Failed to parse item: PRIVATE-JSON')).kind).toBe('sdk-parse');
  const abort = new Error('private'); abort.name = 'AbortError';
  expect(inspectSdkFailureEvidence(abort).kind).toBe('aborted');
});

test('does not invoke hostile property getters or expose caller data', () => {
  let calls = 0;
  const hostile = Object.create(null, {
    message: { get() { calls++; throw new Error('PRIVATE'); } },
    name: { get() { calls++; throw new Error('PRIVATE'); } },
  });
  for (const value of [hostile, null, 'PRIVATE', new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error('PRIVATE'); },
  })]) {
    expect(inspectSdkFailureEvidence(value).kind).toBe('other');
    expect(JSON.stringify(inspectSdkFailureEvidence(value))).not.toContain('PRIVATE');
  }
  expect(calls).toBe(0);
});

test('oversized input produces bounded closed evidence without interpreting its middle', () => {
  const value = inspectSdkFailureEvidence(new Error('Codex Exec exited with code 1: '
    +'x'.repeat(100000)+'\nError loading rules: PRIVATE'));
  expect(value.kind).toBe('cli-exit');
  expect(value.startupEvidence?.classificationLimited).toBe(true);
  expect(JSON.stringify(value).length).toBeLessThan(1024);
  expect(JSON.stringify(value)).not.toContain('PRIVATE');
});
