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
  });
});
