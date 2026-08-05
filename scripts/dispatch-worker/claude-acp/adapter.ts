/**
 * BDC-owned Claude ACP adapter.
 *
 * Production invokes the official Claude Agent SDK in-process. Tests may set
 * BDC_CLAUDE_ACP_TEST_EXECUTOR to ok, throw, empty, hang, or matrix; this is
 * the only fake-executor seam and is never consulted when the variable is
 * absent.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  agent,
  methods,
  type AgentApp,
  type AgentConnection,
  type Stream,
} from '@agentclientprotocol/sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeExecutor {
  execute(
    prompt: string,
    signal: AbortSignal,
    onText: (text: string) => Promise<void>
  ): Promise<void>;
}

interface SessionState {
  abortController?: AbortController;
}

function promptText(parts: { type: string; text?: string }[]): string {
  return parts.map(part => (part.type === 'text' ? (part.text ?? '') : '')).join('');
}

export const sdkExecutor: ClaudeExecutor = {
  async execute(prompt, signal, onText): Promise<void> {
    const abortController = new AbortController();
    const abort = (): void => {
      abortController.abort();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const conversation = query({ prompt, options: { abortController } });
      for await (const message of conversation) {
        if (message.type === 'assistant') {
          if (message.error) throw new Error(`claude_sdk_assistant_error: ${message.error}`);
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text.length > 0) await onText(block.text);
          }
        } else if (message.type === 'result' && message.subtype !== 'success') {
          throw new Error(`claude_sdk_result_error: ${message.errors.join('; ')}`);
        }
      }
    } finally {
      signal.removeEventListener('abort', abort);
    }
  },
};

function fakeExecutor(mode: string): ClaudeExecutor {
  return {
    async execute(prompt, signal, onText): Promise<void> {
      const selected =
        mode === 'matrix'
          ? prompt === 'forced failure'
            ? 'throw'
            : prompt === 'cancel mid-generation' || prompt === 'timeout honestly'
              ? 'hang'
              : 'ok'
          : mode;
      if (selected === 'throw') throw new Error('scripted executor failure');
      if (selected === 'empty') return;
      if (selected === 'hang') {
        await new Promise<void>((_resolve, reject) => {
          const rejectCancelled = (): void => {
            reject(new Error('cancelled'));
          };
          if (signal.aborted) rejectCancelled();
          else signal.addEventListener('abort', rejectCancelled, { once: true });
        });
        return;
      }
      if (selected !== 'ok') throw new Error(`unknown fake executor mode: ${selected}`);
      const bytes = Buffer.byteLength(prompt);
      const sha256 = createHash('sha256').update(prompt).digest('hex');
      await onText(
        `ACP_STUB_OK bytes=${bytes} sha256=${sha256} argv=${JSON.stringify(process.argv.slice(2))}`
      );
    },
  };
}

export function executorFromEnvironment(env: NodeJS.ProcessEnv = process.env): ClaudeExecutor {
  const mode = env.BDC_CLAUDE_ACP_TEST_EXECUTOR;
  return mode ? fakeExecutor(mode) : sdkExecutor;
}

export function createClaudeAcpAgent(executor: ClaudeExecutor = sdkExecutor): AgentApp {
  const sessions = new Map<string, SessionState>();

  return agent({ name: 'bdc-claude-acp' })
    .onRequest('initialize', async () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
      authMethods: [],
    }))
    .onRequest('session/new', async () => {
      const sessionId = randomUUID();
      sessions.set(sessionId, {});
      return { sessionId };
    })
    .onRequest('session/prompt', async ctx => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) throw new Error(`unknown session: ${ctx.params.sessionId}`);
      session.abortController?.abort();
      const abortController = new AbortController();
      session.abortController = abortController;
      const sendText = async (text: string): Promise<void> => {
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        });
      };
      try {
        await executor.execute(
          promptText(ctx.params.prompt as { type: string; text?: string }[]),
          abortController.signal,
          sendText
        );
        return { stopReason: 'end_turn' as const };
      } catch (error) {
        if (abortController.signal.aborted) return { stopReason: 'cancelled' as const };
        throw error;
      } finally {
        if (session.abortController === abortController) delete session.abortController;
      }
    })
    .onNotification('session/cancel', async ctx => {
      sessions.get(ctx.params.sessionId)?.abortController?.abort();
    });
}

export function startClaudeAcpAdapter(
  stream: Stream,
  executor = executorFromEnvironment()
): AgentConnection {
  return createClaudeAcpAgent(executor).connect(stream);
}
