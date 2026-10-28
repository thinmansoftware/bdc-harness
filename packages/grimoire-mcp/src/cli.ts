import { buildBlockedPrCard, InvalidPrRefError } from './build-card';
import { GitHubUnavailableError } from './sources/github';
import type { BlockedPrCard } from './card-types';

export function renderText(card: BlockedPrCard): string {
  const checks =
    card.checks
      .map(c => `${c.name}=${c.state}${c.required === true ? ' (required)' : ''}`)
      .join(', ') || 'none';
  return [
    `PR: ${card.pr.repo}#${card.pr.number} ${card.pr.state} ${card.pr.title}`,
    `OWNER: ${card.owner.who} (${card.owner.source})`,
    `REVIEW: ${card.review.verdict}`,
    `CHECKS: ${card.checks_verdict}; ${checks}`,
    `FINDINGS: ${card.findings.join(' | ') || 'none'}`,
    `WO: ${card.wo.id ?? 'none'}${card.wo.issue ? ` (#${card.wo.issue})` : ''}`,
    `RUNS: ${card.cauldron_runs.map(r => `${r.id}:${r.status}`).join(', ') || 'none'}`,
    `BLOCKED BY: ${card.blocker}`,
    `NEXT STEP: ${card.next_permitted_action.action}: ${card.next_permitted_action.text}`,
    `SOURCES: github=${card.sources.github}; event_store=${card.sources.event_store}; taskmaster=${card.sources.taskmaster}`,
  ].join('\n');
}
export async function runCli(args = process.argv.slice(2)): Promise<number> {
  if (args[0] !== 'card' || !args[1]) {
    console.error('usage: card <owner/repo#N> [--json]');
    return 2;
  }
  try {
    const card = await buildBlockedPrCard(args[1]);
    console.log(args.includes('--json') ? JSON.stringify(card) : renderText(card));
    return 0;
  } catch (error) {
    if (error instanceof InvalidPrRefError) {
      console.error(error.message);
      return 2;
    }
    if (error instanceof GitHubUnavailableError) {
      console.error(error.message);
      return 1;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
if (import.meta.main) process.exit(await runCli());
