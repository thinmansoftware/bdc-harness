/**
 * cli-allow-satisfied.test.ts -- `smart-cauldron fire ... --allow-satisfied`
 * parses into CliArgs.allowSatisfied so fire.ps1 -AllowSatisfied can reach the
 * conductor (2026-09-02: it previously stopped at fire.ps1's own gate).
 */

import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../cli.js';

function fireArgv(...extra: string[]): string[] {
  return [
    'bun',
    'cli.ts',
    'fire',
    'WO-LSPRO-M157-STREAM-STAYS-OPEN-UI-01',
    '--project',
    'lspro-react',
    ...extra,
  ];
}

describe('parseArgs --allow-satisfied', () => {
  test('defaults to false', () => {
    const args = parseArgs(fireArgv());
    expect(args.command).toBe('fire');
    expect(args.woId).toBe('WO-LSPRO-M157-STREAM-STAYS-OPEN-UI-01');
    expect(args.project).toBe('lspro-react');
    expect(args.allowSatisfied).toBe(false);
  });

  test('--allow-satisfied sets the flag and consumes no value', () => {
    const args = parseArgs(fireArgv('--allow-satisfied', '--class', 'CODE'));
    expect(args.allowSatisfied).toBe(true);
    expect(args.woClass).toBe('CODE');
  });

  test('the flag composes with --entry and --tags exactly as fire.ps1 emits them', () => {
    const args = parseArgs(
      fireArgv('--class', 'CODE', '--tags', 'mechanical', '--entry', 'codex', '--allow-satisfied')
    );
    expect(args).toMatchObject({
      allowSatisfied: true,
      woClass: 'CODE',
      tags: ['mechanical'],
      entry: 'codex',
      dryRun: false,
    });
  });
});
