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
 *  - `--output-format stream-json` one JSON event per line while the agent
 *               works, so the DAG idle timer resets. Text mode prints only the
 *               final answer at exit and would trip the idle timeout.
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
    // The catch is attached immediately: a stream-json error result throws before
    // this promise is awaited, and must not surface as an unhandled rejection.
    const stderrText = (
      child.stderr ? new Response(child.stderr).text() : Promise.resolve('')
    ).catch(() => undefined);
    // Deliver the prompt WITHOUT awaiting it before reading stdout: the child
    // reads stdin to EOF before answering, so writing and reading must overlap.
    const delivery = deliverPrompt(child.stdin, buildCursorPrompt(prompt, options));

    const stream: CursorStreamAccum = {
      assistantText: '',
      servedModelId: null,
    };
    let diagnostics = '';
    let finalText = '';
    try {
      if (child.stdout) {
        const decoder = new TextDecoder();
        const reader = child.stdout.getReader();
        let remainder = '';
        const consumeLine = (line: string): MessageChunk | undefined => {
          const stripped = line.endsWith('\r') ? line.slice(0, -1) : line;
          if (stripped.trim().length === 0) return undefined;
          let parsed: unknown;
          try {
            parsed = JSON.parse(stripped);
          } catch {
            diagnostics += `${stripped}\n`;
            return undefined;
          }
          try {
            return interpretCursorStreamEvent(parsed, stream);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(attachDiagnostics(message, diagnostics));
          }
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          remainder += decoder.decode(value, { stream: true });
          const lines = remainder.split('\n');
          remainder = lines.pop() ?? '';
          for (const line of lines) {
            const chunk = consumeLine(line);
            if (chunk !== undefined) yield chunk;
          }
        }
        remainder += decoder.decode();
        if (remainder.length > 0) {
          const chunk = consumeLine(remainder);
          if (chunk !== undefined) yield chunk;
        }
      }
      const [exitCode, stderr] = await Promise.all([child.exited, stderrText]);
      await delivery;
      if (exitCode !== 0) {
        const detail = (stderr ?? '').trim().slice(-400) || 'no stderr';
        throw new Error(
          attachDiagnostics(
            `cursor-agent exited ${exitCode} (model ${model}): ${detail}`,
            diagnostics
          )
        );
      }
      finalText = stream.assistantText;
      if (finalText.trim().length === 0 && stream.resultText !== undefined) {
        finalText = stream.resultText;
      }
      if (finalText.trim().length === 0) {
        // rc 0 with no output is the Workspace Trust / auth no-op
        // (scripts/dispatch-worker/seat-preflight.ts cursorBuildResultIsEmpty).
        // Never report it as success.
        throw new Error(
          attachDiagnostics(
            'cursor-agent exited 0 with empty output (workspace trust or authentication not granted)',
            diagnostics
          )
        );
      }
    } finally {
      options?.abortSignal?.removeEventListener('abort', onAbort);
    }

    let structuredOutput: unknown;
    if (options?.outputFormat?.type === 'json_schema') {
      structuredOutput = parseJsonBestEffort(finalText);
    }

    const servedModelId = stream.servedModelId;
    yield {
      type: 'result',
      stopReason: 'stop',
      structuredOutput,
      servedModelId,
      ...(servedModelId === null
        ? {
            servedModelMissingReason: 'cursor-agent stream-json init event did not include a model',
          }
        : {}),
    };
  }
}

interface CursorStreamAccum {
  assistantText: string;
  servedModelId: string | null;
  resultText?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function attachDiagnostics(message: string, diagnostics: string): string {
  if (diagnostics.length === 0) return message;
  return `${message}\n${diagnostics.slice(-400)}`;
}

function assistantTextFrom(event: Record<string, unknown>): string {
  const message = event.message;
  if (!isRecord(message)) return '';
  const content = message.content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') text += part.text;
  }
  return text;
}

function toolNameFrom(toolCall: unknown): string {
  if (!isRecord(toolCall)) return 'tool_call';
  const key = Object.keys(toolCall)[0];
  return key !== undefined && key.length > 0 ? key : 'tool_call';
}

/** Interpret one stream-json value. Throws on a failed result event. */
function interpretCursorStreamEvent(
  value: unknown,
  state: CursorStreamAccum
): MessageChunk | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'assistant') {
    const content = assistantTextFrom(value);
    state.assistantText += content;
    return { type: 'assistant', content };
  }
  if (value.type === 'thinking') {
    const text = typeof value.text === 'string' ? value.text : '';
    return { type: 'thinking', content: text };
  }
  if (value.type === 'tool_call') {
    const toolName = toolNameFrom(value.tool_call);
    const toolCallId = typeof value.call_id === 'string' ? value.call_id : undefined;
    return toolCallId !== undefined
      ? { type: 'tool', toolName, toolCallId }
      : { type: 'tool', toolName };
  }
  if (value.type === 'system' && value.subtype === 'init') {
    if (typeof value.model === 'string' && value.model.length > 0) {
      state.servedModelId = value.model;
    }
    return undefined;
  }
  if (value.type === 'result') {
    if (typeof value.result === 'string') state.resultText = value.result;
    if (value.is_error === true || value.subtype !== 'success') {
      const raw = typeof value.result === 'string' ? value.result : '';
      throw new Error(`cursor-agent result error: ${raw.slice(-400)}`);
    }
    return undefined;
  }
  return undefined;
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
