/**
 * CLI wrapper for recordPushEvidence (WO-HARNESS-ESCALATION-BRANCH-HANDOFF-01).
 *
 * Lane push steps call this after a successful git push. The working directory
 * is the lane process cwd. There is no cwd argument.
 *
 *   bun packages/core/src/escalation/record-push-evidence.ts <runId> <repository> <branch> <sha>
 */

import { recordPushEvidence } from './branch-handoff';

function printUsage(): void {
  process.stderr.write('usage: record-push-evidence <runId> <repository> <branch> <sha>\n');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args.some((arg): boolean => arg.length === 0)) {
    printUsage();
    return 2;
  }
  const runId = args[0] ?? '';
  const repository = args[1] ?? '';
  const branch = args[2] ?? '';
  const sha = args[3] ?? '';
  try {
    const workflowDb = await import('../db/workflows');
    await recordPushEvidence(
      {
        listWorkflowRuns: (): Promise<never[]> => Promise.resolve([]),
        listWorkflowEvents: (): Promise<never[]> => Promise.resolve([]),
        updateWorkflowRun: workflowDb.updateWorkflowRun,
      },
      { runId, repository, branch, pushedHead: sha }
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  main()
    .then((code): void => {
      process.exit(code);
    })
    .catch((error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
}
