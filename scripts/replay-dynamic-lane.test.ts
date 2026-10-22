import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dir, 'replay-dynamic-lane.ts');
const fixture = resolve(
  import.meta.dir,
  '../packages/workflows/src/reliability/fixtures/dynamic-lane/eligible-synthetic.json'
);
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function run(path: string, cwd = import.meta.dir) {
  const child = Bun.spawn([process.execPath, 'run', script, '--input', path], {
    cwd, stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '' },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe('replay-dynamic-lane CLI', () => {
  test('emits exact deterministic receipt bytes for valid abstention without changing input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dynamic-lane-')); temporary.push(dir);
    const copy = join(dir, 'fixture.json');
    const original = await readFile(fixture); await writeFile(copy, original);
    const before = await stat(copy);
    const first = await run(copy, dir); const second = await run(copy, dir);
    expect(first.exitCode).toBe(0); expect(first.stderr).toBe('');
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout.endsWith('\n')).toBe(true);
    expect(JSON.parse(first.stdout).decision).toBe('abstain');
    expect(await readFile(copy)).toEqual(original);
    expect((await stat(copy)).mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(dir)).toEqual(['fixture.json']);
  });

  test('malformed envelope returns deterministic diagnostic and nonzero status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dynamic-lane-')); temporary.push(dir);
    const path = join(dir, 'bad.json'); await writeFile(path, '{"schemaVersion":"wrong-version"}\n');
    const result = await run(path, dir);
    expect(result.exitCode).toBe(2); expect(result.stdout).toBe('');
    expect(result.stderr).toBe("dynamic-lane-replay: invalid envelope at schemaVersion: Invalid literal value, expected \"dynamic-lane-snapshot/v3\"\n");
    expect(await readdir(dir)).toEqual(['bad.json']);
  });

  test('malformed Jev evidence is a valid zero-exit abstention', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dynamic-lane-')); temporary.push(dir);
    const input = JSON.parse(await readFile(fixture, 'utf8')) as Record<string, unknown>;
    input.jevExchange = { choice: 7 };
    const path = join(dir, 'invalid-jev.json'); await writeFile(path, `${JSON.stringify(input)}\n`);
    const result = await run(path, dir);
    expect(result.exitCode).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).jevDisposition).toBe('malformed_exchange');
  });

  test('invalid JSON, unreadable input, and arguments are public deterministic errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dynamic-lane-')); temporary.push(dir);
    const invalid = join(dir, 'invalid.json'); await writeFile(invalid, '{');
    expect((await run(invalid, dir)).stderr).toBe('dynamic-lane-replay: invalid JSON\n');
    expect((await run(join(dir, 'missing.json'), dir)).stderr).toBe('dynamic-lane-replay: unable to read input (ENOENT)\n');
    const child = Bun.spawn([process.execPath, 'run', script], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toBe('dynamic-lane-replay: expected --input <fixture.json>\n');
  });
});
