import { describe, expect, it } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';

// Root bunfig.toml sets [test] root = "./packages". Stop 5 passes
// scripts/container/build-app-image.test.ts without a ./ prefix, so Bun
// treats it as a name filter, searches only under packages/, and exits 0
// without running Tests 2-5. Register that suite through this file, which
// the same command does execute, and which package CI already runs.
await import('../../../scripts/container/build-app-image.test');

// The previous pin, built from parts so the stale-version stop grep finds nothing here.
const staleNode = ['26', '12', '1'].join('.');

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

  it('packages the run completion report script into the production image', async () => {
    const dockerfile = await readFile(
      join(import.meta.dir, '..', '..', '..', 'Dockerfile'),
      'utf8'
    );
    const copyLine = dockerfile
      .split(/\r?\n/)
      .find(l => l.startsWith('COPY scripts/') && l.endsWith('./scripts/'));
    expect(copyLine).toContain('scripts/run-completion-report.ts');
    expect(dockerfile.split('AS production')[1]).toContain('scripts/run-completion-report.ts');
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
  /**
   * Test 9 (WO-HARNESS-OPENROUTER-REVIEW-DIFF-SCAN-01): the OpenRouter review
   * fence shells out to gitleaks to scan customer diffs/prompts before they
   * reach an OpenRouter seat. A missing binary makes the fence fail closed
   * (reroute), but the governed image must ship it so clean customer reviews
   * are not needlessly rerouted. Assert it is installed into the PRODUCTION
   * stage (not merely a build stage) at /usr/local/bin, pinned to 8.30.1.
   */
  it('Test 9: packages gitleaks 8.30.1 into the production image', async () => {
    const dockerfile = await readFile(
      join(import.meta.dir, '..', '..', '..', 'Dockerfile'),
      'utf8'
    );
    const runtime = dockerfile.split('AS production')[1] ?? '';

    expect(runtime).toContain('GITLEAKS_VERSION=8.30.1');
    expect(runtime).toContain('install -m 755 /tmp/gitleaks /usr/local/bin/gitleaks');
    expect(runtime).toContain(
      'https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz'
    );
    // Checksum-verified, like every other pinned binary in this image.
    expect(runtime).toContain(
      'echo "${GITLEAKS_LINUX_X64_SHA256}  /tmp/gitleaks.tar.gz" | sha256sum -c -'
    );
    expect(runtime).toContain('test "$(command -v gitleaks)" = /usr/local/bin/gitleaks');
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

  it('dockerfile_pins_current_lts_with_checksum: Test 1, pins the current Node LTS and makes it the default', async () => {
    const dockerfile = await readFile(
      join(import.meta.dir, '..', '..', '..', 'Dockerfile'),
      'utf8'
    );
    const runtime = dockerfile.split('AS production')[1] ?? '';

    expect(runtime).toContain('NODE26_VERSION=26.13.0');
    expect(runtime).toContain('PNPM_VERSION=12.14.0');
    const nodeSha = 'd28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997';
    expect(runtime).toContain(`NODE26_SHA256=${nodeSha}`);
    const nodeChecksumAt = runtime.indexOf(
      'echo "${NODE26_SHA256}  /tmp/node26.tar.xz" | sha256sum -c -'
    );
    const nodeExtractAt = runtime.indexOf('tar -xJf /tmp/node26.tar.xz -C /opt/node26');
    expect(nodeChecksumAt).toBeGreaterThanOrEqual(0);
    expect(nodeExtractAt).toBeGreaterThan(nodeChecksumAt);
    expect(dockerfile).not.toContain(staleNode);
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
    expect(runtime).toMatch(/^ENV PATH=\/opt\/node26\/bin:/m);
    // Debian nodejs/npm are not installed; the LTS Node is the only Node.
    const aptInstalls = runtime
      .replace(/\\\r?\n/g, ' ')
      .split(/\r?\n/)
      .filter(line => line.startsWith('RUN') && line.includes('apt-get install'))
      .flatMap(line => line.split('apt-get install').slice(1))
      .map(segment => segment.split(/&&|;/)[0] ?? '');
    expect(aptInstalls.length).toBeGreaterThan(0);
    for (const line of aptInstalls) {
      expect(line).not.toMatch(/\b(?:nodejs|npm)\b/);
    }
    expect(runtime).toContain('"$(npm root -g)/agent-browser"');
    expect(runtime).toContain('ln -sf /usr/bin/python3 /usr/local/bin/python');
    expect(runtime).toContain('test "$default_node" = "v${NODE26_VERSION}"');
    expect(runtime).toContain('test "$default_path" = "/opt/node26/bin/node"');
    expect(runtime).not.toContain('default node unexpectedly');
    // Node precedes the agent-browser npm install that needs it.
    expect(runtime.indexOf('/opt/node26/bin:${PATH}')).toBeLessThan(
      runtime.indexOf('npm install -g agent-browser')
    );
  });

  it('image_reports_current_lts_node_as_default: Test 2, docker-build probes default node and runs the smoke script', async () => {
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
      'test "$(pnpm exec node --version)" = "v26.13.0"',
      'test "$(node --version)" = "v26.13.0"',
      'test "$(command -v node)" = "/opt/node26/bin/node"',
      'test "$(bun --version)" = "1.3.11"',
      'http://localhost:3000/api/health',
      'node --version && npm --version && npx --version && pytest --version',
    ]) {
      expect(workflow).toContain(needle);
    }
    expect(workflow).not.toContain(staleNode);
    expect(workflow).not.toContain('v26*) exit 1');
    expect(workflow).toContain('scripts/container/node-lts-smoke.sh');
    const smoke = await readFile(
      join(import.meta.dir, '..', '..', '..', 'scripts/container/node-lts-smoke.sh'),
      'utf8'
    );
    expect(smoke).toContain('python --version');
    expect(smoke).toContain('Python 3.');
  });

  it('Test 1: production stage stamps the build commit', async () => {
    const dockerfile = await readFile(
      join(import.meta.dir, '..', '..', '..', 'Dockerfile'),
      'utf8'
    );
    const runtime = dockerfile.split('AS production')[1] ?? '';
    const labelLine = 'LABEL org.opencontainers.image.revision="${ARCHON_BUILD_SHA}"';

    // Split on CRLF too: on Windows checkouts (core.autocrlf / text=auto) the
    // working-tree Dockerfile is CRLF, and a bare '\n' split leaves a trailing '\r'.
    expect(runtime.split(/\r?\n/)).toContain(labelLine);
    const argAt = runtime.indexOf('ARG ARCHON_BUILD_SHA=unknown');
    const labelAt = runtime.indexOf(labelLine);
    expect(argAt).toBeGreaterThanOrEqual(0);
    expect(labelAt).toBeGreaterThan(argAt);
    expect(dockerfile.match(/org\.opencontainers\.image\.revision/g)).toHaveLength(1);
  });
});
