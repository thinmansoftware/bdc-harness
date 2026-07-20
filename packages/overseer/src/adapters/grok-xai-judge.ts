import type { GrokDispositionReceipt, GrokJudgeEvidence } from '../types.ts';

const DEFAULT_MODEL = 'grok-4';
const DEFAULT_TIMEOUT_MS = 60_000;
const XAI_CHAT_COMPLETIONS_URL = 'https://api.x.ai/v1/chat/completions';

export interface GrokXaiJudgeOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly url?: string;
}

interface XaiChatChoice {
  readonly message?: { readonly content?: unknown };
}

interface XaiChatResponse {
  readonly choices?: readonly XaiChatChoice[];
}

export function parseXaiGrokVerdict(content: string): 'approve' | 'hold' | 'invalid' {
  const match = /^VERDICT:\s*(APPROVE|HOLD)\s*$/.exec(content.trim());
  if (match?.[1] === 'APPROVE') return 'approve';
  if (match?.[1] === 'HOLD') return 'hold';
  return 'invalid';
}

export function createXaiGrokJudge(options: GrokXaiJudgeOptions): {
  judge: (evidence: GrokJudgeEvidence) => Promise<GrokDispositionReceipt>;
} {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = options.model ?? DEFAULT_MODEL;
  const url = options.url ?? XAI_CHAT_COMPLETIONS_URL;

  return {
    async judge(evidence): Promise<GrokDispositionReceipt> {
      if (!options.apiKey.trim()) return receipt(evidence, 'hold', 'judge_error');

      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'system',
                content:
                  'You are the BDC Overseer merge judge. Return exactly one line: VERDICT: APPROVE or VERDICT: HOLD.',
              },
              { role: 'user', content: buildPrompt(evidence) },
            ],
            temperature: 0,
          }),
        });
        if (!response.ok) return receipt(evidence, 'hold', 'judge_error');

        const parsed = (await response.json()) as XaiChatResponse;
        const content = parsed.choices?.[0]?.message?.content;
        if (typeof content !== 'string') return receipt(evidence, 'hold', 'judge_output_invalid');

        const verdict = parseXaiGrokVerdict(content);
        if (verdict === 'approve') return receipt(evidence, 'approve', 'judge_approve');
        if (verdict === 'hold') return receipt(evidence, 'hold', 'judge_hold');
        return receipt(evidence, 'hold', 'judge_output_invalid');
      } catch (error) {
        const reason =
          error instanceof DOMException && error.name === 'AbortError'
            ? 'judge_timeout'
            : 'judge_error';
        return receipt(evidence, 'hold', reason);
      } finally {
        clearTimeout(timeout);
      }
    },
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
    '',
    'Approve only if the evidence supports advancing to deterministic merge gates. Otherwise hold.',
  ].join('\n');
}
