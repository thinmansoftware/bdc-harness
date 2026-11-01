/**
 * Served-lane reconcile CLI.
 *
 *   bun run scripts/served-lanes/cli.ts --apply
 *   bun run scripts/served-lanes/cli.ts --drift
 *
 * Paths come from the Archon home and baked defaults. There are no overrides.
 */
import { join } from 'path';
import {
  getDefaultWorkflowsPath,
  getHomeWorkflowsPath,
} from '../../packages/paths/src/archon-paths';
import { computeDrift, readServedLaneHistory, reconcileServedLanes } from './sync';

function usage(): void {
  console.error('Usage: bun run scripts/served-lanes/cli.ts --apply|--drift');
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2);
  const mode = flags.length === 1 ? flags[0] : undefined;
  if (mode !== '--apply' && mode !== '--drift') {
    usage();
    process.exit(1);
  }

  const volumeDir = getHomeWorkflowsPath();
  const bakedDir = getDefaultWorkflowsPath();
  const history = readServedLaneHistory(join(import.meta.dir, 'history.json'));

  if (mode === '--drift') {
    const drift = await computeDrift({ volumeDir, bakedDir, history });
    process.stdout.write(`${JSON.stringify(drift, null, 2)}\n`);
    return;
  }

  await reconcileServedLanes({
    volumeDir,
    bakedDir,
    history,
    now: new Date(),
  });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
