import { expect, test } from 'bun:test';
import { normalizeGitHubRemote } from './canonical-remote';

test.each([
  ['git@github.com:BlueDevilCollectibles/bdc-harness.git', 'bluedevilcollectibles/bdc-harness'],
  ['https://github.com/BlueDevilCollectibles/bdc-harness.git', 'bluedevilcollectibles/bdc-harness'],
  [
    'ssh://git@github.com/BlueDevilCollectibles/bdc-harness.git',
    'bluedevilcollectibles/bdc-harness',
  ],
  ['BlueDevilCollectibles/bdc-harness', 'bluedevilcollectibles/bdc-harness'],
  [
    'https://x-access-token:ghs_FAKETOKEN123@github.com/BlueDevilCollectibles/bdc-harness.git',
    'bluedevilcollectibles/bdc-harness',
  ],
  [
    'https://ghp_FAKETOKEN456@github.com/BlueDevilCollectibles/bdc-harness.git',
    'bluedevilcollectibles/bdc-harness',
  ],
])('normalizes %s', (remote, expected) => {
  expect(normalizeGitHubRemote(remote)).toBe(expected);
});

test('rejects an unsupported host', () => {
  expect(() => normalizeGitHubRemote('https://example.com/owner/repo.git')).toThrow(
    'canary_remote_unsupported'
  );
});

test('rejects an extra path segment', () => {
  expect(() => normalizeGitHubRemote('owner/repo/extra')).toThrow('canary_remote_unsupported');
});

test('error message redacts credentials from an unsupported credentialed URL', () => {
  const token = 'ghs_SECRETTOKEN789';
  const remote = `https://x-access-token:${token}@example.com/owner/repo.git`;
  let message = '';
  try {
    normalizeGitHubRemote(remote);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('canary_remote_unsupported');
  expect(message).not.toContain(token);
  expect(message).not.toContain('x-access-token');
  expect(message).toContain('//***@');
});
