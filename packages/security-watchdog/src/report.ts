import { randomUUID } from 'crypto';
import { link, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { FORBIDDEN_ACTION_PATTERN, type ScanReport, scanReportSchema } from './types';

function scrubText(value: string): string {
  return value.replace(/(?:sk|ghp|glpat|xox[baprs])-[A-Za-z0-9_-]{12,}/g, match => {
    const prefix = match.slice(0, Math.min(4, match.length));
    return `${prefix}...[redacted:${match.length}]`;
  });
}

export function redactObject<T>(value: T): T {
  return JSON.parse(scrubText(JSON.stringify(value))) as T;
}

export function renderReportMarkdown(report: ScanReport): string {
  const parsed = scanReportSchema.parse(redactObject(report));
  const lines = [
    '# Security Watchdog Report',
    '',
    `- Run: \`${parsed.runId}\``,
    `- Verdict: **${parsed.verdict}**`,
    `- Generated: ${parsed.generatedAt}`,
    '',
    '| Module | Severity | Target | Reason | Evidence |',
    '|---|---|---|---|---|',
    ...parsed.findings.map(
      finding =>
        `| ${finding.module} | ${finding.severity} | ${finding.target} | ${finding.reason_code} | ${scrubText(JSON.stringify(finding.evidence))} |`
    ),
    '',
  ];
  const markdown = `${lines.join('\n')}\n`;
  if (FORBIDDEN_ACTION_PATTERN.test(markdown)) throw new Error('phase1_report_contains_action_string');
  return markdown;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeSecurityWatchdogArtifacts(outputRoot: string, report: ScanReport): Promise<readonly string[]> {
  const parsed = scanReportSchema.parse(redactObject(report));
  const directory = join(outputRoot, parsed.runId);
  const paths = [join(directory, 'findings.json'), join(directory, 'report.md')];
  const contents = [`${JSON.stringify(parsed, null, 2)}\n`, renderReportMarkdown(parsed)];
  await mkdir(directory, { recursive: true });
  const existing = await Promise.all(paths.map(readIfPresent));
  if (existing.every((value, index) => value === contents[index])) return paths;
  if (existing.some(value => value !== null)) throw new Error('security_watchdog_artifact_conflict');

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
