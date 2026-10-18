import { closeDatabase } from '@archon/core/db/connection';
import { requeueTransientMergeSkips } from '@archon/core/db/overseer';
import { classifyMergeSkip } from '../merge-skip-classification';

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const result = await requeueTransientMergeSkips({ dryRun, classify: classifyMergeSkip });
  for (const row of result.rows) console.log(JSON.stringify(row));
  console.log(`matched=${result.matched} requeued=${result.requeued} dry_run=${dryRun}`);
  await closeDatabase();
}

if (import.meta.main) {
  void main().catch(async error => {
    console.error(error instanceof Error ? error.message : String(error));
    await closeDatabase();
    process.exitCode = 1;
  });
}
