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
    '--output-format',
    'stream-json',
    '--workspace',
    cwd,
    '--model',
    model,
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

    const assistantParts: string[] = [];
    let servedModelId: string | undefined;
    let resultEvent: CursorStreamEvent | undefined;
    let resultError: Error | undefined;
    let malformedOutput = '';
    let finalText = '';
    try {
      if (child.stdout) {
        const decoder = new TextDecoder();
        const reader = child.stdout.getReader();
        let lineBuffer = '';
        const processLine = (line: string): MessageChunk | undefined => {
          if (line.trim().length === 0) return undefined;
          let event: CursorStreamEvent;
          try {
            const parsed: unknown = JSON.parse(line);
            if (!parsed || typeof parsed !== 'object') throw new Error('not an event object');
            event = parsed as CursorStreamEvent;
          } catch {
            malformedOutput = `${malformedOutput}\n${line}`.slice(-400);
            return undefined;
          }

          if (event.type === 'system' && event.subtype === 'init') {
            if (typeof event.model === 'string' && event.model.trim().length > 0) {
              servedModelId = event.model;
            }
          } else if (event.type === 'assistant') {
            const text = extractAssistantText(event);
            if (text.length > 0) {
              assistantParts.push(text);
              return { type: 'assistant', content: text };
            }
          } else if (event.type === 'thinking') {
            return { type: 'thinking', content: typeof event.text === 'string' ? event.text : '' };
          } else if (event.type === 'tool_call') {
            return {
              type: 'tool',
              toolName: event.subtype ? `cursor:${event.subtype}` : 'cursor:tool_call',
              ...(typeof event.call_id === 'string' ? { toolCallId: event.call_id } : {}),
            };
          } else if (event.type === 'result') {
            resultEvent = event;
            if (event.is_error === true || event.subtype !== 'success') {
              const detail = typeof event.result === 'string' ? event.result.slice(-400) : '';
              resultError = new Error(
                `cursor-agent result failed${detail.length > 0 ? `: ${detail}` : ''}`
              );
            }
          }
          return undefined;
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split(/\r?\n/);
          lineBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const chunk = processLine(line);
            if (chunk) yield chunk;
          }
        }
        lineBuffer += decoder.decode();
        if (lineBuffer.length > 0) {
          const chunk = processLine(lineBuffer);
          if (chunk) yield chunk;
        }
      }
      const [exitCode, stderr] = await Promise.all([child.exited, stderrText]);
      await delivery;
      if (exitCode !== 0) {
        const detail = stderr.trim().slice(-400) || malformedOutput.trim() || 'no stderr';
        throw new Error(`cursor-agent exited ${exitCode} (model ${model}): ${detail}`);
      }
      if (resultError) throw resultError;

      const assistantText = assistantParts.join('');
      const resultText = typeof resultEvent?.result === 'string' ? resultEvent.result : '';
      finalText = assistantText.length > 0 ? assistantText : resultText;
      if (finalText.trim().length === 0) {
        // rc 0 with no output is the Workspace Trust / auth no-op
        // (scripts/dispatch-worker/seat-preflight.ts cursorBuildResultIsEmpty).
        // Never report it as success.
        throw new Error(
          'cursor-agent exited 0 with empty output (workspace trust or authentication not granted)'
        );
      }
      if (assistantText.length === 0) {
        yield { type: 'assistant', content: resultText };
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
      servedModelId: servedModelId ?? null,
      ...(servedModelId === undefined
        ? { servedModelMissingReason: 'cursor_stream_init_model_missing' }
        : {}),
    };
  }
}

interface CursorStreamEvent {
  type?: string;
  subtype?: string;
  model?: unknown;
  text?: unknown;
  call_id?: unknown;
  is_error?: unknown;
  result?: unknown;
  message?: { content?: unknown };
}

function extractAssistantText(event: CursorStreamEvent): string {
  if (!Array.isArray(event.message?.content)) return '';
  return event.message.content
    .flatMap(part => {
      if (!part || typeof part !== 'object') return [];
      const value = part as { type?: unknown; text?: unknown };
      return value.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
    })
    .join('');
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
