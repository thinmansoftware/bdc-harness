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
 *  - `--output-format stream-json`  one JSON object per line; the default
 *               `text` format only prints the final answer at exit, which
 *               starves the DAG executor's per-chunk idle timer (anchor: zero-
 *               codex run a4923f64 "loop 'implement' iteration 1 exceeded idle
 *               timeout (600000ms)"). We yield `assistant`/`thinking`/`tool`
 *               chunks incrementally so each event resets the idle timer; only
 *               the final `result` event carries exit metadata.
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

/**
 * Cursor-agent stream-json event shape -- the subset this provider consumes.
 * Captured against cursor-agent 2026.08.11-e8db854 in archon-app-1 on
 * 2026-09-24 (WO-MATRIX-M2-MINIMAX-01 inlined design excerpt). Other event
 * types (user, file edits, etc.) are forwarded into the diagnostic buffer
 * rather than treated as fatal -- one missing field type must not block a
 * working stream.
 */
interface CursorStreamEvent {
  type?: string;
  subtype?: string;
  model?: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  result?: string;
  text?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  tool_call?: {
    shellToolCall?: { args?: Record<string, unknown> };
    readToolCall?: { args?: Record<string, unknown> };
    writeToolCall?: { args?: Record<string, unknown> };
    editToolCall?: { args?: Record<string, unknown> };
  };
}

const GARBAGE_LINE_BUFFER_LIMIT = 4 * 1024;

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

    // Stream-json event accumulation. assistantText is concatenated in encounter
    // order and used as the final node output (falling back to result.result if
    // no assistant text was ever seen). thinkingText / toolCallText are NEVER
    // appended to the final node output -- they are diagnostic noise that
    // happens to keep the idle timer alive.
    let finalText = '';
    let resultFallbackText = '';
    let servedModelId: string | null | undefined;
    let garbageLineBuffer = '';

    try {
      if (child.stdout) {
        const decoder = new TextDecoder();
        const reader = child.stdout.getReader();
        let pending = '';
        // dispatchLine runs side effects on finalText / resultFallbackText /
        // servedModelId / garbageLineBuffer synchronously and returns the
        // activity chunks that the caller must yield. Yielding them inline
        // (between `await reader.read()` calls) is what keeps the DAG
        // executor's per-chunk idle timer alive during a long run; the
        // cursor-agent stream-json contract is "one JSON object per line",
        // so yielding per-line preserves ordering without needing to wait
        // for the stream to close (anchor: a4923f64 idle-timeout run).
        const dispatchLine = (raw: string): MessageChunk[] => {
          const line = raw.replace(/\r$/, '');
          if (line.length === 0) return [];
          let event: CursorStreamEvent | undefined;
          try {
            event = JSON.parse(line) as CursorStreamEvent;
          } catch {
            garbageLineBuffer = appendGarbage(garbageLineBuffer, line);
            return [];
          }
          const yieldChunks: MessageChunk[] = [];
          for (const chunk of processStreamEvent(event)) {
            switch (chunk.kind) {
              case 'final_text':
                finalText += chunk.text;
                break;
              case 'fallback':
                resultFallbackText = chunk.text;
                break;
              case 'served_model':
                servedModelId = chunk.text;
                break;
              case 'throw':
                throw new Error(chunk.text);
              case 'garbage':
                garbageLineBuffer = appendGarbage(garbageLineBuffer, line);
                break;
              case 'yield':
                yieldChunks.push(chunk.chunk);
                break;
            }
          }
          return yieldChunks;
        };
        for (;;) {
          const { done, value } = await reader.read();
          const chunkText = value
            ? decoder.decode(value, { stream: true })
            : done
              ? decoder.decode()
              : '';
          if (chunkText.length === 0 && !done) continue;

          // Split into complete lines (ending in \n) plus a possibly-incomplete
          // tail that we keep for the next read(). A trailing line without a
          // newline is processed once we observe `done`.
          pending += chunkText;
          let newlineIndex = pending.indexOf('\n');
          while (newlineIndex !== -1) {
            const rawLine = pending.slice(0, newlineIndex);
            pending = pending.slice(newlineIndex + 1);
            for (const activityChunk of dispatchLine(rawLine)) {
              yield activityChunk;
            }
            newlineIndex = pending.indexOf('\n');
          }

          if (done) {
            // Flush the final line: it has no trailing newline, but it's still
            // a complete JSON object per the cursor-agent stream-json contract.
            const tail = pending;
            pending = '';
            if (tail.length > 0) {
              for (const activityChunk of dispatchLine(tail)) {
                yield activityChunk;
              }
            }
            break;
          }
        }
      }
      const [exitCode, stderr] = await Promise.all([child.exited, stderrText]);
      await delivery;
      if (exitCode !== 0) {
        const detail = stderr.trim().slice(-400) || 'no stderr';
        throw new Error(`cursor-agent exited ${exitCode} (model ${model}): ${detail}`);
      }
      if (finalText.trim().length === 0 && resultFallbackText.trim().length === 0) {
        // rc 0 with no output is the Workspace Trust / auth no-op
        // (scripts/dispatch-worker/seat-preflight.ts cursorBuildResultIsEmpty).
        // Never report it as success.
        throw new Error(
          'cursor-agent exited 0 with empty output (workspace trust or authentication not granted)'
        );
      }
      if (finalText.trim().length === 0) {
        // No assistant events arrived -- fall back to result.result as the node
        // text. This keeps an OK exit that only ever emitted a final `result`
        // (e.g. very short runs with one assistant message coalesced into
        // result.result) visible to downstream nodes. Emit an assistant chunk
        // so downstream consumers that reconstruct node text from assistant
        // chunks still see it -- the final result chunk carries the same text
        // via structuredOutput / the platform adapter's node_text path.
        finalText = resultFallbackText;
        if (finalText.trim().length > 0) {
          yield { type: 'assistant', content: finalText };
        }
      }
    } finally {
      options?.abortSignal?.removeEventListener('abort', onAbort);
    }

    let structuredOutput: unknown;
    if (options?.outputFormat?.type === 'json_schema') {
      structuredOutput = parseJsonBestEffort(finalText);
    }

    // servedModelId is set from the init event's `model` field. When absent,
    // record a stable absence reason per the served-model contract
    // (WO-HARNESS-LAYER1-SERVED-MODEL-CAPTURE-01) so downstream consumers can
    // distinguish "provider could not tell us" from "we never tried".
    const resolvedServedModelId =
      typeof servedModelId === 'string' && servedModelId.length > 0 ? servedModelId : null;
    const resultChunk: MessageChunk = {
      type: 'result',
      stopReason: 'stop',
      structuredOutput,
      servedModelId: resolvedServedModelId,
      servedModelMissingReason:
        resolvedServedModelId === null
          ? 'cursor-agent stream-json did not include a system/init event with a model field'
          : undefined,
    };
    yield resultChunk;
  }
}

