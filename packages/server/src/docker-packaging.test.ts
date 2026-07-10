import { describe, expect, it } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';

describe('production Docker packaging', () => {
  it('copies Smart Cauldron source required by the server runtime', async () => {
    const dockerfile = await readFile(
      join(import.meta.dir, '..', '..', '..', 'Dockerfile'),
      'utf8'
    );

    expect(dockerfile).toContain('COPY packages/smart-cauldron/ ./packages/smart-cauldron/');
    expect(
      dockerfile.match(/COPY packages\/canary-suite\/package\.json \.\/packages\/canary-suite\//g)
    ).toHaveLength(2);
    expect(dockerfile).toContain('COPY packages/canary-suite/ ./packages/canary-suite/');
    expect(dockerfile).toContain('COPY .archon/ ./.archon/');
  });
});
