import type { MessageChunk } from '../../packages/providers/src/types';

export interface CanaryCompletion {
  results: number;
  failureCode: 'none' | 'unexpected_system' | 'terminal_rejected' | 'provider_failed';
  systemCategory?: string;
  diagnosticHint?: string;
}

export function classifyCanarySystem(content: string): string {
  if (content.startsWith('[TASKS] Tasks:\n')) return 'task_list';
  if (content.startsWith('[X] File change')) return 'file_change_failed';
  if (content.startsWith('[OK] File changes:\n')) return 'file_change_unexpected';
  if (content.startsWith('[WARNING] Structured output')) return 'format_warning';
  if (content.startsWith('[WARNING] Could not resume')) return 'resume_warning';
  if (content.startsWith('[CODEX FAILBACK]')) return 'failback';
  return 'other';
}

export function classifyCanaryException(error: unknown, aborted: boolean): string {
  if (aborted) return 'aborted';
  // Error text stays in memory. These are diagnostic hints, never server assertions.
  const text = error instanceof Error ? error.message : '';
  if (/401|unauthorized|authentication|refresh.token/i.test(text)) return 'auth_hint';
  if (/429|rate.limit|quota|usage.limit/i.test(text)) return 'quota_hint';
  if (/model.*(?:access|support|available|not.found)|access.*model/i.test(text))
    return 'model_access_hint';
  if (/connection|network|websocket|stream.*disconnect|timed.out|fetch.failed|TLS|SSL/i.test(text))
    return 'transport_hint';
  if (/process.*exit|subprocess/i.test(text)) return 'process_hint';
  return 'other';
}

export function acceptCanaryChunk(state: CanaryCompletion, chunk: MessageChunk): void {
  if (chunk.type === 'system') {
    const category = classifyCanarySystem(chunk.content);
    if (category === 'task_list') {
      // Progress is untrusted data. Discard its entire body; it grants no authority.
      state.systemCategory = category;
      return;
    }
    if (
      ![
        '[OK] File changes:\n[+] canary.txt',
        '[OK] File changes:\n[+] /workspace/canary.txt',
      ].includes(chunk.content)
    ) {
      state.failureCode = 'unexpected_system';
      state.systemCategory = category;
      state.diagnosticHint = /permission denied|not permitted|read-only/i.test(chunk.content)
        ? 'permission_hint'
        : /sandbox/i.test(chunk.content)
          ? 'sandbox_hint'
          : 'other';
      throw new Error('unexpected system diagnostic');
    }
  }
  if (chunk.type === 'result') {
    if (
      state.results ||
      chunk.isError ||
      chunk.errors?.length ||
      chunk.errorSubtype ||
      chunk.servedModelId !== null ||
      chunk.servedModelMissingReason !== 'codex_sdk_does_not_expose_served_model'
    ) {
      state.failureCode = 'terminal_rejected';
      throw new Error('canary rejected');
    }
    state.results += 1;
  }
}
