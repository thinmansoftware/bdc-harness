import { readFile } from 'fs/promises';
import { runCanary, type RunCanaryOptions } from './runner';
import type { RunCanaryResult } from './types';

interface CanaryCliDeps {
  readonly runner: (options: RunCanaryOptions) => Promise<RunCanaryResult>;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function exitFor(verdict: RunCanaryResult['report']['verdict']): number {
  return { passed: 0, failed: 2, blocked: 3, aborted: 4 }[verdict];
}

export async function runCanaryCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: CanaryCliDeps = {
    runner: runCanary,
    stdout: value => process.stdout.write(`${value}\n`),
    stderr: value => process.stderr.write(`${value}\n`),
  }
): Promise<number> {
  const command = args[0];
  const level = command === 'check' ? 0 : command === 'plan' ? 1 : null;
  if (level === null) {
    deps.stderr(
      'Usage: archon-canary <check|plan> --manifest PATH --api-base URL --codebase-id ID --output-root PATH'
    );
    return 3;
  }
  const manifestPath = flag(args, '--manifest');
  const apiBase = flag(args, '--api-base');
  const codebaseId = flag(args, '--codebase-id');
  const outputRoot = flag(args, '--output-root');
  if (!manifestPath || !apiBase || !codebaseId || !outputRoot) {
    deps.stderr('canary_cli_missing_required_argument');
    return 3;
  }
  const tokenFile = flag(args, '--token-file');
  const token = tokenFile ? (await readFile(tokenFile, 'utf8')).trim() : env.ARCHON_OPERATOR_TOKEN;
  if (!token) {
    deps.stderr('ARCHON_OPERATOR_TOKEN is required (or use --token-file)');
    return 3;
  }
  try {
    const result = await deps.runner({
      level,
      manifestPath,
      apiBase,
      token,
      outputRoot,
      codebaseId,
    });
    if (args.includes('--json')) deps.stdout(JSON.stringify(result.report, null, 2));
    else deps.stdout(`${result.report.verdict}: ${result.report.suiteRunId}`);
    return exitFor(result.report.verdict);
  } catch (error) {
    deps.stderr((error as Error).message.replaceAll(token, '[REDACTED]'));
    return 4;
  }
}

if (import.meta.main) process.exitCode = await runCanaryCli(Bun.argv.slice(2));
