/**
 * Regression tests for bdc-harness #852 -- the terminal-run judge
 * (judge-first.ts) and the merge second-opinion judge
 * (judge-second-opinion.ts) each carried their own copy of "how to spawn a
 * ladder rung", and both copies were wrong twice over: `cursor` was spawned as
 * a literal executable (the CLI is `cursor-agent`, which has no -p flag), and
 * the whole prompt rode in ONE argv element, which Linux caps at MAX_ARG_STRLEN
 * (131,072 bytes) -- the E2BIG that #776/#786 already fixed for the PR-review
 * judge. Live 2026-09-15 13:47Z, ladder codex,grok,cursor with codex out of
 * quota and grok out of credits: the PR-review judge got a verdict from the
 * cursor rung; judge-first logged `Executable not found in $PATH: "cursor"`
 * and ended judge_unavailable.
 *
 * Every child here is a double. No network, no real binary.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  DEFAULT_CURSOR_JUDGE_MODEL,
  buildJudgeTransport,
  removeJudgeTransportFiles,
  type JudgeChild,
  type JudgeChildSpawn,
} from '../judge-transport';
import { parseJudgeOutput, spawnJudgeBinary } from '../judge-first';
import { parseGrokVerdict, spawnGrok } from '../judge-second-opinion';

/** Linux MAX_ARG_STRLEN: the cap on ONE argv element. */
const MAX_ARG_STRLEN = 131_072;
/** Comfortably past the cap, in the spirit of pr-review-large-prompt.test.ts. */
const LARGE_PROMPT = `judge this private envelope: ${'e'.repeat(200_000)}`;
const VERDICT_JSON =
  '{"verdict":"observe","confidence":0.7,"proposed_action":"none","reason":"ok"}';
const FENCE = '`'.repeat(3);
const CODEX_ARGV = ['bunx', '@openai/codex', 'exec', '--skip-git-repo-check'];

function largestArgvElementBytes(argv: string[]): number {
  return argv.reduce((max, arg) => Math.max(max, Buffer.byteLength(arg, 'utf8')), 0);
}

function expectNothingOversizedInArgv(argv: string[]): void {
  // The prompt genuinely exceeds the cap -- otherwise this proves nothing.
  expect(Buffer.byteLength(LARGE_PROMPT, 'utf8')).toBeGreaterThan(MAX_ARG_STRLEN);
  expect(largestArgvElementBytes(argv)).toBeLessThan(MAX_ARG_STRLEN);
  for (const arg of argv) {
    expect(arg).not.toContain('judge this private envelope');
    expect(arg).not.toContain('e'.repeat(100));
  }
}

const ORIGINAL_ENV = {
  cursorModel: process.env.OVERSEER_CURSOR_JUDGE_MODEL,
  ladder: process.env.OVERSEER_JUDGE_LADDER,
};

function restoreEnv(): void {
  if (ORIGINAL_ENV.cursorModel === undefined) delete process.env.OVERSEER_CURSOR_JUDGE_MODEL;
  else process.env.OVERSEER_CURSOR_JUDGE_MODEL = ORIGINAL_ENV.cursorModel;
  if (ORIGINAL_ENV.ladder === undefined) delete process.env.OVERSEER_JUDGE_LADDER;
  else process.env.OVERSEER_JUDGE_LADDER = ORIGINAL_ENV.ladder;
}

afterEach(restoreEnv);

interface ChildState {
  written: string;
  ended: boolean;
  killed: boolean;
}

/**
 * A child that behaves like codex exec / cursor-agent: it reads stdin to EOF
 * and only THEN exits with its answer. If a seam awaited the process before
 * writing the prompt, `exited` would never settle and the test would time out
 * -- exactly the deadlock the overlapping delivery prevents.
 */
function consumingChild(
  stdout: string,
  exitCode = 0,
  stderr = ''
): { child: JudgeChild; state: ChildState } {
  const state: ChildState = { written: '', ended: false, killed: false };
  let settleExit: (code: number) => void = () => undefined;
  const exited = new Promise<number>(resolve => {
    settleExit = resolve;
  });
  const child: JudgeChild = {
    stdin: {
      write: async (chunk: string): Promise<number> => {
        state.written += chunk;
        return chunk.length;
      },
      end: async (): Promise<void> => {
        state.ended = true;
        settleExit(exitCode);
      },
    },
    stdout: new Response(stdout).body,
    stderr: new Response(stderr).body,
    exited,
    kill: (): void => {
      state.killed = true;
    },
  };
  return { child, state };
}

