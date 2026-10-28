import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'bun:test';

const FORBIDDEN = [
  'process.env.GH_TOKEN',
  'process.env.GITHUB_TOKEN',
  'MERGE_MANAGER_GH_TOKEN',
  'GH_AUTH_TOKEN_INTERNAL',
];

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'test' || entry === '__tests__') continue;
      walk(path, files);
      continue;
    }
    if (!path.endsWith('.ts') || path.endsWith('.test.ts')) continue;
    if (path.endsWith(`${join('github', 'service-identity.ts')}`)) continue;
    if (path.endsWith('bundled-defaults.generated.ts')) continue;
    files.push(path);
  }
}

test('Test 5: no direct env token reads outside the provider', () => {
  const root = join(import.meta.dir, '..', '..', '..', '..', 'packages');
  const files: string[] = [];
  walk(root, files);
  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (FORBIDDEN.some(pattern => line.includes(pattern))) {
        hits.push(`${relative(root, file)}:${index + 1}:${line.trim()}`);
      }
    });
  }
  expect(hits).toEqual([]);
});
