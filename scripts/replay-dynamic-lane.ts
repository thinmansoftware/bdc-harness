import { readFile } from 'node:fs/promises';
import {
  canonicalDynamicLaneJson,
  dynamicLaneSnapshotSchema,
  evaluateDynamicLane,
} from '../packages/workflows/src/reliability/dynamic-lane-admission';

export async function replayDynamicLane(argv: string[]): Promise<number> {
  if (argv.length !== 2 || argv[0] !== '--input' || !argv[1]) {
    process.stderr.write('dynamic-lane-replay: expected --input <fixture.json>\n');
    return 2;
  }
  try {
    const bytes = await readFile(argv[1], 'utf8');
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes);
    } catch {
      process.stderr.write('dynamic-lane-replay: invalid JSON\n');
      return 2;
    }
    const parsed = dynamicLaneSnapshotSchema.safeParse(decoded);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.join('.') || '<root>';
      process.stderr.write(
        `dynamic-lane-replay: invalid envelope at ${path}: ${issue?.message ?? 'invalid input'}\n`
      );
      return 2;
    }
    process.stdout.write(canonicalDynamicLaneJson(evaluateDynamicLane(parsed.data)));
    return 0;
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : 'read_failed';
    process.stderr.write(`dynamic-lane-replay: unable to read input (${code})\n`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await replayDynamicLane(process.argv.slice(2));
}
