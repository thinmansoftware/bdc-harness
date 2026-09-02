/**
 * cascade-allow-satisfied.test.ts -- the conductor honors an explicit operator
 * override of the already-satisfied guard (RunCascadeOptions.allowSatisfied,
 * plumbed from `fire.ps1 -AllowSatisfied` -> `cli.ts fire --allow-satisfied`).
 *
 * Anchor (2026-09-02): fire.ps1 -AllowSatisfied only bypassed fire.ps1's OWN gh
 * check; the conductor then ran its own claim check, logged ALREADY SATISFIED
 * for lspro-react #568 and refused to fire #1889. The flag never reached the
 * cascade.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCascade } from '../cascade.js';
import type { CascadeDeps, RunCascadeOptions } from '../cascade.js';
import type { FireResult, GateVerdict, PollResult, WoClaim } from '../types.js';

const testOutRoot = join(tmpdir(), `smart-cauldron-allow-satisfied-${randomUUID()}`);
afterAll(async () => {
  await rm(testOutRoot, { recursive: true, force: true });
});

/** Windows runners cross Bun's 5000ms default on the first cascade in a file. */
const SLOW_TEST_TIMEOUT_MS = 30_000;

function baseOpts(partial: Partial<RunCascadeOptions> = {}): RunCascadeOptions {
  return {
    woId: 'WO-LSPRO-M157-STREAM-STAYS-OPEN-UI-01',
    woClass: 'CODE',
    tags: ['mechanical'],
    outDir: join(testOutRoot, randomUUID()),
    token: 'test-token',
    project: 'lspro-react',
    ...partial,
  };
}

const mergedPreStep: WoClaim = {
  number: 568,
  state: 'MERGED',
  title: 'fix(m157): restore the phone CGC streamed gate on staging (W5 regression)',
  url: 'https://github.com/thinmansoftware/lspro-react/pull/568',
  repo: 'thinmansoftware/lspro-react',
};

function fireOk(runId: string): FireResult {
  return { ok: true, runId, conversationId: 'conv-stub', infraError: null };
}

function pollPassed(): PollResult {
  return {
    runId: 'run-stub',
    terminalStatus: 'completed',
    validatorVerdict: 'satisfied',
    prUrl: 'https://github.com/thinmansoftware/lspro-react/pull/700',
    prMergeable: true,
    servedModelId: null,
    rawMetadata: {},
  };
}

function passVerdict(): GateVerdict {
  return {
    pass: true,
    reason: 'all gate conditions passed',
    cancelled: false,
    validatorVerdict: 'satisfied',
    prOpened: true,
    prMergeable: true,
    terminalStatus: 'completed',
  };
}

function depsWithClaim(onFire: () => void): CascadeDeps {
  return {
    findWoClaim: async () => mergedPreStep,
    fire: async () => {
      onFire();
      return fireOk('run-override');
    },
    poll: async () => pollPassed(),
    judge: () => passVerdict(),
    escalate: async () => undefined,
    writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
  };
}

describe('allowSatisfied (operator override of the satisfied guard)', () => {
  test(
    'without the flag, an existing MERGED claim skips the cascade (status won, attempts 0)',
    async () => {
      let fireCalled = false;
      const record = await runCascade(baseOpts({ deps: depsWithClaim(() => (fireCalled = true)) }));
      expect(fireCalled).toBe(false);
      expect(record.status).toBe('won');
      expect(record.attempts.length).toBe(0);
    },
    SLOW_TEST_TIMEOUT_MS
  );

  test(
    'with allowSatisfied: true, the same claim is logged and the cascade fires anyway',
    async () => {
      let fireCalled = false;
      const logged: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      };
      try {
        const record = await runCascade(
          baseOpts({ allowSatisfied: true, deps: depsWithClaim(() => (fireCalled = true)) })
        );
        expect(fireCalled).toBe(true);
        expect(record.status).toBe('won');
        expect(record.attempts.length).toBe(1);
        expect(record.attempts[0]?.outcome).toBe('won');
      } finally {
        console.log = originalLog;
      }
      const override = logged.find(line => line.includes('ALLOW-SATISFIED override'));
      expect(override).toBeDefined();
      expect(override).toContain('PR #568');
      expect(override).toContain('firing anyway');
      expect(logged.some(line => line.includes('ALREADY SATISFIED'))).toBe(false);
    },
    SLOW_TEST_TIMEOUT_MS
  );

  test(
    'with allowSatisfied: true and no claim, the flag is a no-op and says so',
    async () => {
      const logged: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      };
      let fireCalled = false;
      try {
        const deps: CascadeDeps = {
          ...depsWithClaim(() => (fireCalled = true)),
          findWoClaim: async () => null,
        };
        const record = await runCascade(baseOpts({ allowSatisfied: true, deps }));
        expect(fireCalled).toBe(true);
        expect(record.status).toBe('won');
      } finally {
        console.log = originalLog;
      }
      expect(logged.some(line => line.includes('flag had no effect'))).toBe(true);
    },
    SLOW_TEST_TIMEOUT_MS
  );
});
