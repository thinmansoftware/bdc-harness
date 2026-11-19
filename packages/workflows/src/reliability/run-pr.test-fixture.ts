import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '../../../..');

/** Exercise real shipped lane nodes and local bare Git through the shared fixture. */
export function runLanePrFixture(fixtureCase: string): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync(
    [
      'python3',
      join(REPO_ROOT, '.archon/workflows/defaults/__tests__/fixtures/run-pr-fixture.py'),
      'adopt',
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, PR_FIXTURE_CASE: fixtureCase },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  return {
    code: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
