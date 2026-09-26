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
 *  - `--output-format stream-json` one JSON event per line (init / thinking /
 *    tool_call / assistant / result); the default text format prints only the
 *    final answer at exit, which starved the DAG idle timeout on long builds
 *    (bdc-harness #920).
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

    // stream-json accumulators. Only assistant text reaches the node output;
    // thinking/tool_call events are yielded purely so the DAG idle timer sees
    // activity while the agent works (bdc-harness #920).
    let assistantText = '';
    let resultText: string | undefined;
    let servedModelId: string | null = null;
    let initEventSeen = false; // true once any system (init) event arrives
    let malformedCount = 0;
    let malformedSample = '';
    const handleEvent = (event: unknown): MessageChunk[] => {
      if (typeof event !== 'object' || event === null) return [];
      const type = (event as { type?: unknown }).type;
      if (type === 'system') initEventSeen = true;
      switch (type) {
        case 'system': {
          const e = event as { subtype?: unknown; model?: unknown };
          if (e.subtype === 'init' && typeof e.model === 'string' && e.model.trim().length > 0) {
            servedModelId = e.model;
          }
          return [];
        }
        case 'assistant': {
          const content = (event as { message?: { content?: unknown } }).message?.content;
          const text = Array.isArray(content)
            ? content
                .flatMap(part => {
                  if (typeof part !== 'object' || part === null) return [];
                  const p = part as { type?: unknown; text?: unknown };
                  return p.type === 'text' && typeof p.text === 'string' ? [p.text] : [];
                })
                .join('')
            : '';
          if (text.length === 0) return [];
          assistantText += text;
          return [{ type: 'assistant', content: text }];
        }
        case 'thinking': {
          const text = (event as { text?: unknown }).text;
          return [{ type: 'thinking', content: typeof text === 'string' ? text : '' }];
        }
        case 'tool_call': {
          const call = (event as { tool_call?: Record<string, unknown> }).tool_call ?? {};
          const toolName = describeToolCall(call);
          return [{ type: 'tool', toolName, toolInput: call }];
        }
        case 'result': {
          const e = event as { subtype?: unknown; is_error?: unknown; result?: unknown };
          if (typeof e.result === 'string') resultText = e.result;
          if (e.is_error === true || e.subtype !== 'success') {
            const detail = (typeof e.result === 'string' ? e.result : '').slice(-400);
            throw new Error(
              `cursor-agent stream-json result error (subtype ${String(e.subtype)}): ${
                detail.length > 0 ? detail : 'no result text'
              }`
            );
          }
          return [];
        }
        default:
          return [];
      }
    };
    const handleLine = (line: string): MessageChunk[] => {
      if (line.trim().length === 0) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A partial render / progress line is diagnostic-only; one bad line
        // must never abort an otherwise valid stream.
        malformedCount += 1;
        malformedSample = line.slice(-400);
        return [];
      }
      return handleEvent(parsed);
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
          let newlineAt = buffer.indexOf('\n');
          while (newlineAt !== -1) {
            const line = buffer.slice(0, newlineAt).replace(/\r$/, '');
            buffer = buffer.slice(newlineAt + 1);
            for (const chunk of handleLine(line)) yield chunk;
            newlineAt = buffer.indexOf('\n');
          }
        }
        buffer += decoder.decode();
        // A final record without a trailing newline is still a valid event.
        for (const chunk of handleLine(buffer.replace(/\r$/, ''))) yield chunk;
      }
      const [exitCode, stderr] = await Promise.all([child.exited, stderrText]);
      await delivery;
      if (exitCode !== 0) {
        const detail = stderr.trim().slice(-400) || 'no stderr';
        throw new Error(`cursor-agent exited ${exitCode} (model ${model}): ${detail}`);
      }
      // The final node text is the concatenation of assistant texts; fall back
      // to the success result text when the stream carried no assistant events.
      finalText = assistantText.length > 0 ? assistantText : (resultText ?? '');
      if (finalText.trim().length === 0) {
        // rc 0 with no output is the Workspace Trust / auth no-op
        // (scripts/dispatch-worker/seat-preflight.ts cursorBuildResultIsEmpty).
        // Never report it as success.
        throw new Error(
          'cursor-agent exited 0 with empty output (workspace trust or authentication not granted)'
        );
      }
      if (malformedCount > 0) {
        console.warn(
          `provider:cursor ignored ${String(malformedCount)} non-JSON stdout line(s); last: ${malformedSample}`
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
        ? {
            servedModelMissingReason: initEventSeen
              ? 'cursor-agent stream-json init event carried no model field'
              : 'cursor-agent stream-json stream carried no system/init event',
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

/**
 * Derive a stable tool name from a stream-json tool_call payload. The payload
 * is keyed by tool kind (shellToolCall, readToolCall, ...), so the name is the
 * first `*ToolCall` key with the trailing "ToolCall" stripped.
 */
function describeToolCall(call: Record<string, unknown>): string {
  for (const key of Object.keys(call)) {
    if (key.endsWith('ToolCall') && typeof call[key] === 'object' && call[key] !== null) {
      return key.slice(0, -'ToolCall'.length) || key;
    }
  }
  return 'tool_call';
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
