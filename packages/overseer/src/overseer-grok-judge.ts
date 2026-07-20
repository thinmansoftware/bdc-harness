import type { GrokDispositionReceipt, GrokJudgeEvidence } from './types';

export interface XaiGrokJudgeOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

interface XaiChatResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | null;
    };
  }[];
}

const DEFAULT_MODEL = 'grok-4';
const DEFAULT_ENDPOINT = 'https://api.x.ai/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 60_000;

export function parseXaiGrokVerdict(content: string): 'approve' | 'hold' | 'invalid' {
  const trimmed = content.trim();
  if (/^VERDICT:\s*APPROVE\s*$/i.test(trimmed)) return 'approve';
  if (/^VERDICT:\s*HOLD\s*$/i.test(trimmed)) return 'hold';
  return 'invalid';
}

export function createXaiGrokMergeJudge(options: XaiGrokJudgeOptions = {}) {
  return async function judgeWithXaiGrok(
    evidence: GrokJudgeEvidence
  ): Promise<GrokDispositionReceipt> {
    const apiKey = options.apiKey ?? process.env.XAI_API_KEY;
    if (!apiKey) return receipt(evidence, 'hold', 'judge_error');

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await (options.fetch ?? fetch)(options.endpoint ?? DEFAULT_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model ?? DEFAULT_MODEL,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                'Return exactly one line: VERDICT: APPROVE or VERDICT: HOLD. ' +
                'Approve only when the supplied merge evidence is internally consistent.',
            },
            { role: 'user', content: buildPrompt(evidence) },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) return receipt(evidence, 'hold', 'judge_error');
      const payload = (await response.json()) as XaiChatResponse;
      const content = payload.choices?.[0]?.message?.content ?? '';
      const verdict = parseXaiGrokVerdict(content);
      if (verdict === 'approve') return receipt(evidence, 'approve', 'judge_approve');
      if (verdict === 'hold') return receipt(evidence, 'hold', 'judge_hold');
      return receipt(evidence, 'hold', 'judge_output_invalid');
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return receipt(evidence, 'hold', 'judge_timeout');
      }
      return receipt(evidence, 'hold', 'judge_error');
    } finally {
      clearTimeout(timeout);
    }
  };
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

function buildPrompt(evidence: GrokJudgeEvidence): string {
  return [
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
