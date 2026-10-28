import { describe, expect, it } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(entry => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
    })
  );
  return nested.flat();
}

describe('Tests 5 and 7: provider routing and inventory', () => {
  it('has no direct production token reads outside the provider', async () => {
    const root = resolve(import.meta.dir, '../../../..');
    const files = await sourceFiles(join(root, 'packages'));
    const forbidden =
      /process\.env\.(?:GH_TOKEN|GITHUB_TOKEN|MERGE_MANAGER_GH_TOKEN|GH_AUTH_TOKEN_INTERNAL)/;
    const matches: string[] = [];
    for (const file of files) {
      if (file.endsWith('/service-identity.ts')) continue;
      if (forbidden.test(await readFile(file, 'utf8'))) matches.push(file);
    }
    expect(matches).toEqual([]);
  });

  it('documents all nine credential inventory entries', async () => {
    const root = resolve(import.meta.dir, '../../../..');
    const inventory = await readFile(join(root, 'docs/credentials-inventory.md'), 'utf8');
    for (const entry of [
      'GITHUB_APP_ID',
      'GITHUB_APP_MERGE_MANAGER_',
      'GITHUB_APP_RUN_NODES_',
      'GITHUB_APP_TASKMASTER_',
      'GH_AUTH_TOKEN_INTERNAL',
      'CURSOR_API_KEY',
      '.codex/auth.json',
      '.claude/.credentials.json',
      'XAI_API_KEY',
    ]) {
      expect(inventory).toContain(entry);
    }
  });
});
