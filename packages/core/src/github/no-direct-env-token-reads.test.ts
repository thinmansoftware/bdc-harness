/**
 * Test 5 (WO-HARNESS-GITHUB-TOKEN-PROVIDER-REFRESH-01): no source file outside
 * the provider reads a GitHub token directly from the environment.
 *
 * The WO objective is "no direct read of GH_TOKEN, GITHUB_TOKEN,
 * MERGE_MANAGER_GH_TOKEN or GH_AUTH_TOKEN_INTERNAL outside service-identity.ts".
 * This test enforces exactly that: it scans every non-test TypeScript source
 * file under packages/ for a `process.env.<NAME>` (or `process.env['<NAME>']`)
 * READ of any of the four token names, excluding service-identity.ts (the one
 * place allowed to read them), test files, and the generated defaults bundle
 * (which embeds those bare names as prompt text, not as env reads). A match
 * anywhere else fails the test.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES_DIR = join(import.meta.dir, '..', '..', '..', '..', 'packages');

const TOKEN_NAMES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'MERGE_MANAGER_GH_TOKEN',
  'GH_AUTH_TOKEN_INTERNAL',
];
const NAME_GROUP = TOKEN_NAMES.join('|');
const TOKEN_READ = new RegExp(
  `process\\.env(?:\\.(?:${NAME_GROUP})\\b|\\[\\s*['"](?:${NAME_GROUP})['"]\\s*\\])`
);

function isExcluded(path: string): boolean {
  return (
    path.endsWith('service-identity.ts') ||
    path.endsWith('.test.ts') ||
    path.includes('/node_modules/') ||
    path.includes('/dist/') ||
    path.includes('bundled-defaults.generated')
  );
}

function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      collectTsFiles(full, out);
    } else if (full.endsWith('.ts') && !isExcluded(full)) {
      out.push(full);
    }
  }
}

describe('Test 5: no direct GitHub token env reads outside the provider', () => {
  it('finds zero process.env token reads in packages/ source (excluding provider + tests)', () => {
    const files: string[] = [];
    collectTsFiles(PACKAGES_DIR, files);
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      if (TOKEN_READ.test(contents)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
