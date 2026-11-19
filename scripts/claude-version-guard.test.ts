import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { assertClaudeVersion } from './claude-version-guard';

test('installed Claude floor rejects stale CLI and accepts both Fable minima coverage', () => {
  for (const value of ['2.1.197', '2.1.251', '2.1.289', 'unknown']) {
    expect(() => assertClaudeVersion(value)).toThrow();
  }
  for (const value of ['2.1.290', '2.1.322 (Claude Code)', '2.2.0', '3.0.0']) {
    expect(() => assertClaudeVersion(value)).not.toThrow();
  }
});

test('production image checks actual bundled CLI after frozen install', () => {
  const docker = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  expect(docker).toContain('RUN bun install --frozen-lockfile --production');
  expect(docker.indexOf('RUN bun run scripts/claude-version-guard.ts')).toBeGreaterThan(
    docker.indexOf('RUN bun install --frozen-lockfile --production')
  );
  expect(docker).toContain(
    'COPY scripts/claude-version-guard.ts scripts/claude-model-probe.ts ./scripts/'
  );
});
