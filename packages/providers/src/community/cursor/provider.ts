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

    // cursor-agent stream-json emits one JSON object per line. We consume
    // stdout incrementally (complete lines only) so progress events are yielded
    // while the child is still working -- keeping the DAG executor's idle timer
    // alive across a long build -- instead of waiting for process exit.
    let finalText = '';
    let servedModelId: string | null = null;
    let servedModelMissingReason: string | null =
      'cursor-agent stream init event carried no served-model field';
    let resultText: string | null = null;
    let resultError = false;
    let resultSubtype: string | null = null;
    // Bounded diagnostic buffer for lines that are not valid JSON.
    const diagnosticLines: string[] = [];
    const DIAGNOSTIC_MAX_LINES = 20;

    // Nested async generator so each parsed event can itself yield a chunk.
    async function* processLine(line: string): AsyncGenerator<MessageChunk> {
      if (line.length === 0) return;
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        event = parsed as Record<string, unknown>;
      } catch {
        // A non-JSON line must never crash the stream; retain a bounded record.
        if (diagnosticLines.length < DIAGNOSTIC_MAX_LINES) {
          diagnosticLines.push(line.slice(0, 400));
        }
        return;
      }

      const type = event.type;
      if (type === 'system' || type === 'init') {
        const modelField = event.model;
        if (typeof modelField === 'string' && modelField.length > 0) {
          servedModelId = modelField;
          servedModelMissingReason = null;
        }
        return;
      }
      if (type === 'thinking') {
        // Yield an activity-counting chunk so the idle timer keeps resetting;
        // thinking text must never enter the final node output.
        yield { type: 'thinking', content: extractText(event.text) };
        return;
      }
      if (type === 'tool_call') {
        const call = asRecord(event.tool_call);
        const toolName = extractToolName(call);
        yield {
          type: 'tool',
          toolName: toolName.length > 0 ? toolName : 'cursor-agent-tool',
          ...(typeof event.call_id === 'string' && event.call_id.length > 0
            ? { toolCallId: event.call_id }
            : {}),
        };
        return;
      }
      if (type === 'assistant') {
        const text = extractAssistantText(event);
        if (text.length > 0) {
          finalText += text;
          yield { type: 'assistant', content: text };
        }
        return;
      }
      if (type === 'result') {
        const result = typeof event.result === 'string' ? event.result : '';
        resultText = result;
        resultError = event.is_error === true;
        resultSubtype = typeof event.subtype === 'string' ? event.subtype : null;
        if (!resultError && resultSubtype !== null && resultSubtype !== 'success') {
          resultError = true;
        }
        return;
      }
      // Unknown valid event types are ignored safely.
    }

    try {
      if (child.stdout) {
        const decoder = new TextDecoder();
        const reader = child.stdout.getReader();
        let pending = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) yield* processLine(line);
        }
        pending += decoder.decode();
        if (pending.length > 0) yield* processLine(pending);
      }

      const [exitCode, stderr] = await Promise.all([child.exited, stderrText]);
      await delivery;
      if (exitCode !== 0) {
        const detail = stderr.trim().slice(-400) || 'no stderr';
        throw new Error(`cursor-agent exited ${exitCode} (model ${model}): ${detail}`);
      }
      if (resultError) {
        const detail = (resultText ?? '').slice(-400) || `subtype ${resultSubtype ?? 'unknown'}`;
        throw new Error(`cursor-agent reported an error result: ${detail}`);
      }
      if (finalText.trim().length === 0) {
        finalText = resultText ?? '';
      }
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
      servedModelMissingReason: servedModelMissingReason ?? undefined,
    };
  }
}

function extractText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Join the text parts of an assistant message in order, exactly once. */
function extractAssistantText(event: Record<string, unknown>): string {
  const message = asRecord(event.message);
  const content = message.content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (typeof part === 'string') return part;
      const obj = asRecord(part);
      return typeof obj.text === 'string' ? obj.text : '';
    })
    .join('');
}

/**
 * Best-effort tool-name extraction from a cursor-agent tool_call object. The
 * live event wraps the actual call under a provider-specific key (e.g.
 * `shellToolCall`) whose value has an `args` shape. Fall back to the wrapper
 * key when the command cannot be determined.
 */
function extractToolName(call: Record<string, unknown>): string {
  for (const [key, value] of Object.entries(call)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const args = asRecord(asRecord(value).args);
    const command = args.command;
    if (typeof command === 'string' && command.trim().length > 0) {
      return command.trim().split(/\s+/)[0] ?? `cursor-${key}`;
    }
    return `cursor-${key}`;
  }
  return 'cursor-agent-tool';
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
