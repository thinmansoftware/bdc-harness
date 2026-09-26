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
 *  - `--output-format stream-json`  newline-delimited JSON events on stdout
 *               (one object per line). Schema verified live against
 *               cursor-agent 2026.09.23-86fc751: `system/init` (carries the
 *               served `model`), `thinking` deltas, `assistant` messages,
 *               `tool_call` started/completed progress, and one terminal
 *               `result` event (`result` text, `is_error`, `subtype`).
 *               Unparseable lines are skipped, never fatal.
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
    '--output-format',
    'stream-json',
    '--force',
    '--trust',
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

    const state: CursorStreamState = {
      servedModel: null,
      streamedText: '',
      resultFallbackText: '',
      resultError: null,
    };
    let finalText = '';
    try {
      if (child.stdout) {
        const decoder = new TextDecoder();
        const reader = child.stdout.getReader();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            yield* routeStreamLine(buffer.slice(0, newline), state);
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
          }
        }
        buffer += decoder.decode();
        if (buffer.length > 0) {
          yield* routeStreamLine(buffer, state);
        }
      }
      const [exitCode, stderr] = await Promise.all([child.exited, stderrText]);
      await delivery;
      if (exitCode !== 0) {
        const detail = stderr.trim().slice(-400) || 'no stderr';
        throw new Error(`cursor-agent exited ${exitCode} (model ${model}): ${detail}`);
      }
      // Result-text fallback: when no assistant message streamed, the terminal
      // result event's text IS the answer text.
      finalText = state.streamedText.length > 0 ? state.streamedText : state.resultFallbackText;
      if (state.resultError === null && finalText.trim().length === 0) {
        // rc 0 with no usable stream output is the Workspace Trust / auth
        // no-op (scripts/dispatch-worker/seat-preflight.ts
        // cursorBuildResultIsEmpty). Never report it as success.
        throw new Error(
          'cursor-agent exited 0 with empty output (workspace trust or authentication not granted)'
        );
      }
    } finally {
      options?.abortSignal?.removeEventListener('abort', onAbort);
    }

    if (state.streamedText.length === 0 && state.resultFallbackText.length > 0) {
      yield { type: 'assistant', content: state.resultFallbackText };
    }

    let structuredOutput: unknown;
    if (options?.outputFormat?.type === 'json_schema') {
      structuredOutput = parseJsonBestEffort(finalText);
    }

    const servedModelFields =
      state.servedModel !== null
        ? { servedModelId: state.servedModel }
        : {
            servedModelId: null,
            servedModelMissingReason:
              'cursor-agent stream-json stream carried no init-event model field',
          };

    if (state.resultError !== null) {
      // A result event reporting an error becomes an isError result chunk; the
      // dag-executor's msg.isError branch turns it into a thrown node failure.
      yield {
        type: 'result',
        isError: true,
        errorSubtype: state.resultError.subtype,
        errors: state.resultError.errors,
        ...servedModelFields,
      };
    } else {
      yield {
        type: 'result',
        stopReason: 'stop',
        structuredOutput,
        ...servedModelFields,
      };
    }
  }
}

/** Mutable parse state shared across stream-json lines. */
interface CursorStreamState {
  servedModel: string | null;
  streamedText: string;
  resultFallbackText: string;
  resultError: { subtype: string; errors: string[] } | null;
}

