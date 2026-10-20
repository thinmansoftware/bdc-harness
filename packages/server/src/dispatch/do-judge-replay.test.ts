// node:fs, not fs/promises: notifiers.test.ts mock.module('fs/promises') is process-global.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import {
  DO_JUDGE_REPLAY_STORE_LIMIT,
  DO_JUDGE_REPLAY_STORE_SCAN,
  DUTY_OFFICER_JUDGE_REPLAY_SQL,
  loadRecentDutyOfficerJudgeRecords,
  parseReplayFixture,
  recordedModelAction,
  runDoJudgeReplay,
  selectStoredJudgeReplayRecords,
  type ReplayAction,
} from './do-judge-replay';
import { runReplayCli } from '../../../../scripts/dispatch/do-judge-replay';

const SCRIPT_PATH = fileURLToPath(
  new URL('../../../../scripts/dispatch/do-judge-replay.ts', import.meta.url)
);

function input(id: string): DispatchMessage {
  return { id } as DispatchMessage;
}

function stored(
  id: string,
  result: { disposition: string; transport: string | null } | null,
  extra: Partial<DispatchMessage> = {}
): DispatchMessage {
  return {
    id,
    recipient: 'duty-officer',
    status: 'done',
    result_body: result === null ? null : JSON.stringify(result),
    ...extra,
  } as DispatchMessage;
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
    expect(source.includes('--from-store')).toBe(true);
    expect(source.includes('defaultLoadStoreRecords')).toBe(true);
    expect(source.includes('getDatabase')).toBe(true);
    expect(source.includes('loadRecentDutyOfficerJudgeRecords')).toBe(true);
  });

  test('store loader keeps the last 50 paid-model verdicts', async () => {
    const decoys: DispatchMessage[] = [
      stored('mechanical', { disposition: 'escalated_to_xo', transport: null }),
      stored('claude-row', { disposition: 'cued', transport: 'claude:claude-haiku-5-5' }),
      stored('mailbox', {
        disposition: 'taskmaster_mailbox',
        transport: 'openrouter:x-ai/grok-4.7',
      }),
      stored('held', null, { status: 'queued' }),
      stored(
        'other-recipient',
        { disposition: 'cued', transport: 'xai:grok-4.7' },
        {
          recipient: 'xo',
        }
      ),
      stored('bad-json', null, { result_body: '{not json' }),
    ];
    const judged = Array.from({ length: 60 }, (_, index) =>
      stored(`m${index}`, {
        disposition: index % 2 === 0 ? 'cued' : 'escalated_to_xo',
        transport: index % 3 === 0 ? 'xai:grok-4.7' : 'openrouter:x-ai/grok-4.7',
      })
    );
    let seenSql = '';
    let seenParams: readonly unknown[] = [];
    const records = await loadRecentDutyOfficerJudgeRecords(async (sql, params) => {
      seenSql = sql;
      seenParams = params;
      return { rows: [...decoys, ...judged] };
    });

    expect(seenSql).toBe(DUTY_OFFICER_JUDGE_REPLAY_SQL);
    expect(seenSql).toContain('agent_dispatch_messages');
    expect(seenSql).toContain("'duty-officer'");
    expect(seenSql).toContain('ORDER BY completed_at DESC');
    expect(seenParams).toEqual([DO_JUDGE_REPLAY_STORE_SCAN]);
    expect(DO_JUDGE_REPLAY_STORE_LIMIT).toBe(50);
    expect(records).toHaveLength(50);
    expect(records[0]).toMatchObject({ id: 'm0', recordedAction: 'nudge' });
    expect(records[1]).toMatchObject({ id: 'm1', recordedAction: 'escalate_xo' });
    expect(records.some(row => row.recordedAction === 'hold')).toBe(false);
    expect(records.some(row => row.recordedAction === 'failed')).toBe(false);
    expect(records.some(row => row.id === 'mechanical' || row.id === 'claude-row')).toBe(false);
    expect(recordedModelAction(null)).toBeNull();
    expect(selectStoredJudgeReplayRecords(judged, 2)).toHaveLength(2);
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

  test('cli loads stored judge inputs when --from-store is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'do-judge-replay-store-'));
    try {
      const outPath = join(dir, 'report.json');
      const records = Array.from({ length: 50 }, (_, index) => ({
        id: `s${index}`,
        input: input(`s${index}`),
        recordedAction: 'escalate_xo' as const,
      }));
      let loaded = 0;
      const code = await runReplayCli({
        argv: ['bun', 'scripts/dispatch/do-judge-replay.ts', '--from-store', '--out', outPath],
        env: { OPENROUTER_API_KEY: 'or-test', GLM_API_KEY: 'glm-test' },
        loadStoreRecords: async () => {
          loaded += 1;
          return records;
        },
        writeText: async (path, text) => {
          writeFileSync(path, text);
        },
        classify: () => {
          return 'nudge';
        },
      });
      expect(loaded).toBe(1);
      expect(code).toBe(0);
      const report = JSON.parse(readFileSync(outPath, 'utf8')) as {
        total: number;
        agreementCount: number;
      };
      expect(report.total).toBe(50);
      expect(report.agreementCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cli rejects --fixture together with --from-store', async () => {
    const lines: string[] = [];
    const code = await runReplayCli({
      argv: ['bun', 'script', '--fixture', 'fixture.json', '--from-store', '--out', 'report.json'],
      env: {},
      loadStoreRecords: async () => {
        throw new Error('store should not be read');
      },
      readText: async () => {
        throw new Error('fixture should not be read');
      },
      stderr: line => {
        lines.push(line);
      },
    });
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('--from-store');
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
