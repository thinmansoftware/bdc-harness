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
      if (stream.resultError !== null) {
        const detail = stream.resultError || 'cursor-agent result error';
        const skipped =
          stream.diagnostics.length > 0
            ? ` [${stream.diagnostics.length} non-json line(s) skipped]`
            : '';
        throw new Error(`${detail}${skipped}`);
      }
      if (stream.finalText.trim().length === 0 && stream.successResultText.trim().length > 0) {
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
  resultError: string | null;
  successResultText: string;
  diagnostics: string[];
}

function createCursorStreamState(): CursorStreamState {
  return {
    finalText: '',
    resultError: null,
    successResultText: '',
    diagnostics: [],
  };
}

/**
 * One stream-json line. Bad JSON is recorded and skipped.
 * thinking yields its `text` delta (idle-timer reset plus live progress).
 * tool_call yields an empty thinking chunk: MessageChunk's tool variant
 * requires toolName, which cursor-agent nests differently per tool.
 * Neither event's text is appended to the node output (assistant texts only).
 */
function chunksForStreamLine(line: string, state: CursorStreamState): MessageChunk[] {
  const raw = line.endsWith('\r') ? line.slice(0, -1) : line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    state.diagnostics.push(raw);
    return [];
  }
  const event = asRecord(parsed);
  if (!event || typeof event.type !== 'string') {
    state.diagnostics.push(raw);
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
    return [{ type: 'thinking', content: '' }];
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
      state.resultError = resultText.slice(-400);
    } else {
      state.successResultText = resultText;
    }
    return [];
  }
  return [];
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
