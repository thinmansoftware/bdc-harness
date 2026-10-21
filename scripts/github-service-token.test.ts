import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('Test 4: run-node entrypoint auth', () => {
  it('resolves run_nodes only when App names are present and preserves PAT fallback', () => {
    const entrypoint = readFileSync(new URL('../docker-entrypoint.sh', import.meta.url), 'utf8');
    expect(entrypoint).toContain('github-service-token.ts run_nodes');
    expect(entrypoint).toContain('_GH_AUTH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"');
    expect(entrypoint).not.toContain('GITHUB_APP_TASKMASTER_ID');
  });
});
