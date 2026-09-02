import { randomUUID } from 'crypto';
import { link, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import type { LifecycleCanaryReport } from './types';

// Renders the ten-leg scoreboard. Each row reports verdict + reason codes +
// artifact-query evidence, per Section 6/Stop Point 1 of the WO (no leg silently
// omitted, no false pass).
export function renderLifecycleMarkdown(report: LifecycleCanaryReport): string {
  const lines: string[] = [
    '# Lifecycle Canary Report (end-to-end wheel probe)',
    '',
    `- Suite run: \`${report.suiteRunId}\``,
    `- Verdict: **${report.verdict.toUpperCase()}**`,
    `- Generated: ${report.generatedAt}`,
    `- Reason codes: ${report.reasonCodes.length ? report.reasonCodes.join(', ') : '-'}`,
    '',
    '| # | Leg | Verdict | Reasons | Gap | Evidence |',
    '|---:|---|---|---|---|---|',
    ...report.legs.map(
      (legReport, index) =>
        `| ${index + 1} | ${legReport.title} | ${legReport.verdict} | ${legReport.reasonCodes.join(', ') || '-'} | ${legReport.gap ?? '-'} | ${legReport.evidenceRefs.join('; ') || '-'} |`
    ),
    '',
    '## Invariants',
    '',
    report.invariantViolations.length
      ? report.invariantViolations.map(violation => `- VIOLATED: ${violation}`).join('\n')
      : '- No invariant violations detected.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// Atomic write mirroring report.ts: temp file + link, idempotent on identical
// content, conflict-safe on divergent bytes for the same run id.
export async function writeLifecycleCanaryArtifacts(
  outputRoot: string,
  report: LifecycleCanaryReport
): Promise<string[]> {
  const directory = join(outputRoot, report.suiteRunId);
  const paths = [join(directory, 'summary.json'), join(directory, 'summary.md')];
  const contents = [`${JSON.stringify(report, null, 2)}\n`, renderLifecycleMarkdown(report)];
  await mkdir(directory, { recursive: true });
  const existing = await Promise.all(paths.map(readIfPresent));
  if (existing.every((value, index) => value === contents[index])) return paths;
  if (existing.some(value => value !== null)) throw new Error('lifecycle_canary_artifact_conflict');

  const writerId = randomUUID();
  const temporary = paths.map(path => `${path}.tmp-${writerId}`);
  try {
    for (let index = 0; index < temporary.length; index += 1) {
      await writeFile(temporary[index], contents[index], { flag: 'wx' });
    }
    for (let index = 0; index < paths.length; index += 1) {
      try {
        await link(temporary[index], paths[index]);
      } catch (error) {
        const published = await readIfPresent(paths[index]);
        if (published !== contents[index]) throw error;
      }
      await rm(temporary[index], { force: true });
    }
  } catch (error) {
    await Promise.all(temporary.map(path => rm(path, { force: true })));
    throw error;
  }
  return paths;
}
