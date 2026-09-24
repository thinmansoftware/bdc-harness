import { describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
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

  it('bakes ARCHON_BUILD_SHA after the entrypoint layer', async () => {
    const dockerfile = await readFile(
      join(import.meta.dir, '..', '..', '..', 'Dockerfile'),
      'utf8'
    );
    expect(dockerfile.indexOf('ARG ARCHON_BUILD_SHA')).toBeGreaterThan(
      dockerfile.indexOf('chmod +x /usr/local/bin/docker-entrypoint.sh')
    );
    expect(dockerfile).toContain('LABEL org.opencontainers.image.revision=${ARCHON_BUILD_SHA}');
  });

  it.skipIf(process.platform === 'win32')(
    'build-app-image.sh stamps HEAD and refuses a dirty tree',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'build-app-image-'));
      try {
        const scriptDir = join(dir, 'scripts', 'container');
        await Bun.spawn(['mkdir', '-p', scriptDir]).exited;
        const source = await readFile(
          join(import.meta.dir, '..', '..', '..', 'scripts', 'container', 'build-app-image.sh'),
          'utf8'
        );
        const scriptPath = join(scriptDir, 'build-app-image.sh');
        await writeFile(scriptPath, source);
        await chmod(scriptPath, 0o755);
        await writeFile(join(dir, 'README'), 'one\n');
        const gitEnv = {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        };
        const init = Bun.spawn(['git', 'init'], {
          cwd: dir,
          env: gitEnv,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(await init.exited).toBe(0);
        const add = Bun.spawn(['git', 'add', 'README', 'scripts/container/build-app-image.sh'], {
          cwd: dir,
          env: gitEnv,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(await add.exited).toBe(0);
        const commit = Bun.spawn(['git', 'commit', '-m', 'init'], {
          cwd: dir,
          env: gitEnv,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(await commit.exited).toBe(0);
        const headProc = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
          cwd: dir,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const head = (await new Response(headProc.stdout).text()).trim();
        expect(await headProc.exited).toBe(0);

        const stubLog = join(dir, 'stub.log');
        const stub = join(dir, 'stub-docker.sh');
        await writeFile(
          stub,
          `#!/usr/bin/env bash\nprintf '%s %s\\n' "$ARCHON_BUILD_SHA" "$*" > "${stubLog}"\nexit 0\n`
        );
        await chmod(stub, 0o755);
        const built = Bun.spawn(['bash', scriptPath], {
          cwd: dir,
          env: { ...gitEnv, ARCHON_DOCKER_BIN: stub },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(await built.exited).toBe(0);
        const logged = (await readFile(stubLog, 'utf8')).trim();
        expect(logged).toBe(`${head} compose build app`);
        expect(head).toMatch(/^[0-9a-f]{40}$/);

        await writeFile(join(dir, 'README'), 'dirty\n');
        const dirty = Bun.spawn(['bash', scriptPath], {
          cwd: dir,
          env: { ...gitEnv, ARCHON_DOCKER_BIN: stub },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const dirtyCode = await dirty.exited;
        const dirtyErr = await new Response(dirty.stderr).text();
        expect(dirtyCode).toBe(3);
        expect(dirtyErr).toContain('DIRTY');

        // Restore the tracked file to a clean state, then prove an UNTRACKED
        // file alone also refuses the build -- Docker's build context includes
        // untracked files, so the guard must not ignore them (Overseer finding
        // on PR #933: --untracked-files=no let an untracked file slip through).
        const restore = Bun.spawn(['git', 'checkout', '--', 'README'], {
          cwd: dir,
          env: gitEnv,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(await restore.exited).toBe(0);
        await writeFile(join(dir, 'untracked.txt'), 'new file\n');
        const untrackedDirty = Bun.spawn(['bash', scriptPath], {
          cwd: dir,
          env: { ...gitEnv, ARCHON_DOCKER_BIN: stub },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const untrackedCode = await untrackedDirty.exited;
        const untrackedErr = await new Response(untrackedDirty.stderr).text();
        expect(untrackedCode).toBe(3);
        expect(untrackedErr).toContain('DIRTY');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );
});