/** A child for prompt-file rungs: no stdin at all, exits at once. */
function fileFedChild(stdout: string): JudgeChild {
  return {
    stdin: undefined,
    stdout: new Response(stdout).body,
    stderr: new Response('').body,
    exited: Promise.resolve(0),
    kill: (): void => undefined,
  };
}

interface SpawnRecord {
  argv: string[];
  stdinMode: 'ignore' | 'pipe';
  promptFileContents?: string;
}

function recordingSpawn(child: JudgeChild, records: SpawnRecord[]): JudgeChildSpawn {
  return (argv, stdinMode) => {
    const record: SpawnRecord = { argv, stdinMode };
    const flag = argv.indexOf('--prompt-file');
    const promptPath = flag >= 0 ? argv[flag + 1] : undefined;
    // Read the file while it exists -- the seam removes it in a finally.
    if (promptPath !== undefined) record.promptFileContents = readFileSync(promptPath, 'utf8');
    records.push(record);
    return child;
  };
}

describe('#852 -- buildJudgeTransport knows the cursor rung', () => {
  test('spawns cursor-agent in read-only ask mode with the prompt on stdin', async () => {
    delete process.env.OVERSEER_CURSOR_JUDGE_MODEL;
    const transport = await buildJudgeTransport('cursor', 'private envelope');
    expect(DEFAULT_CURSOR_JUDGE_MODEL).toBe('grok-4.7-high');
    expect(transport.argv).toEqual([
      'cursor-agent',
      '--print',
      '--mode',
      'ask',
      '--trust',
      '--model',
      DEFAULT_CURSOR_JUDGE_MODEL,
    ]);
    expect(transport.stdinPrompt).toBe('private envelope');
    expect(transport.promptFile).toBeUndefined();
    expect(transport.promptDir).toBeUndefined();
    // The two shapes that failed live: a literal `cursor` executable, and -p.
    expect(transport.argv[0]).not.toBe('cursor');
    expect(transport.argv).not.toContain('-p');
    for (const arg of transport.argv) expect(arg).not.toContain('private envelope');
  });

  test('honours OVERSEER_CURSOR_JUDGE_MODEL and ignores a blank value', async () => {
    process.env.OVERSEER_CURSOR_JUDGE_MODEL = 'gpt-5.6-sol-high';
    const configured = await buildJudgeTransport('cursor', 'p');
    expect(configured.argv.slice(-2)).toEqual(['--model', 'gpt-5.6-sol-high']);

    process.env.OVERSEER_CURSOR_JUDGE_MODEL = '   ';
    const blank = await buildJudgeTransport('cursor', 'p');
    expect(blank.argv.slice(-2)).toEqual(['--model', DEFAULT_CURSOR_JUDGE_MODEL]);
  });
});

describe("#852 -- codex and grok keep today's PR-review behaviour", () => {
  test('codex: bunx exec with the prompt on stdin and no prompt file', async () => {
    const transport = await buildJudgeTransport('codex', 'private envelope');
    expect(transport.argv).toEqual(CODEX_ARGV);
    expect(transport.stdinPrompt).toBe('private envelope');
    expect(transport.promptFile).toBeUndefined();
    expect(transport.promptDir).toBeUndefined();
  });

  test('grok: --prompt-file to a 0600 file in a 0700 dir, both removed by the cleanup helper', async () => {
    const transport = await buildJudgeTransport('grok', 'private envelope');
    const { promptFile, promptDir } = transport;
    expect(promptFile).toBeDefined();
    expect(promptDir).toBeDefined();
    if (promptFile === undefined || promptDir === undefined) return;
    expect(transport.argv).toEqual(['grok', '--prompt-file', promptFile]);
    expect(transport.stdinPrompt).toBeUndefined();
    expect(await Bun.file(promptFile).text()).toBe('private envelope');
    // Unix permission bits are synthesized on Windows -- assert where real.
    if (process.platform !== 'win32') {
      expect((await stat(promptFile)).mode & 0o777).toBe(0o600);
      expect((await stat(promptDir)).mode & 0o777).toBe(0o700);
    }
    await removeJudgeTransportFiles(transport);
    await expect(stat(promptFile)).rejects.toThrow();
    await expect(stat(promptDir)).rejects.toThrow();
    // Idempotent: a second cleanup of already-removed paths does not throw.
    await removeJudgeTransportFiles(transport);
  });
});

