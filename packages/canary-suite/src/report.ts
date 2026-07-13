import { randomUUID } from 'crypto';
import { link, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import type { CanaryPlan, CanaryReduction, CanaryReport, CanaryVerdict } from './types';
import { verdictForStaticCapability } from './layer3-policy';

export function createCanaryReport(
  suiteRunId: string,
  level: 0 | 1,
  plan: CanaryPlan,
  reduction: CanaryReduction
): CanaryReport {
  return {
    schemaVersion: 1,
    suiteRunId,
    level,
    generatedAt: plan.snapshot.observedAt,
    requestId: plan.requestId,
    verdict: reduction.verdict,
    reasonCodes: reduction.reasonCodes,
    evidenceRefs: reduction.evidenceRefs,
    lanes: plan.directRoutes.map(route => {
      const capabilityFailed = route.matches.some(item => item.capabilityIssues.length > 0);
      const capabilityStatus =
        route.matches.length === 0
          ? 'missing'
          : route.matches.length > 1
            ? 'duplicate'
            : capabilityFailed
              ? 'failed'
              : 'passed';
      // Clean static capability is demoted by policy to static_only, never passed.
      const verdict: CanaryVerdict = verdictForStaticCapability(capabilityStatus);
      return {
        lane: route.lane,
        level,
        verdict,
        reasonCodes: capabilityStatus === 'passed' ? [] : [capabilityStatus],
        workflowRevision: route.matches[0]?.revision ?? null,
        capabilityStatus,
        evidenceRefs: [`workflow:${route.lane}`],
      };
    }),
  };
}

export function renderCanaryMarkdown(report: CanaryReport): string {
  const lines = [
    '# Smart Cauldron Canary Report',
    '',
    `- Suite run: \`${report.suiteRunId}\``,
    `- Level: ${report.level}`,
    `- Verdict: **${report.verdict.toUpperCase()}**`,
    `- Observed: ${report.generatedAt}`,
    '',
    '| Lane | Level | Verdict | Reasons | Workflow revision | Capability | Evidence |',
    '|---|---:|---|---|---|---|---|',
    ...report.lanes.map(
      lane =>
        `| ${lane.lane} | ${lane.level} | ${lane.verdict} | ${lane.reasonCodes.join(', ') || '-'} | ${lane.workflowRevision ?? '-'} | ${lane.capabilityStatus} | ${lane.evidenceRefs.join(', ')} |`
    ),
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

export async function writeCanaryArtifacts(
  outputRoot: string,
  plan: CanaryPlan,
  report: CanaryReport
): Promise<string[]> {
  const directory = join(outputRoot, report.suiteRunId);
  const paths = [
    join(directory, 'plan.json'),
    join(directory, 'summary.json'),
    join(directory, 'summary.md'),
  ];
  const contents = [
    `${JSON.stringify(plan, null, 2)}\n`,
    `${JSON.stringify(report, null, 2)}\n`,
    renderCanaryMarkdown(report),
  ];
  await mkdir(directory, { recursive: true });
  const existing = await Promise.all(paths.map(readIfPresent));
  if (existing.every((value, index) => value === contents[index])) return paths;
  if (existing.some(value => value !== null)) throw new Error('canary_artifact_conflict');

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
