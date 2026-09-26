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
 *  - `--output-format stream-json` one JSON event per line while the agent
 *    works. Text mode prints only the final answer, which lets a long build
 *    trip the DAG idle timeout (bdc-harness #920).
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

    const stream = createCursorStreamState();
    try {
      if (child.stdout) {
        const decoder = new TextDecoder();
        const reader = child.stdout.getReader();
        let buffer = '';
        const take = (text: string): MessageChunk[] => {
          buffer += text;
          const chunks: MessageChunk[] = [];
          for (;;) {
            const nl = buffer.indexOf('\n');
            if (nl < 0) break;
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            chunks.push(...chunksForStreamLine(line, stream));
          }
          return chunks;
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          for (const chunk of take(text)) yield chunk;
        }
        for (const chunk of take(decoder.decode())) yield chunk;
        if (buffer.length > 0) {
          for (const chunk of chunksForStreamLine(buffer, stream)) yield chunk;
        }
      }
      const [exitCode, stderr] = await Promise.all([child.exited, stderrText]);
      await delivery;
      if (exitCode !== 0) {
        const detail = stderr.trim().slice(-400) || 'no stderr';
        throw new Error(`cursor-agent exited ${exitCode} (model ${model}): ${detail}`);
      }
      // A failed stream result already threw where it was parsed (see
      // chunksForStreamLine), so reaching here means the result was a success.
      if (stream.finalText.trim().length === 0 && stream.successResultText.trim().length > 0) {
        // The WO allows the concatenation of assistant texts to fall back to
        // `result.result` when no assistant text was seen.
        stream.finalText = stream.successResultText;
        yield { type: 'assistant', content: stream.successResultText };
      }
      if (stream.finalText.trim().length === 0) {
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
      structuredOutput = parseJsonBestEffort(stream.finalText);
    }

    yield {
      type: 'result',
      stopReason: 'stop',
      structuredOutput,
      servedModelId: stream.servedModel ?? null,
      ...(stream.servedModel
        ? {}
        : {
            servedModelMissingReason:
              'cursor-agent stream-json output had no system/init model field',
          }),
    };
  }
}

interface CursorStreamState {
  finalText: string;
  servedModel?: string;
  successResultText: string;
  /** How many non-JSON / shapeless stdout lines were seen (bounded reporting). */
  malformedCount: number;
  /** Bounded tail of the most recent malformed lines -- never grows past MAX. */
  malformedTail: string;
}

/** Hard cap for the malformed-line diagnostic tail; garbage cannot grow memory. */
const MAX_MALFORMED_TAIL_CHARS = 400;

function createCursorStreamState(): CursorStreamState {
  return {
    finalText: '',
    successResultText: '',
    malformedCount: 0,
    malformedTail: '',
  };
}

function recordMalformedLine(state: CursorStreamState, line: string): void {
  state.malformedCount += 1;
  const joined = state.malformedTail.length > 0 ? `${state.malformedTail}\n${line}` : line;
  state.malformedTail =
    joined.length > MAX_MALFORMED_TAIL_CHARS ? joined.slice(-MAX_MALFORMED_TAIL_CHARS) : joined;
}

/** Build the error thrown for a failed stream result: text tail + bounded diagnostics. */
function resultErrorMessage(state: CursorStreamState, resultText: string): string {
  const detail = resultText.slice(-400) || 'cursor-agent result error';
  const skipped =
    state.malformedCount > 0 ? ` [${state.malformedCount} non-json line(s) skipped]` : '';
  const tail =
    state.malformedTail.length > 0 ? ` -- non-json tail: ${state.malformedTail}` : '';
  return `${detail}${skipped}${tail}`;
}

/**
 * One stream-json line. Bad JSON is recorded in the BOUNDED diagnostic tail
 * and skipped, never fatal. thinking yields its `text` delta and tool_call
 * yields tool/tool_result chunks: all reset the DAG idle timer as live
 * progress, and none is appended to the node output (assistant texts only).
 * An error result (is_error or non-success subtype) throws HERE, when it is
 * parsed -- not later at stdout close.
 */
