import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  dynamicLaneSnapshotSchema,
  evaluateDynamicLane,
  type DynamicLaneV4Snapshot,
} from '../packages/workflows/src/reliability/dynamic-lane-admission';

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
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '' },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe('replay-dynamic-lane CLI', () => {
  test('v4 Haiku proposal replays with no credentials and preserves the input bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dynamic-lane-v4-'));
    temporary.push(dir);
    const input = dynamicLaneSnapshotSchema.parse(
      JSON.parse(
        await readFile(
          resolve(
            import.meta.dir,
            '../packages/workflows/src/reliability/fixtures/dynamic-lane/eligible-haiku-synthetic.json'
          ),
          'utf8'
        )
      )
    ) as DynamicLaneV4Snapshot;
    const pending = evaluateDynamicLane(input);
    const route = input.routingResourcePlan[0]!;
    input.decisionExchanges = [
      {
        routeId: route.routeId,
        engineId: route.engineId,
        adapterId: route.adapterId,
        accountId: route.accountId,
        transport: route.transport,
        origin: 'synthetic',
        requestedModel: route.requestedModel,
        servedModel: route.requestedModel,
        attemptId: 'cli-1',
        startedAt: '2026-10-17T11:59:01.000Z',
        completedAt: '2026-10-17T11:59:02.000Z',
        usage: null,
        cashCost: null,
        latencyMs: null,
        outcome: 'success',
        response: {
          schemaVersion: 'dynamic-lane-response/v1',
          decisionId: input.decisionId,
          requestHash: pending.requestHash,
          snapshotHash: pending.snapshotHash,
          choice: 'select',
          candidateId: 'codex-plan',
          rationale: 'Choose eligible model.',
          evidenceReferences: ['evidence-001'],
        },
      },
    ];
    const path = join(dir, 'haiku.json');
    const bytes = `${JSON.stringify(input)}\n`;
    await writeFile(path, bytes);
    const first = await run(path, dir);
    const second = await run(path, dir);
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe('');
    expect(first.stdout).toBe(second.stdout);
    const receipt = JSON.parse(first.stdout);
    expect(receipt.decision).toBe('propose');
    expect(receipt.engineId).toBe('haiku');
    expect(receipt.decisionOrigin).toBe('synthetic');
    expect(receipt.postExecutionReview).toBe('unissued');
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(await readdir(dir)).toEqual(['haiku.json']);
  });

  test('omitted and empty semantic packets yield exit zero without a request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dynamic-lane-missing-'));
    temporary.push(dir);
    for (const key of ['taskBrief', 'roleObjective', 'decisionEvidence', 'candidateProfiles']) {
      for (const value of [undefined, {}]) {
        const input = JSON.parse(await readFile(fixture, 'utf8')) as Record<string, unknown>;
        input[key] = value;
        const path = join(dir, 'missing.json');
        await writeFile(path, JSON.stringify(input));
        const result = await run(path, dir);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout).request).toBeNull();
      }
    }
  });
  test('emits exact deterministic receipt bytes for valid abstention without changing input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dynamic-lane-'));
    temporary.push(dir);
    const copy = join(dir, 'fixture.json');
    const original = await readFile(fixture);
    await writeFile(copy, original);
    const before = await stat(copy);
    const first = await run(copy, dir);
    const second = await run(copy, dir);
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe('');
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout.endsWith('\n')).toBe(true);
    expect(JSON.parse(first.stdout).decision).toBe('abstain');
    expect(await readFile(copy)).toEqual(original);
    expect((await stat(copy)).mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(dir)).toEqual(['fixture.json']);
  });

  test('malformed envelope returns deterministic diagnostic and nonzero status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dynamic-lane-'));
    temporary.push(dir);
    const path = join(dir, 'bad.json');
    await writeFile(path, '{"schemaVersion":"wrong-version"}\n');
    const result = await run(path, dir);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      "dynamic-lane-replay: invalid envelope at schemaVersion: Invalid discriminator value. Expected 'dynamic-lane-snapshot/v3' | 'dynamic-lane-snapshot/v4'\n"
    );
    expect(await readdir(dir)).toEqual(['bad.json']);
  });

  test('malformed Jev evidence is a valid zero-exit abstention', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dynamic-lane-'));
    temporary.push(dir);
    const input = JSON.parse(await readFile(fixture, 'utf8')) as Record<string, unknown>;
    input.jevExchange = { choice: 7 };
    const path = join(dir, 'invalid-jev.json');
    await writeFile(path, `${JSON.stringify(input)}\n`);
    const result = await run(path, dir);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).jevDisposition).toBe('malformed_exchange');
  });

  test('unsupported semantic packet is a deterministic zero-exit abstention with no request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dynamic-lane-'));
    temporary.push(dir);
    const input = JSON.parse(await readFile(fixture, 'utf8')) as Record<string, unknown>;
    (input.taskBrief as Record<string, unknown>).version = 'task-brief/v999';
    const path = join(dir, 'unsupported-version.json');
    const bytes = `${JSON.stringify(input)}\n`;
    await writeFile(path, bytes);
    const first = await run(path, dir);
    const second = await run(path, dir);
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe('');
    expect(first.stdout).toBe(second.stdout);
    const receipt = JSON.parse(first.stdout);
    expect(receipt.candidateRejections['codex-plan']).toContain('unsupported_task_brief_version');
    expect(receipt.request).toBeNull();
    expect(receipt.requestHash).toBeNull();
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(await readdir(dir)).toEqual(['unsupported-version.json']);
  });

  test('invalid JSON, unreadable input, and arguments are public deterministic errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dynamic-lane-'));
    temporary.push(dir);
    const invalid = join(dir, 'invalid.json');
    await writeFile(invalid, '{');
    expect((await run(invalid, dir)).stderr).toBe('dynamic-lane-replay: invalid JSON\n');
    expect((await run(join(dir, 'missing.json'), dir)).stderr).toBe(
      'dynamic-lane-replay: unable to read input (ENOENT)\n'
    );
    const child = Bun.spawn([process.execPath, 'run', script], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toBe(
      'dynamic-lane-replay: expected --input <fixture.json>\n'
    );
  });
});
