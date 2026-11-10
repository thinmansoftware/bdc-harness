import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Fable 5.1 needs 2.1.251; Fable 5.2 needs 2.1.290 (WO #4895).
export const MIN_CLAUDE_CODE = '2.1.290';
export function assertClaudeVersion(value: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(value.trim());
  if (!match) throw new Error('Unrecognized Claude Code version');
  const actual = match.slice(1).map(Number);
  const minimum = MIN_CLAUDE_CODE.split('.').map(Number);
  for (let i = 0; i < minimum.length; i++) {
    if (actual[i] > minimum[i]) return actual.join('.');
    if (actual[i] < minimum[i])
      throw new Error(`Claude Code ${actual.join('.')} < ${MIN_CLAUDE_CODE}`);
  }
  return actual.join('.');
}

export function checkInstalledClaude(): string {
  const require = createRequire(import.meta.url);
  const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk/package.json');
  const sdk = JSON.parse(readFileSync(sdkPath, 'utf8')) as {
    version: string;
    claudeCodeVersion: string;
  };
  const nativePath = require.resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    { paths: [dirname(sdkPath)] }
  );
  const binary = join(dirname(nativePath), process.platform === 'win32' ? 'claude.exe' : 'claude');
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (result.error || result.status !== 0)
    throw new Error('Installed bundled Claude --version failed');
  const version = assertClaudeVersion(result.stdout);
  if (version !== sdk.claudeCodeVersion)
    throw new Error('Installed CLI differs from agent SDK metadata');
  console.log(
    JSON.stringify({ agentSdk: sdk.version, claudeCode: version, minimum: MIN_CLAUDE_CODE })
  );
  return binary;
}

if (import.meta.main) checkInstalledClaude();
