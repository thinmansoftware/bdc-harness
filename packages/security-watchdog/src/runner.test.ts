import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runScan } from './runner';
import { criticalFinding, fixtureBaseline } from './test-fixtures';
import type { Baseline } from './types';

let tempRoot: string | null = null;

async function writeBaseline(root: string, baseline: Baseline): Promise<string> {
  const baselineRoot = join(root, 'baseline');
  await mkdir(baselineRoot, { recursive: true });
  await writeFile(join(baselineRoot, 'expected-open-ports.json'), JSON.stringify(baseline.expectedOpenPorts));
  await writeFile(join(baselineRoot, 'legitimate-anon-grants.json'), JSON.stringify(baseline.legitimateAnonGrants));
  await writeFile(join(baselineRoot, 'authorized-webhooks.json'), JSON.stringify(baseline.authorizedWebhooks));
  await writeFile(join(baselineRoot, 'container-inventory.json'), JSON.stringify(baseline.containerInventory));
  return baselineRoot;
}

afterEach(async () => {
  if (tempRoot !== null) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('runScan', () => {
  test('runs scanners, writes artifacts, and escalates criticals without model calls', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'security-watchdog-runner-'));
    const baselineRoot = await writeBaseline(tempRoot, fixtureBaseline);
    let sent = 0;
    const result = await runScan({
      baselineRoot,
      outputRoot: join(tempRoot, 'out'),
      runId: 'run-1',
      telegramToken: 'token',
      telegramSender: async () => {
        sent += 1;
      },
      scanners: {
        'port-exposure': async () => [criticalFinding],
        'secret-scan': async () => [],
        'webhook-probe': async () => [],
        'rls-anon-sweep': async () => [],
        'world-readable': async () => [],
        'legacy-twelve': async () => [],
      },
    });
    expect(result.report.verdict).toBe('CRITICAL');
    expect(result.artifactPaths).toHaveLength(2);
    expect(result.escalatedCriticals).toBe(1);
    expect(sent).toBe(1);
  });

  test('fails closed when a scanner client is missing', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'security-watchdog-runner-'));
    const baselineRoot = await writeBaseline(tempRoot, fixtureBaseline);
    await expect(runScan({ baselineRoot, outputRoot: join(tempRoot, 'out'), runId: 'run-2' })).rejects.toThrow(
      'scanner_client_required:port-exposure'
    );
  });
});
