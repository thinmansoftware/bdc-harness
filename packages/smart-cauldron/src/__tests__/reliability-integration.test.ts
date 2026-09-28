import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { runCascade } from '../cascade.js';
import { PollTransportError } from '../poll.js';
import type { CascadeDeps } from '../cascade.js';
import type { CascadeRunRecord } from '../types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function outDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'smart-cauldron-reliability-'));
  tempDirs.push(dir);
  return dir;
}

async function persistedRecord(dir: string): Promise<CascadeRunRecord> {
  const entries = await readdir(dir, { withFileTypes: true });
  const runDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'wo-locks') continue;
    const files = await readdir(join(dir, entry.name), { withFileTypes: true });
    if (files.some(file => file.isFile() && file.name === 'cascade-record.json')) {
      runDirs.push(entry.name);
    }
  }
  if (runDirs.length !== 1) {
    throw new Error(
      `Expected exactly one cascade record directory in ${dir}; found ${runDirs.length}. ` +
        `Entries seen: ${JSON.stringify(entries.map(entry => entry.name).sort())}`
    );
  }
  const [runDir] = runDirs;
  return JSON.parse(
    await readFile(join(dir, runDir, 'cascade-record.json'), 'utf8')
  ) as CascadeRunRecord;
}

function winningDeps(fire: ReturnType<typeof mock>): CascadeDeps {
  return {
    preflight: async () => undefined,
    fire,
    poll: async options => ({
      runId: options.runId,
      terminalStatus: 'completed',
      validatorVerdict: 'satisfied',
      prUrl: 'https://github.com/owner/repo/pull/1',
      prMergeable: true,
      servedModelId: 'fixture-model',
      rawMetadata: {},
    }),
    judge: () => ({
      pass: true,
      reason: 'fixture gate passed',
      validatorVerdict: 'satisfied',
      prOpened: true,
      prMergeable: true,
      terminalStatus: 'completed',
    }),
    escalate: async () => undefined,
  };
}

describe('Smart Cauldron restart integration fixtures', () => {
  test('conductor dry run persists planned and never calls a provider', async () => {
    const dir = await outDir();
    const fire = mock(async () => ({
      ok: true,
      runId: 'should-not-fire',
      conversationId: 'should-not-fire',
      infraError: null,
    }));
    const record = await runCascade({
      woId: 'WO-DRY-RUN-FIXTURE',
      dispatchId: 'dry-run-fixture',
      woClass: 'CODE',
      tags: ['mechanical'],
      dryRun: true,
      outDir: dir,
      deps: { fire },
    });
    const persisted = await persistedRecord(dir);

    expect(record.status).toBe('planned');
    expect(persisted.status).toBe('planned');
    expect(persisted.request.dryRun).toBe(true);
    expect(fire).not.toHaveBeenCalled();
  });

  test('replay after a completed process cannot duplicate the provider call', async () => {
    const dir = await outDir();
    const fire = mock(async () => ({
      ok: true,
      runId: 'run-once',
      conversationId: 'conversation-once',
      infraError: null,
    }));
    const options = {
      woId: 'WO-IDEMPOTENT-FIXTURE',
      dispatchId: 'idempotent-fixture',
      woClass: 'CODE',
      tags: ['mechanical'],
      project: 'harness',
      token: 'fixture-token',
      outDir: dir,
      deps: winningDeps(fire),
    };

    const first = await runCascade(options);
    const replay = await runCascade(options);

    expect(first.status).toBe('won');
    expect(replay).toEqual(first);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  test('poll transport failure is durably distinct from progress timeout', async () => {
    const dir = await outDir();
    const fire = mock(async () => ({
      ok: true,
      runId: 'run-transport-failure',
      conversationId: 'conversation-transport-failure',
      infraError: null,
    }));
    const record = await runCascade({
      woId: 'WO-POLL-TRANSPORT-FIXTURE',
      dispatchId: 'poll-transport-fixture',
      project: 'harness',
      token: 'fixture-token',
      outDir: dir,
      deps: {
        ...winningDeps(fire),
        poll: async () => {
          throw new PollTransportError('HTTP 503');
        },
      },
    });
    const persisted = await persistedRecord(dir);

    expect(record.status).toBe('infra-alert');
    expect(persisted.attempts[0]?.outcome).toBe('infra-error');
    expect(persisted.attempts[0]?.infraErrorReason).toContain('HTTP 503');
  });
});
