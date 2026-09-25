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
 *  - `--output-format stream-json` newline-delimited JSON events on stdout.
 *               With the default text format the CLI prints ONLY the final
 *               answer at exit, so sendQuery would yield nothing while the
 *               agent works and a long build trips the lane's idle timeout
 *               (bdc-harness #920). stream-json emits thinking / tool_call /
 *               assistant / result events as they happen, which both keeps the
 *               DAG executor's idle timer alive and exposes the served model
 *               in the init event.
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

    // stream-json state (one JSON object per line on stdout).
    let finalText = ''; // assistant text only -- thinking/tool text never lands here
    let resultText = ''; // the terminal result.result, fallback when no assistant text
    let servedModelId: string | null = null; // from the system/init event's model field
    let pending = ''; // unterminated stdout tail across reader.read() calls
    let malformedTail = ''; // bounded diagnostic tail of non-JSON lines
    let sawInitModel = false;
    try {
      if (child.stdout) {
        const decoder = new TextDecoder();
        const reader = child.stdout.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          if (text.length === 0) continue;
          pending += text;
          let newlineIndex = pending.indexOf('\n');
          while (newlineIndex !== -1) {
            const rawLine = pending.slice(0, newlineIndex);
            pending = pending.slice(newlineIndex + 1);
            yield* processStreamLine(stripCarriageReturn(rawLine), {
              onAssistantText: value => {
                finalText += value;
              },
              onResultText: value => {
                resultText = value;
              },
              onModel: value => {
                servedModelId = value;
                sawInitModel = true;
              },
              onMalformedLine: value => {
                malformedTail = boundDiagnostic(malformedTail + '\n' + value);
              },
            });
            newlineIndex = pending.indexOf('\n');
          }
        }
        const tail = decoder.decode();
        if (tail.length > 0) pending += tail;
        if (pending.length > 0) {
          // The final event may arrive without a terminating newline; process it once.
          yield* processStreamLine(stripCarriageReturn(pending), {
            onAssistantText: value => {
              finalText += value;
            },
            onResultText: value => {
              resultText = value;
            },
            onModel: value => {
              servedModelId = value;
              sawInitModel = true;
            },
            onMalformedLine: value => {
              malformedTail = boundDiagnostic(malformedTail + '\n' + value);
            },
          });
          pending = '';
        }
      }
      const [exitCode, stderr] = await Promise.all([child.exited, stderrText]);
      await delivery;
      if (exitCode !== 0) {
        const detail = stderr.trim().slice(-400) || 'no stderr';
        throw new Error(`cursor-agent exited ${exitCode} (model ${model}): ${detail}`);
      }
      const nodeText = finalText.trim().length > 0 ? finalText : resultText;
      if (nodeText.trim().length === 0) {
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
      structuredOutput = parseJsonBestEffort(finalText.trim().length > 0 ? finalText : resultText);
    }

    yield {
      type: 'result',
      stopReason: 'stop',
      structuredOutput,
      servedModelId,
      ...(servedModelId === null
        ? {
            servedModelMissingReason: sawInitModel
              ? 'cursor-agent stream-json init event carried no usable model field'
              : 'cursor-agent stream-json emitted no init event with a model',
          }
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

/** A single stream-json stdout line, decoded from JSON but not yet validated. */
type StreamEvent = Record<string, unknown>;

interface StreamLineHandlers {
  onAssistantText(text: string): void;
  onResultText(text: string): void;
  onModel(model: string): void;
  onMalformedLine(line: string): void;
}

/**
 * cursor-agent emits CRLF-terminated lines on some platforms; strip a trailing
 * carriage return so `\r` never becomes part of the JSON payload.
 */
function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Keep the malformed-line diagnostic bounded so garbage output cannot grow memory. */
function boundDiagnostic(text: string): string {
  const max = 400;
  return text.length > max ? text.slice(-max) : text;
}

/**
 * Turn the shape `{"shellToolCall": {"args": {...}}}` into a tool name and its
 * keyed payload. The first object-valued key is the tool; when the shape is
 * absent, fall back to a generic name and the raw event.
 */
function extractToolCallPayload(rawEvent: StreamEvent): {
  toolName: string;
  payload: unknown;
  input: Record<string, unknown> | undefined;
} {
  const toolCall = rawEvent.tool_call;
  if (toolCall !== null && typeof toolCall === 'object' && !Array.isArray(toolCall)) {
    const keyed = toolCall as Record<string, unknown>;
    const firstKey = Object.keys(keyed)[0];
    if (firstKey !== undefined) {
      const payload = keyed[firstKey];
      const args =
        payload !== null && typeof payload === 'object' && !Array.isArray(payload)
          ? ((payload as Record<string, unknown>).args as Record<string, unknown> | undefined)
          : undefined;
      return {
        toolName: firstKey,
        payload,
        input: args !== null && typeof args === 'object' && !Array.isArray(args) ? args : undefined,
      };
    }
  }
  return { toolName: 'cursor-tool', payload: toolCall, input: undefined };
}

/** Read `output`/`result`-shaped fields from a completed tool call payload. */
function extractToolOutput(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'number' || typeof payload === 'boolean' || typeof payload === 'bigint') {
    return String(payload);
  }
  if (payload === null || payload === undefined) return '';
  if (typeof payload !== 'object' || Array.isArray(payload)) return '';
  const record = payload as Record<string, unknown>;
  for (const key of ['output', 'result', 'content', 'text']) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return '';
  }
}

/**
 * Process one decoded stdout line of cursor-agent stream-json output. Yields
 * progress chunks (thinking / tool / tool_result / assistant) as they arrive
 * so the DAG executor's idle timer never goes silent during a long build
 * (bdc-harness #920). Unrecognized events are ignored; a non-JSON line is
 * recorded to the bounded diagnostic tail and skipped -- it must never crash
 * the stream.
 */
function* processStreamLine(line: string, handlers: StreamLineHandlers): Generator<MessageChunk> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    handlers.onMalformedLine(trimmed);
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    handlers.onMalformedLine(trimmed);
    return;
  }
  const event = parsed as StreamEvent;
  const type = event.type;

  if (type === 'system' && event.subtype === 'init') {
    const model = event.model;
    if (typeof model === 'string' && model.trim().length > 0) handlers.onModel(model);
    return;
  }

  if (type === 'assistant') {
    const message = event.message;
    const content =
      message !== null && typeof message === 'object' && !Array.isArray(message)
        ? (message as Record<string, unknown>).content
        : undefined;
    const text = joinAssistantText(content);
    if (text.length === 0) return;
    handlers.onAssistantText(text);
    yield { type: 'assistant', content: text };
    return;
  }

  if (type === 'thinking') {
    // Progress-only: thinking text must never reach the final node output.
    const text = typeof event.text === 'string' ? event.text : '';
    yield { type: 'thinking', content: text };
    return;
  }

  if (type === 'tool_call') {
    const { toolName, payload, input } = extractToolCallPayload(event);
    if (event.subtype === 'started') {
      yield {
        type: 'tool',
        toolName,
        ...(input !== undefined ? { toolInput: input } : {}),
      };
      return;
    }
    if (event.subtype === 'completed') {
      yield { type: 'tool_result', toolName, toolOutput: extractToolOutput(payload) };
      return;
    }
    return;
  }

  if (type === 'result') {
    const text = typeof event.result === 'string' ? event.result : '';
    const isError = event.is_error === true;
    const subtype = event.subtype;
    if (isError || (typeof subtype === 'string' && subtype !== 'success')) {
      throw new Error(
        `cursor-agent stream result reported failure${
          typeof subtype === 'string' ? ` (${subtype})` : ''
        }: ${text.slice(-400) || 'no result text'}`
      );
    }
    handlers.onResultText(text);
    return;
  }

  // Everything else (user events, unknown types) is valid JSON but carries no
  // progress or final text -- ignore it.
}

/**
 * Join the text parts of an assistant event's message.content in source order.
 * Entries without a string text field are skipped, never stringified.
 */
function joinAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let joined = '';
  for (const entry of content) {
    if (entry === null || typeof entry !== 'object') continue;
    const text = (entry as Record<string, unknown>).text;
    if (typeof text === 'string') joined += text;
  }
  return joined;
}
