import type { GrokJudgeEvidence } from './types.ts';

const DEFAULT_TIMEOUT_MS = 60_000;

interface GrokSpawnResult {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
}

interface JudgeWithGrokOptions {
  timeoutMs?: number;
  spawn?: (prompt: string) => Promise<GrokSpawnResult>;
}

export function parseGrokVerdict(stdout: string): 'approve' | 'hold' {
  const match = stdout.match(/^VERDICT:\s*(APPROVE|HOLD)\s*$/m);
  return match?.[1] === 'APPROVE' ? 'approve' : 'hold';
}

export async function judgeWithGrok(
  evidence: GrokJudgeEvidence,
  options: JudgeWithGrokOptions = {}
): Promise<'approve' | 'hold'> {
  const prompt = buildGrokPrompt(evidence);
  const spawn =
    options.spawn ?? (input => spawnGrok(input, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));

  try {
    const result = await spawn(prompt);
    if (result.timedOut || result.exitCode !== 0) return 'hold';
    return parseGrokVerdict(result.stdout);
  } catch {
    return 'hold';
  }
}

function buildGrokPrompt(evidence: GrokJudgeEvidence): string {
  return [
    'You are the optional Grok second-opinion merge judge for the BDC Overseer.',
    'Return exactly one verdict line: VERDICT: APPROVE or VERDICT: HOLD.',
    'APPROVE means the PR evidence supports auto-merge. HOLD means an operator should review.',
    '',
    `WO: ${evidence.woId}`,
    `PR: #${evidence.prNumber} ${evidence.prTitle}`,
    `Checks: total=${evidence.checksSummary.total}, passed=${evidence.checksSummary.passed}, failed=${evidence.checksSummary.failed}, pending=${evidence.checksSummary.pending}, conclusion=${evidence.checksSummary.conclusion ?? 'unknown'}`,
    `Files changed: ${evidence.filesChangedCount}`,
    `Diff stat: ${evidence.diffStat}`,
  ].join('\n');
}

async function spawnGrok(prompt: string, timeoutMs: number): Promise<GrokSpawnResult> {
  const subprocess = Bun.spawn(['grok', '-p', prompt], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timeout: Timer | undefined;
  const timeoutResult = new Promise<GrokSpawnResult>(resolve => {
    timeout = setTimeout(() => {
      subprocess.kill();
      resolve({ exitCode: 124, stdout: '', timedOut: true });
    }, timeoutMs);
  });

  const processResult = (async (): Promise<GrokSpawnResult> => {
    const [exitCode, stdout] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
    ]);
    return { exitCode, stdout, timedOut: false };
  })();

  const result = await Promise.race([processResult, timeoutResult]);
  if (timeout) clearTimeout(timeout);
  return result;
}