/** Routed action for one stream-json event. */
type CursorStreamEvent =
  | { kind: 'init'; model: string | null }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_start'; toolName: string; toolCallId?: string }
  | { kind: 'tool_end'; toolName: string; toolCallId?: string; output: string }
  | {
      kind: 'result';
      isError: boolean;
      errorSubtype: string;
      errors: string[];
      text: string;
    }
  | { kind: 'ignore' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractAssistantText(event: Record<string, unknown>): string {
  const message = isRecord(event.message) ? event.message : undefined;
  const content = message?.content ?? event.content;
  if (Array.isArray(content)) {
    return content
      .map(block =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''
      )
      .join('');
  }
  if (typeof content === 'string') return content;
  return typeof event.text === 'string' ? event.text : '';
}

/** Compact, bounded rendering of a tool result for a tool_result chunk. */
function describeToolResult(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 4000 ? `${text.slice(0, 4000)}... (truncated)` : text;
}

/**
 * Classify one decoded stream-json event (shapes verified live against
 * cursor-agent 2026.09.23-86fc751). Unknown event types route to 'ignore':
 * the stream is additive, so new event kinds must never break a run.
 */
function classifyStreamEvent(event: Record<string, unknown>): CursorStreamEvent {
  const type = typeof event.type === 'string' ? event.type : '';
  const subtype = typeof event.subtype === 'string' ? event.subtype : '';

  if ((type === 'system' && subtype === 'init') || type === 'init') {
    return { kind: 'init', model: typeof event.model === 'string' ? event.model : null };
  }

  if (type === 'thinking') {
    return typeof event.text === 'string' && event.text.length > 0
      ? { kind: 'thinking', text: event.text }
      : { kind: 'ignore' };
  }

  if (type === 'assistant') {
    const text = extractAssistantText(event);
    return text.length > 0 ? { kind: 'assistant', text } : { kind: 'ignore' };
  }

  if (type === 'tool_call') {
    const call = isRecord(event.tool_call) ? event.tool_call : {};
    const toolCallId =
      typeof call.toolCallId === 'string'
        ? call.toolCallId
        : typeof event.call_id === 'string'
          ? event.call_id
          : undefined;
    let toolName = 'cursor_tool';
    let payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(call)) {
      if (key.endsWith('ToolCall') && isRecord(value)) {
        toolName = key.slice(0, -'ToolCall'.length);
        payload = value;
        break;
      }
    }
    const result = payload.result;
    if (subtype === 'completed' || result !== undefined) {
      return {
        kind: 'tool_end',
        toolName,
        toolCallId,
        output: result !== undefined ? describeToolResult(result) : '',
      };
    }
    return { kind: 'tool_start', toolName, toolCallId };
  }

  if (type === 'result') {
    const text =
      typeof event.result === 'string'
        ? event.result
        : typeof event.text === 'string'
          ? event.text
          : '';
    const isError =
      event.is_error === true ||
      event.isError === true ||
      subtype.startsWith('error') ||
      event.error != null;
    const errors = Array.isArray(event.errors)
      ? event.errors.filter((e): e is string => typeof e === 'string')
      : typeof event.error === 'string' && event.error.length > 0
        ? [event.error]
        : text.length > 0
          ? [text]
          : ['cursor-agent reported a result error'];
    return {
      kind: 'result',
      isError,
      errorSubtype: subtype.length > 0 ? subtype : 'cursor_result_error',
      errors,
      text,
    };
  }

  return { kind: 'ignore' };
}

/**
 * Route one stdout line into MessageChunks, updating parse state. A line that
 * is not valid JSON is skipped (malformed-line tolerance); only the process
 * exit code and the empty-output guard can fail a run.
 */
function* routeStreamLine(line: string, state: CursorStreamState): Generator<MessageChunk> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;
  const event = classifyStreamEvent(parsed);
  switch (event.kind) {
    case 'init':
      if (event.model !== null && state.servedModel === null) {
        state.servedModel = event.model;
      }
      break;
    case 'assistant':
      state.streamedText += event.text;
      yield { type: 'assistant', content: event.text };
      break;
    case 'thinking':
      yield { type: 'thinking', content: event.text };
      break;
    case 'tool_start':
      yield {
        type: 'tool',
        toolName: event.toolName,
        ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
      };
      break;
    case 'tool_end':
      yield {
        type: 'tool_result',
        toolName: event.toolName,
        toolOutput: event.output,
        ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
      };
      break;
    case 'result':
      state.resultFallbackText = event.text;
      if (event.isError && state.resultError === null) {
        state.resultError = { subtype: event.errorSubtype, errors: event.errors };
      }
      break;
    case 'ignore':
      break;
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