function chunksForStreamLine(line: string, state: CursorStreamState): MessageChunk[] {
  const raw = line.endsWith('\r') ? line.slice(0, -1) : line;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    recordMalformedLine(state, trimmed);
    return [];
  }
  const event = asRecord(parsed);
  if (!event || typeof event.type !== 'string') {
    recordMalformedLine(state, trimmed);
    return [];
  }
  if (event.type === 'assistant') {
    const text = assistantEventText(event);
    state.finalText += text;
    return [{ type: 'assistant', content: text }];
  }
  if (event.type === 'thinking') {
    const text = typeof event.text === 'string' ? event.text : '';
    return [{ type: 'thinking', content: text }];
  }
  if (event.type === 'tool_call') {
    if (event.subtype === 'started') {
      return [toolStartedChunk(event)];
    }
    if (event.subtype === 'completed') {
      return [toolCompletedChunk(event)];
    }
    return [];
  }
  if (event.type === 'system' && event.subtype === 'init') {
    if (typeof event.model === 'string' && event.model.length > 0) {
      state.servedModel = event.model;
    }
    return [];
  }
  if (event.type === 'result') {
    const resultText = typeof event.result === 'string' ? event.result : '';
    const failed = event.is_error === true || event.subtype !== 'success';
    if (failed) {
      // Fail when the error result is parsed: a stream-json result error is
      // terminal, so the node fails without waiting for process exit.
      throw new Error(resultErrorMessage(state, resultText));
    }
    state.successResultText = resultText;
    return [];
  }
  return [];
}

/**
 * Map a stream-json tool_call event to the tool chunk fields. The tool is
 * named by the first object-valued key of `tool_call` (e.g. shellToolCall);
 * absent shapes fall back to a generic name rather than losing the progress.
 */
function toolCallFields(event: Record<string, unknown>): {
  toolName: string;
  toolInput: Record<string, unknown> | undefined;
  toolOutput: string;
} {
  const call = asRecord(event.tool_call);
  const firstKey = call ? Object.keys(call)[0] : undefined;
  const payload = firstKey !== undefined && call ? call[firstKey] : undefined;
  const payloadRecord = asRecord(payload);
  const args = payloadRecord ? asRecord(payloadRecord.args) : undefined;
  let toolOutput = '';
  if (typeof payload === 'string') {
    toolOutput = payload;
  } else if (payloadRecord) {
    for (const key of ['output', 'result', 'content', 'text']) {
      const value = payloadRecord[key];
      if (typeof value === 'string') {
        toolOutput = value;
        break;
      }
    }
    if (toolOutput.length === 0) toolOutput = JSON.stringify(payloadRecord);
  } else if (payload !== undefined && payload !== null) {
    toolOutput = String(payload);
  }
  return {
    toolName: firstKey ?? 'cursor-tool',
    toolInput: args ?? undefined,
    toolOutput,
  };
}

function toolStartedChunk(event: Record<string, unknown>): MessageChunk {
  const { toolName, toolInput } = toolCallFields(event);
  const chunk: MessageChunk = { type: 'tool', toolName };
  if (toolInput !== undefined) chunk.toolInput = toolInput;
  return chunk;
}

function toolCompletedChunk(event: Record<string, unknown>): MessageChunk {
  const { toolName, toolOutput } = toolCallFields(event);
  return { type: 'tool_result', toolName, toolOutput };
}

function assistantEventText(event: Record<string, unknown>): string {
  const message = asRecord(event.message);
  if (!message || !Array.isArray(message.content)) return '';
  let text = '';
  for (const part of message.content) {
    const record = asRecord(part);
    if (record && typeof record.text === 'string') text += record.text;
  }
  return text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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