type StreamProcessing =
  | { kind: 'yield'; chunk: MessageChunk }
  | { kind: 'final_text'; text: string }
  | { kind: 'fallback'; text: string }
  | { kind: 'served_model'; text: string }
  | { kind: 'garbage' }
  | { kind: 'throw'; text: string };

function processStreamEvent(event: CursorStreamEvent): StreamProcessing[] {
  switch (event.type) {
    case 'system': {
      // The init system event carries the served model id -- captured but not
      // yielded, so the platform stream sees only AI activity.
      if (event.subtype === 'init' && typeof event.model === 'string') {
        return [{ kind: 'served_model', text: event.model }];
      }
      return [];
    }
    case 'assistant': {
      const text = joinAssistantText(event.message?.content);
      if (text.length === 0) return [];
      return [
        { kind: 'final_text', text },
        { kind: 'yield', chunk: { type: 'assistant', content: text } },
      ];
    }
    case 'thinking': {
      const text = typeof event.text === 'string' ? event.text : '';
      // A `thinking` chunk is one of the chunk types the DAG executor already
      // counts as activity (its idle-timer reset accepts every yielded value
      // by default). Emit it so the idle timer stays alive, but do NOT append
      // the text to the final node output -- thinking prose is diagnostic, not
      // a deliverable.
      return text.length > 0
        ? [{ kind: 'yield', chunk: { type: 'thinking', content: text } }]
        : [{ kind: 'yield', chunk: { type: 'thinking', content: '' } }];
    }
    case 'tool_call': {
      // Yield a `tool` chunk for both started and completed subtypes so each
      // tool invocation resets the idle timer twice. The DAG executor uses
      // these to emit tool_started/tool_completed events; the tool name is
      // derived from whichever nested subtool is present in the payload.
      const toolName = deriveToolCallName(event.tool_call);
      return [
        { kind: 'yield', chunk: { type: 'tool', toolName, toolInput: event.tool_call } },
      ];
    }
    case 'result': {
      const resultText = typeof event.result === 'string' ? event.result : '';
      const isError = event.is_error === true || event.subtype !== 'success';
      if (isError) {
        const detail = resultText.slice(-400) || `cursor-agent reported ${event.subtype ?? 'error'}`;
        return [{ kind: 'throw', text: detail }];
      }
      return [{ kind: 'fallback', text: resultText }];
    }
    default:
      // Unknown event types are diagnostic noise; ignore them silently.
      return [];
  }
}

function joinAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { type?: string; text: string } =>
        !!part &&
        typeof part === 'object' &&
        (part.type === 'text' || part.type === undefined) &&
        typeof part.text === 'string'
    )
    .map(part => part.text)
    .join('');
}

function deriveToolCallName(
  toolCall: CursorStreamEvent['tool_call']
): string {
  if (!toolCall || typeof toolCall !== 'object') return 'cursor_tool';
  if (toolCall.shellToolCall) return 'shell';
  if (toolCall.readToolCall) return 'read_file';
  if (toolCall.writeToolCall) return 'write_file';
  if (toolCall.editToolCall) return 'edit_file';
  return 'cursor_tool';
}

function appendGarbage(buffer: string, line: string): string {
  const combined = buffer.length > 0 ? `${buffer}\n${line}` : line;
  if (combined.length <= GARBAGE_LINE_BUFFER_LIMIT) return combined;
  // Keep the tail so the most recent malformed line is preserved for diagnostics.
  return combined.slice(combined.length - GARBAGE_LINE_BUFFER_LIMIT);
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
