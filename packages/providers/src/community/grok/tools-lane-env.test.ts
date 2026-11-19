import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeGrokTool } from './tools';

const names = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'MERGE_MANAGER_GH_TOKEN',
  'GH_AUTH_TOKEN_INTERNAL',
  'ARCHON_GITHUB_PERMISSION_FALLBACK_TOKEN',
];

// The bash tool uses cmd.exe on Windows; the shell assertion runs where it uses bash.
const posixTest = process.platform === 'win32' ? test.skip : test;

describe('grok bash tool environment (bdc-xo#5464)', () => {
  posixTest('the shell does not inherit the personal GitHub token names', async () => {
    const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
    for (const n of names) process.env[n] = 'ghp_synthetic';
    try {
      const cwd = mkdtempSync(join(tmpdir(), 'grok-lane-env-'));
      const out = await executeGrokTool(
        cwd,
        'bash',
        JSON.stringify({ command: 'env | cut -d= -f1' })
      );
      const listed = out.split('\n').map(s => s.trim());
      for (const n of names) expect(listed).not.toContain(n);
      expect(listed).toContain('ARCHON_GITHUB_NO_PERMISSION_FALLBACK');
    } finally {
      for (const n of names) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    }
  });
});
