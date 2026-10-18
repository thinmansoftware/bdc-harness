import type { MessageChunk } from '../../packages/providers/src/types';

export interface CanaryCompletion {
  results: number;
  failureCode: 'none' | 'unexpected_system' | 'terminal_rejected' | 'provider_failed';
}

export function acceptCanaryChunk(state: CanaryCompletion, chunk: MessageChunk): void {
  if (chunk.type === 'system') {
    if (
      ![
        '[OK] File changes:\n[+] canary.txt',
        '[OK] File changes:\n[+] /workspace/canary.txt',
      ].includes(chunk.content)
    ) {
      state.failureCode = 'unexpected_system';
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
