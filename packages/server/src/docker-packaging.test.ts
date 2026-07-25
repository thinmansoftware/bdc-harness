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

  /**
   * These CLI tools are relied on by lane bash nodes and by agent code search.
   * A missing binary fails at RUNTIME with exit 127, mid-run, after the fire has
   * already been paid for -- the 2026-07-10 jq outage is the anchor. Assert them
   * here so a future image slim-down cannot silently strip them.
   */
  it('installs the CLI tools lanes and agents depend on', async () => {
    const dockerfile = await readFile(
      join(import.meta.dir, '..', '..', '..', 'Dockerfile'),
      'utf8'
    );

    for (const tool of ['jq', 'ripgrep', 'fd-find', 'shellcheck']) {
      expect(dockerfile).toContain(`    ${tool} \\`);
    }

    // Debian installs fd-find's binary as `fdfind`; agents invoke `fd`.
    expect(dockerfile).toContain('/usr/local/bin/fd');
  });
});
