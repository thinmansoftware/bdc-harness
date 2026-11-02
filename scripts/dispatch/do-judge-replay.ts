import { readFile, writeFile } from 'fs/promises';
import type { DispatchMessage } from '../../packages/core/src/db/dispatch';
import { judgeDutyOfficerItem } from '../../packages/server/src/dispatch/duty-officer-judge';
import {
  parseReplayFixture,
  runDoJudgeReplay,
  type ReplayAction,
} from '../../packages/server/src/dispatch/do-judge-replay';

export const DO_JUDGE_REPLAY_USAGE =
  'usage: bun scripts/dispatch/do-judge-replay.ts --fixture <path> --out <path>';

export function parseReplayArgs(
  argv: readonly string[]
): { ok: true; fixture: string; out: string } | { ok: false; usage: string } {
  let fixture: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fixture') {
      fixture = argv[i + 1];
      i += 1;
    } else if (arg === '--out') {
      out = argv[i + 1];
      i += 1;
    }
  }
  if (!fixture || !out) {
    return { ok: false, usage: DO_JUDGE_REPLAY_USAGE };
  }
  return { ok: true, fixture, out };
}

export function prepareReplayEnv(env: NodeJS.ProcessEnv): void {
  env.DUTY_OFFICER_JUDGE_PROVIDER = 'claude';
  env.DUTY_OFFICER_JUDGE_ENABLED = 'true';
  delete env.OPENROUTER_API_KEY;
  delete env.GLM_API_KEY;
  delete env.XAI_API_KEY;
}

async function classifyWithJudge(message: DispatchMessage): Promise<ReplayAction> {
  const verdict = await judgeDutyOfficerItem(message);
  return verdict.status === 'ok' ? verdict.action : 'failed';
}

export async function runReplayCli(options: {
  argv: readonly string[];
  readText?: (path: string) => Promise<string>;
  writeText?: (path: string, text: string) => Promise<void>;
  classify?: (message: DispatchMessage) => ReplayAction | Promise<ReplayAction>;
  env?: NodeJS.ProcessEnv;
  stderr?: (line: string) => void;
}): Promise<number> {
  const parsed = parseReplayArgs(options.argv);
  const stderr =
    options.stderr ??
    ((line: string): void => {
      console.error(line);
    });
  if (!parsed.ok) {
    stderr(parsed.usage);
    return 2;
  }

  const env = options.env ?? process.env;
  prepareReplayEnv(env);

  try {
    const readText =
      options.readText ?? ((path: string): Promise<string> => readFile(path, 'utf8'));
    const raw = await readText(parsed.fixture);
    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr(`do_judge_replay_fixture_invalid: ${message}`);
      return 1;
    }
    const records = parseReplayFixture(json);
    const report = await runDoJudgeReplay({
      records,
      classify: options.classify ?? classifyWithJudge,
    });
    const text = `${JSON.stringify(report, null, 2)}\n`;
    const writeText =
      options.writeText ?? ((path: string, body: string): Promise<void> => writeFile(path, body));
    await writeText(parsed.out, text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(message);
    return 1;
  }
}

if (import.meta.main) {
  const code = await runReplayCli({ argv: process.argv });
  process.exit(code);
}
