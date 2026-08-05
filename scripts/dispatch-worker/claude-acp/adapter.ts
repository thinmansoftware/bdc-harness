/**
 * BDC-owned Claude ACP adapter -- the AGENT side of ACP over stdio.
 *
 * WO-HARNESS-CLAUDE-ACP-ADAPTER-01 / M-126 disposition T1 (RATIFIED 3-0,
 * 2026-08-04): both seats REJECTED Zed's third-party
 * `@zed-industries/claude-code-acp` wrapper for carrying board-credential
 * traffic (unaudited third-party code in the highest-trust lane, contrary to
 * Rule 6's supply-chain posture). This module is the small, BDC-owned
 * replacement they converged on: it speaks the agent side of the ACP protocol
 * that `acp/session.ts` (the Dispatch CLIENT) drives, and executes prompts
 * through the official `@anthropic-ai/claude-agent-sdk`. Both SDKs are already
 * adopted, audited dependencies of this repo.
 *
 * Handshake this adapter answers (the other end of acp/session.ts):
 *   initialize (protocolVersion 1, NO auth methods) -> session/new ->
 *   session/prompt (executes via the SDK, streams agent_message_chunk
 *   session/update notifications) -> honest stopReason.
 *
 * Evidence contract (M-126 T4), enforced here:
 *  - Honest completion: a non-empty result answers `stopReason: 'end_turn'`;
 *    an SDK error, an internal failure, or an EMPTY result answers with a
 *    JSON-RPC error carrying a reason -- NEVER a silent stream close.
 *  - Bounded cancellation: `session/cancel` aborts the in-flight execution;
 *    the CLIENT tree-kills after its grace regardless, so correctness never
 *    depends on graceful shutdown.
 *  - Payload integrity: the prompt flows ONLY over the ACP stream and is
 *    handed to the SDK in-process -- never through a child process argv.
 *
 * Execution seam: the function that invokes the Claude SDK is injectable so
 * tests can substitute a scripted fake executor without a live model. Set the
 * env var named by EXECUTOR_MODULE_ENV to an absolute module path exporting
 * `createExecutor()` (or a default export) to swap it in; when the var is
 * unset the adapter uses the real SDK executor. The swap has NO effect on the
 * production path unless the env var is explicitly set.
 */
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream, type AgentApp } from '@agentclientprotocol/sdk';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

/** Env var that, when set to a module path, swaps in a scripted fake executor. */
export const EXECUTOR_MODULE_ENV = 'BDC_CLAUDE_ACP_EXECUTOR_MODULE';

/** ACP protocol version this adapter speaks (matches acp/session.ts). */
export const PROTOCOL_VERSION = 1;

/** Adapter identity reported to the client during the connection. */
export const ADAPTER_NAME = 'bdc-claude-acp';

/** Single-shot session id; the dispatch envelope is one prompt per session. */
export const FIXED_SESSION_ID = 'bdc-claude-acp-1';

export interface ClaudeExecutorInput {
  /** Full prompt text, delivered over the ACP stream (never via argv). */
  prompt: string;
  /** Working directory for the SDK session. */
  cwd: string;
  /** Aborts when the client cancels or the connection closes. */
  signal: AbortSignal;
}

/**
 * The injectable Claude execution seam. Yields assistant text chunks in order.
 * Throwing signals an honest failure; yielding nothing signals an empty result
 * (both are reported to the client as failures, never as completions).
 */
export type ClaudeExecutor = (input: ClaudeExecutorInput) => AsyncIterable<string>;

/**
 * Default executor: runs the prompt through the official Claude Agent SDK
 * in-process and streams assistant text. Mirrors the read-oriented `plan`
 * permission mode the `claude` CLI seat uses; it rides the existing Claude
 * Code login. If the SDK demands a raw API key at runtime that surfaces as an
 * honest failure (a thrown error), not something this adapter works around.
 */
