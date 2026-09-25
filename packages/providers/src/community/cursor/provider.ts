/**
 * CursorAgentProvider -- the operator's Cursor subscription as a build/review seat.
 *
 * Spawns the LOCAL `cursor-agent` CLI (the same binary the Overseer `cursor`
 * judge rung uses) inside the worktree instead of calling an HTTP API: the
 * point is to spend Cursor capacity, not an API key. cursor-agent reaches many
 * models on one account; the model is selected per call with `--model`.
 *
 * Flags (recorded against cursor-agent 2026.08.11-e8db854 in
 * scripts/dispatch-worker/adapters.ts, `cursor-build` entry):
 *  - `--print`  non-interactive; "Has access to all tools, including write and
 *               shell". No `--mode`: both `plan` and `ask` are READ-ONLY, which
 *               is right for the judge rung and wrong for a build seat.
 *  - `--force`  run commands without prompting.
 *  - `--trust`  suppress the Workspace Trust prompt; without it the CLI exits 0
 *               with EMPTY output, so empty output is treated as failure below.
 *  - `--workspace <cwd>` pin the workspace to the worktree.
 *
 * The prompt is delivered on stdin, never as an argv element (Linux
 * MAX_ARG_STRLEN 131,072 bytes per argument; bdc-harness #789).
 *
 * Auth: `cursor-agent login` state under ~/.cursor, or CURSOR_API_KEY in the
 * environment. Neither is read by this module; cursor-agent resolves it itself.
 */
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';
import { CURSOR_AGENT_CAPABILITIES } from './capabilities';
import { parseCursorAgentConfig } from './config';

export const DEFAULT_CURSOR_AGENT_MODEL = 'grok-4.7-high';
export const DEFAULT_CURSOR_AGENT_BINARY = 'cursor-agent';

/** The subset of a spawned child this provider uses; a test supplies a double. */
export interface CursorAgentChild {
  stdin: unknown;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(): void;
}

export interface CursorAgentSpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

export type CursorAgentSpawn = (
  argv: string[],
  options: CursorAgentSpawnOptions
) => CursorAgentChild;

const defaultCursorAgentSpawn: CursorAgentSpawn = (argv, options) =>
  Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  }) as unknown as CursorAgentChild;

/** Exported for tests: the exact argv, with the prompt deliberately absent. */
export function buildCursorAgentArgv(binary: string, model: string, cwd: string): string[] {
  return [
    binary,
    '--print',
    '--force',
    '--trust',
    '--workspace',
    cwd,
    '--model',
    model,
    '--output-format',
    'stream-json',
  ];
}

export class CursorAgentProvider implements IAgentProvider {
  private readonly model: string;
  private readonly binaryPath: string;
  private readonly spawn: CursorAgentSpawn;

  constructor(options?: { assistantConfig?: Record<string, unknown>; spawn?: CursorAgentSpawn }) {
    const config = parseCursorAgentConfig(options?.assistantConfig ?? {});
    this.model = config.model ?? DEFAULT_CURSOR_AGENT_MODEL;
    this.binaryPath = config.binaryPath ?? DEFAULT_CURSOR_AGENT_BINARY;
    this.spawn = options?.spawn ?? defaultCursorAgentSpawn;
  }

  getType(): string {
    return 'cursor';
  }

