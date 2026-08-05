/**
 * Scripted fake Claude executor for the ACP adapter tests
 * (WO-HARNESS-CLAUDE-ACP-ADAPTER-01). It is NEVER used by the production path:
 * the adapter loads it only when the BDC_CLAUDE_ACP_EXECUTOR_MODULE env var
 * points at this file. Behavior is selected by prompt content so a single
 * adapter seat can satisfy both the direct adapter tests and the reused ACP
 * conformance matrix (acp/conformance.ts), which drives fixed prompts.
 *
 * Prompt -> behavior:
 *  - contains 'BDC_ACP_CONFORMANCE:' or 'FAKE:echo' -> echo the received byte
 *    count ('ACP_STUB_OK bytes=N') so a large payload can be proven byte-exact.
 *  - contains 'FAKE:throw' or equals 'forced failure' -> throw (honest failure).
 *  - contains 'FAKE:empty' -> produce no text (honest empty result).
 *  - contains 'FAKE:hang', or equals 'cancel mid-generation' / 'timeout
 *    honestly' -> never resolve, ignoring abort (runaway model -> the client's
 *    bounded tree-kill is the M-126 T4 cancellation scenario).
 *  - anything else -> a normal non-empty completion.
 */
import type { ClaudeExecutor, ClaudeExecutorInput } from './adapter';

export function createExecutor(): ClaudeExecutor {
  return async function* fakeExecutor(input: ClaudeExecutorInput): AsyncIterable<string> {
    const prompt = input.prompt;

    if (prompt.includes('BDC_ACP_CONFORMANCE:') || prompt.includes('FAKE:echo')) {
      yield `ACP_STUB_OK bytes=${Buffer.byteLength(prompt)}`;
      return;
    }
    if (prompt.includes('FAKE:throw') || prompt === 'forced failure') {
      throw new Error('fake_executor_boom: forced failure requested');
    }
    if (prompt.includes('FAKE:empty')) {
      return;
    }
    if (
      !prompt.includes('FAKE:hang') &&
      prompt !== 'cancel mid-generation' &&
      prompt !== 'timeout honestly'
    ) {
      yield 'FAKE_OK: ';
      yield 'claude-acp adapter round-trip';
      return;
    }

    // Runaway executor: never yields, never returns, ignores abort. Forces the
    // client's bounded process-tree kill.
    await new Promise<never>(() => {
      /* intentionally never resolves */
    });
  };
}

export default createExecutor;