export async function* realClaudeExecutor(input: ClaudeExecutorInput): AsyncIterable<string> {
  const options: Options = { cwd: input.cwd, permissionMode: 'plan' };
  const stream = query({ prompt: input.prompt, options });
  const onAbort = (): void => {
    void stream.interrupt().catch(() => {
      /* the connection may already be gone; the client tree-kill is the backstop */
    });
  };
  if (input.signal.aborted) {
    onAbort();
    return;
  }
  input.signal.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const message of stream) {
      if (input.signal.aborted) break;
      const event = message as { type?: string; message?: { content?: unknown } };
      if (event.type !== 'assistant') continue;
      const content = event.message?.content;
      if (!Array.isArray(content)) continue;
      for (const raw of content) {
        const block = raw as { type?: string; text?: string };
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          yield block.text;
        }
      }
    }
  } finally {
    input.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Resolves the executor for this process: the env-named fake in test mode, or
 * the real SDK executor otherwise. Fails closed if the env var names a module
 * that does not export a usable factory.
 */
export async function resolveExecutor(): Promise<ClaudeExecutor> {
  const modulePath = process.env[EXECUTOR_MODULE_ENV];
  if (modulePath !== undefined && modulePath.length > 0) {
    const mod = (await import(modulePath)) as {
      createExecutor?: () => ClaudeExecutor;
      default?: () => ClaudeExecutor;
    };
    const factory = mod.createExecutor ?? mod.default;
    if (typeof factory !== 'function') {
      throw new Error(
        `claude_acp_executor_module_invalid: ${modulePath} must export createExecutor() or default()`
      );
    }
    return factory();
  }
  return realClaudeExecutor;
}

function extractPromptText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  let text = '';
  for (const raw of blocks) {
    const block = raw as { type?: string; text?: string };
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    }
  }
  return text;
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'claude_acp_failed';
  }
}

/**
 * Builds the ACP agent app with the given execution seam. Registered handlers:
 * initialize, session/new, session/prompt, and the session/cancel notification.
 */
export function buildAgentApp(executor: ClaudeExecutor): AgentApp {
  const cancelControllers = new Map<string, AbortController>();

  return agent({ name: ADAPTER_NAME })
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {},
      authMethods: [],
    }))
    .onRequest('session/new', () => ({ sessionId: FIXED_SESSION_ID }))
    .onRequest('session/prompt', async ctx => {
      const sessionId = ctx.params.sessionId;
      const promptText = extractPromptText(ctx.params.prompt);
      const controller = new AbortController();
      cancelControllers.set(sessionId, controller);
      const signal = AbortSignal.any([controller.signal, ctx.signal]);
      let produced = '';
      try {
        for await (const chunk of executor({ prompt: promptText, cwd: process.cwd(), signal })) {
          if (typeof chunk !== 'string' || chunk.length === 0) continue;
          produced += chunk;
          await ctx.client.notify('session/update', {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: chunk },
            },
          });
        }
      } catch (error) {
        // Bounded cancellation wins over a raised error: a cancelled run is
        // reported honestly as 'cancelled', not as an opaque failure.
        if (signal.aborted) return { stopReason: 'cancelled' };
        throw error instanceof Error ? error : new Error(reasonOf(error));
      } finally {
        cancelControllers.delete(sessionId);
      }
      if (signal.aborted) return { stopReason: 'cancelled' };
      if (produced.trim().length === 0) {
        // Honest completion: an empty result is never a done. Answer with a
        // JSON-RPC error carrying a reason instead of a silent end_turn.
        throw new Error('claude_acp_empty_result: executor produced no output');
      }
      return { stopReason: 'end_turn' };
    })
    .onNotification('session/cancel', ctx => {
      cancelControllers.get(ctx.params.sessionId)?.abort();
    });
}

/**
 * Starts the adapter on this process's stdio and serves one ACP client until
 * the connection closes. Pass an executor to override the seam; otherwise it
 * is resolved from the environment (real SDK unless the test env var is set).
 */
export async function runClaudeAcpAdapter(executor?: ClaudeExecutor): Promise<void> {
  const resolved = executor ?? (await resolveExecutor());
  const app = buildAgentApp(resolved);
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  );
  const connection = app.connect(stream);
  await connection.closed;
}
