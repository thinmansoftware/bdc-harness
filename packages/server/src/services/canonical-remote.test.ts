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
