import { describe, expect, test } from 'bun:test';
import { discoverContainersFromDocker, resolveContainers } from './container-discovery';
import { fixtureBaseline } from './test-fixtures';

describe('container discovery', () => {
  test('missing or renamed target emits HIGH target_not_found', async () => {
    const result = await resolveContainers(fixtureBaseline.containerInventory, async () => [
      { name: 'lspro-static', image: 'app:latest', status: 'Up' },
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      severity: 'HIGH',
      target: 'lspro-react',
      reason_code: 'target_not_found',
    });
  });

  test('parses docker ps output dynamically', async () => {
    const containers = await discoverContainersFromDocker(
      async () => 'lspro-react\timage:v1\tUp 4 hours\n'
    );
    expect(containers[0]).toEqual({ name: 'lspro-react', image: 'image:v1', status: 'Up 4 hours' });
  });
});