  getCapabilities(): ProviderCapabilities {
    return CURSOR_AGENT_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    _resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    if (!cwd) {
      throw new Error('provider:cursor requires a non-empty cwd (worktree path)');
    }
    const model = options?.model ?? this.model;
    const argv = buildCursorAgentArgv(this.binaryPath, model, cwd);
    const child = this.spawn(argv, { cwd, env: { ...process.env, ...(options?.env ?? {}) } });
    const onAbort = (): void => {
      child.kill();
    };
    options?.abortSignal?.addEventListener('abort', onAbort, { once: true });

    // Drain stderr from the start so a chatty child can never block on a full pipe.
    const stderrText = child.stderr ? new Response(child.stderr).text() : Promise.resolve('');
    // Deliver the prompt WITHOUT awaiting it before reading stdout: the child
    // reads stdin to EOF before answering, so writing and reading must overlap.
    const delivery = deliverPrompt(child.stdin, buildCursorPrompt(prompt, options));

    let finalText = '';
    let assistantTextSeen = false;
    let servedModelId: string | null = null;
    let resultText = '';
    let resultError: Error | undefined;
    try {
      if (child.stdout) {
        const decoder = new TextDecoder();
        const reader = child.stdout.getReader();
        let carry = '';
        const processLine = (line: string): MessageChunk | undefined => {
          if (!line.trim()) return undefined;
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            // Cursor occasionally writes diagnostics outside the JSON stream.
            // Keep consuming valid events after such a line.
            return undefined;
          }
          if (!event || typeof event !== 'object') return undefined;
          const record = event as Record<string, unknown>;
          switch (record.type) {
            case 'system': {
              const modelValue = record.model;
              if (typeof modelValue === 'string' && modelValue.length > 0) {
                servedModelId = modelValue;
              }
              return undefined;
            }
            case 'thinking':
              return {
                type: 'thinking',
                content: typeof record.text === 'string' ? record.text : '',
              };
            case 'tool_call':
              return { type: 'tool', toolName: 'cursor-agent' };
            case 'assistant': {
              const message = record.message;
              const content =
                message && typeof message === 'object'
                  ? (message as Record<string, unknown>).content
                  : undefined;
              const parts = Array.isArray(content)
                ? content.flatMap(item => {
                    if (!item || typeof item !== 'object') return [];
                    const text = (item as Record<string, unknown>).text;
                    return typeof text === 'string' ? [text] : [];
                  })
                : [];
              const text = parts.join('');
              assistantTextSeen = text.length > 0;
              finalText += text;
              return { type: 'assistant', content: text };
            }
            case 'result': {
              resultText = typeof record.result === 'string' ? record.result : '';
              const subtype = record.subtype;
              const isError = record.is_error === true || subtype !== 'success';
              if (isError) {
                resultError = new Error(
                  `cursor-agent result failed: ${resultText.slice(-400) || 'unknown error'}`
                );
              } else if (!assistantTextSeen) {
                finalText = resultText;
              }
              return undefined;
            }
            default:
              return undefined;
          }
        };
        const processCompleteLines = (): void => {
          const lines = carry.split(/\r?\n/);
          carry = lines.pop() ?? '';
          for (const line of lines) {
            const chunk = processLine(line);
            if (chunk) yieldChunk(chunk);
          }
        };
        let pendingChunks: MessageChunk[] = [];
        const yieldChunk = (chunk: MessageChunk): void => {
          pendingChunks.push(chunk);
        };
        const drainPending = function* (): Generator<MessageChunk> {
          while (pendingChunks.length > 0) yield pendingChunks.shift() as MessageChunk;
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          carry += decoder.decode(value, { stream: true });
          processCompleteLines();
          for (const chunk of drainPending()) yield chunk;
        }
        carry += decoder.decode();
        const lines = carry.split(/\r?\n/);
        carry = '';
        for (const line of lines) {
          const chunk = processLine(line);
          if (chunk) pendingChunks.push(chunk);
        }
        for (const chunk of drainPending()) yield chunk;
      }
      const [exitCode, stderr] = await Promise.all([child.exited, stderrText]);
      await delivery;
      if (exitCode !== 0) {
        const detail = stderr.trim().slice(-400) || 'no stderr';
        throw new Error(`cursor-agent exited ${exitCode} (model ${model}): ${detail}`);
      }
      if (resultError) throw resultError;
      if (finalText.trim().length === 0) {
        // rc 0 with no output is the Workspace Trust / auth no-op
        // (scripts/dispatch-worker/seat-preflight.ts cursorBuildResultIsEmpty).
        // Never report it as success.
        throw new Error(
          'cursor-agent exited 0 with empty output (workspace trust or authentication not granted)'
        );
      }
    } finally {
      options?.abortSignal?.removeEventListener('abort', onAbort);
    }

    let structuredOutput: unknown;
    if (options?.outputFormat?.type === 'json_schema') {
      structuredOutput = parseJsonBestEffort(finalText);
    }

    yield {
      type: 'result',
      stopReason: 'stop',
      structuredOutput,
      servedModelId,
      ...(servedModelId === null
        ? { servedModelMissingReason: 'cursor-agent stream-json init event carried no model' }
        : {}),
    };
  }
}

function buildCursorPrompt(prompt: string, options?: SendQueryOptions): string {
  const parts: string[] = [];
  if (options?.systemPrompt) parts.push(options.systemPrompt, '');
  parts.push(prompt);
  if (options?.outputFormat?.type === 'json_schema') {
    parts.push(
      '',
      'Respond with valid JSON only matching this schema:',
      JSON.stringify(options.outputFormat.schema)
    );
  }
  return parts.join('\n');
}

/**
 * Write the prompt and close the pipe so the child sees EOF. Rejections are
 * swallowed: a child that exits early (auth failure, bad flag) tears the pipe
 * down and the exit code, not the EPIPE, is the error that matters.
 */
async function deliverPrompt(stdin: unknown, prompt: string): Promise<void> {
  const writer = stdin as { write(chunk: string): unknown; end(): unknown } | null;
  if (!writer) return;
  try {
    await writer.write(prompt);
    await writer.end();
  } catch {
    // Child gone or pipe torn down -- see above.
  }
}

function parseJsonBestEffort(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```[A-Za-z0-9_-]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}
