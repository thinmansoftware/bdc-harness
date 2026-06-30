#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { runFusion } from './runner';

interface CliOptions {
  slug: string;
  diffPath: string;
  workOrderPath: string;
  outputRoot?: string;
}

function usage(): string {
  return [
    'Usage: fusion-review --slug <slug> --diff <diff.patch> --work-order <wo.md> [--out fusion-runs]',
    '',
    'Runs a fusion review round and writes round-1 artifacts, synthesis.md, and manifest.json.',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--slug' && value) {
      options.slug = value;
      index += 1;
    } else if (arg === '--diff' && value) {
      options.diffPath = value;
      index += 1;
    } else if (arg === '--work-order' && value) {
      options.workOrderPath = value;
      index += 1;
    } else if (arg === '--out' && value) {
      options.outputRoot = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!options.slug || !options.diffPath || !options.workOrderPath) {
    throw new Error(usage());
  }

  return options as CliOptions;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [diff, workOrder] = await Promise.all([
    readFile(options.diffPath, 'utf8'),
    readFile(options.workOrderPath, 'utf8'),
  ]);
  const result = await runFusion({
    slug: options.slug,
    diff,
    workOrder,
    outputRoot: options.outputRoot,
  });
  console.log(`Fusion run written to ${result.runDir}`);
  console.log(`Manifest v2 validation: ${result.manifest.validation.status}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
