import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  scanChangedSecrets,
  formatScanFindings,
  detectSecretsInText,
  type ScanChangedSecretsDeps,
} from './scan-changed-secrets';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'm42-scan-'));
  temps.push(d);
  return d;
}

describe('scan-changed-secrets', () => {
  test('detects ghp_, github_pat_, sk-, and xai- tokens without emitting raw values', () => {
    const githubClassic = 'gh' + 'p_' + 'A'.repeat(40);
    const githubFineGrained = 'github' + '_pat_' + '11AAAAAAA0123456789_' + 'B'.repeat(50);
    const openAi = 's' + 'k-proj-' + 'c'.repeat(40);
    const openRouter = 's' + 'k-or-v1-' + 'd'.repeat(36);
    const xai = 'x' + 'ai-' + 'e'.repeat(40);
    const samples = [
      { id: 'github_classic', line: `token=${githubClassic}` },
      {
        id: 'github_fine_grained',
        line: `token=${githubFineGrained}`,
      },
      { id: 'openai_sk', line: `${'OPENAI'}_${'API_KEY'}=${openAi}` },
      {
        id: 'openrouter_sk',
        line: `${'OPENROUTER'}_${'API_KEY'}: "${openRouter}"`,
      },
      { id: 'xai', line: `${'XAI'}_${'API_KEY'}='${xai}'` },
    ];

    for (const sample of samples) {
      const findings = detectSecretsInText('secrets.env', sample.line);
      expect(findings.length).toBeGreaterThan(0);
      const rendered = formatScanFindings(findings);
      expect(rendered).toContain('secrets.env');
      expect(rendered).toContain(sample.id === 'xai' ? 'xai_token' : findings[0]!.pattern_id);
      // raw secret material must never appear
      expect(rendered).not.toContain(githubClassic);
      expect(rendered).not.toContain(githubFineGrained);
      expect(rendered).not.toContain(openAi);
      expect(rendered).not.toContain(openRouter);
      expect(rendered).not.toContain(xai);
    }
  });

  test('detects quoted and unquoted assignment variants with = or :', () => {
    const githubClassic = 'gh' + 'p_' + 'F'.repeat(40);
    const openRouter = 's' + 'k-or-v1-' + 'g'.repeat(36);
    const anthropic = 's' + 'k-ant-' + 'h'.repeat(40);
    const lines = [
      `${'GITHUB'}_${'TOKEN'}=${githubClassic}`,
      `${'GH'}_${'TOKEN'}: ${githubClassic}`,
      `${'OPENROUTER'}_${'API_KEY'}="${openRouter}"`,
      `${'ANTHROPIC'}_${'API_KEY'}: '${anthropic}'`,
      `${'CLAUDE'}_${'API_KEY'}=${anthropic}`,
    ];
    for (const line of lines) {
      const findings = detectSecretsInText('cfg.yaml', line);
      expect(findings.length).toBeGreaterThan(0);
      const out = formatScanFindings(findings);
      expect(out).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
      expect(out).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    }
  });

  test('fails closed on NUL/binary content and missing files', async () => {
    const dir = tempDir();
    const missing = join(dir, 'missing.env');
    const binary = join(dir, 'blob.bin');
    writeFileSync(binary, Buffer.from([0x00, 0x01, 0x02, 0x68, 0x69]));

    const depsMissing: ScanChangedSecretsDeps = {
      listChangedPaths: async () => [missing],
      readFileContent: async path => {
        throw new Error(`ENOENT: ${path}`);
      },
    };
    await expect(scanChangedSecrets({ base: 'a', head: 'b' }, depsMissing)).rejects.toThrow(
      /missing|ENOENT|fail/i
    );

    const depsBinary: ScanChangedSecretsDeps = {
      listChangedPaths: async () => [binary],
      readFileContent: async () => '\u0000binary',
    };
    await expect(scanChangedSecrets({ base: 'a', head: 'b' }, depsBinary)).rejects.toThrow(
      /binary|NUL|fail/i
    );
  });

  test('requires exact --base and --head refs', async () => {
    await expect(
      scanChangedSecrets(
        { base: '', head: 'HEAD' },
        {
          listChangedPaths: async () => [],
          readFileContent: async () => '',
        }
      )
    ).rejects.toThrow(/base/);

    await expect(
      scanChangedSecrets(
        { base: 'origin/dev', head: '' },
        {
          listChangedPaths: async () => [],
          readFileContent: async () => '',
        }
      )
    ).rejects.toThrow(/head/);
  });

  test('emits exactly SECRET_SCAN=clean on zero findings', async () => {
    const dir = tempDir();
    const file = join(dir, 'ok.ts');
    writeFileSync(file, 'export const x = 1;\n');
    const result = await scanChangedSecrets(
      { base: 'origin/dev', head: 'HEAD' },
      {
        listChangedPaths: async () => [file],
        readFileContent: async () => 'export const x = 1;\n',
      }
    );
    expect(result.findings).toHaveLength(0);
    expect(result.summary_line).toBe('SECRET_SCAN=clean');
  });

  test('deduplicates findings by path/line/pattern', () => {
    const githubClassic = 'gh' + 'p_' + 'J'.repeat(40);
    const line = `${'GITHUB'}_${'TOKEN'}=${githubClassic} ${githubClassic}`;
    const findings = detectSecretsInText('dup.env', line);
    const keys = new Set(findings.map(f => `${f.path}:${f.line}:${f.pattern_id}`));
    expect(keys.size).toBe(findings.length);
  });

  test('dirty working tree cannot hide or create a finding for immutable head content', async () => {
    const cleanHeadContent = 'export const safe = true;\n';
    const dirtyWorktreeContent = 'export const leak = "gh' + 'p_' + 'Z'.repeat(40) + '";\n';

    // Simulated default path: reader always returns head blob, never worktree.
    const headReads: string[] = [];
    const result = await scanChangedSecrets(
      { base: 'base', head: 'headsha' },
      {
        listChangedPaths: async () => ['packages/app/src/safe.ts'],
        readFileContent: async (path, head) => {
          headReads.push(`${head ?? 'missing'}:${path}`);
          // Even if a dirty worktree would contain a secret, head content is clean.
          void dirtyWorktreeContent;
          return cleanHeadContent;
        },
      }
    );
    expect(result.findings).toHaveLength(0);
    expect(result.summary_line).toBe('SECRET_SCAN=clean');
    expect(headReads).toEqual(['headsha:packages/app/src/safe.ts']);

    // Conversely: head has a secret; worktree is clean. Finding must still fire.
    const githubClassic = 'gh' + 'p_' + 'Y'.repeat(40);
    const dirtyResult = await scanChangedSecrets(
      { base: 'base', head: 'headsha2' },
      {
        listChangedPaths: async () => ['packages/app/src/leaky.ts'],
        readFileContent: async (_path, head) => {
          expect(head).toBe('headsha2');
          return `token=${githubClassic}\n`;
        },
      }
    );
    expect(dirtyResult.findings.length).toBeGreaterThan(0);
    expect(formatScanFindings(dirtyResult.findings)).not.toContain(githubClassic);
  });
});
