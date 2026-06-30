#!/usr/bin/env bun
/**
 * cli.ts -- Smart Cauldron v1.0 CLI entrypoint.
 *
 * Usage:
 *   smart-cauldron fire <WO-ID> [options]
 *
 * Options:
 *   --class CODE|INFRA|MIXED   WO class for conductor ruleset
 *   --tags tag1,tag2           Comma-separated tags
 *   --entry glm|codex|claude|frontier  Override entry tier (skips conductor)
 *   --out-dir <path>           cascade-runs output dir (default: ./cascade-runs)
 *   --dry-run                  Print which tier would be picked, do not fire
 *   --api-url <url>            Archon API base (default: ARCHON_API_BASE_URL or http://localhost:3090)
 *
 * Secret boundary: API URL comes from env (ARCHON_API_BASE_URL) or --api-url flag.
 * ASCII only. No emojis.
 */

import { runCascade } from './cascade.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  command: string;
  woId?: string;
  woClass?: string;
  tags?: string[];
  entry?: string;
  outDir: string;
  dryRun: boolean;
  apiUrl?: string;
}

function printHelp(): void {
  console.log(`
smart-cauldron -- Smart Cauldron v1.0 per-run escalation cascade

Usage:
  smart-cauldron fire <WO-ID> [options]

Commands:
  fire <WO-ID>   Fire a WO through the cascade (cheapest tier first)

Options:
  --class <CLASS>    WO class for conductor ruleset (CODE, INFRA, MIXED)
  --tags <tags>      Comma-separated tags (e.g. mechanical,auth)
  --entry <tier>     Override entry tier (glm, codex, claude, frontier)
  --out-dir <path>   Output directory for cascade records (default: ./cascade-runs)
  --dry-run          Print entry tier selection only; do not fire
  --api-url <url>    Archon API base URL (default: ARCHON_API_BASE_URL env or http://localhost:3090)
  --help, -h         Show this help

Examples:
  smart-cauldron fire WO-HARNESS-001 --class CODE --tags mechanical
  smart-cauldron fire WO-AUTH-002 --class CODE --tags auth,security
  smart-cauldron fire WO-INFRA-003 --class INFRA
  smart-cauldron fire WO-HARNESS-001 --dry-run
  smart-cauldron fire WO-HARNESS-001 --entry claude --api-url http://localhost:3090
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // remove 'bun' and script path

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  const command = args[0] ?? '';
  const result: CliArgs = {
    command,
    outDir: './cascade-runs',
    dryRun: false,
  };

  const positional: string[] = [];
  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--class' && i + 1 < args.length) {
      result.woClass = args[i + 1];
      i += 2;
    } else if (arg === '--tags' && i + 1 < args.length) {
      result.tags = (args[i + 1] ?? '')
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
      i += 2;
    } else if (arg === '--entry' && i + 1 < args.length) {
      result.entry = args[i + 1];
      i += 2;
    } else if (arg === '--out-dir' && i + 1 < args.length) {
      result.outDir = args[i + 1] ?? './cascade-runs';
      i += 2;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
      i++;
    } else if (arg === '--api-url' && i + 1 < args.length) {
      result.apiUrl = args[i + 1];
      i += 2;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg && !arg.startsWith('--')) {
      positional.push(arg);
      i++;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  if (positional.length > 0) {
    result.woId = positional[0];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.command !== 'fire') {
    console.error(`Unknown command: ${args.command}`);
    console.error('Run "smart-cauldron --help" for usage.');
    process.exit(1);
  }

  if (!args.woId) {
    console.error('Error: WO-ID is required.');
    console.error('Usage: smart-cauldron fire <WO-ID> [options]');
    process.exit(1);
  }

  console.log(`[smart-cauldron] Starting cascade for woId=${args.woId}`);
  if (args.woClass) console.log(`[smart-cauldron]   class=${args.woClass}`);
  if (args.tags && args.tags.length > 0)
    console.log(`[smart-cauldron]   tags=${args.tags.join(',')}`);
  if (args.entry) console.log(`[smart-cauldron]   entry override=${args.entry}`);
  if (args.dryRun) console.log('[smart-cauldron]   DRY RUN mode');

  const record = await runCascade({
    woId: args.woId,
    woClass: args.woClass,
    tags: args.tags,
    entryOverride: args.entry,
    outDir: args.outDir,
    dryRun: args.dryRun,
    apiBaseUrl: args.apiUrl,
  });

  console.log('');
  console.log('[smart-cauldron] Cascade complete:');
  console.log(`  status:      ${record.status}`);
  console.log(`  winningTier: ${record.winningTier ?? 'none'}`);
  console.log(`  climbed:     ${record.telemetry.climbed}`);
  console.log(`  climbCount:  ${record.telemetry.climbCount}`);
  console.log(`  wonCheap:    ${record.telemetry.wonCheap}`);
  console.log(`  attempts:    ${record.attempts.length}`);
  if (record.totalCostUsd !== null) {
    console.log(`  totalCost:   $${record.totalCostUsd.toFixed(6)}`);
  }

  if (record.status === 'blocked') {
    process.exit(2);
  } else if (record.status === 'infra-alert') {
    process.exit(3);
  }
}

main().catch(err => {
  console.error('[smart-cauldron] Fatal error:', (err as Error).message);
  process.exit(1);
});
