// node:fs, not fs/promises: notifiers.test.ts mock.module('fs/promises') is process-global.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import { parseReplayFixture, runDoJudgeReplay, type ReplayAction } from './do-judge-replay';
import { runReplayCli } from '../../../../scripts/dispatch/do-judge-replay';

const SCRIPT_PATH = fileURLToPath(
  new URL('../../../../scripts/dispatch/do-judge-replay.ts', import.meta.url)
);

function input(id: string): DispatchMessage {
  return { id } as DispatchMessage;
}

describe('do judge replay', () => {
  test('replay_report_compares_verdicts', async () => {
    const recorded: ReplayAction[] = ['nudge', 'hold', 'escalate_xo', 'failed', 'nudge'];
    const fresh: ReplayAction[] = ['nudge', 'escalate_xo', 'escalate_xo', 'failed', 'hold'];
    const records = recorded.map((recordedAction, index) => ({
      id: `m${index + 1}`,
      input: input(`m${index + 1}`),
      recordedAction,
    }));

    const report = await runDoJudgeReplay({
      records,
      classify: message => fresh[Number(message.id.slice(1)) - 1] as ReplayAction,
    });

    expect(report.total).toBe(5);
    expect(report.agreementCount).toBe(3);
    expect(report.rows).toEqual([
      { id: 'm1', oldVerdict: 'nudge', newVerdict: 'nudge', agree: true },
      { id: 'm2', oldVerdict: 'hold', newVerdict: 'escalate_xo', agree: false },
      { id: 'm3', oldVerdict: 'escalate_xo', newVerdict: 'escalate_xo', agree: true },
      { id: 'm4', oldVerdict: 'failed', newVerdict: 'failed', agree: true },
      { id: 'm5', oldVerdict: 'nudge', newVerdict: 'hold', agree: false },
    ]);
  });

  test('rejects malformed fixtures instead of inventing verdicts', () => {
    expect(() => parseReplayFixture({ records: [] })).toThrow(/do_judge_replay_fixture_invalid/);
    expect(() =>
      parseReplayFixture([{ id: 'm1', recordedAction: 'ship', input: { id: 'm1' } }])
    ).toThrow(/recordedAction is invalid/);
    expect(() =>
      parseReplayFixture([{ id: '', recordedAction: 'hold', input: { id: 'm1' } }])
    ).toThrow(/missing id/);
  });

  test('rejects a classifier result outside the verdict set', async () => {
    await expect(
      runDoJudgeReplay({
        records: [{ id: 'm1', input: input('m1'), recordedAction: 'hold' }],
        classify: () => 'ship' as ReplayAction,
      })
    ).rejects.toThrow(/do_judge_replay_classifier_invalid: m1/);
  });

  test('script source does not post mail or call paid providers', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    expect(source.includes('createAuthenticatedMessage')).toBe(false);
    expect(source.includes('postIssueComment')).toBe(false);
    expect(source.includes('openrouter.ai')).toBe(false);
    expect(source.includes('gh ')).toBe(false);
  });

  test('cli writes a report and exits 2 when arguments are missing', async () => {
    const lines: string[] = [];
    const missing = await runReplayCli({
      argv: ['bun', 'scripts/dispatch/do-judge-replay.ts'],
      env: {},
      stderr: line => {
        lines.push(line);
      },
      classify: async () => 'hold',
    });
    expect(missing).toBe(2);
    expect(lines.join('\n')).toContain('--fixture');
    expect(lines.join('\n')).toContain('--out');

    const dir = mkdtempSync(join(tmpdir(), 'do-judge-replay-'));
    try {
      const fixturePath = join(dir, 'fixture.json');
      const outPath = join(dir, 'report.json');
      const fixture = [
        { id: 'm1', recordedAction: 'nudge', input: { id: 'm1' } },
        { id: 'm2', recordedAction: 'hold', input: { id: 'm2' } },
      ];
      writeFileSync(fixturePath, JSON.stringify(fixture));
      const env: NodeJS.ProcessEnv = {
        OPENROUTER_API_KEY: 'or-test',
        GLM_API_KEY: 'glm-test',
        XAI_API_KEY: 'xai-test',
      };
      const code = await runReplayCli({
        argv: [
          'bun',
          'scripts/dispatch/do-judge-replay.ts',
          '--fixture',
          fixturePath,
          '--out',
          outPath,
        ],
        env,
        readText: async path => readFileSync(path, 'utf8'),
        writeText: async (path, text) => {
          writeFileSync(path, text);
        },
        classify: () => {
          expect(env.DUTY_OFFICER_JUDGE_PROVIDER).toBe('claude');
          expect(env.DUTY_OFFICER_JUDGE_ENABLED).toBe('true');
          expect(env.OPENROUTER_API_KEY).toBeUndefined();
          expect(env.GLM_API_KEY).toBeUndefined();
          expect(env.XAI_API_KEY).toBeUndefined();
          return 'nudge';
        },
      });
      expect(code).toBe(0);
      const report = JSON.parse(readFileSync(outPath, 'utf8')) as {
        total: number;
        agreementCount: number;
        rows: { id: string; oldVerdict: string; newVerdict: string; agree: boolean }[];
      };
      expect(report.total).toBe(2);
      expect(report.agreementCount).toBe(1);
      expect(report.rows[0]).toEqual({
        id: 'm1',
        oldVerdict: 'nudge',
        newVerdict: 'nudge',
        agree: true,
      });
      expect(report.rows[1]?.agree).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cli returns nonzero when the report cannot be written', async () => {
    const errors: string[] = [];
    const code = await runReplayCli({
      argv: ['bun', 'script', '--fixture', 'fixture.json', '--out', 'report.json'],
      readText: async () =>
        JSON.stringify([{ id: 'm1', recordedAction: 'hold', input: { id: 'm1' } }]),
      writeText: async () => {
        throw new Error('disk full');
      },
      classify: async () => 'hold',
      env: {},
      stderr: line => {
        errors.push(line);
      },
    });
    expect(code).not.toBe(0);
    expect(errors.join('\n')).toContain('disk full');
  });

  test('cli returns nonzero for a malformed fixture', async () => {
    const errors: string[] = [];
    const code = await runReplayCli({
      argv: ['bun', 'script', '--fixture', 'fixture.json', '--out', 'report.json'],
      readText: async () => '{"not":"an array"}',
      classify: async () => {
        throw new Error('classify should not run');
      },
      env: {},
      stderr: line => {
        errors.push(line);
      },
    });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('do_judge_replay_fixture_invalid');
  });
});
