import type { GrokDispositionReceipt, GrokJudgeEvidence } from './types.ts';

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
  const match = /^VERDICT:\s*(APPROVE|HOLD)\s*$/.exec(stdout.trim());
  return match?.[1] === 'APPROVE' ? 'approve' : 'hold';
}

export async function judgeWithGrok(
  evidence: GrokJudgeEvidence,
  options: JudgeWithGrokOptions = {}
): Promise<GrokDispositionReceipt> {
  const prompt = buildGrokPrompt(evidence);
  const spawn =
    options.spawn ??
    ((input: string): Promise<GrokSpawnResult> =>
      spawnGrok(input, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));

  try {
    const result = await spawn(prompt);
    if (result.timedOut) return receipt(evidence, 'hold', 'judge_timeout');
    if (result.exitCode !== 0) return receipt(evidence, 'hold', 'judge_exit_nonzero');
    const verdict = parseGrokVerdict(result.stdout);
    if (verdict === 'approve') return receipt(evidence, 'approve', 'judge_approve');
    if (/^VERDICT:\s*HOLD\s*$/.test(result.stdout.trim())) {
      return receipt(evidence, 'hold', 'judge_hold');
    }
    return receipt(evidence, 'hold', 'judge_output_invalid');
  } catch {
    return receipt(evidence, 'hold', 'judge_error');
  }
}

function receipt(
  evidence: GrokJudgeEvidence,
  disposition: GrokDispositionReceipt['disposition'],
  reason: GrokDispositionReceipt['reason']
): GrokDispositionReceipt {
  return {
    schemaVersion: 'overseer-grok-merge-disposition-v1',
    disposition,
    reason,
    woId: evidence.woId,
    prNumber: evidence.prNumber,
    headSha: evidence.headSha,
    baseSha: evidence.baseSha,
    evidenceDigest: evidence.evidenceDigest,
    operator: evidence.operator,
  };
}

function buildGrokPrompt(evidence: GrokJudgeEvidence): string {
  return [
    'You are the Grok merge disposition operator for the BDC Overseer.',
    'Return exactly one verdict line: VERDICT: APPROVE or VERDICT: HOLD.',
    'APPROVE advances the candidate to deterministic gates; it never authorizes or performs a merge. HOLD means an operator should review.',
    '',
    `WO: ${evidence.woId}`,
    `PR: #${evidence.prNumber} ${evidence.prTitle}`,
    `Head SHA: ${evidence.headSha}`,
    `Base SHA: ${evidence.baseSha}`,
    `Evidence digest: ${evidence.evidenceDigest}`,
    `Operator: ${evidence.operator.identity} provider=${evidence.operator.provider} model_family=${evidence.operator.modelFamily}`,
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
