#!/usr/bin/env bun
/**
 * Read-only inbox-reader report over an existing surface.jsonl
 * (WO-HARNESS-DISPATCH-INBOX-READER-01, Section 4 / Test 17).
 *
 * Classifies each JSONL line with the SAME rules the in-process reader uses and
 * prints a digest. It reads only -- it never disposes, never writes any mailbox
 * column, never contacts the database or an HTTP endpoint.
 *
 * Usage:
 *   bun scripts/dispatch/inbox-reader-report.ts --surface <path-to-surface.jsonl>
 */
import { readFileSync } from 'fs';
import { buildReportFromSurfaceLines } from '../../packages/server/src/dispatch/inbox-reader';

function parseArgs(argv: string[]): { surface: string | null } {
  let surface: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--surface') {
      surface = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return { surface };
}

function main(): number {
  const { surface } = parseArgs(process.argv.slice(2));
  if (!surface) {
    process.stderr.write('usage: inbox-reader-report.ts --surface <path>\n');
    return 2;
  }

  let raw: string;
  try {
    raw = readFileSync(surface, 'utf8');
  } catch (error) {
    process.stderr.write(`failed to read ${surface}: ${(error as Error).message}\n`);
    return 2;
  }

  const lines = raw.split('\n');
  const report = buildReportFromSurfaceLines(lines);

  const out: string[] = [];
  out.push('Dispatch inbox-reader surface report');
  out.push(`  source: ${surface}`);
  out.push(`  INFO_DUPLICATE: ${report.counts.INFO_DUPLICATE}`);
  out.push(`  NUDGE:          ${report.counts.NUDGE}`);
  out.push(`  ACTIONABLE:     ${report.counts.ACTIONABLE}`);
  out.push(`  parse_errors:   ${report.parse_errors}`);
  out.push('');
  const byRule = new Map<string, number>();
  for (const entry of report.classifications) {
    byRule.set(entry.rule_id, (byRule.get(entry.rule_id) ?? 0) + 1);
  }
  out.push('  by rule_id:');
  for (const [ruleId, count] of byRule) {
    out.push(`    ${ruleId}: ${count}`);
  }
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

process.exit(main());
