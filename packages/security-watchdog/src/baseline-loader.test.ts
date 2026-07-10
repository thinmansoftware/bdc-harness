import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadBaseline } from './baseline-loader';
import { fixtureBaseline } from './test-fixtures';

let tempRoot: string | null = null;

async function writeBaseline(root: string, override: Record<string, unknown> = {}): Promise<void> {
  await writeFile(join(root, 'expected-open-ports.json'), JSON.stringify(override.expectedOpenPorts ?? fixtureBaseline.expectedOpenPorts));
  await writeFile(
    join(root, 'legitimate-anon-grants.json'),
    JSON.stringify(override.legitimateAnonGrants ?? fixtureBaseline.legitimateAnonGrants)
  );
  await writeFile(join(root, 'authorized-webhooks.json'), JSON.stringify(override.authorizedWebhooks ?? fixtureBaseline.authorizedWebhooks));
  await writeFile(
    join(root, 'container-inventory.json'),
    JSON.stringify(override.containerInventory ?? fixtureBaseline.containerInventory)
  );
}

afterEach(async () => {
  if (tempRoot !== null) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('loadBaseline', () => {
  test('loads and validates all baseline data files', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'security-watchdog-baseline-'));
    await writeBaseline(tempRoot);
    const baseline = await loadBaseline(tempRoot);
    expect(baseline.expectedOpenPorts.map(port => port.port)).toContain(443);
  });

  test('fails closed on malformed baseline data', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'security-watchdog-baseline-'));
    await writeBaseline(tempRoot, { expectedOpenPorts: [{ port: 70000, reason: 'bad' }] });
    await expect(loadBaseline(tempRoot)).rejects.toThrow();
  });
});
