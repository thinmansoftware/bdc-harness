import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Focused source-recipe contract, not proof of an installed image or a general
// Dockerfile interpreter. Only unchanged source-to-/app copies count here.
function startupImageDependencies(recipe: string): string[] {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const final = recipe.split(/^FROM /m).at(-1)!;
  expect(final.startsWith('oven/bun:1.3.11-slim AS production')).toBe(true);
  const copied = final.split(/\r?\n/).flatMap(line => {
    const match = /^COPY ([\w./-]+) \.\/([\w./-]+)$/.exec(line);
    return match && match[1] === match[2] ? [match[1]!] : [];
  });
  const entry = readFileSync(new URL('./probe-codex-startup.ts', import.meta.url), 'utf8');
  const targets = [...entry.matchAll(/const \w+Path = '\/app\/([^']+)';/g)].map(match => match[1]!);
  expect(targets.sort()).toEqual([
    'packages/providers/src/codex/restricted-policy.ts',
    'scripts/staging/teetime-reviewer-fixture.ts',
    'scripts/staging/teetime-startup-protocol.ts',
  ]);
  const pending = [...targets], visited = new Set<string>();
  const scanner = new Bun.Transpiler({ loader: 'ts' });
  while (pending.length) {
    const name = pending.pop()!;
    if (visited.has(name)) continue;
    if (name.startsWith('../') || !existsSync(resolve(root, name)))
      throw new Error('unresolved startup dependency: ' + name);
    if (!copied.some(source => source.endsWith('/') ? name.startsWith(source) : name === source))
      throw new Error('startup dependency absent from final-stage recipe: ' + name);
    visited.add(name);
    for (const item of scanner.scanImports(readFileSync(resolve(root, name), 'utf8'))) {
      if (item.path.startsWith('node:')) continue;
      if (item.kind !== 'import-statement' || !item.path.startsWith('.'))
        throw new Error('unsupported startup dependency form');
      const path = posix.normalize(posix.join(posix.dirname(name), item.path));
      pending.push(path.endsWith('.ts') ? path : path + '.ts');
    }
  }
  return [...visited].sort();
}

test('final image recipe covers startup literal imports and their runtime closure', () => {
  const recipe = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  expect(startupImageDependencies(recipe)).toContain('packages/providers/src/codex/sdk-failure-evidence.ts');
});

test('build-stage source and provider package metadata cannot supply missing startup runtime files', () => {
  const recipe = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  for (const line of [
    'COPY scripts/staging/teetime-startup-protocol.ts ./scripts/staging/teetime-startup-protocol.ts',
    'COPY packages/providers/ ./packages/providers/',
  ]) {
    expect(() => startupImageDependencies(recipe.replace(line, ''))).toThrow('startup dependency absent');
  }
});

test('stdin startup entry failure stays closed through independent Python projection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'teetime-startup-entry-'));
  try {
    const env: Record<string, string> = { TEE_TIME_SANDBOX_PROBE: '0' };
    if (process.platform === 'win32' && process.env.SystemRoot)
      env.SystemRoot = process.env.SystemRoot;
    const entry = readFileSync(new URL('./probe-codex-startup.ts', import.meta.url), 'utf8');
    for (const phase of ['context', 'imports']) {
      // Synthetic source fixture only: bypass the context guard to exercise an
      // early missing import. No native executable or account can be reached.
      const input = phase === 'context' ? entry : entry
        .replace("requireValue(process.env.TEE_TIME_SANDBOX_PROBE === '1' && process.getuid?.() === 1001);", 'requireValue(true);')
        .replace("'/app/packages/providers/src/codex/restricted-policy.ts'",
          JSON.stringify(pathToFileURL(join(directory, 'PRIVATE-MISSING-MODULE.ts')).href));
      const result = Bun.spawnSync([process.execPath, 'run', '-'], {
        cwd: directory,
        env,
        stdin: Buffer.from(input),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 3000,
        killSignal: 'SIGKILL',
        maxBuffer: 16384,
      });
      expect(result.exitCode).toBe(1);
      expect(result.signalCode ?? null).toBeNull();
      expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual(
        { kind: 'teetime-startup-capture-failed-v2', phase }
      );
      expect(new TextDecoder().decode(result.stderr)).toBe('');
      expect(new TextDecoder().decode(result.stdout)).not.toContain('PRIVATE');
      const python = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [
        '-I', '-B', '-c',
        'import sys;sys.path.insert(0,sys.argv[1]);from teetime_startup_packet import startup_failure_diagnostic,startup_metadata;raw=sys.stdin.buffer.read();v=startup_failure_diagnostic(raw,1);assert v["phase"]==sys.argv[2];\ntry: startup_metadata(raw)\nexcept ValueError: pass\nelse: raise AssertionError("failure cannot be private success")',
        fileURLToPath(new URL('./', import.meta.url)), phase,
      ], { input: result.stdout, encoding: 'utf8', timeout: 3000 });
      expect(python.status).toBe(0);
    }
  } finally {
    const target = realpathSync(directory);
    if (
      dirname(target) !== realpathSync(tmpdir()) ||
      !basename(target).startsWith('teetime-startup-entry-')
    )
      throw new Error('owned startup test cleanup path rejected');
    rmSync(target, { recursive: true });
  }
});
