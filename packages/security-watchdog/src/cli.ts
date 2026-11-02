#!/usr/bin/env bun
import { runScan, type RunScanOptions, type RunScanResult } from './runner';
import { moduleIdSchema, severityRank, type ModuleId } from './types';

export interface ParsedCli {
  readonly command: 'scan';
  readonly module?: ModuleId;
  readonly baselineRoot?: string;
  readonly outputRoot?: string;
}

export function parseCliArgs(args: readonly string[]): ParsedCli {
  if (args[0] !== 'scan') throw new Error('usage: archon-security-watchdog scan [--module ID]');
  let module: ModuleId | undefined;
  let baselineRoot: string | undefined;
  let outputRoot: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--module') {
      module = moduleIdSchema.parse(args[index + 1]);
      index += 1;
    } else if (arg === '--baseline-root') {
      baselineRoot = args[index + 1];
      index += 1;
    } else if (arg === '--output-root') {
      outputRoot = args[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown_argument:${arg}`);
    }
  }
  return { command: 'scan', module, baselineRoot, outputRoot };
}

export function exitCodeForResult(result: RunScanResult): 0 | 2 {
  return severityRank[result.report.verdict] > 0 ? 2 : 0;
}

export async function cliMain(
  args: readonly string[] = process.argv.slice(2),
  run: (options: RunScanOptions) => Promise<RunScanResult> = runScan
): Promise<number> {
  try {
    const parsed = parseCliArgs(args);
    const result = await run({
      module: parsed.module,
      baselineRoot: parsed.baselineRoot,
      outputRoot: parsed.outputRoot,
    });
    process.stdout.write(`${JSON.stringify(result.report)}\n`);
    return exitCodeForResult(result);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 4;
  }
}

if (import.meta.main) {
  const code = await cliMain();
  process.exit(code);
}
