import { describe, expect, test } from 'bun:test';
import { scanWorldReadableFiles } from '../modules/world-readable';
import { fixtureBaseline } from '../test-fixtures';

describe('scanWorldReadableFiles', () => {
  test('flags world-readable credential files', async () => {
    const findings = await scanWorldReadableFiles(fixtureBaseline, async () => ({
      exists: true,
      mode: 0o644,
    }));
    expect(findings[0]).toMatchObject({
      severity: 'HIGH',
      reason_code: 'credential_file_world_readable',
    });
  });
});