describe('#852 -- a >128 KB prompt never lands in argv', () => {
  test('codex', async () => {
    const transport = await buildJudgeTransport('codex', LARGE_PROMPT);
    expectNothingOversizedInArgv(transport.argv);
    expect(transport.stdinPrompt).toBe(LARGE_PROMPT);
  });

  test('cursor', async () => {
    const transport = await buildJudgeTransport('cursor', LARGE_PROMPT);
    expectNothingOversizedInArgv(transport.argv);
    expect(transport.stdinPrompt).toBe(LARGE_PROMPT);
  });

  test('grok', async () => {
    const transport = await buildJudgeTransport('grok', LARGE_PROMPT);
    expectNothingOversizedInArgv(transport.argv);
    expect(transport.stdinPrompt).toBeUndefined();
    expect(transport.promptFile).toBeDefined();
    if (transport.promptFile !== undefined) {
      expect(await Bun.file(transport.promptFile).text()).toBe(LARGE_PROMPT);
    }
    if (transport.promptDir !== undefined) {
      await rm(transport.promptDir, { recursive: true, force: true });
    }
  });
});

describe('#852 -- judge-first seam (spawnJudgeBinary) goes through the shared transport', () => {
  test('cursor: cursor-agent on argv, the whole prompt on stdin, fenced JSON still parses', async () => {
    delete process.env.OVERSEER_CURSOR_JUDGE_MODEL;
    const records: SpawnRecord[] = [];
    const { child, state } = consumingChild(`${FENCE}json\n${VERDICT_JSON}\n${FENCE}\n`);
    const result = await spawnJudgeBinary(
      'cursor',
      LARGE_PROMPT,
      5_000,
      recordingSpawn(child, records)
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.argv[0]).toBe('cursor-agent');
    expect(records[0]?.argv.slice(-2)).toEqual(['--model', DEFAULT_CURSOR_JUDGE_MODEL]);
    expect(records[0]?.stdinMode).toBe('pipe');
    expectNothingOversizedInArgv(records[0]?.argv ?? ['']);
    expect(state.written).toBe(LARGE_PROMPT);
    expect(state.ended).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(parseJudgeOutput(result.stdout)?.verdict).toBe('observe');
  });

  test('codex: bunx exec with no positional prompt; the prompt arrives on stdin', async () => {
    const records: SpawnRecord[] = [];
    const { child, state } = consumingChild(`chatter\n${VERDICT_JSON}\n`);
    const result = await spawnJudgeBinary(
      'codex',
      LARGE_PROMPT,
      5_000,
      recordingSpawn(child, records)
    );
    expect(records[0]?.argv).toEqual(CODEX_ARGV);
    expect(records[0]?.stdinMode).toBe('pipe');
    expect(state.written).toBe(LARGE_PROMPT);
    expect(parseJudgeOutput(result.stdout)?.verdict).toBe('observe');
  });

  test('grok: --prompt-file carries the full prompt and is removed after the run', async () => {
    const records: SpawnRecord[] = [];
    const result = await spawnJudgeBinary(
      'grok',
      LARGE_PROMPT,
      5_000,
      recordingSpawn(fileFedChild(VERDICT_JSON), records)
    );
    const argv = records[0]?.argv ?? [];
    expect(argv.slice(0, 2)).toEqual(['grok', '--prompt-file']);
    expect(records[0]?.stdinMode).toBe('ignore');
    expectNothingOversizedInArgv(argv);
    expect(records[0]?.promptFileContents).toBe(LARGE_PROMPT);
    const promptPath = argv[2] ?? '';
    await expect(stat(promptPath)).rejects.toThrow();
    await expect(stat(dirname(promptPath))).rejects.toThrow();
    expect(result).toEqual({ exitCode: 0, stdout: VERDICT_JSON, timedOut: false });
  });

  test("a cursor child that never reads stdin still times out on this seam's wall clock", async () => {
    // Linux pipe buffer; a write past this blocks until the child reads.
    const PIPE_BUFFER = 64 * 1024;
    let buffered = 0;
    let pendingWrite: { reject: (error: Error) => void } | undefined;
    const state = { killed: false, destroyed: false };
    const child: JudgeChild = {
      stdin: {
        write: async (chunk: string): Promise<number> => {
          buffered += chunk.length;
          if (buffered <= PIPE_BUFFER) return chunk.length;
          // Pipe full and nobody reading: park until the writer is destroyed.
          return new Promise<number>((_resolve, reject) => {
            pendingWrite = { reject };
          });
        },
        end: async (): Promise<void> => undefined,
        destroy: (): void => {
          state.destroyed = true;
          pendingWrite?.reject(new Error('EPIPE: write after destroy'));
          pendingWrite = undefined;
        },
      },
      stdout: null,
      stderr: null,
      exited: new Promise<number>(() => undefined), // never exits on its own
      kill: (): void => {
        state.killed = true;
      },
    };
    const started = Date.now();
    const result = await spawnJudgeBinary('cursor', LARGE_PROMPT, 250, () => child);
    expect(result).toEqual({ exitCode: 124, stdout: '', timedOut: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(state.killed).toBe(true);
    expect(state.destroyed).toBe(true);
    expect(buffered).toBeGreaterThan(PIPE_BUFFER);
  });
});

describe('#852 -- judge-second-opinion seam (spawnGrok) goes through the shared transport', () => {
  test('cursor rung: cursor-agent on argv, prompt on stdin, strict parser still sees a bare verdict', async () => {
    process.env.OVERSEER_JUDGE_LADDER = 'cursor';
    delete process.env.OVERSEER_CURSOR_JUDGE_MODEL;
    const records: SpawnRecord[] = [];
    const { child, state } = consumingChild('VERDICT: APPROVE\n');
    const result = await spawnGrok(LARGE_PROMPT, 5_000, recordingSpawn(child, records));
    expect(records[0]?.argv[0]).toBe('cursor-agent');
    expect(records[0]?.stdinMode).toBe('pipe');
    expectNothingOversizedInArgv(records[0]?.argv ?? ['']);
    expect(state.written).toBe(LARGE_PROMPT);
    expect(result.exitCode).toBe(0);
    expect(parseGrokVerdict(result.stdout)).toBe('approve');
  });

  test('codex rung: stdin delivery, stderr fallback and wrapper normalization intact', async () => {
    process.env.OVERSEER_JUDGE_LADDER = 'codex';
    const records: SpawnRecord[] = [];
    // 15th canary defect shape: empty stdout, whole framed answer on stderr.
    const framed = [
      'user',
      'Return exactly one verdict line: VERDICT: APPROVE or VERDICT: HOLD.',
      'warning: Codex could not find bubblewrap on PATH.',
      'codex',
      'VERDICT: APPROVE',
      'tokens used',
      '5,557',
    ].join('\n');
    const { child, state } = consumingChild('', 0, framed);
    const result = await spawnGrok(LARGE_PROMPT, 5_000, recordingSpawn(child, records));
    expect(records[0]?.argv).toEqual(CODEX_ARGV);
    expect(state.written).toBe(LARGE_PROMPT);
    expect(result.stdout).toBe('VERDICT: APPROVE');
    expect(parseGrokVerdict(result.stdout)).toBe('approve');
  });

  test('grok rung: --prompt-file carries the full prompt and is removed after the run', async () => {
    process.env.OVERSEER_JUDGE_LADDER = 'grok';
    const records: SpawnRecord[] = [];
    const result = await spawnGrok(
      LARGE_PROMPT,
      5_000,
      recordingSpawn(fileFedChild('VERDICT: HOLD\n'), records)
    );
    const argv = records[0]?.argv ?? [];
    expect(argv.slice(0, 2)).toEqual(['grok', '--prompt-file']);
    expect(records[0]?.stdinMode).toBe('ignore');
    expectNothingOversizedInArgv(argv);
    expect(records[0]?.promptFileContents).toBe(LARGE_PROMPT);
    await expect(stat(argv[2] ?? '')).rejects.toThrow();
    expect(parseGrokVerdict(result.stdout)).toBe('hold');
  });
});
