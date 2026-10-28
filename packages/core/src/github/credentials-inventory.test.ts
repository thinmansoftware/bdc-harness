import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';

const REQUIRED = [
  'GITHUB_APP_ID',
  'GITHUB_APP_MERGE_MANAGER_',
  'GITHUB_APP_RUN_NODES_',
  'GITHUB_APP_TASKMASTER_',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'MERGE_MANAGER_GH_TOKEN',
  'GH_AUTH_TOKEN_INTERNAL',
  'CURSOR_API_KEY',
  '/home/appuser/.codex/auth.json',
  '/home/appuser/.claude/.credentials.json',
  'XAI_API_KEY',
];

test('Test 7: inventory lists every harness credential', () => {
  const path = join(import.meta.dir, '..', '..', '..', '..', 'docs', 'credentials-inventory.md');
  const text = readFileSync(path, 'utf8');
  expect(text).toContain('| Credential |');
  expect(text).toContain('Used by');
  expect(text).toContain('Refresh method');
  expect(text).toContain('Self-refresh');
  expect(text).toContain('Owner');
  expect(text).toContain('Expiry');
  for (const row of REQUIRED) {
    expect(text).toContain(row);
  }
});
