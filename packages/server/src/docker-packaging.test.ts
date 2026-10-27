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
  it('retains the build toolchain and probes it in the final image', async () => {
    const dockerfile = await readFile(
      join(import.meta.dir, '..', '..', '..', 'Dockerfile'),
      'utf8'
    );
    const runtime = dockerfile.split('AS production')[1] ?? '';
    expect(runtime).toContain('python3-pytest');
    expect(runtime).not.toMatch(/apt-get purge[^\n]*(?:nodejs|npm)/);
    for (const probe of ['node --version', 'npm --version', 'npx --version', 'pytest --version']) {
      expect(runtime).toContain(probe);
    }
  });

  it('pins Node 26 and pnpm 12.14.0 off the global PATH', async () => {
    const dockerfile = await readFile(
      join(import.meta.dir, '..', '..', '..', 'Dockerfile'),
      'utf8'
    );
    const runtime = dockerfile.split('AS production')[1] ?? '';

    expect(runtime).toContain('NODE26_VERSION=26.12.1');
    expect(runtime).toContain('PNPM_VERSION=12.14.0');
    expect(runtime).toContain('6170b2d474e1c626f43cff3adc118df9fe3b573258a4fc3d850c8dbc6b079bbd');
    expect(runtime).toContain('ea206e35474bf87be9564a85ca70ed1c8ebdc45da55aafb0a3bf09d1ba69b179');
    expect(
      runtime.match(
        /PNPM_NATIVE_SHA256=1de98ed2e9621113b0887b06322b461efb9df73d913fc1d151039b10b7117a41/g
      )
    ).toHaveLength(1);
    expect(runtime).toContain(
      'https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-${PNPM_VERSION}.tgz'
    );
    const nativeChecksumAt = runtime.indexOf(
      'echo "${PNPM_NATIVE_SHA256}  /tmp/pnpm-native.tgz" | sha256sum -c -'
    );
    const nativeExtractAt = runtime.indexOf('tar -xzf /tmp/pnpm-native.tgz -C /tmp/pnpm-native');
    expect(nativeChecksumAt).toBeGreaterThanOrEqual(0);
    expect(nativeExtractAt).toBeGreaterThan(nativeChecksumAt);
    expect(runtime).toContain(
      'install -m 755 /tmp/pnpm-native/package/pnpm "/opt/pnpm-${PNPM_VERSION}/pnpm"'
    );
    expect(runtime).toContain('sha256sum -c');
    expect(runtime).toContain('COPY scripts/container/project-pnpm.sh /usr/local/bin/pnpm');
    expect(runtime).toContain('pnpm exec node --version');
    expect(runtime).toContain('ENTRYPOINT ["docker-entrypoint.sh"]');
    expect(runtime).not.toMatch(/ENV PATH=.*node26/);
  });

  it('wires the offline packaged pnpm probe into docker-build', async () => {
    const workflow = await readFile(
      join(import.meta.dir, '..', '..', '..', '.github/workflows/test.yml'),
      'utf8'
    );

    for (const needle of [
      '--network none',
      '--user appuser',
      '--entrypoint sh',
      'archon-ci:test',
      'test "$(pnpm --version)" = "12.14.0"',
      'test "$(pnpm exec node --version)" = "v26.12.1"',
      'v26*) exit 1',
      'test "$(bun --version)" = "1.3.11"',
      'http://localhost:3000/api/health',
      'node --version && npm --version && npx --version && pytest --version',
    ]) {
      expect(workflow).toContain(needle);
    }
  });
});
